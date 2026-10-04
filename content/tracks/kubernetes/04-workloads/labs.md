These labs exercise every workload controller: you will watch rolling updates step by step, rescue a stuck rollout, run blue/green and canary releases, give pods stable identities with a StatefulSet, run batch work with Jobs and CronJobs, and finish by deploying the full shipit stack.

**Prerequisites:** the `lab` kind cluster from module 02 (three nodes, NodePort 30080/30081 mapped to localhost). If you need to recreate it:

```bash
cd ~/k8s-labs/02 && kind create cluster --config kind-lab.yaml
```

Set up a namespace for this module:

```bash
mkdir -p ~/k8s-labs/04 && cd ~/k8s-labs/04
kubectl create namespace workloads
kubectl config set-context --current --namespace=workloads
```

## Lab 1: Rolling updates step by step

:::meta
difficulty: easy
time: 30 min
:::

Goal: observe how `maxSurge`, `maxUnavailable` and `minReadySeconds` shape a rollout, then use history, undo, pause/resume and the Recreate strategy.

### Steps

1. Create a Deployment with 4 replicas and a slow-ish rollout so you can see each step:

```bash
cat > web.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  annotations:
    kubernetes.io/change-cause: "initial: nginx 1.26"
spec:
  replicas: 4
  revisionHistoryLimit: 5
  minReadySeconds: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: nginx
          image: nginx:1.26-alpine
          readinessProbe:
            httpGet: { path: /, port: 80 }
            periodSeconds: 2
EOF
kubectl apply -f web.yaml
kubectl rollout status deploy/web
```

2. In a second terminal, watch ReplicaSets:

```bash
kubectl -n workloads get rs -l app=web -w
```

3. In the first terminal, roll out a new image and record why:

```bash
kubectl set image deploy/web nginx=nginx:1.27-alpine
kubectl annotate deploy/web kubernetes.io/change-cause="bump nginx to 1.27" --overwrite
kubectl rollout status deploy/web
```

4. Inspect history and roll back:

```bash
kubectl rollout history deploy/web
kubectl rollout history deploy/web --revision=1 | grep -i image
kubectl rollout undo deploy/web
kubectl rollout status deploy/web
kubectl rollout history deploy/web
kubectl get deploy web -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

5. Batch several changes into one rollout with pause/resume:

```bash
kubectl rollout pause deploy/web
kubectl set image deploy/web nginx=nginx:1.27-alpine
kubectl set env deploy/web GREETING=hello
kubectl set resources deploy/web -c nginx --requests=cpu=10m,memory=16Mi
kubectl get rs -l app=web           # nothing new yet
kubectl rollout resume deploy/web
kubectl rollout status deploy/web
kubectl rollout history deploy/web
```

6. Switch to the Recreate strategy and compare:

```bash
kubectl patch deploy web -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'
kubectl set image deploy/web nginx=nginx:1.26-alpine
kubectl get pods -l app=web -w      # Ctrl+C when 4 new pods are Running
```

### Verify

- During step 3, the watch shows the new ReplicaSet going 1 → 2 → 3 → 4 while the old one goes 4 → 3 → 2 → 1 → 0, and the total never exceeds 5.
- After undo, the image is back to `nginx:1.26-alpine` and history shows a new revision number (the old revision 1 disappears from the list because it was reused).
- After resume, only **one** new revision was created for three changes.
- With Recreate, all old pods terminate before any new pod is created.

:::hint
With `maxSurge: 1` and `maxUnavailable: 0`, the controller can only add one extra pod and must wait for it to be available (Ready for 5 s because of `minReadySeconds`) before removing an old one. For the Recreate patch, `rollingUpdate` must be removed (set to `null`) or the API server rejects the change.
:::

:::solution
Expected watch output for step 3 (abbreviated):

```text
NAME             DESIRED   CURRENT   READY
web-6b9c...      4         4         4      # v1.26
web-7f4d...      1         1         0      # v1.27 created, surge 1
web-7f4d...      1         1         1
web-6b9c...      3         4         4      # after minReadySeconds, scale old down
web-6b9c...      3         3         3
web-7f4d...      2         2         1
...
web-7f4d...      4         4         4
web-6b9c...      0         0         0      # kept for rollback
```

- `rollout undo` copies revision 1's template into the Deployment. Since that template already has a ReplicaSet, the controller scales that ReplicaSet back up and gives it a new revision number (3). Revision numbers are stored as the `deployment.kubernetes.io/revision` annotation on ReplicaSets.
- Paused Deployments accept spec changes but the controller does not act on template changes until resumed.
- Recreate scales the old ReplicaSet to 0, waits for all old pods to terminate, then scales the new one up. You see a short period with zero pods: downtime.
:::

### Clean up

```bash
kubectl delete deploy web
```

## Lab 2: Break & fix — the rollout that never finishes

:::meta
difficulty: medium
time: 30 min
:::

Goal: diagnose two kinds of stuck rollouts, see how `maxUnavailable: 0` and readiness protect users, and recover.

### Steps

1. Deploy a healthy version (http-echo prints a version string):

```bash
cat > api.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  progressDeadlineSeconds: 45
  strategy:
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: echo
          image: hashicorp/http-echo
          args: ["-text=api v1", "-listen=:8080"]
          readinessProbe:
            httpGet: { path: /, port: 8080 }
            periodSeconds: 2
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: NodePort
  selector: { app: api }
  ports:
    - { port: 80, targetPort: 8080, nodePort: 30080 }
