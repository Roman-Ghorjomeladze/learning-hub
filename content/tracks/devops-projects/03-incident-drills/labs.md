Twelve drills, each a self-contained incident. They run on the kind cluster from Project 1 in a separate namespace, `gameday`, so your real `shipit` namespace stays untouched. Drills 9 and 10 use Terraform, drill 11 uses Helm.

### One-time setup

```bash
cd ~/code/shipit
make up                                   # Project 1 cluster, Terraform mode, local image shipit-api:dev
export KUBECONFIG=$PWD/infra/.kube/config
brew install hey
mkdir -p drills
```

Create the three game-day files.

`drills/baseline.yaml`

```yaml
# Game-day baseline: a self-contained copy of shipit in namespace "gameday".
# Requires the Project 1 cluster (Traefik Gateway "traefik-gateway" in ns "gateway")
# and the image shipit-api:dev loaded into kind.
apiVersion: v1
kind: Namespace
metadata:
  name: gameday
---
apiVersion: v1
kind: Secret
metadata:
  name: gameday-db
  namespace: gameday
stringData:
  POSTGRES_PASSWORD: gameday
  DATABASE_URL: postgres://shipit:gameday@postgres:5432/shipit
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: gameday
  labels: { app: postgres }
spec:
  replicas: 1
  selector:
    matchLabels: { app: postgres }
  template:
    metadata:
      labels: { app: postgres }
    spec:
      containers:
        - name: postgres
          image: postgres:17
          env:
            - { name: POSTGRES_USER, value: shipit }
            - { name: POSTGRES_DB, value: shipit }
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef: { name: gameday-db, key: POSTGRES_PASSWORD }
          ports:
            - containerPort: 5432
          readinessProbe:
            exec:
              command: ["pg_isready", "-h", "127.0.0.1", "-U", "shipit", "-d", "shipit"]
            periodSeconds: 5
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
      volumes:
        - name: data
          emptyDir: {}   # disposable on purpose
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: gameday
spec:
  selector: { app: postgres }
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: gameday
  labels: { app: redis }
spec:
  replicas: 1
  selector:
    matchLabels: { app: redis }
  template:
    metadata:
      labels: { app: redis }
    spec:
      containers:
        - name: redis
          image: redis:8-alpine
          args: ["--save", "", "--appendonly", "no"]
          ports:
            - containerPort: 6379
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: gameday
spec:
  selector: { app: redis }
  ports:
    - port: 6379
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shipit-api
  namespace: gameday
  labels: { app: shipit-api }
spec:
  replicas: 2
  progressDeadlineSeconds: 120
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }
  selector:
    matchLabels: { app: shipit-api }
  template:
    metadata:
      labels: { app: shipit-api }
    spec:
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: api
          image: shipit-api:dev
          imagePullPolicy: IfNotPresent
          ports:
            - { name: http, containerPort: 3000 }
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: gameday-db, key: DATABASE_URL }
            - { name: REDIS_URL, value: "redis://redis:6379" }
            - { name: SHUTDOWN_DELAY_MS, value: "5000" }
            - { name: NODE_OPTIONS, value: "--max-old-space-size=192" }
          startupProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 2
            failureThreshold: 30
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { memory: 256Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: shipit-api
  namespace: gameday
spec:
  selector: { app: shipit-api }
  ports:
    - { name: http, port: 80, targetPort: http }
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shipit-api
  namespace: gameday
spec:
  parentRefs:
    - { name: traefik-gateway, namespace: gateway }
  hostnames: ["gameday.local"]
  rules:
    - backendRefs:
        - { name: shipit-api, port: 80 }
```

`drills/reset.sh`

```bash
#!/usr/bin/env bash
# Recreate the game-day baseline from scratch and wait until it serves traffic.
set -euo pipefail
cd "$(dirname "$0")"
kubectl delete namespace gameday --ignore-not-found --wait=true
kubectl apply -f baseline.yaml
kubectl -n gameday rollout status deploy/postgres --timeout=180s
kubectl -n gameday rollout status deploy/redis --timeout=120s
kubectl -n gameday rollout status deploy/shipit-api --timeout=180s
for i in $(seq 1 30); do
  if curl -fsS -m 2 -H 'Host: gameday.local' http://localhost:8080/readyz >/dev/null; then
    echo "baseline healthy"; exit 0
  fi
  sleep 2
done
echo "baseline did not become healthy" >&2; exit 1
```

`drills/watch.sh`

```bash
#!/usr/bin/env bash
# Poor man's monitoring: one synthetic request per second, printed with a timestamp.
# Leave it running in its own terminal during every drill.
URL="${URL:-http://localhost:8080/items}"
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H 'Host: gameday.local' "$URL")
  printf '%s %s\n' "$(date +%H:%M:%S)" "$code"
  sleep 1
done
```

```bash
chmod +x drills/*.sh
drills/reset.sh                           # prints "baseline healthy"
```

### How to run every drill

1. `drills/reset.sh` (healthy baseline).
2. In a second terminal: `drills/watch.sh`. This is your monitoring; it prints one status code per second.
3. Note the time, then run the **Inject** block. Treat it as an unknown change made by someone else: do not study it, respond to the symptoms.
4. Work the incident: triage, **mitigate**, find the root cause, fix it durably, verify with `watch.sh`.
5. Answer the **Postmortem prompt** in 3–5 sentences (keep them in a `drills/POSTMORTEMS.md`).
6. Open the hint only after 10 minutes, the solution after you have a fix or are truly stuck.

:::tip Your incident notebook
For each drill, write: time injected, time detected, time mitigated, time resolved, the commands that gave you the answer. After all 12 drills, those notes are your personal runbook, and good material for "tell me about a time you debugged..." interview questions.
:::

## Drill 1: The rollout that never finishes

:::meta
difficulty: easy
time: 20 min
:::

**Page:** "Deploy pipeline for shipit-api timed out waiting for the rollout. Customers report nothing unusual."

### Inject

```bash
kubectl -n gameday patch deploy shipit-api -p '{"spec":{"template":{"spec":{"containers":[{"name":"api","env":[{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"gameday-database","key":"DATABASE_URL","optional":true}}}]}]}}}}'
```

### Symptoms

- `watch.sh` keeps printing `200`.
- `kubectl -n gameday rollout status deploy/shipit-api` hangs and eventually reports `exceeded its progress deadline`.
- One extra pod is not Ready and its restart count keeps growing.

### Investigate

- What state is the new pod in, and what did the process print before it exited?
- What changed between the previous and current ReplicaSet?
- Why is there no user impact?

:::hint
`kubectl logs <new-pod> -n gameday --previous` shows the last crash. Then compare the env section of the Deployment with the Secrets that actually exist (`kubectl get secrets -n gameday`). Look closely at the `optional` field: what would have happened without it?
:::

