You need `docker`, `kind`, `kubectl` and `helm`. Load is generated **inside** the cluster with the `grafana/k6` image, so `kubectl port-forward` never becomes the bottleneck (you can also `brew install k6` or `brew install hey` to play from your Mac).

### Shared setup

Create the cluster and install metrics-server (with `--kubelet-insecure-tls`, needed on kind only):

```bash
kind create cluster --name scale-lab
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deployment/metrics-server
```

All labs use one small Node.js server, stored in a ConfigMap and run with the public `node:22-alpine` image. Its behaviour is controlled by env vars:

| Env var | Effect |
| --- | --- |
| `STARTUP_DELAY_SECONDS` | Wait this long before listening (a slow starter) |
| `WORK_MS` | Burn this much CPU per request (for the HPA) |
| `LATENCY_MS` | Wait this long (async) before responding (in-flight requests) |
| `DEPENDENCY_HOST` / `DEPENDENCY_PORT` | `/readyz` also checks a TCP connection to this dependency |
| `GRACEFUL` | `true`: drain properly on SIGTERM. Otherwise exit immediately |

Endpoints: `/healthz` (liveness), `/readyz` (readiness), `/admin/unready`, `/admin/ready`, `/admin/break` (make liveness fail), anything else returns `hello from <pod>`.

```bash
cat <<'EOF' > /tmp/probe-app.js
const http = require('http');
const net = require('net');
const env = process.env;
const startupDelay = Number(env.STARTUP_DELAY_SECONDS || 0) * 1000;
const workMs = Number(env.WORK_MS || 0);
const latencyMs = Number(env.LATENCY_MS || 0);
const graceful = env.GRACEFUL === 'true';
let ready = false, alive = true, shuttingDown = false;

const burn = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
const depOk = () => new Promise((resolve) => {
  if (!env.DEPENDENCY_HOST) return resolve(true);
  const s = net.connect({ host: env.DEPENDENCY_HOST, port: Number(env.DEPENDENCY_PORT || 6379), timeout: 500 });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.on('timeout', () => { s.destroy(); resolve(false); });
});

const server = http.createServer(async (req, res) => {
  if (shuttingDown) res.setHeader('connection', 'close');
  switch (req.url) {
    case '/healthz': res.statusCode = alive ? 200 : 500; return res.end(alive ? 'ok\n' : 'broken\n');
    case '/readyz': {
      const ok = ready && !shuttingDown && (await depOk());
      res.statusCode = ok ? 200 : 503; return res.end(ok ? 'ready\n' : 'not ready\n');
    }
    case '/admin/unready': ready = false; return res.end('now unready\n');
    case '/admin/ready': ready = true; return res.end('now ready\n');
    case '/admin/break': alive = false; return res.end('liveness will fail\n');
  }
  burn(workMs);
  setTimeout(() => res.end(`hello from ${env.HOSTNAME}\n`), latencyMs);
});

console.log(`starting (startup delay ${startupDelay / 1000}s)`);
setTimeout(() => server.listen(3000, () => { ready = true; console.log('listening on 3000'); }), startupDelay);

process.on('SIGTERM', () => {
  console.log(`SIGTERM received (graceful=${graceful})`);
  if (!graceful) process.exit(0);
  shuttingDown = true;                      // readyz -> 503, responses carry "Connection: close"
  setTimeout(() => {
    server.close(() => { console.log('drained, exiting'); process.exit(0); });
  }, 2000);                                 // let keep-alive clients receive "Connection: close" first
  setTimeout(() => { console.log('forced exit'); process.exit(1); }, 25000).unref();
});
EOF
kubectl create configmap probe-app --from-file=server.js=/tmp/probe-app.js
```

And a reusable k6 load script:

```bash
cat <<'EOF' > /tmp/load.js
import http from 'k6/http';
export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '2m',
};
export default function () {
  http.get(__ENV.TARGET);
}
EOF
kubectl create configmap k6-script --from-file=load.js=/tmp/load.js
```

## Lab 1: Readiness moves traffic, liveness restarts

:::meta
difficulty: easy
time: 20 min
:::