EOF
kubectl apply -f api.yaml
kubectl rollout status deploy/api
curl -s localhost:30080
```

2. Start a traffic loop in a second terminal and leave it running:

```bash
while true; do curl -s -m 1 -o /dev/null -w '%{http_code}\n' localhost:30080; sleep 0.2; done | uniq -c
```

3. Break it, version A (a colleague "released v2"):

```bash
kubectl set image deploy/api echo=hashicorp/http-echo:v2.0-does-not-exist
kubectl rollout status deploy/api --timeout=90s; echo "exit code: $?"
```

4. Diagnose: what state are the pods and the Deployment in? Is the traffic loop still printing `200`? Then recover.

5. Break it, version B (the image exists but the new version listens on a different port):

```bash
kubectl patch deploy api --type json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args","value":["-text=api v2","-listen=:9090"]}]'
kubectl rollout status deploy/api --timeout=90s; echo "exit code: $?"
```

6. Diagnose and recover again.

### Verify

- Both times `kubectl rollout status` exits non-zero with `exceeded its progress deadline`.
- The traffic loop kept printing `200` throughout (no errors).
- After recovery, `kubectl get deploy api` shows `3/3` and `curl localhost:30080` prints `api v1`.

:::hint
Look at `kubectl get rs,pods -l app=api`, `kubectl describe deploy api` (Conditions section), and `kubectl describe pod` for the new pods. How many new pods were created, and why only that many? What does readiness do to a pod that listens on the wrong port?
:::

:::solution
Version A diagnosis:

```bash
kubectl get rs,pods -l app=api
# old RS 3/3 ready, new RS 1 pod in ImagePullBackOff
kubectl describe deploy api | sed -n '/Conditions:/,/OldReplicaSets/p'
# Progressing  False  ProgressDeadlineExceeded
kubectl describe pod -l app=api | grep -E 'Failed|not found' | head -3
```

Only one new pod exists because `maxSurge: 1`; with `maxUnavailable: 0` the controller may not remove any old pod until a new one is available, which never happens. Users are unaffected because all 3 old pods keep serving.

Version B diagnosis:

```bash
kubectl get pods -l app=api
# new pod Running but 0/1 READY
kubectl describe pod <new-pod> | grep -A2 Readiness
# Readiness probe failed: ... connect: connection refused   (probe hits 8080, app listens on 9090)
```

The container runs fine, so a liveness-only setup (or no probes) would have marked it available and continued the rollout, replacing every good pod with a broken one. Readiness stopped it.

Recovery (both cases):

```bash
kubectl rollout undo deploy/api
kubectl rollout status deploy/api
curl -s localhost:30080
```

Notes:

- Kubernetes never rolls back automatically. `ProgressDeadlineExceeded` is a signal for your pipeline (`rollout status` exit code) or your progressive-delivery tool.
- With the default `maxUnavailable: 25%` and 3 replicas, it rounds down to 0, so the result would have been the same here. With 4 replicas, one old pod would have been removed immediately, costing 25% capacity during the incident.
- Remember to fix the manifest in git too; otherwise the next apply reintroduces the bad version.
:::

### Clean up

Stop the traffic loop with Ctrl+C.

```bash
kubectl delete -f api.yaml
```

## Lab 3: Blue/green and canary with labels

:::meta
difficulty: medium
time: 30 min
:::

Goal: implement a blue/green switch and a ~25% canary using only Deployments, labels and a Service selector.

### Steps

1. Create blue and green Deployments and a Service pointing at blue:

```bash
cat > bluegreen.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: shop-blue }
spec:
  replicas: 3
  selector: { matchLabels: { app: shop, color: blue } }
  template:
    metadata: { labels: { app: shop, color: blue } }
    spec:
      containers:
        - name: echo
          image: hashicorp/http-echo
          args: ["-text=BLUE v1", "-listen=:8080"]
          readinessProbe: { httpGet: { path: /, port: 8080 }, periodSeconds: 2 }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: shop-green }
