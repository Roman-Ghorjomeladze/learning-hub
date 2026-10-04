These labs are mostly **break & fix**: you apply broken manifests and diagnose them with the flow from the lesson (get → describe → events → logs → exec/debug). Resist reading the manifests for the answer first; practise reading the cluster instead.

```bash
cat > kind-obs.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
EOF
kind create cluster --name obs --config kind-obs.yaml
mkdir -p ~/k8s-obs && cd ~/k8s-obs
```

Lab 5 installs a monitoring stack: give Docker Desktop at least 6 GB of memory for it. When finished: `kind delete cluster --name obs`.

## Lab 1: Triage drill — six broken pods

:::meta
difficulty: medium
time: 40 min
:::

**Goal:** six pods are broken in six different ways. For each, name the status, find the evidence that proves the cause (quote the event, log line or field), and fix it.

### Steps

1. Apply the broken workload:

```bash
kubectl create namespace triage
cat > triage.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: web, namespace: triage }
spec:
  containers:
    - name: web
      image: nginx:1.277
---
apiVersion: v1
kind: Pod
metadata: { name: worker, namespace: triage }
spec:
  containers:
    - name: worker
      image: busybox:1.36
      command: ["sh", "-c", "echo 'loading /etc/worker/config.yaml'; test -f /etc/worker/config.yaml || { echo 'FATAL: config file missing'; exit 1; }; sleep 3600"]
---
apiVersion: v1
kind: Secret
metadata: { name: api-secrets, namespace: triage }
stringData:
  db-password: s3cret
---
apiVersion: v1
kind: Pod
metadata: { name: api, namespace: triage }
spec:
  containers:
    - name: api
      image: hashicorp/http-echo:1.0
      args: ["-text=api"]
      env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef: { name: api-secrets, key: DB_PASSWORD }
---
apiVersion: v1
kind: Pod
metadata: { name: report, namespace: triage }
spec:
  containers:
    - name: report
      image: busybox:1.36
      command: ["sleep", "3600"]
      resources:
        requests: { cpu: "64", memory: 64Mi }
---
apiVersion: v1
kind: Pod
metadata: { name: cache-warmer, namespace: triage }
spec:
  containers:
    - name: warmer
      image: python:3.13-alpine
      command: ["python", "-c", "import time; data = 'x' * (200 * 1024 * 1024); print('warmed', flush=True); time.sleep(3600)"]
      resources:
        requests: { memory: 64Mi }
        limits: { memory: 64Mi }
---
apiVersion: v1
kind: Pod
metadata: { name: frontend, namespace: triage }
spec:
  containers:
    - name: nginx
      image: nginxinc/nginx-unprivileged:1.27-alpine
      livenessProbe:
        httpGet: { path: /, port: 80 }
        initialDelaySeconds: 2
        periodSeconds: 3
        failureThreshold: 2
EOF
kubectl apply -f triage.yaml
```

2. Wait two minutes, then start triage:

```bash
kubectl -n triage get pods -o wide
kubectl -n triage get events --sort-by=.lastTimestamp | tail -30
```

3. For each pod, fill in this table in your notes, then fix the manifest and re-apply (pods are mostly immutable: `kubectl delete -f triage.yaml` and apply the fixed file, or delete/recreate single pods):

| Pod | Status | Evidence | Fix |
| --- | --- | --- | --- |
| web | | | |
| worker | | | |
| api | | | |
| report | | | |
| cache-warmer | | | |
| frontend | | | |

### Verify

After your fixes, `kubectl -n triage get pods` shows all six `Running` with restarts no longer increasing (worker may legitimately need a config file you provide; see the solution for options).

:::hint
- `describe` → **Events** for web, api, report, frontend.
- `logs --previous` for worker.
- `describe` → **Last State** and exit code for cache-warmer.
- frontend's restarts look like a crash loop, but read the events carefully: who is killing it?
:::