Goal: see exactly what each probe does: a failing readiness probe removes a pod from the Service's endpoints without restarting it; a failing liveness probe restarts the container.

### Steps

1. Deploy 3 replicas with all three probes and a Service:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: app
          image: node:22-alpine
          command: ["node", "/app/server.js"]
          ports:
            - name: http
              containerPort: 3000
          startupProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 2
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 3
            failureThreshold: 1
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
          volumeMounts:
            - name: code
              mountPath: /app
      volumes:
        - name: code
          configMap:
            name: probe-app
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: { app: web }
  ports:
    - port: 80
      targetPort: http
EOF
kubectl rollout status deploy/web
```

2. In a second terminal, watch the endpoints:

```bash
kubectl get endpointslices -l kubernetes.io/service-name=web -w \
  -o custom-columns=NAME:.metadata.name,READY:.endpoints[*].conditions.ready,PODS:.endpoints[*].targetRef.name
```

3. Make one pod unready, then ready again:

```bash
POD=$(kubectl get pods -l app=web -o jsonpath='{.items[0].metadata.name}')
kubectl exec "$POD" -- wget -qO- localhost:3000/admin/unready
sleep 5; kubectl get pods -l app=web
kubectl run curl --rm -it --restart=Never --image=curlimages/curl -- \
  sh -c 'for i in $(seq 1 12); do curl -s web; done'
kubectl exec "$POD" -- wget -qO- localhost:3000/admin/ready
```

4. Break liveness on the same pod:

```bash
kubectl exec "$POD" -- wget -qO- localhost:3000/admin/break
kubectl get pod "$POD" -w      # wait ~15-20 s for RESTARTS to become 1, then Ctrl+C
kubectl describe pod "$POD" | sed -n '/Events:/,$p'
```

### Verify

- After `/admin/unready`, the pod shows `READY 0/1`, its endpoint is `ready: false`, the curl loop only gets answers from the other two pods, and `RESTARTS` stays 0.
- After `/admin/break`, the events show `Liveness probe failed: HTTP probe failed with statuscode: 500` followed by `Container app failed liveness probe, will be restarted`, `RESTARTS` becomes 1, and the pod is healthy again (the restart reset its in-memory state).

:::hint
If `wget` is not found, the image changed; use `kubectl exec "$POD" -- node -e "fetch('http://localhost:3000/admin/unready').then(r=>r.text()).then(console.log)"` instead.
:::

:::solution
The steps are the solution. Notice the asymmetry: readiness took the pod out of rotation within about 3 seconds (`periodSeconds: 3`, `failureThreshold: 1`) and put it back as soon as it recovered. Liveness needed three failures five seconds apart before restarting, because restarts are destructive. That is the intended tuning: readiness fast and sensitive, liveness slow and conservative.
:::

### Clean up

```bash
kubectl delete deploy web
kubectl delete svc web
```

## Lab 2: Break and fix: the restart storm

:::meta
difficulty: medium
time: 30 min
:::

Goal: a colleague configured probes for a slow-starting API that depends on Redis. Pods never become ready, and when Redis blips, every pod restarts. Find and fix both problems.

### Setup

```bash
kubectl create deployment redis --image=redis:7-alpine
kubectl expose deployment redis --port=6379

cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: app
          image: node:22-alpine
          command: ["node", "/app/server.js"]
          env:
            - { name: STARTUP_DELAY_SECONDS, value: "40" }
            - { name: DEPENDENCY_HOST, value: redis }
            - { name: DEPENDENCY_PORT, value: "6379" }
          ports:
            - name: http
              containerPort: 3000
          livenessProbe:
            httpGet: { path: /readyz, port: http }
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
          volumeMounts:
            - name: code
              mountPath: /app
      volumes:
        - name: code
          configMap:
            name: probe-app