spec:
  replicas: 3
  selector: { matchLabels: { app: shop, color: green } }
  template:
    metadata: { labels: { app: shop, color: green } }
    spec:
      containers:
        - name: echo
          image: hashicorp/http-echo
          args: ["-text=GREEN v2", "-listen=:8080"]
          readinessProbe: { httpGet: { path: /, port: 8080 }, periodSeconds: 2 }
---
apiVersion: v1
kind: Service
metadata: { name: shop }
spec:
  type: NodePort
  selector: { app: shop, color: blue }
  ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }]
---
apiVersion: v1
kind: Service
metadata: { name: shop-preview }
spec:
  type: NodePort
  selector: { app: shop, color: green }
  ports: [{ port: 80, targetPort: 8080, nodePort: 30081 }]
EOF
kubectl apply -f bluegreen.yaml
kubectl wait --for=condition=Available deploy --all --timeout=90s
curl -s localhost:30080; curl -s localhost:30081
```

2. "Test" green on the preview port, then switch production traffic and roll back:

```bash
for i in $(seq 5); do curl -s localhost:30081; done
kubectl patch svc shop -p '{"spec":{"selector":{"app":"shop","color":"green"}}}'
for i in $(seq 5); do curl -s localhost:30080; done
kubectl patch svc shop -p '{"spec":{"selector":{"app":"shop","color":"blue"}}}'
curl -s localhost:30080
```

3. Turn it into a canary: make the Service select only `app=shop`, then size the Deployments so about 25% of traffic hits green:

```bash
kubectl patch svc shop --type json -p '[{"op":"remove","path":"/spec/selector/color"}]'
kubectl scale deploy shop-blue --replicas=3
kubectl scale deploy shop-green --replicas=1
kubectl wait --for=condition=Available deploy --all --timeout=60s
for i in $(seq 200); do curl -s -H 'Connection: close' localhost:30080; done | sort | uniq -c
```

4. Promote the canary: scale green up and blue down.

```bash
kubectl scale deploy shop-green --replicas=3
kubectl wait --for=condition=Available deploy/shop-green --timeout=60s
kubectl scale deploy shop-blue --replicas=0
for i in $(seq 50); do curl -s -H 'Connection: close' localhost:30080; done | sort | uniq -c
```

### Verify

- Step 2: production flips from `BLUE v1` to `GREEN v2` instantly, and back.
- Step 3: roughly 150 BLUE and 50 GREEN out of 200 (it varies).
- Step 4: 100% GREEN.

:::hint
`kubectl get endpointslices -l kubernetes.io/service-name=shop -o wide` shows which pod IPs the Service currently targets. The canary percentage is approximately `green replicas / total replicas` because kube-proxy picks a backend at random per connection.
:::

:::solution
- A Service has no idea about Deployments: it routes to every Ready pod whose labels match its selector. Changing the selector re-targets traffic within a second or two (EndpointSlices update, kube-proxy reprograms rules).
- Blue/green: both versions run at full size; the switch and the rollback are a single selector patch. The preview Service lets you smoke-test green before switching.
- Canary: one selector that matches both Deployments; the ratio of Ready pods sets the split. 1 of 4 pods ≈ 25%. Precise percentages require more replicas or an L7 router (Gateway API `HTTPRoute` weights, a mesh, Argo Rollouts).
- In production you would watch error rate and latency per `color`/`track` label before promoting, and both versions must share a compatible database schema.
:::

### Clean up

```bash
kubectl delete -f bluegreen.yaml
```

## Lab 4: StatefulSet — stable identity, DNS and storage

:::meta
difficulty: medium
time: 35 min
:::

Goal: see ordered creation, per-pod DNS through a headless Service, per-pod PVCs that survive pod deletion and scale-down, and a partitioned rolling update.

### Steps

1. Create a headless Service and a StatefulSet. An init container writes the pod's identity to its own volume the first time it starts:

```bash
cat > sts.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  clusterIP: None
  selector: { app: web-sts }
  ports: [{ name: http, port: 80 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: web }
spec:
  serviceName: web
  replicas: 3
  selector: { matchLabels: { app: web-sts } }
  template:
    metadata: { labels: { app: web-sts } }
    spec:
      initContainers:
        - name: init-page
          image: busybox:1.37
          command: ["sh", "-c", "[ -f /data/index.html ] || echo \"$(hostname) first booted at $(date -Iseconds)\" > /data/index.html"]
          volumeMounts: [{ name: data, mountPath: /data }]
      containers:
        - name: nginx
          image: nginx:1.26-alpine
          ports: [{ name: http, containerPort: 80 }]
          readinessProbe: { httpGet: { path: /, port: 80 }, periodSeconds: 2 }
          volumeMounts: [{ name: data, mountPath: /usr/share/nginx/html }]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: { requests: { storage: 100Mi } }
EOF
kubectl apply -f sts.yaml
kubectl get pods -l app=web-sts -w     # Ctrl+C when all 3 are Ready
```

2. Look at the identities, PVCs and DNS:

```bash
kubectl get pods,pvc -l app=web-sts -o wide
kubectl get pvc
kubectl run dns --image=busybox:1.37 --rm -it --restart=Never -- sh -c '
  nslookup web.workloads.svc.cluster.local;
  nslookup web-1.web.workloads.svc.cluster.local;
  wget -qO- web-0.web; wget -qO- web-1.web; wget -qO- web-2.web'
```

3. Delete `web-1` and check what comes back:

```bash
kubectl delete pod web-1
kubectl get pods -l app=web-sts -w     # Ctrl+C when web-1 is Ready again
kubectl exec web-1 -- cat /usr/share/nginx/html/index.html
```

4. Scale down and up:

```bash
kubectl scale sts web --replicas=1
kubectl get pods,pvc -l app=web-sts
kubectl scale sts web --replicas=3
kubectl rollout status sts/web
kubectl exec web-2 -- cat /usr/share/nginx/html/index.html
```

5. Partitioned rolling update (a stateful canary): only update ordinals ≥ 2.

```bash
kubectl patch sts web -p '{"spec":{"updateStrategy":{"type":"RollingUpdate","rollingUpdate":{"partition":2}}}}'
kubectl set image sts/web nginx=nginx:1.27-alpine
kubectl rollout status sts/web --timeout=60s
kubectl get pods -l app=web-sts -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image
kubectl patch sts web -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":0}}}}'
kubectl rollout status sts/web
kubectl get pods -l app=web-sts -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image
```

### Verify

- Pods were created in order `web-0`, `web-1`, `web-2`, each after the previous was Ready.
- `nslookup web` returns 3 pod IPs (no single ClusterIP); `web-1.web` returns one IP.
- After deleting `web-1`, the new `web-1` shows the **original** "first booted" timestamp.
- After scaling to 1, all three PVCs still exist; after scaling back, `web-2` has its old content.
- With `partition: 2`, only `web-2` runs nginx 1.27 until you lower the partition.

:::hint
PVC names follow `<volumeClaimTemplate name>-<pod name>`, e.g. `data-web-1`. kind's default StorageClass (`standard`, local-path provisioner) creates the volume on the node where the pod first runs, so the pod will be rescheduled to that same node.
:::

:::solution
- Ordered creation is `podManagementPolicy: OrderedReady` (default). `Parallel` creates/deletes all pods at once while keeping identities.
- Headless Service DNS: `web.workloads.svc.cluster.local` returns A records for all Ready pods; `web-N.web.workloads.svc.cluster.local` resolves a specific pod. This is how database replicas or Kafka brokers find each other.
- The replacement `web-1` re-binds `data-web-1`, so the init container sees the existing file and keeps the original timestamp. With local-path storage the volume lives on one node, and the PV's node affinity forces the pod back to that node.
- `persistentVolumeClaimRetentionPolicy` defaults to `Retain` for both `whenScaled` and `whenDeleted`, so PVCs survive scale-down and deletion.
- `partition: 2` means "only pods with ordinal ≥ 2 get the new template". The StatefulSet's `status.updateRevision` vs `currentRevision` shows the two revisions. Lowering the partition to 0 rolls the rest, highest ordinal first.
:::

### Clean up

```bash
kubectl delete -f sts.yaml
kubectl delete pvc -l app=web-sts
```

## Lab 5: Jobs, CronJobs and DaemonSets

:::meta
difficulty: medium
time: 35 min
:::

Goal: run parallel and indexed Jobs, watch retries and failure, schedule a CronJob with a time zone and concurrency policy, and run a DaemonSet on every node.

### Steps

1. An indexed Job processing 6 "shards", 2 at a time:

```bash
cat > indexed-job.yaml <<'EOF'
apiVersion: batch/v1
kind: Job
metadata: { name: shards }
spec:
  completions: 6
  parallelism: 2
  completionMode: Indexed
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: worker
          image: busybox:1.37
          command: ["sh", "-c", "echo processing shard $JOB_COMPLETION_INDEX on $(hostname); sleep 5"]
EOF
kubectl apply -f indexed-job.yaml
kubectl get pods -l job-name=shards -w     # Ctrl+C when 6 are Completed
kubectl get job shards
for p in $(kubectl get pods -l job-name=shards -o name); do kubectl logs "$p"; done | sort
```

2. A Job that always fails, to see retries and the failure condition:

```bash
cat > failing-job.yaml <<'EOF'
apiVersion: batch/v1
kind: Job
metadata: { name: flaky }
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: main
          image: busybox:1.37
          command: ["sh", "-c", "echo trying; exit 1"]
EOF
kubectl apply -f failing-job.yaml
kubectl get pods -l job-name=flaky -w      # Ctrl+C after 3 pods have failed
kubectl describe job flaky | sed -n '/Conditions:/,$p'
```

3. A CronJob that runs every minute, takes 90 seconds, and must not overlap:

```bash
cat > cron.yaml <<'EOF'
apiVersion: batch/v1
kind: CronJob
metadata: { name: report }
spec:
  schedule: "* * * * *"
  timeZone: "Asia/Tbilisi"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 2
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: report
              image: busybox:1.37
              command: ["sh", "-c", "echo report started at $(date); sleep 90; echo done"]
EOF
kubectl apply -f cron.yaml
kubectl get cronjob report
sleep 200
kubectl get jobs --sort-by=.metadata.creationTimestamp
kubectl get events --field-selector involvedObject.name=report --sort-by=.metadata.creationTimestamp | tail
```

4. Trigger a run manually and suspend the CronJob:

```bash
kubectl create job report-manual --from=cronjob/report
kubectl patch cronjob report -p '{"spec":{"suspend":true}}'
kubectl get cronjob report
```

5. A DaemonSet that runs on every node, including the control plane:

```bash
cat > ds.yaml <<'EOF'
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: node-info }
spec:
  selector: { matchLabels: { app: node-info } }
  template:
    metadata: { labels: { app: node-info } }
    spec:
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: info
          image: busybox:1.37
          env:
            - name: NODE_NAME
              valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
          command: ["sh", "-c", "while true; do echo running on $NODE_NAME; sleep 30; done"]
          resources:
            requests: { cpu: 5m, memory: 8Mi }
