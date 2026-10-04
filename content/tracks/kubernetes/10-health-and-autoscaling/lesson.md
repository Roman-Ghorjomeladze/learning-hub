Kubernetes can only keep your app available if it knows two things: **is this container healthy, and can it take traffic right now?** And it can only keep the app responsive under changing load if it knows **when to add or remove capacity**. This module covers both: probes and graceful shutdown (so deploys and failures cause zero errors), then the autoscaling stack from pods (HPA, VPA, KEDA) to nodes (Cluster Autoscaler, Karpenter).

## Probes: three questions, three probes

The kubelet on each node runs probes against your containers. Each probe answers a different question and triggers a different action:

| Probe | Question | On failure | Typical endpoint for `shipit-api` |
| --- | --- | --- | --- |
| **startupProbe** | Has the app finished starting? | Keep waiting until `failureThreshold` is exhausted, then restart. Liveness and readiness are disabled until it succeeds | `GET /healthz` |
| **livenessProbe** | Is the process stuck beyond recovery? | **Restart the container** | `GET /healthz` (process-local, always 200 if the event loop works) |
| **readinessProbe** | Should this pod receive traffic now? | **Remove the pod from Service endpoints** (no restart) | `GET /readyz` (checks DB and Redis, returns 503 while shutting down) |

```text
 container starts
      |
      v
 startupProbe ----fails > threshold----> restart
      | succeeds once
      v
 livenessProbe (periodic) ----fails threshold times----> restart container
 readinessProbe (periodic) ---fails----> pod NotReady -> removed from EndpointSlices
                           ---passes---> pod Ready    -> added back
```

Readiness failure is **cheap and reversible**: the pod stays up and comes back into rotation when it recovers. Liveness failure is **destructive**: the container is killed and restarted, losing in-flight requests and warm caches. Use liveness sparingly.

### Probe mechanisms

```yaml
livenessProbe:
  httpGet:                       # 200-399 = success
    path: /healthz
    port: 3000                   # or a named port: http
    httpHeaders:
      - name: x-probe
        value: kubelet
readinessProbe:
  tcpSocket:                     # success if the TCP connection opens
    port: 5432
startupProbe:
  exec:                          # success if exit code 0
    command: ["pg_isready", "-U", "shipit"]
---
livenessProbe:
  grpc:                          # standard gRPC health checking protocol
    port: 50051
    service: shipit.v1.Items     # optional
```

`exec` probes fork a process in the container every period, which costs CPU at scale; prefer `httpGet` or `grpc` for application containers.

### Timing fields

| Field | Default | Meaning |
| --- | --- | --- |
| `initialDelaySeconds` | 0 | Wait before the first probe (prefer a startupProbe instead) |
| `periodSeconds` | 10 | How often to probe |
| `timeoutSeconds` | 1 | Probe times out after this |
| `failureThreshold` | 3 | Consecutive failures before acting |
| `successThreshold` | 1 | Consecutive successes to be considered passing again (must be 1 for liveness/startup) |
| `terminationGracePeriodSeconds` | pod value | Per-probe override of the grace period when liveness/startup kills the container |

Time to detection is roughly `periodSeconds x failureThreshold`. Time allowed for startup with a startupProbe is `periodSeconds x failureThreshold` of the startup probe:

```yaml
startupProbe:
  httpGet: { path: /healthz, port: http }
  periodSeconds: 5
  failureThreshold: 24          # up to 120 s to start (migrations, cache warm-up, JIT)
livenessProbe:
  httpGet: { path: /healthz, port: http }
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 3           # restart after ~30 s of being stuck
readinessProbe:
  httpGet: { path: /readyz, port: http }
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 2           # out of rotation after ~10 s
```

### Implementing the endpoints in Node/NestJS

```typescript
// Plain Node/Express style. In NestJS, @nestjs/terminus provides HealthCheckService,
// TypeOrm/Prisma and microservice health indicators for /readyz.
let shuttingDown = false;

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');           // event loop alive = healthy. No dependencies!
});

app.get('/readyz', async (_req, res) => {
  if (shuttingDown) return res.status(503).send('shutting down');
  try {
    await Promise.all([
      pool.query('SELECT 1'),           // Postgres reachable
      redis.ping(),                     // Redis reachable
    ]);
    res.status(200).send('ready');
  } catch {
    res.status(503).send('dependencies unavailable');
  }
});
```