:::solution
| Pod | Status | Evidence | Fix |
| --- | --- | --- | --- |
| web | `ErrImagePull` / `ImagePullBackOff` | Event: `Failed to pull image "nginx:1.277": ... not found` | Use an existing tag: `nginx:1.27` |
| worker | `CrashLoopBackOff` | `kubectl -n triage logs worker --previous` → `FATAL: config file missing`; Last State exit code 1 | Provide the file, e.g. a ConfigMap mounted at `/etc/worker` (below) |
| api | `CreateContainerConfigError` | Event: `Error: couldn't find key DB_PASSWORD in Secret triage/api-secrets` | Reference the existing key `db-password` (or rename the Secret key) |
| report | `Pending` | Event: `FailedScheduling: 0/2 nodes are available: ... Insufficient cpu` | Request a realistic amount, e.g. `cpu: 100m` |
| cache-warmer | `CrashLoopBackOff` with Last State `OOMKilled`, exit 137 | `describe` → `Last State: Terminated, Reason: OOMKilled, Exit Code: 137` | Raise the limit above the working set (e.g. `memory: 320Mi`) or reduce memory use |
| frontend | `Running` with restarts, then `CrashLoopBackOff` | Events: `Liveness probe failed: ... connect: connection refused` and `Container nginx failed liveness probe, will be restarted` | Probe the port the app listens on: `port: 8080` |

Fix for worker:

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: worker-config, namespace: triage }
data:
  config.yaml: |
    queue: emails
---
apiVersion: v1
kind: Pod
metadata: { name: worker, namespace: triage }
spec:
  containers:
    - name: worker
      image: busybox:1.36
      command: ["sh", "-c", "echo 'loading /etc/worker/config.yaml'; test -f /etc/worker/config.yaml || { echo 'FATAL: config file missing'; exit 1; }; sleep 3600"]
      volumeMounts:
        - { name: config, mountPath: /etc/worker }
  volumes:
    - name: config
      configMap: { name: worker-config }
```

Notes:

- For `frontend`, the Last State often shows `Completed` / exit code 0: the kubelet sent SIGTERM after the failed probe and nginx exited cleanly. A restart with exit 0 plus probe events means "the probe is wrong", not "the app crashed".
- For `report`, nothing in the pod's logs helps: the container never started. Pending is always answered by scheduler events.
- For `api`, the Secret exists, so a quick `kubectl get secret` looks fine. The **key** is what is missing. Use `kubectl -n triage get secret api-secrets -o jsonpath='{.data}'` to list keys.
:::

### Clean up

```bash
kubectl delete ns triage
```

## Lab 2: Break & fix — "the Service doesn't work"

:::meta
difficulty: medium
time: 30 min
:::

**Goal:** a web app in namespace `store` is unreachable from namespace `client`. There are **four** independent problems. Use the Service checklist (DNS → Service → endpoints → pod port → policy) to find them all.

### Steps

1. Apply the broken setup:

```bash
cat > store.yaml <<'EOF'
apiVersion: v1
kind: Namespace
metadata: { name: store }
---
apiVersion: v1
kind: Namespace
metadata: { name: client }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: store }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: nginx
          image: nginxinc/nginx-unprivileged:1.27-alpine
          ports:
            - { name: http, containerPort: 8080 }
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: store }
spec:
  selector: { app: webapp }
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: lockdown, namespace: store }
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
EOF
kubectl apply -f store.yaml
```

2. Reproduce the problem:

```bash
kubectl -n client run t --rm -i --restart=Never --image=curlimages/curl -- curl -sv -m 3 http://web.store
```

3. Diagnose step by step. Useful commands:

```bash
kubectl -n client run dns --rm -i --restart=Never --image=busybox:1.36 -- nslookup web.store.svc.cluster.local
kubectl -n store get svc web -o wide
kubectl -n store get endpointslices -l kubernetes.io/service-name=web -o wide
kubectl -n store get pods --show-labels -o wide
kubectl -n store describe pod -l app=web | grep -A3 -i readiness
kubectl -n store get networkpolicy
```

4. Fix each problem in `store.yaml`, re-apply, and re-run the check from step 2 after each fix to see the symptom change.

### Verify

The command from step 2 prints the nginx welcome page HTML, and `kubectl -n store get endpointslices -l kubernetes.io/service-name=web -o jsonpath='{.items[0].endpoints[*].conditions.ready}'` prints `true true`.

:::hint
DNS resolves fine, which proves the Service exists: the problem is behind it. An EndpointSlice with no endpoints means the selector matches nothing. Endpoints with `ready: false` mean the readiness probe fails: what does nginx return for `/healthz`? Once endpoints are ready, compare the Service's `targetPort` with the container port. If curling a pod IP directly from `client` times out, something blocks the traffic before it reaches nginx.
:::

:::solution
1. **Selector mismatch**: the Service selects `app: webapp`, pods are labelled `app: web`. The EndpointSlice is empty. Fix: `selector: { app: web }`.
2. **Readiness probe fails**: nginx has no `/healthz` and returns 404, so endpoints exist but are `ready: false` and receive no traffic. `describe pod` shows `Readiness probe failed: HTTP probe failed with statuscode: 404`. Fix: `path: /` (or add a health location to the nginx config).
3. **Wrong targetPort**: traffic is sent to port 80, nginx-unprivileged listens on 8080. Fix: `targetPort: http` (the named container port) or `8080`.
4. **NetworkPolicy**: `lockdown` selects all pods for Ingress with no allow rules, so everything is dropped (curl times out rather than being refused). Fix: delete it, or add an allow rule:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: lockdown, namespace: store }
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: client }
      ports:
        - { protocol: TCP, port: 8080 }
```