:::solution
**Root cause.** The Deployment's `DATABASE_URL` now references a Secret named `gameday-database`, which does not exist (the real one is `gameday-db`). Someone also set `optional: true`, so instead of the protective `CreateContainerConfigError`, the container starts without `DATABASE_URL`, the app's config validation logs `missing required env: DATABASE_URL` and exits 1, and kubelet restarts it with backoff: `CrashLoopBackOff`.

**Why no outage.** `maxUnavailable: 0` keeps both old pods serving until a new pod becomes Ready, which never happens. The rollout stalls instead of taking the service down, and `progressDeadlineSeconds: 120` turns the stall into a visible failure.

**Evidence:**

```bash
kubectl get pods -n gameday -l app=shipit-api           # one pod CrashLoopBackOff, RESTARTS climbing
kubectl logs -n gameday <pod> --previous                 # {"level":"fatal","msg":"missing required env: DATABASE_URL"}
kubectl get deploy shipit-api -n gameday -o jsonpath='{.spec.template.spec.containers[0].env[0]}{"\n"}'
kubectl get secrets -n gameday                           # gameday-db exists, gameday-database does not
```

**Mitigate:** `kubectl rollout undo deploy/shipit-api -n gameday` (the pipeline's failed rollout is now cleaned up).

**Durable fix:** correct the Secret name in the chart/manifest, and remove `optional: true`. Required configuration must never be optional: a `CreateContainerConfigError` stops a bad rollout before any process runs, and that is a feature. Add a CI check that renders the chart and verifies referenced Secrets exist in the target environment, or let a tool like External Secrets own the Secret alongside the app.
:::

### Postmortem prompt

What turned a loud, safe failure (`CreateContainerConfigError`) into a confusing one (`CrashLoopBackOff`)? Which two settings limited the blast radius to zero?

### Verify

`kubectl -n gameday rollout status deploy/shipit-api` succeeds and all `shipit-api` pods are `1/1` with no recent restarts.

### Clean up

```bash
drills/reset.sh
```

## Drill 2: The report worker that keeps dying

:::meta
difficulty: medium
time: 25 min
:::

**Page:** "report-worker restarted 6 times in 10 minutes. Monthly reports are not being generated."

### Inject

```bash
cat > drills/02-report-worker.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: report-worker
  namespace: gameday
spec:
  replicas: 1
  selector:
    matchLabels: { app: report-worker }
  template:
    metadata:
      labels: { app: report-worker }
    spec:
      containers:
        - name: worker
          image: node:22-alpine
          command: ["node", "-e"]
          args:
            - |
              // Builds the monthly report by buffering every export chunk in memory.
              const chunks = [];
              let mb = 0;
              console.log("building report...");
              const timer = setInterval(() => {
                chunks.push(Buffer.alloc(1024 * 1024, 1)); // 1 MiB per export chunk
                mb += 1;
                if (mb % 25 === 0) console.log(`buffered ${mb} MiB`);
                if (mb >= 300) { clearInterval(timer); console.log("report ready"); }
              }, 20);
              setInterval(() => {}, 60_000);
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { memory: 128Mi }
EOF
kubectl apply -f drills/02-report-worker.yaml
```

### Symptoms

- `kubectl get pods -n gameday -l app=report-worker -w` shows `Running`, then `OOMKilled`, then `CrashLoopBackOff`, over and over.
- The logs never say "report ready".

### Investigate

- What is the exact termination reason and exit code? Is there an error message from Node?
- How much memory does the container use just before it dies, compared with its limit?
- Would `--max-old-space-size` help here? Why or why not?

:::hint
`kubectl describe pod` → `Last State: Terminated`, `Reason`, `Exit Code`. Run `kubectl top pod -n gameday -l app=report-worker` a few times while it runs. Then think about where `Buffer` memory lives: inside or outside the V8 heap?
:::

:::solution
**Root cause.** The worker buffers the whole report in memory (300 × 1 MiB Buffers) while its container limit is 128 MiB. Buffers are allocated **outside** the V8 heap, so V8 never complains; the process RSS crosses the cgroup limit and the kernel kills it with SIGKILL.

**Evidence:**

```text
$ kubectl describe pod -n gameday -l app=report-worker | grep -A4 "Last State"
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
$ kubectl logs -n gameday deploy/report-worker --previous
building report...
buffered 25 MiB
buffered 50 MiB
buffered 75 MiB          <- last line: no stack trace, the kernel killed it
```

Exit code 137 = 128 + 9 (SIGKILL). No Node error, because Node never got a chance to run any code. Compare with a V8 heap exhaustion, which prints `JavaScript heap out of memory` and exits 134 (see the lesson's deep dive). `--max-old-space-size` only limits the JS heap, so it does nothing here.

**Mitigate:** if reports are urgent, raise the limit enough to finish (for example `limits.memory: 512Mi` via `kubectl set resources deploy/report-worker -n gameday --limits=memory=512Mi --requests=memory=512Mi`), knowing it only postpones the problem as data grows.

**Durable fix:** stop holding everything in memory. Stream: process each chunk and let it go (write to object storage, a file, or a database incrementally).

```javascript
// streaming version: constant memory regardless of report size
let mb = 0, checksum = 0;
const timer = setInterval(() => {
  const chunk = Buffer.alloc(1024 * 1024, 1);
  checksum += chunk[0];          // "process" the chunk, then drop the reference
  mb += 1;
  if (mb % 25 === 0) console.log(`processed ${mb} MiB`);
  if (mb >= 300) { clearInterval(timer); console.log("report ready", checksum); }
}, 20);
setInterval(() => {}, 60_000);
```

Replace the script in the manifest with it, apply, and watch `kubectl top pod` stay flat while "report ready" appears. Then size requests and limits from observed usage plus headroom, and alert on memory usage approaching the limit, not only on restarts.
:::

### Postmortem prompt

Why did the logs contain no error at all? Which alert would have caught this before reports were missed, and what design rule (one sentence) prevents the class of bug?

### Verify

The fixed worker logs `report ready`, has `RESTARTS` 0 after several minutes, and `kubectl top pod` shows memory well under the limit.

### Clean up

```bash
kubectl delete -f drills/02-report-worker.yaml
```

## Drill 3: 503s for everyone after a "faster deploys" change

:::meta
difficulty: medium
time: 25 min
:::

**Page:** "Synthetic check failing: shipit-api returns 503 for 100% of requests since the last deploy."

### Inject

```bash
kubectl -n gameday patch deploy shipit-api -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null},"template":{"spec":{"containers":[{"name":"api","readinessProbe":{"httpGet":{"path":"/ready","port":"http"}}}]}}}}'
```

### Symptoms

- `watch.sh` switches from `200` to `503` within seconds and stays there.
- Pods are `Running` but `0/1` Ready, with zero restarts.

### Investigate

- Which component returns the 503, the app or the Gateway? How can you tell?
- Why are the pods not Ready?
- Why did **all** capacity disappear at once, when your rollout strategy should prevent that?

:::hint
`kubectl get endpointslices -n gameday -l kubernetes.io/service-name=shipit-api` shows whether the Service has any ready endpoints. `kubectl describe pod` shows the probe failure message. Then check `kubectl get deploy shipit-api -n gameday -o jsonpath='{.spec.strategy}'`.
:::

:::solution
**Root cause, two contributing changes:**

1. The readiness probe path changed from `/readyz` to `/ready`, which returns 404. Pods never become Ready, so the Service has no ready endpoints and Traefik answers `503` itself (the app never sees the requests). `kubectl port-forward deploy/shipit-api -n gameday 3000` and `curl localhost:3000/items` would show the app is actually fine.
2. The strategy changed from `RollingUpdate` (`maxUnavailable: 0`) to `Recreate`, which deletes all old pods before creating new ones. With the old strategy, this broken probe would only have stalled the rollout (like Drill 1).

**Evidence:**

```bash
kubectl describe pod -n gameday -l app=shipit-api | grep -i "readiness probe failed"
#   Readiness probe failed: HTTP probe failed with statuscode: 404
kubectl get endpointslices -n gameday -l kubernetes.io/service-name=shipit-api -o wide   # no ready endpoints
kubectl rollout history deploy/shipit-api -n gameday
```

**Mitigate:** `kubectl rollout undo deploy/shipit-api -n gameday`. Service comes back once the old-template pods are Ready.

**The trap:** `rollout undo` only restores the **pod template**. `spec.strategy` is not part of the template, so the Deployment is still `Recreate`, and the next deploy will again cause a full outage. Check and fix it:

```bash
kubectl get deploy shipit-api -n gameday -o jsonpath='{.spec.strategy.type}{"\n"}'     # Recreate
kubectl -n gameday patch deploy shipit-api -p '{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxUnavailable":0,"maxSurge":1}}}}'
```

**Durable fix:** revert both changes in the chart. Add CI protection: the e2e smoke test from Project 2 would have failed this change before merge, and a policy (Kyverno/Gatekeeper, or a simple kubeconform custom rule) can forbid `Recreate` for user-facing Deployments.
:::

### Postmortem prompt

Which of the two changes caused the outage, and which one made it total? Why is "`rollout undo` fixed it" an incomplete resolution?

### Verify

`watch.sh` prints `200`, the strategy is `RollingUpdate` with `maxUnavailable: 0`, and the readiness path is `/readyz`.

### Clean up

```bash
drills/reset.sh
```

## Drill 4: Zero trust, zero traffic

:::meta
difficulty: hard
time: 30 min
:::

**Page:** "shipit-api 503 since 10:42. Security rolled out baseline network policies this morning; a release went out at the same time."

### Inject

```bash
cat > drills/04-netpol.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-all, namespace: gameday }
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-dns, namespace: gameday }
spec:
  podSelector: {}
  policyTypes: ["Egress"]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports:
        - { port: 53, protocol: UDP }
        - { port: 53, protocol: TCP }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-gateway-to-api, namespace: gameday }
spec:
  podSelector: { matchLabels: { app: shipit-api } }
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: gateway } }
      ports:
        - { port: 3000, protocol: TCP }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-api-to-redis, namespace: gameday }
spec:
  podSelector: { matchLabels: { app: shipit-api } }
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector: { matchLabels: { app: redis } }
      ports:
        - { port: 6379, protocol: TCP }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-redis-from-api, namespace: gameday }
spec:
  podSelector: { matchLabels: { app: redis } }
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: shipit-api } }
      ports:
        - { port: 6379, protocol: TCP }
EOF
kubectl apply -f drills/04-netpol.yaml
kubectl -n gameday rollout restart deploy/postgres deploy/shipit-api   # the release + a DB restart
```

### Symptoms

- After a short delay, `watch.sh` shows `503`.
- API pods are `Running`, `0/1` Ready, no restarts. Postgres and Redis pods are Ready.
- App logs show `database not reachable yet` with timeouts, or readiness errors.

### Investigate

- Can the API pods reach Redis? Postgres? DNS? Prove it from inside an API pod.
- Which policies select the API pods and the Postgres pod, and what do they allow?
- Why did the problem only appear after the restart, not when the policies were applied?

:::hint
The API image has Node, so you can test TCP from inside it without a debug image (the pod's `runAsNonRoot` blocks root-only debug images):

```bash
kubectl exec -n gameday deploy/shipit-api -- node -e '
const net = require("net");
for (const [h, p] of [["postgres", 5432], ["redis", 6379]]) {
  const s = net.connect({ host: h, port: p, timeout: 3000 });
  s.on("connect", () => { console.log(h, p, "OPEN"); s.destroy(); });
  s.on("timeout", () => { console.log(h, p, "TIMEOUT"); s.destroy(); });
  s.on("error", (e) => console.log(h, p, e.code));
}'
```

Then `kubectl get networkpolicy -n gameday` and `kubectl describe networkpolicy -n gameday`. NetworkPolicies are allow-lists: a connection needs an egress rule on the client side **and** an ingress rule on the server side.
:::

:::solution
**Root cause.** `default-deny-all` blocks all ingress and egress for every pod in the namespace. The follow-up allow rules cover DNS, Gateway → API and API ↔ Redis, but **nothing allows API → Postgres** (egress from the API pods, ingress to the Postgres pod). Readiness checks Postgres, so every API pod goes NotReady and Traefik returns 503.

**Why it was delayed.** Many NetworkPolicy implementations enforce policy on **new** connections; already established TCP connections (the pg pool's idle connections) can keep working. The outage started when the release restarted the API pods and Postgres restarted, which forced new connections. This makes network policy rollouts look safe right up to the next deploy, a classic delayed-blast incident.

**Evidence:**

```text
$ kubectl exec -n gameday deploy/shipit-api -- node -e '...'
redis 6379 OPEN
postgres 5432 TIMEOUT
$ kubectl get networkpolicy -n gameday
NAME                   POD-SELECTOR      AGE
allow-api-to-redis     app=shipit-api    5m
allow-dns              <none>            5m
allow-gateway-to-api   app=shipit-api    5m
allow-redis-from-api   app=redis         5m
default-deny-all       <none>            5m
```

**Mitigate (fast):** `kubectl delete networkpolicy default-deny-all -n gameday` restores traffic in seconds. In a real company, agree on this with security in the incident channel; it is a temporary rollback of a security control.

**Durable fix:** add the missing pair and re-apply the deny:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-api-to-postgres, namespace: gameday }
spec:
  podSelector: { matchLabels: { app: shipit-api } }
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector: { matchLabels: { app: postgres } }
      ports:
        - { port: 5432, protocol: TCP }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-postgres-from-api, namespace: gameday }
spec:
  podSelector: { matchLabels: { app: postgres } }
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: shipit-api } }
      ports:
        - { port: 5432, protocol: TCP }