:::warning The most common probe mistakes
- **Liveness that checks the database or Redis.** When Postgres has a hiccup, every replica fails liveness at once and Kubernetes restarts your whole fleet, which then stampedes the recovering database with reconnects. A dependency outage becomes a full outage. Dependencies belong in readiness (or nowhere), never in liveness.
- **No startupProbe for slow starters.** A liveness probe with a short delay kills the app before it finishes starting: `CrashLoopBackOff` with logs that just stop mid-boot. Add a startupProbe instead of a huge `initialDelaySeconds`.
- **`timeoutSeconds: 1` on a busy Node process.** A CPU-bound request blocks the event loop; the probe times out; liveness restarts a pod that was merely busy. Give probes 2 to 5 seconds and enough failures.
- **Readiness identical to liveness.** Then you get restarts when you only wanted to stop traffic.
- **Expensive readiness checks.** Running a heavy query every 5 seconds from every pod adds real load. Keep checks cheap, and consider caching the result for a few seconds.
- **Readiness on dependencies shared by all pods** can also take every pod out of rotation at once. Sometimes serving degraded responses (from cache) is better than serving nothing; decide deliberately.
:::

:::try Watch readiness move endpoints
In Lab 1 you will flip a pod's readiness through an admin endpoint. Before that, try reasoning with `kubectl get endpointslices -l kubernetes.io/service-name=<svc> -o yaml`: each endpoint has `conditions.ready`. Unready pods remain listed with `ready: false`, and proxies skip them. That field is the whole mechanism behind readiness.
:::

## Graceful shutdown and zero-downtime deploys

Every rollout, scale-down, drain and Karpenter consolidation deletes pods. If that causes errors, you have errors on every deploy. To get it right you need to understand what happens when a pod is deleted, because **two things happen in parallel**:

```text
 kubectl delete pod / rollout replaces pod
                  |
       pod marked Terminating (deletionTimestamp set)
          /                                   \
 (A) control plane                          (B) kubelet on the node
 EndpointSlice controller marks the          1. runs preStop hook (if any)
 endpoint not ready/terminating              2. sends SIGTERM to PID 1 in each container
     -> kube-proxy / Gateway / LB            3. waits up to terminationGracePeriodSeconds
        update their routing                    (default 30 s, counted from the start,
        (takes ~100 ms to several s,             preStop time included)
         longer for cloud LBs)               4. SIGKILL whatever is left
```

Path A and path B race. If your process exits on SIGTERM immediately, there is a window where proxies still send requests to a pod that is gone: connection refused and 502s on every deploy. The standard fix has three parts:

1. **preStop sleep**: delay SIGTERM a few seconds so routing updates first. Kubernetes has a native sleep action, so you do not even need `sleep` in the image:

```yaml
spec:
  terminationGracePeriodSeconds: 45     # > preStop + longest request + cleanup
  containers:
    - name: api
      lifecycle:
        preStop:
          sleep:
            seconds: 10                  # native sleep action (on by default since 1.30)
          # exec: { command: ["sleep", "10"] }   # older clusters; needs sleep in the image
```

2. **Handle SIGTERM in the app**: stop accepting new connections, finish in-flight requests, close keep-alive connections, close DB/Redis pools, then exit.

3. **Fail readiness during shutdown** (optional but cheap), so anything that still probes stops sending traffic.

```typescript
// src/main.ts (plain Node http server; NestJS: app.enableShutdownHooks() and
// implement onApplicationShutdown / beforeApplicationShutdown in your providers)
const server = app.listen(config.PORT);

process.on('SIGTERM', () => {
  console.log('SIGTERM: draining');
  shuttingDown = true;                    // /readyz now returns 503

  server.close(async () => {              // stop accepting; callback when connections are done
    await Promise.allSettled([pool.end(), redis.quit()]);
    console.log('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections?.();        // drop idle keep-alive sockets now

  setTimeout(() => {                      // safety net below terminationGracePeriodSeconds
    console.error('forced exit');
    process.exit(1);
  }, 25_000).unref();
});
```