Note the NetworkPolicy port is the **pod** port (8080), not the Service port, because policies are evaluated on pod traffic after the Service's DNAT.

Symptom fingerprints worth remembering: "connection refused" quickly means something answered and nothing listens on that port (wrong targetPort, no endpoints in some setups); a **timeout** usually means traffic is dropped (NetworkPolicy, wrong IP, security groups in the cloud).
:::

### Clean up

```bash
kubectl delete -f store.yaml
```

## Lab 3: kubectl debug toolbox

:::meta
difficulty: medium
time: 30 min
:::

**Goal:** use all three modes of `kubectl debug`: ephemeral containers in a shell-less pod, a modified copy of a crashing pod, and a node debugging session.

### Steps

1. **Ephemeral container.** Start a scratch-based app and confirm you cannot exec into it:

```bash
kubectl create namespace dbg
kubectl -n dbg run echo --image=hashicorp/http-echo:1.0 -- -text=hello -listen=:5678
kubectl -n dbg wait --for=condition=Ready pod/echo
kubectl -n dbg exec -it echo -- sh                 # fails: no shell in the image
```

Attach a network toolbox that shares the pod's network and the app's process namespace:

```bash
kubectl -n dbg debug -it echo --image=nicolaka/netshoot --target=echo -- bash
# inside:
ps aux                     # /http-echo is visible
ss -lntp                   # what is listening, and which process
curl -s localhost:5678     # hello
dig +short kubernetes.default.svc.cluster.local
ls /proc/1/root/           # the app container's filesystem (scratch: almost empty)
exit
kubectl -n dbg get pod echo -o jsonpath='{.spec.ephemeralContainers[*].name}'; echo
```

2. **Copy a crashing pod.** This pod exits immediately:

```bash
kubectl -n dbg run crashy --image=busybox:1.36 --env=API_URL= -- sh -c '[ -n "$API_URL" ] || { echo "API_URL not set"; exit 1; }; echo "calling $API_URL"; sleep 3600'
sleep 15; kubectl -n dbg get pod crashy
kubectl -n dbg logs crashy --previous
```

Make a copy that starts a shell instead, inspect its environment, and reproduce the start command by hand:

```bash
kubectl -n dbg debug crashy -it --copy-to=crashy-debug --container=crashy -- sh
# inside:
env | grep API_URL
API_URL=http://shipit-api sh -c '[ -n "$API_URL" ] && echo "would call $API_URL"'
exit
```

3. **Node debugging.** Open a privileged session on a node:

```bash
kubectl debug node/obs-worker -it --image=busybox:1.36
# inside:
ls /host/var/log/pods | head
chroot /host /bin/bash
crictl ps | head           # containers as containerd sees them
crictl images | head
exit; exit
```

### Verify

- In step 1 `ss -lntp` shows `:5678` owned by `http-echo`.
- In step 2 the copy `crashy-debug` is `Running` (your shell), while `crashy` is in `CrashLoopBackOff`.
- In step 3 `crictl ps` lists containers including `echo`'s.

:::hint
If the ephemeral container cannot see the app's processes, check that you passed `--target=<container name>`; the container is named after the pod when created with `kubectl run`. Node debug pods are created in the current namespace and named `node-debugger-...`; they do not clean themselves up.
:::

:::solution
The commands above are the solution. Things to note:

- Ephemeral containers are recorded permanently in `spec.ephemeralContainers`; they disappear only when the pod is replaced. Use them freely in dev, carefully in prod (they are an audit-worthy action, and RBAC can restrict `pods/ephemeralcontainers`).
- The copy (`--copy-to`) has the same spec but a new name and none of the original labels' controller ownership, so it receives no Service traffic.
- The node debugger pod runs with host namespaces and mounts `/` at `/host`. On kind you could equally `docker exec -it obs-worker bash`; on a managed cluster `kubectl debug node/...` is often the only way in (or SSM on EKS).

Clean up the node debugger pod:

```bash
kubectl get pods -o name | grep node-debugger | xargs kubectl delete
```
:::

### Clean up

```bash
kubectl delete ns dbg
```

## Lab 4: Break & fix — stuck Terminating and evictions

:::meta
difficulty: medium
time: 30 min
:::

**Goal:** understand why objects hang in `Terminating`, fix each case the right way, and watch the kubelet evict a pod.

### Steps

1. **Finalizer without a controller.**

```bash
kubectl create namespace stuck
kubectl -n stuck create configmap legacy --from-literal=a=b
kubectl -n stuck patch configmap legacy --type=merge -p '{"metadata":{"finalizers":["example.com/cleanup-bucket"]}}'
kubectl -n stuck delete configmap legacy --wait=false
kubectl -n stuck get configmap legacy -o jsonpath='{.metadata.deletionTimestamp} {.metadata.finalizers}'; echo
```

The object is "being deleted" but still exists. Imagine `example.com/cleanup-bucket` belonged to an operator someone uninstalled.

2. **A namespace that will not die.** Delete the namespace while the ConfigMap still holds its finalizer:

```bash
kubectl delete namespace stuck --wait=false
kubectl get ns stuck
kubectl get ns stuck -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}'
```

Fix it properly (find what blocks it, decide, then unblock).

3. **A pod that ignores SIGTERM.**

```bash
kubectl create namespace grace
cat > stubborn.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: stubborn, namespace: grace }
spec:
  terminationGracePeriodSeconds: 120
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "trap 'echo got SIGTERM, ignoring it' TERM; while true; do sleep 1; done"]
EOF
kubectl apply -f stubborn.yaml && kubectl -n grace wait --for=condition=Ready pod/stubborn
time kubectl -n grace delete pod stubborn --wait=false; kubectl -n grace get pod stubborn
kubectl -n grace logs stubborn
```

The pod sits in `Terminating`. Explain what the kubelet is doing, and what the application should do instead.

4. **Eviction for exceeding local storage.**

```bash
cat > hog.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: disk-hog, namespace: grace }
spec:
  containers:
    - name: writer
      image: busybox:1.36
      command: ["sh", "-c", "dd if=/dev/zero of=/scratch/big bs=1M count=150; echo written; sleep 3600"]
      volumeMounts:
        - { name: scratch, mountPath: /scratch }
  volumes:
    - name: scratch
      emptyDir:
        sizeLimit: 50Mi
EOF
kubectl apply -f hog.yaml
kubectl -n grace get pod disk-hog -w        # within a minute or two: Evicted / Failed
kubectl -n grace describe pod disk-hog | grep -iE 'status|reason|message'
```

