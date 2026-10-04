Most Kubernetes incidents are not exotic. A typo in an image tag, a missing Secret key, a selector that does not match, a memory limit that is too low, a probe pointing at the wrong port. What separates a senior engineer is not knowing more obscure commands but having a **systematic flow** that finds the cause in minutes, and an **observability stack** that tells you something is wrong before users do.

## The troubleshooting flow

Work from the outside in, and let each step tell you where to look next:

```text
1. get        kubectl get pods,deploy,rs,svc -n ns -o wide        what state is everything in?
   │
2. describe   kubectl describe pod <pod>                           conditions, container states, last state,
   │                                                               exit codes, probe config, EVENTS at the bottom
3. events     kubectl events -n ns --for pod/<pod>                 scheduler, kubelet, controllers explain themselves
   │          kubectl get events -n ns --sort-by=.lastTimestamp
4. logs       kubectl logs <pod> [-c container] [--previous]       what the app said before dying
   │
5. exec/debug kubectl exec -it <pod> -- sh                         look from inside: env, files, DNS, connectivity
              kubectl debug ...                                    when there is no shell, or the pod will not start
```

Rules of thumb:

- **If there is no pod, look one level up.** Deployment → ReplicaSet → Pod. Quota violations, Pod Security rejections and admission webhook denials appear as events on the **ReplicaSet** (or StatefulSet/Job), because the controller's create call failed.
- **Pending is the scheduler's problem; Waiting is the kubelet's; Running-but-broken is the app's.** Each has a different place to look.
- **`--previous` is essential for crash loops.** `kubectl logs` shows the current container, which may have just started and printed nothing. The crash reason is in the previous instance.
- **Events expire** (one hour by default). For older incidents you need your logging/monitoring stack.

:::tip Useful one-liners
```bash
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded   # everything unhealthy
kubectl get pods -A | grep -vE 'Running|Completed'                                   # quick and dirty
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[*].lastState.terminated}'; echo
kubectl logs deploy/shipit-api --all-containers --since=15m
kubectl logs -l app=shipit-api --prefix --tail=20         # across replicas
kubectl get events -A --field-selector type=Warning
```
For tailing many pods at once, `stern` (`brew install stern`) and k9s's log view are excellent.
:::

## Pod statuses and what they mean

The `STATUS` column of `kubectl get pods` is a summary computed by kubectl from the pod phase and container states. Learn to translate it:

| Status | Stage | Usual causes | Where to look |
| --- | --- | --- | --- |
| `Pending` | Scheduling | Insufficient CPU/memory for the **requests**; nodeSelector/affinity matches no node; untainted nodes missing (taints); PVC not bound; too many pods per node | `describe pod` events: `FailedScheduling: 0/3 nodes are available: 3 Insufficient cpu` |
| `ContainerCreating` (stuck) | Kubelet setup | Volume cannot mount (PVC in other AZ, missing ConfigMap/Secret volume), CNI failure, image still pulling (large image) | `describe pod` events: `FailedMount`, `FailedCreatePodSandBox` |
| `ErrImagePull` → `ImagePullBackOff` | Image pull | Typo in name/tag, tag does not exist, private registry without `imagePullSecrets`, wrong architecture (no arm64 variant), rate limits | `describe pod`: `Failed to pull image ... not found` / `unauthorized` / `no match for platform` |
| `CreateContainerConfigError` | Container config | Referenced ConfigMap/Secret or **key** missing; `runAsNonRoot` with root or non-numeric user | `describe pod`: `secret "x" not found`, `couldn't find key DB_PASSWORD` |
| `CreateContainerError` / `RunContainerError` | Container start | Command/entrypoint not found in image, invalid mount, read-only filesystem conflicts | `describe pod` message |
| `CrashLoopBackOff` | Running, repeatedly | App exits (bad config, cannot reach DB and exits, uncaught exception), liveness probe kills it, OOMKilled repeatedly | `logs --previous`, `describe pod` → Last State, exit code, probe events |
| `OOMKilled` (in Last State) | Running | Container exceeded its memory **limit**; kernel killed it (exit code 137) | `describe pod` Last State `Reason: OOMKilled`; metrics for memory trend |
| `Error` / `Completed` | Terminated | Process exited non-zero / zero (normal for Jobs) | `logs` |
| `Evicted` | Node pressure | Node ran low on memory/disk/ephemeral storage; kubelet evicted pods, or pod exceeded its ephemeral-storage limit | `describe pod` message, `describe node` conditions |
| `Terminating` (stuck) | Deletion | Finalizers not removed, app ignores SIGTERM with long grace period, node unreachable | `get -o yaml` → `metadata.finalizers`, `deletionTimestamp` |
| `Unknown` / `NodeLost` | Node | Node stopped reporting (network partition, crashed kubelet) | `kubectl get nodes`, `describe node` |
| `Init:CrashLoopBackOff`, `Init:0/2` | Init containers | An init container fails or waits forever (e.g. "wait for DB") | `logs <pod> -c <init-container>` |