```

Prevention: roll out default-deny per namespace together with the app's own policies (the shipit chart from Project 1 ships its NetworkPolicy), test policies in the e2e environment with a forced restart, and keep a connectivity smoke test (the `node -e` check above) in your runbook.
:::

### Postmortem prompt

Two changes went out at the same time. How would you have proven which one caused the outage? What does "established connections survive" mean for how you test network policy changes?

### Verify

With the deny policy **and** the two new policies in place, restart everything (`kubectl -n gameday rollout restart deploy/postgres deploy/shipit-api`) and `watch.sh` returns to `200`.

### Clean up

```bash
drills/reset.sh
```

## Drill 5: The analytics database will not start

:::meta
difficulty: medium
time: 20 min
:::

**Page:** "New analytics-db StatefulSet has been Pending for 15 minutes. Also, someone noticed a PVC called `scratch` stuck in Pending."

### Inject

```bash
cat > drills/05-analytics.yaml <<'EOF'
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: analytics-db
  namespace: gameday
spec:
  serviceName: analytics-db
  replicas: 1
  selector:
    matchLabels: { app: analytics-db }
  template:
    metadata:
      labels: { app: analytics-db }
    spec:
      containers:
        - name: postgres
          image: postgres:17
          env:
            - { name: POSTGRES_PASSWORD, value: analytics }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 1Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: scratch
  namespace: gameday
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
EOF
kubectl apply -f drills/05-analytics.yaml
```

### Symptoms

- `analytics-db-0` is `Pending`.
- `kubectl get pvc -n gameday` shows `data-analytics-db-0` and `scratch`, both `Pending`.

### Investigate

- Why is the pod not scheduled? Follow the chain from pod to PVC to StorageClass.
- Are both Pending PVCs actually broken?
- Can you fix the StatefulSet in place?

:::hint
`kubectl describe pod analytics-db-0 -n gameday`, `kubectl describe pvc -n gameday`, `kubectl get storageclass`. Look at the `VOLUMEBINDINGMODE` column. For the in-place fix, try `kubectl edit` on the StatefulSet's `volumeClaimTemplates` and read the error.
:::

:::solution
**Root cause.** The StatefulSet requests `storageClassName: fast-ssd`, which does not exist in this cluster (kind provides `standard`, backed by the local-path provisioner). The PVC can never be provisioned, so the pod stays Pending with `pod has unbound immediate PersistentVolumeClaims` / `waiting for a volume to be created`, and the PVC's events say `storageclass.storage.k8s.io "fast-ssd" not found`.

**Red herring.** `scratch` is Pending **by design**: the `standard` class uses `volumeBindingMode: WaitForFirstConsumer`, so the volume is only provisioned when a pod using the PVC is scheduled (so it can be created on the right node). Its event says `waiting for first consumer to be created before binding`. Not an incident. Recognising non-problems quickly is part of triage.

**Fixing it:** `volumeClaimTemplates` are immutable (`spec: Forbidden: updates to statefulset spec for fields other than ... are forbidden`). Delete and recreate:

```bash
kubectl delete statefulset analytics-db -n gameday
kubectl delete pvc data-analytics-db-0 -n gameday        # the stuck claim; it is not re-created automatically with a new class
sed -i '' 's/storageClassName: fast-ssd/storageClassName: standard/' drills/05-analytics.yaml
kubectl apply -f drills/05-analytics.yaml
kubectl get pvc,pods -n gameday -w
```

(`sed -i ''` is the macOS form; on Linux use `sed -i`.) Deleting a StatefulSet does not delete its PVCs; with real data you would keep them (`--cascade=orphan` keeps the pods too) and migrate carefully.

**Prevention:** environment values for storage classes (`storageClassName: ""` means "cluster default", as the shipit-data chart does), and validation in CI against the target cluster's StorageClasses.
:::

### Postmortem prompt

Which signal told you `scratch` was not a problem? Why are StatefulSet volume templates immutable, and what does that imply for how you choose storage settings up front?

### Verify

`analytics-db-0` is `Running` and `data-analytics-db-0` is `Bound` to a `standard` volume.

### Clean up

```bash
kubectl delete -f drills/05-analytics.yaml
kubectl delete pvc data-analytics-db-0 -n gameday --ignore-not-found
```

## Drill 6: exec format error

:::meta
difficulty: medium
time: 25 min
:::

**Page:** "Release 1.3 of shipit-api (adds an entrypoint wrapper) is not rolling out. The new pod fails instantly."

### Inject

```bash
cat > drills/06-Dockerfile <<'EOF'
# Release 1.3: entrypoint wrapper that will load secrets before starting node
FROM shipit-api:dev
USER root
RUN printf 'echo "loading secrets..."\nexec node dist/server.js "$@"\n' > /app/entrypoint.sh \
 && chmod 0755 /app/entrypoint.sh