:::warning Node as PID 1 and npm start
Two classic Node container problems break graceful shutdown:

- **PID 1 ignores signals without a handler.** If your app installs no SIGTERM handler and runs as PID 1, SIGTERM does nothing; the pod hangs for the full grace period and is then SIGKILLed mid-request. Install a handler (above), or use a minimal init such as `tini` as the image entrypoint so signals get default behaviour.
- **`npm start` / `sh -c` as the entrypoint.** npm or the shell becomes PID 1 and may not forward SIGTERM to Node. Use `CMD ["node", "dist/main.js"]` in exec form.
:::

Also configure the rollout so capacity never drops:

```yaml
spec:
  replicas: 3
  minReadySeconds: 5               # a new pod must stay Ready 5 s before it counts
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%                # add new pods first...
      maxUnavailable: 0            # ...never go below desired replicas
```

:::deep Long-lived connections: WebSockets, SSE, gRPC
`server.close()` waits for **all** connections to end. With Socket.io, SSE or gRPC streams, connections may live for hours, so the safety-net timeout fires and clients are cut. Patterns that work:

- On SIGTERM, tell clients to reconnect (Socket.io: emit a "reconnect" event or call `io.close()` after a short delay); clients reconnect through the load balancer to a healthy pod. Spread disconnects over a few seconds to avoid a thundering herd.
- Set `terminationGracePeriodSeconds` to cover your realistic drain time (some teams use 60 to 120 s for WebSocket services), and keep the safety-net timer slightly below it.
- For HTTP/2 and gRPC, send GOAWAY so clients open new streams elsewhere; for HTTP/1.1 keep-alive, respond with `Connection: close` during shutdown.
- Remember that cloud load balancers (AWS ALB/NLB) have their own deregistration delay. With the AWS Load Balancer Controller in IP mode, pod readiness gates and a preStop sleep longer than the target deregistration time avoid 502s.

The general rule: **the preStop delay covers routing propagation; the grace period covers draining existing work.**
:::

## Horizontal Pod Autoscaler (HPA)

The HPA controller (in kube-controller-manager) periodically (every 15 s by default) reads metrics and adjusts `spec.replicas` of a Deployment, StatefulSet or anything with a `scale` subresource.

```text
 metrics-server --metrics.k8s.io--> HPA controller --scale--> Deployment --> ReplicaSet --> pods
 Prometheus Adapter / KEDA --custom.metrics.k8s.io / external.metrics.k8s.io--^
```

The core formula:

```text
desiredReplicas = ceil( currentReplicas * currentMetricValue / targetValue )

e.g. 4 replicas at 90% average CPU utilisation, target 60%:
     ceil(4 * 90 / 60) = ceil(6.0) = 6 replicas
```

Changes within a **10% tolerance** of the target are ignored to prevent flapping. With several metrics, the HPA computes a desired count for each and takes the **highest**. Pods that are not yet ready, or are missing metrics, are treated conservatively.

### A complete HPA v2 manifest

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: shipit-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: shipit-api
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization          # percent of the pod's CPU REQUEST
          averageUtilization: 60
    - type: Resource
      resource:
        name: memory
        target:
          type: AverageValue
          averageValue: 400Mi
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0  # react immediately (default)
      policies:
        - type: Percent
          value: 100                 # at most double...
          periodSeconds: 30
        - type: Pods
          value: 4                   # ...or +4 pods, whichever is larger
          periodSeconds: 30
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300  # use the highest recommendation of the last 5 min (default)
      policies:
        - type: Percent
          value: 20                    # remove at most 20% per minute
          periodSeconds: 60