### Exit codes worth memorising

| Code | Meaning |
| --- | --- |
| 0 | Normal exit (bad for a long-running server: something made it stop) |
| 1 | Application error (Node.js uncaught exception exits 1) |
| 126 / 127 | Command not executable / not found |
| 137 | Killed by SIGKILL (128+9): OOM killer, or kubelet after grace period |
| 139 | Segmentation fault (128+11) |
| 143 | Terminated by SIGTERM (128+15): normal graceful stop |

### CrashLoopBackOff, carefully

CrashLoopBackOff is not a cause, it is a symptom: the container keeps exiting and the kubelet waits longer between restarts (10s, 20s, 40s... capped at 5 minutes). Decision tree:

```text
CrashLoopBackOff
 ├─ Last State: OOMKilled (137)       → memory limit too low or a leak; check usage, raise limit, fix leak
 ├─ Events: "Liveness probe failed"    → the app is alive but the probe is wrong (path, port, too short
 │                                      initialDelay / no startupProbe for slow boots)
 ├─ exit 1 + logs show an error        → app config: missing env var, bad DATABASE_URL, migrations, code bug
 ├─ exit 0                             → the process finished: wrong command, server not started in foreground
 └─ exit 127 / 126                     → command not found / not executable in the image
```

:::warning Do not make liveness depend on dependencies
If shipit-api's liveness probe calls `/readyz` (which checks Postgres and Redis), a short database blip makes the kubelet restart **every** API pod at once, turning a dependency hiccup into a full outage and a CrashLoopBackOff storm. Liveness checks only "is this process stuck?"; readiness handles "can I serve traffic now?".
:::

### OOMKilled vs Evicted

Both are about memory, but they are different mechanisms:

- **OOMKilled**: the **container** exceeded its own `limits.memory`. The kernel's cgroup OOM killer terminates it, the kubelet restarts it in the same pod. Node.js note: V8's heap limit does not automatically follow the container limit in every setup; set `--max-old-space-size` (via `NODE_OPTIONS`) to roughly 75% of the limit so Node throws a heap error you can see instead of being killed silently.
- **Evicted**: the **node** is under pressure (memory, disk, inodes, PIDs) and the kubelet removes pods to protect itself, starting with pods using more than their requests (BestEffort, then Burstable). Evicted pods stay in `Failed` state for inspection; their controller creates replacements. A pod exceeding its `ephemeral-storage` limit is also evicted.

### Stuck in Terminating

Deleting an object sets `metadata.deletionTimestamp`. The object disappears only when its `metadata.finalizers` list is empty. Controllers add finalizers to run cleanup first (delete a cloud load balancer, detach a volume, remove a PVC only when no pod uses it).

```bash
kubectl get pod web-0 -o jsonpath='{.metadata.deletionTimestamp} {.metadata.finalizers}'; echo
kubectl get ns stuck -o jsonpath='{.status.conditions}' | jq .      # which resources/finalizers block a namespace
```