EOF
```

Watch for a minute:

```bash
kubectl get pods -l app=api -w
```

### Your task

1. Explain why the pods never become ready and end up in `CrashLoopBackOff`, then fix it.
2. Once the pods are ready, simulate a Redis outage with `kubectl scale deploy redis --replicas=0` for about 30 seconds, then scale it back to 1. With the colleague's design, all API pods restart. Fix the probes so a Redis outage takes pods **out of rotation** but **never restarts** them.

### Verify

```bash
kubectl rollout status deploy/api --timeout=180s
kubectl get pods -l app=api                       # 3/3 Running, note RESTARTS
kubectl scale deploy redis --replicas=0; sleep 30
kubectl get pods -l app=api                       # READY 0/1 but RESTARTS unchanged
kubectl scale deploy redis --replicas=1; sleep 20
kubectl get pods -l app=api                       # READY 1/1 again, RESTARTS unchanged
```

:::hint
Look at `kubectl describe pod -l app=api` events and `kubectl logs -l app=api --previous`. How long does the app need before it listens? How long does the liveness probe allow? Then ask: what is liveness supposed to measure, and does `/readyz` measure that?
:::

:::solution
**Problem 1: liveness kills the app during startup.** The app needs 40 s before it listens. The liveness probe starts after 5 s and restarts the container after 3 failures 5 s apart, so the container is killed at about 20 s, every time. The logs show only `starting (startup delay 40s)` and the events show `Liveness probe failed: ... connection refused`. Each restart starts the 40 s timer over, ending in `CrashLoopBackOff`.

**Problem 2: liveness depends on Redis.** `/readyz` checks Redis, so a Redis outage fails liveness on every pod at once and Kubernetes restarts the whole fleet, which turns a dependency blip into a full outage (and a reconnect stampede when Redis returns).

**Fix:** add a startupProbe that allows enough time, point liveness at the dependency-free `/healthz`, and keep the dependency check only in readiness:

```bash
kubectl patch deploy api --type=strategic -p '
spec:
  template:
    spec:
      containers:
        - name: app
          startupProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 5
            failureThreshold: 24
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            initialDelaySeconds: 0
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2
'
kubectl rollout status deploy/api --timeout=180s
```

The startupProbe gives up to 120 s (24 x 5 s) to start, liveness only checks that the process responds, and readiness reflects Redis. During the Redis outage the pods go `0/1 READY` (no traffic, no restarts) and recover by themselves.

Whether readiness *should* depend on Redis at all is a design choice: if your API can serve from Postgres when the cache is down, leave Redis out of readiness too and degrade gracefully.
:::

### Clean up

```bash
kubectl delete deploy api redis
kubectl delete svc redis
```

## Lab 3: Zero-downtime rollouts: measure, then fix

:::meta
difficulty: medium
time: 35 min
:::

Goal: put constant load on a service, run rollouts, and count failed requests. First with a naive app that exits immediately on SIGTERM, then with proper graceful shutdown.

### Steps

1. Deploy the naive version (requests take 300 ms, so there are always requests in flight):

```bash
cat <<'EOF' > /tmp/shop.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop
spec:
  replicas: 3
  selector:
    matchLabels: { app: shop }
  template:
    metadata:
      labels: { app: shop }
    spec:
      containers:
        - name: app
          image: node:22-alpine
          command: ["node", "/app/server.js"]
          env:
            - { name: LATENCY_MS, value: "300" }
            - { name: GRACEFUL, value: "false" }
          ports:
            - name: http
              containerPort: 3000
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 2
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
          volumeMounts:
            - name: code
              mountPath: /app
      volumes:
        - name: code
          configMap:
            name: probe-app
---
apiVersion: v1
kind: Service
metadata:
  name: shop
spec:
  selector: { app: shop }
  ports:
    - port: 80
      targetPort: http
EOF
kubectl apply -f /tmp/shop.yaml
kubectl rollout status deploy/shop
```

2. Start 90 seconds of load in the cluster:

```bash
cat <<'EOF' > /tmp/k6-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: k6-shop
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: grafana/k6
          args: ["run", "/scripts/load.js"]
          env:
            - { name: TARGET, value: "http://shop/" }
            - { name: VUS, value: "30" }
            - { name: DURATION, value: "90s" }
          volumeMounts:
            - name: scripts
              mountPath: /scripts
      volumes:
        - name: scripts
          configMap:
            name: k6-script