### Verify

- Namespace `stuck` is gone.
- You can explain the ~120 s delay in step 3 and how SIGKILL ended it.
- `disk-hog` shows `Status: Failed`, `Reason: Evicted` with a message about the emptyDir exceeding its limit.

:::hint
A namespace in `Terminating` lists the blocking finalizers in its conditions (`NamespaceFinalizersRemaining`, `NamespaceContentRemaining`). The kubelet's grace period is a countdown from SIGTERM to SIGKILL. The kubelet checks volume usage periodically, so the eviction is not instant.
:::

:::solution
**Steps 1–2.** The namespace conditions say something like `Some content in the namespace has finalizers remaining: example.com/cleanup-bucket in 1 resource instances`. The right first move is to restore the controller that owns the finalizer so it can do its cleanup. If that controller is gone for good and you accept skipping the cleanup, remove the finalizer:

```bash
kubectl -n stuck patch configmap legacy --type=merge -p '{"metadata":{"finalizers":null}}'
kubectl get ns stuck          # NotFound shortly after
```

Never "fix" a stuck namespace by editing the namespace's own `spec.finalizers` through the finalize API without understanding what is inside: you can leave orphaned cloud resources or resources that reappear oddly.

**Step 3.** On delete, the kubelet sends SIGTERM to PID 1 and starts the 120 s grace period. The shell's `trap` ignores it (the log shows `got SIGTERM, ignoring it`), so after 120 s the kubelet sends SIGKILL (exit 137). An application should handle SIGTERM by stopping new work, finishing in-flight requests and exiting, like shipit-api's `server.close()` handler. If you cannot wait:

```bash
kubectl -n grace delete pod stubborn --grace-period=0 --force
```

This is acceptable here because the node is healthy, and the kubelet still kills the container. On an unreachable node, force deletion only removes the API object.

**Step 4.** After `dd` writes 150 MB into an emptyDir capped at 50Mi, the kubelet's next housekeeping pass evicts the pod: `Status: Failed`, `Reason: Evicted`, `Message: Usage of EmptyDir volume "scratch" exceeds the limit "50Mi".` Evicted pods are not restarted in place; a controller (Deployment) would create a replacement. The same happens when a container's `ephemeral-storage` limit is exceeded, for example by an app writing logs to a file inside the container.
:::

### Clean up

```bash
kubectl delete ns grace stuck --ignore-not-found
```

## Lab 5: Metrics and alerts with kube-prometheus-stack

:::meta
difficulty: hard
time: 50 min
:::

**Goal:** install metrics-server and kube-prometheus-stack on kind, explore dashboards and PromQL, then write an alert, discover why Prometheus ignores it, fix that, and watch it fire.

### Steps