```

Key points:

- **`Utilization` is relative to requests.** No CPU request, no CPU-based HPA (the HPA reports `<unknown>`/`FailedGetResourceMetric`). With a 100m request, 60% means 60m average.
- **Do not set `replicas` in the Deployment manifest you apply with GitOps/`kubectl apply`** once an HPA manages it, or every apply resets the count. Remove the field (Kubernetes keeps the current value).
- **Memory is a poor scaling signal for Node.js** and most garbage-collected runtimes: memory rarely drops after load ends, so the HPA scales up and never down. Prefer CPU, request rate or latency.
- **Scale-down stabilization** (5 minutes by default) prevents flapping when traffic is spiky. Scale-up is immediate by default.

```bash
kubectl autoscale deployment shipit-api --cpu-percent=60 --min=3 --max=20   # quick imperative version
kubectl get hpa shipit-api -w
kubectl describe hpa shipit-api        # current metrics, conditions (AbleToScale, ScalingActive, ScalingLimited), events
```

### Custom and external metrics

CPU is a proxy. Often a better signal is closer to the user or the work:

| Metric type | Source | Example |
| --- | --- | --- |
| `Resource` | metrics-server | CPU, memory per pod |
| `ContainerResource` | metrics-server | CPU of the app container only, ignoring sidecars |
| `Pods` | custom metrics API (e.g. Prometheus Adapter) | `http_requests_per_second` averaged per pod |
| `Object` | custom metrics API | requests per second on a Gateway/Ingress object |
| `External` | external metrics API (Prometheus Adapter, KEDA, cloud adapters) | SQS queue depth, Kafka consumer lag |

```yaml
metrics:
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "50"         # 50 rps per pod
```

You need an adapter that implements `custom.metrics.k8s.io` or `external.metrics.k8s.io`. Running Prometheus Adapter yourself is fiddly, which is one reason KEDA is popular (below).

:::try Do the HPA math
A Deployment has 3 pods, each requesting `cpu: 200m`. Current usage is 180m, 220m and 200m, and the HPA target is `averageUtilization: 50`. Current utilisation is average(90%, 110%, 100%) = 100%, so desired = ceil(3 x 100 / 50) = 6. Later the 6 pods average 105m each (52.5%). The ratio 52.5 / 50 = 1.05 is within the 10% tolerance, so the HPA changes nothing. At 120m (60%) it would scale to ceil(6 x 60 / 50) = ceil(7.2) = 8. Lab 4 lets you watch these numbers live in `kubectl describe hpa`.
:::

## Vertical Pod Autoscaler (VPA)

VPA adjusts **requests** (and proportionally limits) instead of replica counts. It is an add-on from the Kubernetes autoscaler project with a recommender, an updater and an admission webhook.

Modes (`updatePolicy.updateMode`):

- `Off`: only produce recommendations (`kubectl describe vpa`). The safe and most useful starting point for right-sizing.
- `Initial`: set requests only when pods are created.
- `Recreate`: evict pods to apply new requests.
- `InPlaceOrRecreate`: newer VPA releases use in-place pod resize (GA in Kubernetes 1.35) and fall back to eviction.

Do **not** let VPA and HPA both act on the same metric (for example both on CPU): HPA adds pods because utilisation is high, VPA raises requests which lowers utilisation, and they fight. Common combinations: HPA on CPU or custom metrics plus VPA in `Off` mode for recommendations, or VPA on memory only.

## Cluster autoscaling: adding nodes

HPA creates pods; if the nodes are full, those pods are `Pending`. Node autoscalers watch for unschedulable pods and add capacity, and remove underused nodes:

| | **Cluster Autoscaler** | **Karpenter** |
| --- | --- | --- |
| Model | Scales pre-defined node groups (AWS Auto Scaling Groups / EKS managed node groups) | Provisions individual instances directly from the cloud API based on pending pods' needs |
| Instance choice | Fixed per node group | Picks from many instance types/sizes, Spot or On-Demand, per batch of pods (`NodePool`, `EC2NodeClass`) |
| Speed | Minutes (ASG round trip) | Typically faster |
| Scale-down | Removes nodes below a utilisation threshold whose pods fit elsewhere | **Consolidation**: replaces or removes nodes to bin-pack workloads more cheaply |
| Clouds | Many providers | AWS (origin, core of EKS Auto Mode), Azure, others via providers |

Both scale down by **draining** nodes, which respects PodDisruptionBudgets, so the PDB and graceful-shutdown work above is what makes autoscaling safe. Both make decisions based on **requests**, not usage, which is why right-sizing matters (module 09).

```text
 traffic up -> CPU up -> HPA: 6 -> 12 pods -> 4 Pending (no room)
            -> Karpenter/CA sees Pending pods -> new node (1-2 min) -> pods scheduled
 traffic down -> HPA: 12 -> 6 pods (after stabilization)
            -> nodes underused -> consolidation drains & removes a node (PDBs respected)