EOF
kubectl apply -f /tmp/k6-job.yaml
```

3. While it runs, perform two rollouts:

```bash
sleep 15
kubectl rollout restart deploy/shop && kubectl rollout status deploy/shop
sleep 10
kubectl rollout restart deploy/shop && kubectl rollout status deploy/shop
```

4. Read the results when the Job finishes:

```bash
kubectl wait --for=condition=complete job/k6-shop --timeout=180s
kubectl logs job/k6-shop | grep -E 'http_req_failed|http_reqs|WARN' | head -20
```

### Verify

With the naive app, `http_req_failed` is above 0% (typically dozens of failures, with warnings such as `EOF` or `connection reset by peer`). Each pod that exits drops every request in flight.

Now make the same two rollouts produce **0 failed requests**. Requirements: keep `LATENCY_MS=300` and the rollout method; change only the Deployment.

:::hint
You need three things: the app must drain on SIGTERM (this app does that when `GRACEFUL=true`), SIGTERM should arrive only after routing has moved away from the pod (`lifecycle.preStop`), and the rollout should never reduce available capacity (`maxUnavailable`). Check that `terminationGracePeriodSeconds` covers preStop plus draining.
:::

:::solution
```bash
kubectl patch deploy shop --type=strategic -p '
spec:
  minReadySeconds: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      terminationGracePeriodSeconds: 40
      containers:
        - name: app
          env:
            - { name: LATENCY_MS, value: "300" }
            - { name: GRACEFUL, value: "true" }
          lifecycle:
            preStop:
              sleep:
                seconds: 5
'
kubectl rollout status deploy/shop
kubectl delete job k6-shop
kubectl apply -f /tmp/k6-job.yaml
sleep 15
kubectl rollout restart deploy/shop && kubectl rollout status deploy/shop
sleep 10
kubectl rollout restart deploy/shop && kubectl rollout status deploy/shop
kubectl wait --for=condition=complete job/k6-shop --timeout=180s
kubectl logs job/k6-shop | grep -E 'http_req_failed|http_reqs'
```

`http_req_failed` should now be `0.00%`. What each piece does:

1. **preStop sleep 5 s**: the pod is already removed from EndpointSlices when it starts terminating, but kube-proxy needs a moment to update. During the sleep the pod keeps serving whatever still reaches it.
2. **Graceful SIGTERM handling** (`GRACEFUL=true`): readiness turns 503, every response carries `Connection: close` so keep-alive clients reconnect through the Service to other pods, and after 2 s `server.close()` waits for in-flight requests before exiting.
3. **`maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds: 3`**: a new pod must be Ready (and stay Ready 3 s) before an old one is terminated, so capacity never drops.
4. **`terminationGracePeriodSeconds: 40`** comfortably covers 5 s preStop + 2 s + 300 ms requests, so SIGKILL never fires.

If you have the native preStop `sleep` action unavailable (very old clusters), use `exec: {command: ["sleep", "5"]}`; `node:22-alpine` includes `sleep`.
:::

### Clean up

```bash
kubectl delete job k6-shop
kubectl delete -f /tmp/shop.yaml
```

## Lab 4: HPA on CPU under real load

:::meta
difficulty: medium
time: 35 min
:::

Goal: autoscale a CPU-bound service with an HPA v2, drive it with k6, watch it scale out, then tune `behavior` so scale-down happens faster for the lab.

### Steps

1. Deploy a CPU-heavy service (20 ms of CPU per request) with a small CPU request:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cpu-api
spec:
  selector:
    matchLabels: { app: cpu-api }
  template:
    metadata:
      labels: { app: cpu-api }
    spec:
      containers:
        - name: app
          image: node:22-alpine
          command: ["node", "/app/server.js"]
          env:
            - { name: WORK_MS, value: "20" }
          ports:
            - name: http
              containerPort: 3000
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
          resources:
            requests: { cpu: 100m, memory: 64Mi }
            limits: { memory: 128Mi }
          volumeMounts:
            - name: code
              mountPath: /app
      volumes:
        - name: code
          configMap:
            name: probe-app
---
apiVersion: v1
kind: Service
metadata:
  name: cpu-api
spec:
  selector: { app: cpu-api }
  ports:
    - port: 80
      targetPort: http
EOF
kubectl rollout status deploy/cpu-api
```