1. Install metrics-server (kind's kubelets use self-signed certs, hence the extra flag):

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deploy/metrics-server
sleep 30; kubectl top nodes; kubectl top pods -A | head
```

2. Install kube-prometheus-stack (check the latest chart version with `helm search repo`, then pin it with `--version`):

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm search repo prometheus-community/kube-prometheus-stack
cat > kps-values.yaml <<'EOF'
grafana:
  adminPassword: change-me-locally
prometheus-node-exporter:
  hostRootFsMount:
    enabled: false        # avoids a mount propagation error with kind on Docker Desktop
EOF
helm install kps prometheus-community/kube-prometheus-stack -n monitoring --create-namespace \
  -f kps-values.yaml --wait --timeout 10m
kubectl -n monitoring get pods
```

3. Explore Grafana (user `admin`, password from the values file):

```bash
kubectl -n monitoring port-forward svc/kps-grafana 3000:80
```

Open http://localhost:3000 → Dashboards. Look at "Kubernetes / Compute Resources / Namespace (Pods)" and "Kubernetes / Compute Resources / Pod".

4. Explore Prometheus in a second terminal:

```bash
kubectl -n monitoring port-forward svc/prometheus-operated 9090
```

At http://localhost:9090, run these queries and explain each result:

```text
up
sum by (namespace) (kube_pod_info)
sum by (pod) (container_memory_working_set_bytes{namespace="monitoring", container!=""})
kube_deployment_status_replicas_available
```

Open Status → Targets and note which targets are down. On kind, the etcd, scheduler, controller-manager and kube-proxy targets are often down because those components bind to localhost on the node. That is a kind quirk, not your mistake.

5. Create a namespace with a crashing pod and an alert rule for it:

```bash
kubectl create namespace payments
kubectl -n payments run flaky --image=busybox:1.36 -- sh -c 'echo starting; sleep 5; exit 1'
cat > alert.yaml <<'EOF'
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: payments-restarts
  namespace: payments
spec:
  groups:
    - name: payments
      rules:
        - alert: PaymentsPodRestartingOften
          expr: increase(kube_pod_container_status_restarts_total{namespace="payments"}[5m]) > 2
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "{{ $labels.pod }} restarted more than twice in 5 minutes"
EOF
kubectl apply -f alert.yaml
```

6. Look for your rule at http://localhost:9090/rules. It is not there. Find out why and fix it.

7. Once the rule is loaded, watch http://localhost:9090/alerts: the alert goes `Pending`, then `Firing` after `for: 1m`. Optionally port-forward `svc/alertmanager-operated 9093` and see it in Alertmanager.

### Verify

- `kubectl top pods -n monitoring` shows CPU/memory.
- Your rule appears under Status → Rules, and `PaymentsPodRestartingOften` reaches `Firing`.

:::hint
The Prometheus custom resource selects which `PrometheusRule` objects it loads. Compare `kubectl -n monitoring get prometheus -o jsonpath='{.items[0].spec.ruleSelector}'` with the labels on your rule, and look at the labels on the chart's own rules: `kubectl -n monitoring get prometheusrules --show-labels | head -3`.
:::

:::solution
The Prometheus object created by the chart has `ruleSelector: {matchLabels: {release: kps}}`, so it only loads rules carrying the Helm release label. The same applies to ServiceMonitors and PodMonitors. Add the label:

```bash
kubectl -n payments label prometheusrule payments-restarts release=kps
```

or put it in the manifest:

```yaml
metadata:
  name: payments-restarts
  namespace: payments
  labels:
    release: kps
```

Within a minute or so the operator updates Prometheus' configuration and the rule appears. The pod restarts every few seconds plus back-off, so `increase(...[5m]) > 2` becomes true, the alert is `Pending` for 1 minute and then `Firing`.

Alternatively you can make Prometheus select all rules by installing the chart with `prometheus.prometheusSpec.ruleSelectorNilUsesHelmValues=false` (and the equivalent `serviceMonitorSelectorNilUsesHelmValues=false`), which is common in single-team clusters. Either way, this "my ServiceMonitor/Rule is ignored" problem is one of the most frequent kube-prometheus-stack questions.

Note that the stack already ships a generic `KubePodCrashLooping` alert; custom rules make sense for service-level symptoms (error rate, latency, queue depth) that only your app knows about.
:::

### Clean up

```bash
kubectl delete ns payments
helm uninstall kps -n monitoring && kubectl delete ns monitoring
# the chart's CRDs stay installed: kubectl get crd | grep monitoring.coreos.com
```

## Lab 6: Challenge — the mystery outage

:::meta
difficulty: hard
time: 45 min
:::

**Goal:** a small shop (frontend nginx proxying to a backend) "stopped working after Friday's changes". Get it fully healthy. No step-by-step: use everything from this module. There are four problems.

### Setup

```bash
cat > shop.yaml <<'EOF'
apiVersion: v1
kind: Namespace
metadata: { name: shop }
---
apiVersion: v1
kind: ResourceQuota
metadata: { name: shop-quota, namespace: shop }
spec:
  hard:
    pods: "3"
---
apiVersion: v1
kind: ConfigMap
metadata: { name: frontend-nginx, namespace: shop }
data:
  default.conf: |
    server {
      listen 8080;
      location /healthz { return 200 "ok\n"; }
      location / { proxy_pass http://backend:5678; }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: frontend, namespace: shop }
spec:
  replicas: 2
  selector: { matchLabels: { app: frontend } }
  template:
    metadata: { labels: { app: frontend } }
    spec:
      containers:
        - name: nginx
          image: nginxinc/nginx-unprivileged:1.27-alpine
          ports: [{ name: http, containerPort: 8080 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 80 }
            periodSeconds: 5
          volumeMounts:
            - { name: conf, mountPath: /etc/nginx/conf.d }
      volumes:
        - name: conf
          configMap: { name: frontend-nginx }
---
apiVersion: v1
kind: Service
metadata: { name: frontend, namespace: shop }
spec:
  selector: { app: frontend }
  ports: [{ port: 80, targetPort: http }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: backend, namespace: shop }
spec:
  replicas: 2
  selector: { matchLabels: { app: backend } }
  template:
    metadata: { labels: { app: backend } }
    spec:
      containers:
        - name: echo
          image: hashicorp/http-echo:1.0
          args: ["-text=backend-ok", "-listen=:5678"]
          ports: [{ name: http, containerPort: 5678 }]
---
apiVersion: v1
kind: Service
metadata: { name: backend, namespace: shop }
spec:
  selector: { app: back-end }
  ports: [{ port: 8080, targetPort: http }]
EOF
kubectl apply -f shop.yaml
```

### Requirements

1. `kubectl -n default run t --rm -i --restart=Never --image=curlimages/curl -- curl -s -m 3 http://frontend.shop` prints `backend-ok`.
2. `kubectl -n shop get deploy` shows `2/2` for both Deployments.
3. For each problem, write down the single piece of evidence that identified it.

:::hint
Test from outside the `shop` namespace: a test pod inside it counts against the quota. Look at all levels: Deployment → ReplicaSet events, pod readiness, EndpointSlices for both Services, and the nginx error log (`kubectl -n shop logs deploy/frontend`).
:::

:::solution
1. **Quota too small.** `kubectl -n shop get deploy` shows backend `1/2` (or frontend short). `kubectl -n shop describe rs -l app=backend` → `Error creating: pods "backend-..." is forbidden: exceeded quota: shop-quota, requested: pods=1, used: pods=3, limited: pods=3`. Fix: raise `pods` to e.g. `"10"` (the four pods plus room for rolling updates, which temporarily need extra pods).
2. **Frontend readiness probe on the wrong port.** Pods are `0/1 Running`; events: `Readiness probe failed: ... dial tcp ...:80: connect: connection refused`. nginx listens on 8080. Fix: `port: http`. Until this is fixed, the `frontend` EndpointSlice has no ready endpoints and curl gets a refused connection or timeout.
3. **Backend Service selector typo.** `kubectl -n shop get endpointslices -l kubernetes.io/service-name=backend` shows no endpoints; the selector is `app: back-end`, the pods are `app: backend`. Fix the selector.
4. **Upstream port.** Even with ready backends, curl returns `502 Bad Gateway`, and `kubectl -n shop logs deploy/frontend` shows `connect() failed (111: Connection refused) while connecting to upstream ... upstream: "http://10.96.x.x:5678/"`. nginx proxies to the **Service** `backend` on port 5678, but the Service listens on 8080 (5678 is the container port behind it). Fix `proxy_pass http://backend:8080;` and restart the frontend so nginx reloads the ConfigMap (`kubectl -n shop rollout restart deploy/frontend`): mounted ConfigMaps update on disk eventually, but nginx only reads its config at start or on reload.

Fix the quota first: the rolling update triggered by fixing the readiness probe needs a temporary extra pod, which the quota would also block.

Also note that nginx resolves `backend` when it starts: if the Service did not exist at that moment, nginx refuses to start with `host not found in upstream`.

Evidence summary: RS event (quota), probe event (readiness), empty EndpointSlice (selector), nginx log / 502 (upstream).
:::

### Clean up

```bash
kubectl delete ns shop
kind delete cluster --name obs
```