USER 1000:1000
ENTRYPOINT ["/app/entrypoint.sh"]
CMD []
EOF
docker build -t shipit-api:1.3 -f drills/06-Dockerfile app
kind load docker-image shipit-api:1.3 --name shipit
kubectl -n gameday set image deploy/shipit-api api=shipit-api:1.3
```

### Symptoms

- The new pod shows `RunContainerError` or `StartError`, then `CrashLoopBackOff`.
- `watch.sh` stays at `200` (old pods serve).

### Investigate

- What exact error does the runtime report?
- The most common cause of this error is an image built for the wrong CPU architecture. Prove or rule that out.
- If it is not the architecture, what else makes the kernel refuse to execute a file?

:::hint
`kubectl describe pod` and `kubectl logs --previous`. Compare `docker image inspect shipit-api:1.3 --format '{{.Os}}/{{.Architecture}}'` with `kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.architecture}'`. Then look at the first bytes of the entrypoint: `docker run --rm --entrypoint sh shipit-api:1.3 -c 'head -c 32 /app/entrypoint.sh | od -c'`.
:::

:::solution
**Root cause.** `/app/entrypoint.sh` has no shebang line (`#!/bin/sh`). When the container runtime calls `execve()` on it, the kernel does not recognise the file format (no ELF header, no `#!`), and returns `ENOEXEC`: `exec /app/entrypoint.sh: exec format error`. A shell would have guessed and run it as a script, which is why it "worked" when someone tested it with `sh entrypoint.sh`.

**Ruling out architecture:**

```text
$ docker image inspect shipit-api:1.3 --format '{{.Os}}/{{.Architecture}}'
linux/arm64
$ kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.architecture}'
arm64 arm64
$ docker run --rm --entrypoint sh shipit-api:1.3 -c 'head -c 32 /app/entrypoint.sh | od -c'
0000000   e   c   h   o       "   l   o   a   d   i   n   g ...      <- no "#!"
```

Arch matches (on Intel, both say amd64), so the file itself is the problem.

**Mitigate:** `kubectl rollout undo deploy/shipit-api -n gameday`.

**Fix:** add the shebang and rebuild as 1.3.1:

Open `drills/06-Dockerfile` in your editor and make the `printf` line start the script with a shebang (edit in the editor: a `!` typed into an interactive shell triggers history expansion):

```dockerfile
RUN printf '#!/bin/sh\necho "loading secrets..."\nexec node dist/server.js "$@"\n' > /app/entrypoint.sh \
 && chmod 0755 /app/entrypoint.sh
```