```

Plan for the node lag: scale-up of nodes takes a minute or more, so keep some headroom (lower HPA targets, overprovisioning pods with negative priority, or a higher `minReplicas` before known peaks).

## KEDA: event-driven autoscaling

**KEDA** (Kubernetes Event-Driven Autoscaling, a CNCF graduated project) scales workloads from event sources: queue length, stream lag, Prometheus queries, cron schedules, database rows, and many more. It works **with** the HPA: KEDA serves an external metrics API and creates/manages an HPA for you, and it handles the 0 to 1 step itself, which the HPA cannot do.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: email-worker
spec:
  scaleTargetRef:
    name: email-worker            # a Deployment
  minReplicaCount: 0              # scale to zero when idle
  maxReplicaCount: 30
  pollingInterval: 10             # seconds between checks of the source
  cooldownPeriod: 120             # wait before going back to zero
  triggers:
    - type: redis
      metadata:
        address: redis.shipit.svc.cluster.local:6379
        listName: email-jobs
        listLength: "20"          # target: 20 pending items per replica
    - type: cron                  # also keep 2 replicas during business hours
      metadata:
        timezone: Asia/Tbilisi
        start: 0 9 * * 1-5
        end: 0 19 * * 1-5
        desiredReplicas: "2"
```

Typical uses in a Node backend: BullMQ/Redis queue workers, SQS consumers (`aws-sqs-queue` scaler with IRSA/Pod Identity auth via `TriggerAuthentication`), Kafka consumers (scale on consumer lag), and scaling an API on a Prometheus query such as request rate. For run-to-completion work, `ScaledJob` creates Jobs per batch of events instead of scaling a Deployment.

## Load testing to validate scaling

You cannot trust autoscaling you have not watched under load. **k6** (Grafana) scripts are plain JavaScript, so they feel natural for a TypeScript developer:

```javascript
// load.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },   // ramp up to 50 virtual users
    { duration: '3m', target: 50 },   // hold
    { duration: '1m', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],     // fail the test if >1% errors
    http_req_duration: ['p(95)<300'],   // ...or p95 above 300 ms
  },
};

export default function () {
  const res = http.get(`${__ENV.BASE_URL}/items`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}
```

Run it from your Mac (`brew install k6`, then `k6 run -e BASE_URL=http://localhost:8080 load.js`) or, better for kind, **inside the cluster** as a Job so `kubectl port-forward` does not become the bottleneck. `hey` (`brew install hey`) is a simpler one-liner alternative: `hey -z 2m -c 50 http://localhost:8080/items`. While the test runs, watch `kubectl get hpa -w`, `kubectl top pods` and `kubectl get pods -w` side by side.

## Pitfalls and best practices

:::warning Common mistakes
- **HPA without requests** (or a sidecar without requests) shows `<unknown>` and never scales.
- **`minReplicas: 1`** for a production API: one pod, no redundancy during node failures or rollouts. Use at least 2, preferably 3.
- **`replicas:` in Git fighting the HPA** on every sync.
- **Scaling on memory** for GC runtimes: scales up, never down.
- **Liveness probes that restart pods under load** (timeouts on a busy event loop) just as the HPA is trying to add capacity, making overload worse.
- **No PDBs**, so cluster autoscaler scale-down or Karpenter consolidation evicts all replicas at once.
- **Graceful shutdown longer than `terminationGracePeriodSeconds`**: SIGKILL cuts requests anyway.
:::

A production checklist for `shipit-api`:

- startupProbe and liveness on `/healthz` (no dependencies), readiness on `/readyz` (DB + Redis, 503 during shutdown).
- SIGTERM handler, preStop sleep of 5 to 10 s, `terminationGracePeriodSeconds` above preStop + drain time, `maxUnavailable: 0`.
- HPA on CPU (or request rate) with `minReplicas: 3`, sensible scale-down behavior, requests sized from data.
- PDB `maxUnavailable: 1`, topology spread across zones.
- Karpenter or Cluster Autoscaler for nodes; KEDA for queue workers.
- A k6 test in CI or before big launches, with thresholds on error rate and latency.