Note the Deployment has no `replicas` field: the HPA will own it.

2. Create the HPA:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cpu-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cpu-api
  minReplicas: 1
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50
EOF
sleep 30
kubectl get hpa cpu-api
```

3. In a second terminal, watch: `kubectl get hpa cpu-api -w`. In a third (optional): `watch -n 5 kubectl top pods -l app=cpu-api` (`brew install watch`).

4. Start 4 minutes of load:

```bash
sed -e 's/k6-shop/k6-cpu/' -e 's#http://shop/#http://cpu-api/#' \
  -e 's/value: "30"/value: "10"/' -e 's/value: "90s"/value: "4m"/' /tmp/k6-job.yaml | kubectl apply -f -
```

5. During the test, read the HPA's reasoning:

```bash
kubectl describe hpa cpu-api | sed -n '/Metrics:/,$p'
```

6. After the load ends, time how long the scale-down takes. Then make it faster with a `behavior` block:

```bash
kubectl patch hpa cpu-api --type=merge -p '
spec:
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 50
          periodSeconds: 15
'
```

Run the load again (delete the Job and re-apply it with step 4) and compare.

### Verify

- Before load, `TARGETS` shows a low percentage of the 50% target (not `<unknown>`).
- Under load, replicas climb (often to the max of 8) within a minute or two; `describe` shows events like `New size: 4; reason: cpu resource utilization (percentage of request) above target`.
- After the first test, replicas return to 1 only after about 5 minutes (default scale-down stabilization). With the patched behavior, they drop within about a minute.

:::hint
`<unknown>` targets mean the HPA cannot read metrics: check that metrics-server works (`kubectl top pods`) and that the container has a CPU request. If the k6 Job fails to start, check `kubectl logs job/k6-cpu`.
:::

:::solution
The steps are the solution. Why it scales so far: each request burns 20 ms of CPU, so one pod saturating a full core serves about 50 req/s, but its request is only 100m. The target of 50% means 50m average usage per pod, so the HPA keeps adding pods until load per pod falls, or until `maxReplicas`. On a single kind node all pods share the VM's CPUs, so total throughput eventually plateaus; on a real cluster the extra pods would trigger node autoscaling.

What to take away:

- Utilization is a percentage of the **request**. Changing the request changes scaling behaviour without changing the HPA.
- Scale-up is fast by default; scale-down waits for a 5-minute stabilization window. In production, a conservative scale-down is usually what you want.
- `kubectl describe hpa` explains every decision; read it before tuning.
:::

### Clean up

```bash
kubectl delete job k6-cpu --ignore-not-found
kubectl delete hpa cpu-api
kubectl delete deploy cpu-api
kubectl delete svc cpu-api
```

## Lab 5: Challenge: queue workers that scale to zero with KEDA

:::meta
difficulty: hard
time: 45 min
:::

Goal: install KEDA and scale a Redis-backed worker from **0** to many replicas based on queue length, then back to 0 when the queue is empty. This is the pattern for BullMQ/Redis or SQS workers in a Node backend.

### Requirements

1. Install KEDA with Helm into namespace `keda` (chart repo `https://kedacore.github.io/charts`).
2. Run Redis (`redis:7-alpine`) as Deployment + Service `redis` in `default`.
3. A Deployment `worker` that loops forever: `BLPOP jobs` from Redis, "processes" each item for 2 seconds, and logs it. You can use the `redis:7-alpine` image and `redis-cli` in a shell loop.
4. A `ScaledObject` for `worker` with the `redis` trigger on list `jobs`: target 5 items per replica, `minReplicaCount: 0`, `maxReplicaCount: 10`, a short polling interval and a cooldown of about 30 seconds.
5. Push 100 items into `jobs`. Show replicas scaling up, the list draining, and the worker returning to 0 replicas.
6. Show the HPA that KEDA created and explain who handles 0 to 1 and who handles 1 to N.