EOF
kubectl apply -f ds.yaml
kubectl rollout status ds/node-info
kubectl get pods -l app=node-info -o wide
```

6. Remove the toleration and see what happens:

```bash
kubectl patch ds node-info --type json -p '[{"op":"remove","path":"/spec/template/spec/tolerations"}]'
kubectl rollout status ds/node-info
kubectl get pods -l app=node-info -o wide
```

### Verify

- `shards`: 6 completions, logs show indexes 0–5 exactly once, and never more than 2 pods running at once.
- `flaky`: 3 failed pods (1 + 2 retries), condition `Failed` with reason `BackoffLimitExceeded`.
- `report`: while a run is active, the next minute's run is skipped, so Jobs start roughly every 2 minutes, not every minute.
- `node-info`: 3 pods (one per node) with the toleration, 2 pods (workers only) without it.

:::hint
Job pods carry the label `job-name=<job>`. For the CronJob, compare Job creation times with `kubectl get jobs --sort-by=.metadata.creationTimestamp`. The control-plane node has a `NoSchedule` taint (`kubectl describe node lab-control-plane | grep Taints`).
:::

:::solution
- Indexed Jobs give each pod `JOB_COMPLETION_INDEX` and a hostname like `shards-3-xxxxx`. The Job is complete when every index has one successful pod. `parallelism: 2` caps concurrent pods.
- `backoffLimit: 2` allows two retries; with `restartPolicy: Never` each retry is a new pod, so you can read each failure's logs. Retry delays grow exponentially.
- `concurrencyPolicy: Forbid` skips a scheduled run while the previous Job is still active (events show the skip as `JobAlreadyActive` or simply no new Job). With `Allow` you would have overlapping runs; with `Replace` each new run would kill the previous one, and with a 90 s job and a 60 s schedule nothing would ever finish.
- `timeZone: Asia/Tbilisi` makes the schedule use Tbilisi time (UTC+4) instead of the controller's time zone; for a `* * * * *` schedule it makes no visible difference, but for `0 9 * * *` it decides whether the job runs at 09:00 local or 13:00 local.
- `kubectl create job --from=cronjob/...` copies the jobTemplate: the standard way to test or re-run a CronJob by hand.
- A DaemonSet ignores the scheduler's normal spread and simply targets every eligible node. Without the toleration the control-plane taint makes that node ineligible, and the DaemonSet controller removes the pod there.
:::

### Clean up

```bash
kubectl delete -f indexed-job.yaml -f failing-job.yaml -f cron.yaml -f ds.yaml --ignore-not-found
kubectl delete job report-manual --ignore-not-found
```

## Lab 6: Challenge — deploy shipit-api with Postgres and Redis

:::meta
difficulty: hard
time: 60–90 min
:::

Goal: run the full shipit stack on kind using the right controller for each piece, with a migration Job and a zero-downtime rolling update. Requirements only; a full solution follows.

### The app

If you built `shipit-api` in the Docker track, reuse it (make sure it has a `dist/migrate.js` or adapt the Job). Otherwise create this minimal version:

```bash
mkdir -p ~/k8s-labs/04/shipit-api/src && cd ~/k8s-labs/04/shipit-api
cat > package.json <<'EOF'
{
  "name": "shipit-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc", "start": "node dist/index.js" },
  "dependencies": { "express": "^5.1.0", "pg": "^8.13.0", "redis": "^4.7.0" },
  "devDependencies": { "typescript": "^5.6.0", "@types/express": "^5.0.0", "@types/pg": "^8.11.0", "@types/node": "^22.0.0" }
}
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "outDir": "dist", "strict": true, "esModuleInterop": true, "skipLibCheck": true
  },
  "include": ["src"]
}
EOF
cat > src/migrate.ts <<'EOF'
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(`CREATE TABLE IF NOT EXISTS items (
  id serial PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
console.log('migration complete');
await pool.end();
EOF
cat > src/index.ts <<'EOF'
import express from 'express';
import os from 'node:os';
import pg from 'pg';
import { createClient } from 'redis';

const port = Number(process.env.PORT ?? 3000);
const version = process.env.APP_VERSION ?? 'dev';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('redis error:', err.message));

const app = express();
app.use(express.json());

app.get('/', (_req, res) => { res.json({ app: 'shipit-api', version, pod: os.hostname() }); });
app.get('/healthz', (_req, res) => { res.send('ok'); });
app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.send('ready');
  } catch (err) {
    res.status(503).send(`not ready: ${(err as Error).message}`);
  }
});
app.get('/items', async (_req, res) => {
  const cached = await redis.get('items');
  if (cached) { res.set('x-cache', 'hit').json(JSON.parse(cached)); return; }
  const { rows } = await pool.query('SELECT id, name, created_at FROM items ORDER BY id');
  await redis.set('items', JSON.stringify(rows), { EX: 30 });
  res.set('x-cache', 'miss').json(rows);
});
app.post('/items', async (req, res) => {
  const { rows } = await pool.query(
    'INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at', [req.body?.name ?? 'unnamed']);
  await redis.del('items');
  res.status(201).json(rows[0]);
});

await redis.connect();
const server = app.listen(port, () => console.log(`shipit-api ${version} listening on ${port}`));

process.on('SIGTERM', () => {
  console.log('SIGTERM received, draining');
  server.close(async () => {
    await pool.end();
    await redis.quit();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
});
EOF
cat > Dockerfile <<'EOF'
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
EOF
docker build -t shipit-api:1.0.0 .
kind load docker-image shipit-api:1.0.0 --name lab
cd ..
```

### Requirements

1. Everything lives in a namespace `shipit`.
2. **Postgres** (`postgres:17-alpine`) runs as a StatefulSet with 1 replica, a headless Service `postgres`, a 1Gi PVC from a `volumeClaimTemplate`, credentials from a Secret, and a `pg_isready` readiness probe.
3. **Redis** (`redis:7-alpine`, cache only, no persistence) runs as a Deployment with a ClusterIP Service `redis`.
4. A **Job** `shipit-migrate` runs `node dist/migrate.js` once Postgres is ready, with `backoffLimit: 4` and `ttlSecondsAfterFinished: 300`.
5. **shipit-api** runs as a Deployment with 3 replicas, `maxUnavailable: 0`, `maxSurge: 1`, liveness on `/healthz`, readiness on `/readyz`, resource requests and a memory limit, `APP_VERSION` set, `DATABASE_URL` from the Secret, `REDIS_URL` as an env var, and a 5-second preStop sleep.
6. A NodePort Service on `30080` exposes the API so `curl localhost:30080/items` works from your Mac.
7. Build `shipit-api:1.1.0` (same code, `APP_VERSION=1.1.0`), roll it out while a curl loop hits `/items`, and show zero non-200 responses.
8. Prove self-healing for the database: delete `postgres-0`, observe the API pods go unready and come back, and confirm the items you created still exist.

### Verify

- `kubectl -n shipit get sts,deploy,job,svc,pvc` shows everything healthy and the Job `Complete`.
- `curl -X POST localhost:30080/items -H 'content-type: application/json' -d '{"name":"first"}'` returns 201, and `curl localhost:30080/items` lists it (second call has header `x-cache: hit`).
- The rollout loop prints only `200`.
- After deleting `postgres-0`, items are still there.

:::hint
Order matters: Secret → Postgres → wait for `postgres-0` Ready → migration Job → `kubectl wait --for=condition=Complete job/shipit-migrate` → Redis → API. The database host from the API's point of view is the Service name `postgres` (or `postgres-0.postgres` for that specific pod). For the rollout, `kubectl rollout restart` is not enough: change the image tag and `APP_VERSION`.
:::

:::solution
`shipit.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: shipit }
---
apiVersion: v1
kind: Secret
metadata: { name: shipit-db, namespace: shipit }
type: Opaque
stringData:
  POSTGRES_USER: shipit
  POSTGRES_PASSWORD: shipit-dev-password
  POSTGRES_DB: shipit
  DATABASE_URL: postgres://shipit:shipit-dev-password@postgres:5432/shipit
---
apiVersion: v1
kind: Service
metadata: { name: postgres, namespace: shipit }
spec:
  clusterIP: None
  selector: { app: postgres }
  ports: [{ name: pg, port: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres, namespace: shipit }
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:17-alpine
          env:
            - { name: POSTGRES_USER, valueFrom: { secretKeyRef: { name: shipit-db, key: POSTGRES_USER } } }
            - { name: POSTGRES_PASSWORD, valueFrom: { secretKeyRef: { name: shipit-db, key: POSTGRES_PASSWORD } } }
            - { name: POSTGRES_DB, valueFrom: { secretKeyRef: { name: shipit-db, key: POSTGRES_DB } } }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          ports: [{ name: pg, containerPort: 5432 }]
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "shipit", "-d", "shipit"] }
            periodSeconds: 5
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 512Mi }
          volumeMounts: [{ name: data, mountPath: /var/lib/postgresql/data }]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: { requests: { storage: 1Gi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: redis, namespace: shipit }
spec:
  replicas: 1
  selector: { matchLabels: { app: redis } }
  template:
    metadata: { labels: { app: redis } }
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          args: ["--save", "", "--appendonly", "no"]
          ports: [{ containerPort: 6379 }]
          readinessProbe:
            exec: { command: ["redis-cli", "ping"] }
            periodSeconds: 5
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
---
apiVersion: v1
kind: Service
metadata: { name: redis, namespace: shipit }
spec:
  selector: { app: redis }
  ports: [{ port: 6379, targetPort: 6379 }]
```

`migrate-job.yaml`:

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: shipit-migrate, namespace: shipit }
spec:
  backoffLimit: 4
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: shipit-api:1.0.0
          command: ["node", "dist/migrate.js"]
          env:
            - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: shipit-db, key: DATABASE_URL } } }