Causes and fixes:

1. **Finalizer whose controller is gone** (you uninstalled an operator before deleting its custom resources). Best fix: reinstall the controller so it can finish cleanup. Last resort: remove the finalizer with `kubectl patch <obj> --type=merge -p '{"metadata":{"finalizers":null}}'`, accepting that the external cleanup will not happen (orphaned load balancers, volumes).
2. **Pod ignores SIGTERM** and has a long `terminationGracePeriodSeconds`. The kubelet waits the full period, then SIGKILLs. Fix the app (handle SIGTERM; in Node.js `process.on("SIGTERM", ...)`, and make sure your process is PID 1 or uses an init like `tini` so signals arrive).
3. **Node is unreachable**: the API cannot confirm the container stopped. `kubectl delete pod --grace-period=0 --force` removes the object from the API, but the container may still run on the partitioned node. For StatefulSets this can mean two pods with the same identity writing to the same volume. Only force-delete when you know the node is really gone.

## Service not reachable: the checklist

"I can't reach my service" has a small number of causes. Walk the path packets take:

```text
client ─► DNS name ─► Service (ClusterIP:port) ─► EndpointSlice (ready pod IPs) ─► targetPort on pod ─► app listening?
           │               │                          │                               │                    │
         1 resolves?     2 exists, right port?      3 any endpoints?               4 port matches        5 bound to 0.0.0.0?
                                                      selector matches labels?       containerPort/name?
                                                      pods READY?                  6 NetworkPolicy allows?
```

```bash
# 1. DNS from a pod in the same namespace as the client
kubectl run dns --rm -it --restart=Never --image=busybox:1.36 -- nslookup shipit-api.shipit.svc.cluster.local

# 2-3. Service and its endpoints
kubectl -n shipit get svc shipit-api -o wide
kubectl -n shipit get endpointslices -l kubernetes.io/service-name=shipit-api
kubectl -n shipit get pods -l app.kubernetes.io/name=shipit-api --show-labels    # compare to svc selector

# 4-5. Bypass the Service: hit a pod IP directly
kubectl -n shipit get pod -o wide
kubectl run curl --rm -it --restart=Never --image=curlimages/curl -- curl -sv http://<pod-ip>:3000/healthz

# 6. Policies
kubectl -n shipit get networkpolicy
```

Interpretation:

- **No endpoints** → selector does not match pod labels, or pods are not **ready** (readiness probe failing). This is the most common cause.
- **Endpoints exist, pod IP works, Service does not** → Service `port`/`targetPort` mismatch (e.g. `targetPort: 80` while the app listens on 3000).
- **Pod IP does not work either** → app not listening on that port, or listening on `127.0.0.1` only (common with dev servers: Node's `server.listen(3000, "localhost")`), or a NetworkPolicy blocks you.
- **Works in-cluster, not from outside** → the problem is the Gateway/HTTPRoute (module 06): check route `status.parents` conditions, `Accepted` and `ResolvedRefs`, hostnames, and the Gateway's listener.

:::try Read the endpoints
On any cluster with a Deployment and Service, run `kubectl get endpointslices -l kubernetes.io/service-name=<svc> -o yaml` and find `conditions.ready` for each endpoint. Then break the readiness probe (`kubectl patch` it to a wrong path) and watch the endpoint flip to `ready: false` while the pod stays `Running`.
:::

## kubectl debug

`kubectl exec` requires a running container with a shell. Modern images (distroless, scratch, Chainguard) often have neither, and a crashing container cannot be exec'd into. `kubectl debug` covers three situations.

### 1. Ephemeral container in a running pod

```bash
kubectl debug -it pod/shipit-api-7d9f -c debugger --image=busybox:1.36 --target=api
```

This adds a temporary container to the existing pod (no restart). It shares the pod's network namespace (same IP, `localhost` reaches the app) and, with `--target`, the target container's **process namespace**, so `ps` shows the app's processes and `/proc/<pid>/root` exposes its filesystem. Ephemeral containers cannot be removed; they stay in the pod spec (stopped) until the pod is replaced.

Images for debugging: `busybox` (tiny), `nicolaka/netshoot` (dig, tcpdump, curl, iperf, ss: the network Swiss Army knife), `curlimages/curl`.

:::warning Debugging in hardened namespaces
In a namespace that enforces Pod Security `restricted`, ephemeral containers are checked too, and the default debug container (root, privilege escalation allowed) is rejected. Use `--profile=restricted` (or `general`, `baseline`, `netadmin`, `sysadmin` where permitted). `netadmin` adds `NET_ADMIN`/`NET_RAW` for tcpdump, which `restricted` namespaces will not allow.
:::

### 2. Copy of a pod with changes

When a pod crashes on start, debug a **copy** whose command or image you change:

```bash
# same pod, but start a shell instead of the crashing command
kubectl debug pod/shipit-api-7d9f -it --copy-to=api-debug --container=api -- sh

# same pod, but swap the image for one with tools
kubectl debug pod/shipit-api-7d9f -it --copy-to=api-debug --set-image=api=node:22-alpine -- sh

# same pod plus a debug container sharing processes
kubectl debug pod/shipit-api-7d9f -it --copy-to=api-debug --image=busybox:1.36 --share-processes
```

The copy has the same env, volumes and ServiceAccount, so you can reproduce startup (`node dist/index.js`) by hand and see the error. Copies are not managed by the ReplicaSet (labels are not copied by default unless you ask), so they do not receive Service traffic. Delete them when done.

### 3. Node debugging

```bash
kubectl debug node/kind-worker -it --image=busybox:1.36
# inside: the node's root filesystem is mounted at /host
chroot /host            # now you are "on" the node (if it has a shell)
crictl ps               # containers seen by containerd (available on kind nodes)
journalctl -u kubelet   # kubelet logs (systemd-based nodes)
```

This creates a pod with `hostPID`, `hostNetwork` and the host filesystem mounted: effectively root on the node, so RBAC should restrict who can do it. On kind you can also simply `docker exec -it kind-worker bash`, because nodes are containers.

:::try Debug a shell-less container
Run `kubectl run echo --image=hashicorp/http-echo:1.0 -- -text=hi` and try `kubectl exec -it echo -- sh` (fails: the image is built from scratch). Now `kubectl debug -it echo --image=busybox:1.36 --target=echo -- sh`, then inside run `ps` (you see `/http-echo`) and `wget -qO- localhost:5678`. Finally `kubectl get pod echo -o jsonpath='{.spec.ephemeralContainers[*].name}'` shows the debugger stays recorded in the pod.
:::

:::mac kind nodes share your Docker VM
On a Mac, every kind node is a container inside the Docker Desktop (or OrbStack/Colima) Linux VM. If pods go `Pending` with `Insufficient memory` or get `Evicted` with `MemoryPressure`, the limit is often the VM's memory setting, not Kubernetes. Check `docker info | grep -i memory` and raise it in Docker Desktop → Settings → Resources. Monitoring stacks like kube-prometheus-stack want at least 4–6 GB for the VM.
:::

## Metrics

Two different pipelines, often confused:

```text
Resource metrics (built-in path)                Full monitoring (Prometheus)
───────────────────────────────                 ────────────────────────────
kubelet/cAdvisor ─► metrics-server ─► Metrics API      exporters/apps ─► Prometheus scrapes /metrics every 15–30s
                    (in memory, latest value)          ─► TSDB (history) ─► PromQL ─► Grafana dashboards
  used by: kubectl top, HPA, VPA                          └► alert rules ─► Alertmanager ─► Slack/PagerDuty
```

- **metrics-server** keeps only the latest CPU/memory values. It powers `kubectl top` and the HPA (module 10), nothing else. On kind it needs `--kubelet-insecure-tls` because kubelet serving certs are self-signed.
- **Prometheus** scrapes HTTP `/metrics` endpoints, stores time series with labels, and evaluates queries and alert rules.

### kube-prometheus-stack

The standard way to get Prometheus on Kubernetes is the `kube-prometheus-stack` Helm chart (prometheus-community). It installs:

| Component | Role |
| --- | --- |
| Prometheus Operator | Manages Prometheus/Alertmanager from CRDs |
| Prometheus | Scrapes and stores metrics, evaluates rules |
| Alertmanager | Deduplicates, groups, routes and silences alerts |
| Grafana | Dashboards (many preinstalled for cluster, nodes, workloads) |
| kube-state-metrics | Turns object state into metrics (`kube_pod_container_status_restarts_total`, `kube_deployment_status_replicas_available`) |
| node-exporter | Node-level CPU, memory, disk, network |
| Default rules | Dozens of alerts like `KubePodCrashLooping`, `KubePodNotReady`, `KubeDeploymentReplicasMismatch` |

The Operator introduces CRDs you will use constantly:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor               # "scrape the pods behind this Service"
metadata:
  name: shipit-api
  namespace: shipit
  labels:
    release: kps                   # must match the Prometheus' serviceMonitorSelector (by default: the Helm release label)
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: shipit-api
  endpoints:
    - port: http                   # Service port NAME
      path: /metrics
      interval: 30s
```

`PodMonitor` scrapes pods without a Service; `PrometheusRule` holds alerting and recording rules. For your Node.js API, the `prom-client` library exposes default process metrics (event loop lag, heap, GC) and lets you add HTTP request counters and histograms.

### PromQL you should be able to write

```text
# Request rate per pod (RED: Rate)
sum by (pod) (rate(http_requests_total{namespace="shipit"}[5m]))

# Error ratio (RED: Errors)
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))