```bash
docker build -t shipit-api:1.3.1 -f drills/06-Dockerfile app
kind load docker-image shipit-api:1.3.1 --name shipit
kubectl -n gameday set image deploy/shipit-api api=shipit-api:1.3.1
kubectl -n gameday rollout status deploy/shipit-api
```

Other script gotchas with similar symptoms: Windows line endings (`#!/bin/sh\r` → `no such file or directory`, exit 127) and a shebang pointing at a shell the image lacks (`#!/bin/bash` on Alpine).

**The architecture variant (know it cold).** An arm64-only image built on a Mac and run on amd64 nodes (or the reverse) fails with the same `exec format error`, because the ELF binary is for another CPU. Fix: multi-arch builds (`--platform linux/amd64,linux/arm64`) and `imagetools inspect` in CI. On your Mac you may not be able to reproduce it: Docker Desktop and OrbStack register QEMU/Rosetta emulators in the VM kernel, so foreign-arch binaries silently run (slowly) even inside kind. "Works on my machine, fails in the cloud" is exactly that emulation hiding the bug.
:::

### Postmortem prompt

How would a CI step have caught both variants of `exec format error` (missing shebang and wrong architecture) before release? Write the one-line check for each.

### Verify

The Deployment runs `shipit-api:1.3.1`, all pods are Ready, and `kubectl logs -n gameday deploy/shipit-api | head -1` shows `loading secrets...`.

### Clean up

```bash
drills/reset.sh
```

## Drill 7: The autoscaler that does nothing

:::meta
difficulty: medium
time: 25 min
:::

**Page:** "Latency on shipit-api tripled during the marketing campaign. We have an HPA, but it is still at 2 replicas."

### Inject

```bash
kubectl -n gameday patch deploy shipit-api --type=json \
  -p='[{"op":"remove","path":"/spec/template/spec/containers/0/resources/requests"}]'
cat > drills/07-hpa.yaml <<'EOF'
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: shipit-api
  namespace: gameday
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: shipit-api
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50
EOF
kubectl apply -f drills/07-hpa.yaml
kubectl -n gameday rollout status deploy/shipit-api
# the campaign:
hey -z 120s -c 50 -host gameday.local http://localhost:8080/items
```

### Symptoms

- `kubectl get hpa -n gameday` shows `cpu: <unknown>/50%` and `REPLICAS 2` throughout the load.
- `kubectl top pods -n gameday` shows the API pods using plenty of CPU.

### Investigate

- What does the HPA controller itself say?
- What does "utilization" mean for an HPA, and relative to what?
- Is metrics-server healthy?

:::hint
`kubectl describe hpa shipit-api -n gameday` (look at Conditions and Events). Then `kubectl get deploy shipit-api -n gameday -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}'`.
:::

:::solution
**Root cause.** CPU utilisation for an HPA is `actual CPU usage / CPU request`. The container has **no CPU request**, so utilisation is undefined. The HPA reports:

```text
Conditions:
  ScalingActive  False  FailedGetResourceMetric  the HPA was unable to compute the replica count:
                 failed to get cpu utilization: missing request for cpu in container api of Pod shipit-api-...
```

Metrics-server is fine (`kubectl top` works). Note the subtlety: the patch removed all requests, but the pod still has a **memory** request, because Kubernetes defaults a missing request to the limit when a limit is set. CPU has no limit, so no default either.

**Mitigate during the campaign:** scale manually: `kubectl scale deploy/shipit-api -n gameday --replicas=5`. (The HPA will take over again once it works.)

**Fix:** restore requests, then re-run the load:

```bash
kubectl -n gameday set resources deploy/shipit-api --requests=cpu=100m,memory=128Mi
kubectl -n gameday rollout status deploy/shipit-api
kubectl get hpa shipit-api -n gameday -w &
hey -z 120s -c 50 -host gameday.local http://localhost:8080/items
kill %1
```

`TARGETS` now shows a real percentage and `REPLICAS` rises (scale-down happens about 5 minutes after the load stops, the default stabilisation window).

**Other reasons an HPA does not scale** (check them in this order): no metrics-server or metrics API errors; missing requests; target already reached `maxReplicas`; new pods Pending (no cluster capacity); custom/external metric adapters missing; the bottleneck is not CPU (I/O, database, event loop blocked on a dependency), so CPU never crosses the target.

**Prevention:** require CPU requests (a LimitRange with default requests per namespace, or a policy that rejects pods without requests), and include an HPA check in your deploy smoke test (`kubectl get hpa -o jsonpath='{.status.conditions}'`).
:::

### Postmortem prompt

Why is "we have an HPA" not the same as "we autoscale"? Which namespace-level object would have prevented this misconfiguration?

### Verify

Under load, the HPA shows a CPU percentage and scales above 2 replicas.

### Clean up

```bash
kubectl delete -f drills/07-hpa.yaml
drills/reset.sh
```

## Drill 8: The service that does not exist

:::meta
difficulty: easy
time: 20 min
:::

**Page:** "Rollout of shipit-api config change stuck. Change description: 'align REDIS_URL with the values from our old chart'."

### Inject

```bash
kubectl -n gameday set env deploy/shipit-api REDIS_URL=redis://redis-master:6379
```

### Symptoms

- One new pod `Running` but `0/1` Ready; the rollout does not progress.
- `watch.sh` stays at `200`.

### Investigate

- What does the new pod's log say about Redis?
- Does the name resolve inside the cluster? What names do exist?
- How does a pod turn a short name like `redis` into an IP?

:::hint
`kubectl logs -n gameday <new-pod>`. Then test DNS from a throwaway pod in the namespace:

```bash
kubectl run dns-test -n gameday --rm -it --restart=Never --image=busybox:1.36 -- sh -c \
  'cat /etc/resolv.conf; nslookup redis-master; nslookup redis'
```
:::

:::solution
**Root cause.** The Service is called `redis`. `redis-master` is the Service name the Bitnami Redis chart used to create, copied from an old values file. The app logs `redis error ... getaddrinfo ENOTFOUND redis-master`, `/readyz` fails, the pod never becomes Ready, and the rollout stalls (old pods keep serving).

**How in-cluster DNS works** (the part interviewers like):

```text
$ cat /etc/resolv.conf
search gameday.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

- A name with fewer than 5 dots is tried with each search domain first: `redis-master.gameday.svc.cluster.local`, then `redis-master.svc.cluster.local`, then `redis-master.cluster.local`, then `redis-master.` as-is. All fail → `NXDOMAIN`.
- `redis` resolves via the first search domain to the ClusterIP of `redis.gameday.svc.cluster.local`.
- Cross-namespace: `redis.other-namespace` (or the FQDN `redis.other-namespace.svc.cluster.local`).

**Mitigate:** `kubectl rollout undo deploy/shipit-api -n gameday`.

**Fix:** set `REDIS_URL=redis://redis:6379` in the chart values (or the FQDN `redis.gameday.svc.cluster.local`, which is unambiguous). Treat config copied from another chart as code: review Service names against `kubectl get svc`.

:::