### Verify

- With an empty queue, `kubectl get deploy worker` shows `0/0`.
- After pushing 100 items, `worker` scales up (towards 10), `redis-cli LLEN jobs` decreases to 0, and within about a minute after that `worker` is back to `0/0`.
- `kubectl get hpa` lists `keda-hpa-worker`.

:::hint
Find the current KEDA install command on keda.sh (Deploying KEDA > Helm). The worker loop can be: `while true; do item=$(redis-cli -h redis BLPOP jobs 0 | tail -1); echo "processing $item"; sleep 2; done`. Push items with `kubectl exec deploy/redis -- sh -c 'for i in $(seq 1 100); do redis-cli RPUSH jobs job-$i >/dev/null; done'`. `kubectl get scaledobject` shows `READY` and `ACTIVE` columns.
:::

:::solution
```bash
# 1. KEDA
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm install keda kedacore/keda --namespace keda --create-namespace
kubectl -n keda rollout status deploy/keda-operator
kubectl get apiservice v1beta1.external.metrics.k8s.io

# 2-4. Redis, worker and ScaledObject
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  selector:
    matchLabels: { app: redis }
  template:
    metadata:
      labels: { app: redis }
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: redis
spec:
  selector: { app: redis }
  ports:
    - port: 6379
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  replicas: 0
  selector:
    matchLabels: { app: worker }
  template:
    metadata:
      labels: { app: worker }
    spec:
      terminationGracePeriodSeconds: 10
      containers:
        - name: worker
          image: redis:7-alpine
          command:
            - sh
            - -c
            - |
              while true; do
                item=$(redis-cli -h redis BLPOP jobs 0 | tail -1)
                echo "$(hostname) processing $item"
                sleep 2
              done
          resources:
            requests: { cpu: 20m, memory: 16Mi }
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 0
  maxReplicaCount: 10
  pollingInterval: 5
  cooldownPeriod: 30
  triggers:
    - type: redis
      metadata:
        address: redis.default.svc.cluster.local:6379
        listName: jobs
        listLength: "5"
EOF
kubectl rollout status deploy/redis
kubectl get scaledobject worker
kubectl get deploy worker            # 0/0

# 5. Push work and watch (second terminal: kubectl get deploy worker -w)
kubectl exec deploy/redis -- sh -c 'for i in $(seq 1 100); do redis-cli RPUSH jobs job-$i >/dev/null; done'
for i in $(seq 1 12); do
  echo "$(date +%T) queue=$(kubectl exec deploy/redis -- redis-cli LLEN jobs) replicas=$(kubectl get deploy worker -o jsonpath='{.status.replicas}')"
  sleep 10
done
kubectl logs -l app=worker --tail=3 --prefix

# 6. The HPA KEDA manages
kubectl get hpa
kubectl describe hpa keda-hpa-worker | sed -n '/Metrics:/,/Events:/p'
```

Explanation for requirement 6: the HPA cannot scale from or to zero on its own (its minimum is 1 in normal operation). KEDA's operator **activates** the Deployment (0 to 1) when the trigger reports work, and scales it back to 0 after `cooldownPeriod` with no activity. Between 1 and N, the HPA that KEDA created (`keda-hpa-worker`) does the scaling, using the queue length that KEDA's metrics server exposes through the external metrics API: desired replicas = ceil(list length / 5), capped at 10.

Production notes: in a real BullMQ setup you would scale on the waiting-jobs list and handle SIGTERM in the worker so a job in progress finishes (or is returned to the queue) before the pod exits, with `terminationGracePeriodSeconds` longer than your longest job. For SQS use the `aws-sqs-queue` scaler with a `TriggerAuthentication` based on IRSA or EKS Pod Identity.
:::

### Clean up

```bash
kind delete cluster --name scale-lab
rm -f /tmp/probe-app.js /tmp/load.js /tmp/shop.yaml /tmp/k6-job.yaml
```