# p95 latency from a histogram (RED: Duration)
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# Container memory vs limit (USE: Utilisation/Saturation)
sum by (pod) (container_memory_working_set_bytes{namespace="shipit", container!=""})
  / sum by (pod) (kube_pod_container_resource_limits{namespace="shipit", resource="memory"})

# CPU throttling: a classic hidden latency source
rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])

# Restarts in the last hour
increase(kube_pod_container_status_restarts_total[1h]) > 0
```

**RED** (Rate, Errors, Duration) describes services; **USE** (Utilisation, Saturation, Errors) describes resources (nodes, disks, pools). Dashboards per service usually start with RED plus saturation of its main resources.

:::deep Why container_memory_working_set_bytes, and what about CPU limits?
cAdvisor reports several memory figures. `container_memory_usage_bytes` includes page cache that the kernel can reclaim, so it overstates pressure. `working_set_bytes` (usage minus inactive file cache) is what the kubelet uses for eviction decisions and what is closest to the OOM killer's view, so alert on it relative to the limit. For CPU, a limit is enforced by CFS quota in 100 ms periods: a Node.js process that bursts (GC, JSON parsing) can be throttled even when average usage looks low, adding latency spikes. That is why many teams set CPU requests but no CPU limits for latency-sensitive services, and watch the throttling ratio above when they do set them.
:::

## Logging

The Kubernetes logging contract is simple: **write to stdout/stderr**. The container runtime writes those streams to files on the node (`/var/log/pods/...`), the kubelet rotates them, and `kubectl logs` reads them. Consequences:

- Logs are lost when the pod is deleted or the node goes away, and rotation limits how far back you can see. You need aggregation for anything older than "just now".
- Do not write log files inside the container (they fill ephemeral storage and get the pod evicted), and do not ship logs from the app directly to a vendor over the network if a node agent can do it.
- Use **structured JSON logs** (pino in Node.js/NestJS) with a request ID and trace ID, so you can filter and correlate.

The usual architecture is a **node-level agent** as a DaemonSet that tails `/var/log/pods`, adds Kubernetes metadata (namespace, pod, labels) and ships to a backend:

```text
pods ─stdout─► /var/log/pods/* ─► DaemonSet agent ──────────► backend
                                  Fluent Bit, Grafana Alloy,   Loki (labels + cheap object storage),
                                  Vector, OTel Collector       Elasticsearch/OpenSearch, CloudWatch Logs,
                                                               Datadog...
```

**Loki** indexes only labels (namespace, app, pod), not the full text, and stores chunks in object storage, which makes it cheap; you query with LogQL (`{namespace="shipit", app="shipit-api"} |= "error" | json | status >= 500`) inside Grafana. Grafana's former agent Promtail has been deprecated in favour of **Grafana Alloy**; Fluent Bit is the most common vendor-neutral agent. On EKS, Fluent Bit to CloudWatch Logs is a frequent default.

## Tracing and OpenTelemetry

Metrics tell you *that* latency went up, logs tell you *what* a single component did, **traces** tell you *where* time went across services: a trace is a tree of spans (gateway → shipit-api → Postgres query → Redis get).

**OpenTelemetry (OTel)** is the CNCF standard for all three signals: vendor-neutral SDKs, a wire protocol (OTLP) and the **Collector**.

```text
shipit-api (OTel Node SDK, auto-instrumentation for http, express, pg, redis)
     │ OTLP (gRPC 4317 / HTTP 4318)
     ▼
OTel Collector (DaemonSet or Deployment): receive → process (batch, k8sattributes, sampling) → export
     │                      │                         │
     ▼                      ▼                         ▼
 Tempo / Jaeger         Prometheus               Loki / vendor
 (traces)               (metrics)                (logs)
```

For Node.js, `@opentelemetry/sdk-node` with `@opentelemetry/auto-instrumentations-node` instruments Express, `pg` and `redis` with almost no code. The OpenTelemetry Operator can even inject the instrumentation into pods via an annotation. Put the trace ID into your log lines and Grafana can jump from a log line to its trace.

## Alerting basics

Alerts wake people up, so each one must be worth it.

- **Alert on symptoms users feel**, not on every cause: high error rate, high latency, SLO burn rate, "no ready replicas". A node at 85% CPU is not an incident; checkout returning 5xx is.
- Use `for:` to avoid flapping on brief spikes, and severities (`critical` pages someone, `warning` creates a ticket).
- Every alert links to a **runbook**: what it means, how to check, how to mitigate.
- Alertmanager **groups** related alerts into one notification, **inhibits** child alerts when a parent fires (cluster down → do not also page for every pod), and supports **silences** during maintenance.
- Start with the defaults from kube-prometheus-stack, then add a few service-level alerts per app.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: shipit-api
  namespace: shipit
  labels:
    release: kps
spec:
  groups:
    - name: shipit-api
      rules:
        - alert: ShipitApiHighErrorRate
          expr: |
            sum(rate(http_requests_total{namespace="shipit",status=~"5.."}[5m]))
              / sum(rate(http_requests_total{namespace="shipit"}[5m])) > 0.05
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "shipit-api 5xx ratio above 5% for 10 minutes"
            runbook_url: "https://runbooks.example.com/shipit-api/high-error-rate"
```

## Pitfalls and good habits

- Read the **events** before guessing. Most answers are written there in plain English.
- Look **up** the ownership chain when pods are missing, **down** into containers (`--previous`, Last State, exit code) when they crash.
- Keep `kubectl get endpointslices` in muscle memory for networking issues.
- Never "fix" a CrashLoopBackOff by deleting the pod: the new one will crash the same way, and you lose the previous logs.
- Do not force-delete StatefulSet pods on an unreachable node unless you are sure the node is dead.
- Install metrics-server everywhere; install a real monitoring and logging stack before you need it, not during the incident.
- Instrument your own services (prom-client, OTel). Cluster dashboards cannot tell you that one endpoint got slow.