:::deep The ndots:5 performance trap
Because of `ndots:5`, an **external** name like `api.stripe.com` (2 dots) is first tried as `api.stripe.com.gameday.svc.cluster.local`, `api.stripe.com.svc.cluster.local`, `api.stripe.com.cluster.local` (and often over both A and AAAA) before the real query. That multiplies DNS traffic and adds latency to every new outbound connection, and under load it can overwhelm CoreDNS. Fixes: use a fully qualified name with a trailing dot (`api.stripe.com.`) where the client allows it, lower `ndots` for the pod (`spec.dnsConfig.options: [{ name: ndots, value: "2" }]`), keep connections alive (connection pooling, HTTP keep-alive), and consider NodeLocal DNSCache in large clusters. Node's `dns.lookup` uses the system resolver, so it follows `resolv.conf` exactly like this.
:::

### Postmortem prompt

Why did the readiness probe turn a typo into a stalled rollout rather than an outage? What is the difference between `NXDOMAIN` for a Service and a connection timeout to a Service, in terms of likely cause?

### Verify

All `shipit-api` pods are Ready and `kubectl get deploy shipit-api -n gameday -o jsonpath='{.spec.template.spec.containers[0].env}'` shows `redis://redis:6379`.

### Clean up

```bash
drills/reset.sh
```

## Drill 9: Terraform drift after a night of hotfixes

:::meta
difficulty: medium
time: 30 min
:::

**Page (morning after an incident):** "On-call scaled flags-api and switched on the new checkout UI by hand last night. A teammate is about to run `terraform apply` for an unrelated change. Make sure that apply does not undo or break anything important."

### Setup

Create `drills/tf-drift/main.tf`:

`drills/tf-drift/main.tf`

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.36.0, < 4.0.0"
    }
  }
}

variable "kubeconfig" {
  type    = string
  default = "../../infra/.kube/config"
}

provider "kubernetes" {
  config_path = var.kubeconfig
}

resource "kubernetes_namespace_v1" "drift" {
  metadata {
    name = "drift-demo"
  }
}

resource "kubernetes_config_map_v1" "flags" {
  metadata {
    name      = "feature-flags"
    namespace = kubernetes_namespace_v1.drift.metadata[0].name
  }
  data = {
    greeting        = "hello from terraform"
    new_checkout_ui = "false"
  }
}

resource "kubernetes_deployment_v1" "flags_api" {
  metadata {
    name      = "flags-api"
    namespace = kubernetes_namespace_v1.drift.metadata[0].name
    labels    = { app = "flags-api" }
  }

  spec {
    replicas = 2

    selector {
      match_labels = { app = "flags-api" }
    }

    template {
      metadata {
        labels = { app = "flags-api" }
      }
      spec {
        container {
          name  = "echo"
          image = "hashicorp/http-echo:1.0"
          args  = ["-listen=:5678", "-text=$(GREETING)"]

          env {
            name = "GREETING"
            value_from {
              config_map_key_ref {
                name = kubernetes_config_map_v1.flags.metadata[0].name
                key  = "greeting"
              }
            }
          }

          port {
            container_port = 5678
          }
        }
      }
    }
  }
}
```

```bash
cd ~/code/shipit/drills/tf-drift
terraform init && terraform apply -auto-approve
kubectl get deploy,cm -n drift-demo
```

### Inject

```bash
kubectl -n drift-demo scale deploy flags-api --replicas=4
kubectl -n drift-demo patch configmap feature-flags -p '{"data":{"new_checkout_ui":"true"}}'
kubectl -n drift-demo label deploy flags-api owner=oncall-hotfix
```

### Symptoms

- Nothing is broken. The risk is the next `terraform apply`.

### Investigate

- What exactly differs between the real cluster and the Terraform state/code?
- For each difference: keep it (codify) or revert it? Who decides?
- What would a plain `terraform apply` have done?

:::hint
`terraform plan -refresh-only` shows what changed in the real world since the last apply, without proposing to change anything. A normal `terraform plan` shows what Terraform would do to make reality match the code. Compare both outputs.
:::

:::solution
**What you find:**

```bash
terraform plan -refresh-only
#  ~ kubernetes_config_map_v1.flags: data.new_checkout_ui "false" -> "true"
#  ~ kubernetes_deployment_v1.flags_api: metadata.labels + owner = "oncall-hotfix", spec.replicas 2 -> 4
terraform plan
#  ~ update in-place: replicas 4 -> 2, new_checkout_ui "true" -> "false", remove label owner
```

A blind `terraform apply` would have **scaled flags-api back down to 2 and switched the checkout UI off** in the middle of the morning, silently undoing the incident mitigations. That is how a "routine infra change" causes the second incident.

**Decide per change** (with the people who made them):

| Drift | Decision | Action |
| --- | --- | --- |
| `replicas: 4` | Still needed after the incident? Usually yes until the root cause is fixed | Change code to `replicas = 4` (or, if an HPA manages replicas, add `lifecycle { ignore_changes = [spec[0].replicas] }`) |
| `new_checkout_ui = "true"` | Product decision; if confirmed, keep | Change code to `"true"` |
| label `owner=oncall-hotfix` | Noise | Let Terraform remove it |

After editing `main.tf`:

```bash
terraform plan            # only: remove label owner
terraform apply
terraform plan            # No changes. Your infrastructure matches the configuration.
```

(`terraform apply -refresh-only` is the other tool: it accepts the real-world values into **state** without changing code, useful to record drift before deciding. It does not fix the code, so the next normal plan still proposes reverting.)

**Prevention:** run a scheduled `terraform plan -detailed-exitcode` (exit code 2 means changes) in CI to detect drift daily; make "codify or revert hotfixes" a closing step of every incident; for in-cluster workloads prefer GitOps with self-heal, where drift is corrected or flagged continuously.
:::

### Postmortem prompt

Write the incident-closing checklist item that would have prevented the near miss. Why is `terraform plan` before every apply necessary but not sufficient?

### Verify

`terraform plan` reports no changes, and the cluster still has 4 replicas and `new_checkout_ui: "true"`.

### Clean up

```bash
terraform destroy -auto-approve
cd ~/code/shipit
```

## Drill 10: The state lock nobody holds

:::meta
difficulty: medium
time: 25 min
:::

**Page:** "Every Terraform run fails with 'Error acquiring the state lock'. The CI runner that ran the last apply crashed."

### Setup

An S3-compatible backend with native locking (`use_lockfile = true`), the same setup as in the Terraform track:

```bash
docker network create tfdrill
docker run -d --name tf-minio --network tfdrill -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  pgsty/silo:RELEASE.2026-09-16T00-00-00Z server /data --console-address :9001
sleep 3
# Silo is a maintained MinIO fork (minio/minio left Docker Hub in 2026) and bundles the mc client
mc() { docker exec -e MC_HOST_local=http://minioadmin:minioadmin@127.0.0.1:9000 tf-minio mc "$@"; }
mc mb -p local/tfstate
export AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin
```

Create `drills/tf-lock/main.tf`:

`drills/tf-lock/main.tf`

```hcl
terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket                      = "tfstate"
    key                         = "drills/lock.tfstate"
    region                      = "us-east-1"
    endpoints                   = { s3 = "http://localhost:9000" }
    use_path_style              = true
    use_lockfile                = true # native S3 locking: writes <key>.tflock next to the state
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}