```

`api.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shipit-api
  namespace: shipit
  labels: { app.kubernetes.io/name: shipit-api }
spec:
  replicas: 3
  revisionHistoryLimit: 5
  minReadySeconds: 3
  strategy:
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
  selector:
    matchLabels: { app.kubernetes.io/name: shipit-api }
  template:
    metadata:
      labels: { app.kubernetes.io/name: shipit-api }
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: api
          image: shipit-api:1.0.0
          ports: [{ name: http, containerPort: 3000 }]
          env:
            - { name: APP_VERSION, value: "1.0.0" }
            - { name: PORT, value: "3000" }
            - { name: REDIS_URL, value: "redis://redis:6379" }
            - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: shipit-db, key: DATABASE_URL } } }
            - { name: NODE_OPTIONS, value: "--max-old-space-size=192" }
          resources:
            requests: { cpu: 50m, memory: 96Mi }
            limits: { memory: 256Mi }
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 3
            failureThreshold: 2
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
---
apiVersion: v1
kind: Service
metadata: { name: shipit-api, namespace: shipit }
spec:
  type: NodePort
  selector: { app.kubernetes.io/name: shipit-api }
  ports: [{ port: 80, targetPort: http, nodePort: 30080 }]
```

Deploy in order:

```bash
kubectl apply -f shipit.yaml
kubectl -n shipit wait --for=condition=Ready pod/postgres-0 --timeout=120s
kubectl apply -f migrate-job.yaml
kubectl -n shipit wait --for=condition=Complete job/shipit-migrate --timeout=120s
kubectl -n shipit logs job/shipit-migrate
kubectl apply -f api.yaml
kubectl -n shipit rollout status deploy/shipit-api
curl -s -X POST localhost:30080/items -H 'content-type: application/json' -d '{"name":"first"}'; echo
curl -si localhost:30080/items | grep -iE 'x-cache|^\['
curl -si localhost:30080/items | grep -iE 'x-cache'
```

Zero-downtime rollout:

```bash
cd shipit-api && docker build -t shipit-api:1.1.0 . && kind load docker-image shipit-api:1.1.0 --name lab && cd ..
# terminal 2:
while true; do curl -s -m 2 -o /dev/null -w '%{http_code}\n' localhost:30080/items; sleep 0.1; done | uniq -c
# terminal 1:
kubectl -n shipit set image deploy/shipit-api api=shipit-api:1.1.0
kubectl -n shipit set env deploy/shipit-api APP_VERSION=1.1.0
kubectl -n shipit rollout status deploy/shipit-api
curl -s localhost:30080/
```

(Better: change both in `api.yaml` and `kubectl apply` once, so you get one rollout instead of two and git stays the source of truth.)

What makes it zero-downtime: readiness gates new pods, `maxUnavailable: 0` keeps full capacity, the preStop sleep lets endpoints update before shutdown, and the SIGTERM handler drains in-flight requests.

Database self-healing:

```bash
kubectl -n shipit delete pod postgres-0
kubectl -n shipit get pods -w
# shipit-api pods drop to 0/1 READY (readyz fails), postgres-0 is recreated with the same PVC,
# then the API pods become Ready again without restarting (liveness never failed).
curl -s localhost:30080/items
```

The API pods were not restarted because `/healthz` does not check the database: only readiness reacted. The items survive because `postgres-0` re-attached `data-postgres-0`.
:::

### Clean up

```bash
kubectl delete namespace shipit
kubectl delete namespace workloads
kubectl config set-context --current --namespace=default
```

(Deleting the namespace also deletes the PVC `data-postgres-0` inside it.)