variable "run_id" {
  type    = string
  default = "1"
}

# Stands in for a slow resource (an RDS instance, an EKS node group...).
resource "terraform_data" "slow_change" {
  triggers_replace = var.run_id # a new run_id = a new "slow change"

  provisioner "local-exec" {
    command = "echo 'applying change ${var.run_id}...'; sleep 90; echo done"
  }
}
```

```bash
cd ~/code/shipit/drills/tf-lock
terraform init
terraform apply -auto-approve          # first run takes ~90 s
```

### Inject

```bash
terraform apply -auto-approve -var run_id=2 > /tmp/tf-apply.log 2>&1 &
TF_PID=$!
sleep 15
kill -9 "$TF_PID"                      # the CI runner dies mid-apply
echo "terraform killed"
```

### Symptoms

```bash
terraform plan -var run_id=2
# Error: Error acquiring the state lock
# Lock Info:
#   ID:        3f1c...
#   Path:      tfstate/drills/lock.tfstate
#   Operation: OperationTypeApply
#   Who:       roma@MacBook-Pro.local
#   ...
```

### Investigate

- Is anyone (or anything) actually still running an apply against this state?
- Where does the lock live, and what does it contain?
- What state is the infrastructure in after an apply was killed halfway?

:::hint
Check processes (`pgrep -fl "terraform apply"`) and, in real life, CI runs and teammates. Look at the lock object in the bucket:

```bash
mc ls -r local/tfstate                              # the mc() function from the setup
mc cat local/tfstate/drills/lock.tfstate.tflock
```
:::

:::solution
**Root cause.** With `use_lockfile = true`, Terraform creates `drills/lock.tfstate.tflock` next to the state (a conditional write that fails if the object already exists) and deletes it when the operation ends. `kill -9` gave Terraform no chance to clean up, so the lock object remains and every later run refuses to start. The lock JSON shows the ID, operation, user, host and time, which is how you identify the owner.

**Safe resolution procedure:**

1. **Prove the holder is dead.** No `terraform apply` process (`pgrep` prints nothing), no running CI job for this state, nobody on the team mid-apply. Never skip this: force-unlocking a live apply lets two writers corrupt the state.
2. **Remove the lock:** `terraform force-unlock -force <ID>` with the ID from the error message (without `-force` Terraform asks for confirmation). The `.tflock` object disappears.
3. **Reconcile:** `terraform plan -var run_id=2`. The interrupted change shows up as still pending (the killed apply may have destroyed the old `terraform_data` without finishing the new one). Real resources can be half-created too: check the provider's console/API for orphans, then `terraform apply` or `import` as needed.
4. **Investigate why the runner died** (OOM, timeout, preemption) and make CI timeouts longer than the slowest apply.

```text
$ terraform force-unlock -force 3f1c...
Terraform state has been successfully unlocked!
$ terraform apply -auto-approve -var run_id=2
...
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
```

**Prevention:** serialise CI jobs per state (`concurrency` in GitHub Actions), avoid cancelling running applies (`cancel-in-progress: false` for apply jobs), keep S3 versioning on the state bucket so a corrupted state can be restored, and alert when a lock is older than your longest expected apply. (DynamoDB-based locking is deprecated in favour of `use_lockfile`; the procedure is the same.)
:::

### Postmortem prompt

What evidence did you collect before running `force-unlock`, and what could go wrong if you skipped that step? Which two CI settings would prevent this incident?

### Verify

`terraform plan -var run_id=2` runs without a lock error and, after an apply, reports no changes; `mc ls -r local/tfstate` shows no `.tflock` object.

### Clean up

```bash
terraform destroy -auto-approve
cd ~/code/shipit
docker rm -f tf-minio && docker network rm tfdrill
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

## Drill 11: Helm upgrade failed, then "another operation is in progress"

:::meta
difficulty: medium
time: 25 min
:::

**Page:** "webapp upgrade failed in CI. A colleague retried, cancelled it halfway, and now every Helm command says another operation is in progress."

### Setup

```bash
cd ~/code/shipit
helm create drills/webapp >/dev/null
helm install webapp drills/webapp -n gameday-helm --create-namespace --wait
helm list -n gameday-helm
```

### Inject

```bash
# 1) the failed upgrade
helm upgrade webapp drills/webapp -n gameday-helm \
  --set image.tag=1.99-does-not-exist --wait --timeout 60s
# 2) the cancelled retry
helm upgrade webapp drills/webapp -n gameday-helm --set replicaCount=3 --wait --timeout 120s &
sleep 5; kill -9 $!
# 3) the next attempt
helm upgrade webapp drills/webapp -n gameday-helm --set replicaCount=3
```

### Symptoms

- Step 1 ends with `Error: UPGRADE FAILED: ... context deadline exceeded` (or a resource-not-ready message).
- Step 3 fails with `Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress`.
- Is the app down? Check `kubectl get pods -n gameday-helm`.

### Investigate

- What does Helm think the state of each revision is?
- Which revision was the last good one, and which values did it use?
- What is running right now in the cluster?

:::hint
`helm history webapp -n gameday-helm`, `helm status webapp -n gameday-helm`, `helm get values webapp -n gameday-helm --revision <N>`. Helm stores each revision as a Secret: `kubectl get secrets -n gameday-helm -l owner=helm`.
:::

:::solution
**What happened:**

```text
$ helm history webapp -n gameday-helm
REVISION  STATUS           CHART          DESCRIPTION
1         deployed         webapp-0.1.0   Install complete
2         failed           webapp-0.1.0   Upgrade "webapp" failed: context deadline exceeded
3         pending-upgrade  webapp-0.1.0   Preparing upgrade
```

- Revision 2 set a non-existent image tag; new pods went `ImagePullBackOff`, `--wait` timed out, Helm marked it `failed`. Thanks to the chart's RollingUpdate defaults, the old pod kept serving, but the Deployment still points at the bad image.
- Revision 3 was killed mid-operation, so its release record stayed in `pending-upgrade`. Helm treats any `pending-*` status as a lock: "another operation is in progress".

**Fix:** roll back to the last `deployed` revision. Rollback creates a new revision and clears the pending state:

```bash
helm rollback webapp 1 -n gameday-helm --wait
helm history webapp -n gameday-helm         # 4  deployed  Rollback to 1
kubectl get pods -n gameday-helm            # healthy, image from revision 1
```

If rollback itself refuses (older Helm versions sometimes did), the last-resort fix is to delete the stuck release record (`kubectl delete secret -n gameday-helm sh.helm.release.v1.webapp.v3`) and then roll back. Never `helm uninstall` to "reset": it deletes everything the release owns.

Then apply the intended change properly:

```bash
helm upgrade webapp drills/webapp -n gameday-helm --set replicaCount=3 --wait --rollback-on-failure --timeout 120s
# Helm 3 equivalent flag: --atomic
```

**Prevention:** use `--rollback-on-failure` (Helm 4; `--atomic` in Helm 3) so a failed upgrade reverts itself; make CI job timeouts longer than Helm's `--timeout` so the job never kills Helm mid-operation; serialise deploys per release. GitOps with Argo CD avoids the problem class entirely, because Argo CD renders the chart and applies manifests itself, without Helm release records.
:::

### Postmortem prompt

Which two independent failures happened here, and which one actually blocked recovery? Write the CI change that prevents each.

### Verify

`helm status webapp -n gameday-helm` shows `deployed`, three pods are Running, and `helm upgrade` commands work again.

### Clean up

```bash
helm uninstall webapp -n gameday-helm
kubectl delete namespace gameday-helm
rm -rf drills/webapp
```

## Drill 12 (challenge): Blind game day, intermittent 5xx under load

:::meta
difficulty: hard
time: 45 min
:::

**Page:** "Release 2.0 is out. Since then, error spikes and pod restarts whenever traffic goes up. Quiet periods look fine."

This time the injection is encoded so you cannot read it first. Work it like a real incident, with the full method, and write a complete postmortem using the template from the lesson.

### Inject

```bash
drills/reset.sh
echo 'a3ViZWN0bCAtbiBnYW1lZGF5IHBhdGNoIGRlcGxveSBzaGlwaXQtYXBpIC1wICd7InNwZWMiOnsidGVtcGxhdGUiOnsic3BlYyI6eyJjb250YWluZXJzIjpbeyJuYW1lIjoiYXBpIiwicmVzb3VyY2VzIjp7InJlcXVlc3RzIjp7ImNwdSI6IjEwbSIsIm1lbW9yeSI6IjEyOE1pIn0sImxpbWl0cyI6eyJjcHUiOiIxNW0iLCJtZW1vcnkiOiIyNTZNaSJ9fSwibGl2ZW5lc3NQcm9iZSI6eyJodHRwR2V0Ijp7InBhdGgiOiIvaGVhbHRoeiIsInBvcnQiOiJodHRwIn0sInBlcmlvZFNlY29uZHMiOjIsInRpbWVvdXRTZWNvbmRzIjoxLCJmYWlsdXJlVGhyZXNob2xkIjoxfX1dfX19fScgPi9kZXYvbnVsbCAmJiBlY2hvICJyZWxlYXNlIDIuMCBkZXBsb3llZCIK' | base64 --decode | bash
kubectl -n gameday rollout status deploy/shipit-api --timeout=180s
# traffic arrives:
hey -z 120s -c 20 -host gameday.local http://localhost:8080/items
```

### Requirements

1. Detect: show the error pattern in `watch.sh` and in `hey`'s status code distribution.
2. Triage: quantify impact (error percentage, restarts) and identify what changed.
3. Mitigate within 10 minutes of starting.
4. Find **every** contributing factor (there is more than one) with evidence from the cluster, not from decoding the script.
5. Resolve durably and prove it: the same `hey` run produces only `200`s and no restarts.
6. Write a complete postmortem (template from the lesson) with at least three action items, each with type (prevent/detect/mitigate), owner and date.

### Verify

- `hey -z 120s -c 20 -host gameday.local http://localhost:8080/items` reports `[200]` only.
- `RESTARTS` for the API pods stays constant during and after the load.
- Your postmortem names each contributing factor and the evidence for it.

:::hint
Restarts under load but not at rest point to probes or resources. Compare the live Deployment with the known-good baseline: `kubectl diff -f drills/baseline.yaml` shows exactly what drifted. For evidence of CPU throttling, read the container's cgroup stats: `kubectl exec -n gameday deploy/shipit-api -- cat /sys/fs/cgroup/cpu.stat` (look at `nr_throttled` and `throttled_usec`).
:::

:::solution
**What release 2.0 changed** (`kubectl diff -f drills/baseline.yaml` shows it):

- `resources.limits.cpu: 15m` (and the request lowered to `10m` so the patch is valid): the API may use 1.5% of a CPU.
- `livenessProbe`: `periodSeconds: 2`, `timeoutSeconds: 1`, `failureThreshold: 1`: a single slow `/healthz` answer kills the container.

**The failure chain:**

```text
 load ↑ ─► event loop needs CPU ─► CFS throttles at 15m ─► /healthz takes > 1 s
      ─► one liveness failure = restart (failureThreshold 1)
      ─► fewer pods, each throttled harder ─► more liveness failures ─► restart storm
      ─► Traefik: 502 (connections cut) and 503 (no ready endpoints) bursts
 quiet period ─► CPU needs drop under 15m ─► probes pass ─► "looks fine"
```

**Evidence to collect:**

```bash
kubectl get pods -n gameday -l app=shipit-api                     # RESTARTS climbing during load
kubectl get events -n gameday --sort-by=.lastTimestamp | grep -i liveness
#   Liveness probe failed: Get "http://10.244.1.7:3000/healthz": context deadline exceeded
kubectl exec -n gameday deploy/shipit-api -- cat /sys/fs/cgroup/cpu.stat
#   nr_throttled 1834   throttled_usec 98213456                     <- heavy throttling
kubectl top pods -n gameday                                       # CPU pinned at ~15m
kubectl diff -f drills/baseline.yaml                              # the two changes
kubectl rollout history deploy/shipit-api -n gameday              # the release that introduced them
```

**Mitigate:** `kubectl rollout undo deploy/shipit-api -n gameday` (both settings are in the pod template, so undo restores them), or `kubectl apply -f drills/baseline.yaml`.

**Durable fix and reasoning:**

- **No CPU limit** for latency-sensitive Node services (or a generous one); set an honest CPU **request** instead. Throttling a single-threaded event loop stalls every request on that pod, including health checks.
- **Liveness tuned to detect deadlock, not slowness:** `periodSeconds: 10`, `timeoutSeconds: 2–5`, `failureThreshold: 3` at least. A liveness probe that fails under load converts overload into restarts, which reduces capacity and makes the overload worse: a self-amplifying failure.
- **Readiness** is the right tool to shed load from a struggling pod, because it removes the pod from rotation without restarting it.

**Example action items:**

| Action | Type | Owner | Due |
| --- | --- | --- | --- |
| Restore baseline probe and resource settings in the chart; add a comment explaining why | Prevent | Roma | +1 day |
| CI policy: reject `livenessProbe.failureThreshold < 3` and CPU limits below the request on user-facing Deployments | Prevent | Roma | +1 week |
| Alert on container restarts > 3 in 10 min and on CPU throttling ratio > 25% | Detect | Roma | +1 week |
| Load test (hey/k6) as part of the release checklist for resource or probe changes | Detect | Roma | +2 weeks |
:::

### Clean up

```bash
drills/reset.sh                     # or remove the drills namespace entirely:
kubectl delete namespace gameday
```
