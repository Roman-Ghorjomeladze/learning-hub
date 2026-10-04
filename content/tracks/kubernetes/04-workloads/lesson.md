You never want to manage pods one by one. Workload controllers take a **pod template** plus a policy ("keep 3 running", "one per node", "run until 5 succeed") and reconcile pods for you. This module covers every built-in workload controller, how each one behaves during updates and failures, and how to pick between them.

## The common shape

Every workload controller has the same core:

```yaml
spec:
  selector:            # which pods belong to me (must match template labels)
    matchLabels: { app.kubernetes.io/name: shipit-api }
  template:            # the pod I create (a full pod spec without apiVersion/kind)
    metadata:
      labels: { app.kubernetes.io/name: shipit-api }
    spec:
      containers: [ ... ]
  # ... plus controller-specific policy: replicas, strategy, completions, schedule ...
```

| Controller | Policy | Typical workloads |
| --- | --- | --- |
| ReplicaSet | Keep N identical pods | (used by Deployments, not directly) |
| Deployment | N identical pods + rolling updates and rollbacks | Stateless APIs, web frontends, workers |
| StatefulSet | N pods with stable names, ordering and per-pod storage | Databases, Kafka, ZooKeeper, Redis clusters |
| DaemonSet | One pod per (matching) node | Log/metrics agents, CNI, CSI node plugins |
| Job | Run pods until N succeed | Migrations, batch processing, backfills |
| CronJob | Create Jobs on a schedule | Nightly reports, cleanups, backups |

## ReplicaSet

A ReplicaSet keeps `replicas` pods matching its selector running. That is all it does: if you change its pod template, **existing pods are not updated**; only newly created pods use the new template. That is why you do not use ReplicaSets directly. A Deployment manages ReplicaSets for you, one per version of the pod template.

The Deployment adds a `pod-template-hash` label (a hash of the template) to each ReplicaSet's selector and pods, so ReplicaSets from different versions never fight over the same pods.

## Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shipit-api
  namespace: shipit
spec:
  replicas: 4
  revisionHistoryLimit: 5           # how many old ReplicaSets to keep for rollback (default 10)
  minReadySeconds: 5                # pod must be Ready this long to count as available
  progressDeadlineSeconds: 120      # mark rollout as failed if no progress for this long (default 600)
  strategy:
    type: RollingUpdate             # or Recreate
    rollingUpdate:
      maxSurge: 25%                 # extra pods above replicas during the update (default 25%)
      maxUnavailable: 0             # pods below replicas allowed during the update (default 25%)
  selector:
    matchLabels: { app.kubernetes.io/name: shipit-api }
  template:
    metadata:
      labels: { app.kubernetes.io/name: shipit-api }
    spec:
      containers:
        - name: api
          image: ghcr.io/roma/shipit-api:1.4.2
          readinessProbe:
            httpGet: { path: /readyz, port: 3000 }
```

### What triggers a rollout

Only changes to `spec.template` create a new ReplicaSet (a new revision): image, env, resources, probes, labels or annotations in the template. Changing `replicas` just scales the current ReplicaSet. `kubectl rollout restart` works by writing a timestamp annotation into the template.

:::warning ConfigMap and Secret changes do not roll pods
If pods read a ConfigMap through env vars, editing the ConfigMap changes nothing until pods restart. Common fixes: `kubectl rollout restart`, or put a hash of the config in a template annotation (Helm and Kustomize do this: `checksum/config: <sha>`; Kustomize's `configMapGenerator` appends a hash to the name).
:::

### How a rolling update progresses

With `replicas: 4`, `maxSurge: 25%` (rounds **up** to 1) and `maxUnavailable: 25%` (rounds **down** to 1), the controller keeps total pods ≤ 5 and available pods ≥ 3:

```text
            old RS (v1)    new RS (v2)    available
start         4              0              4
step 1        3 (-1)         1 (+1)         3      surge 1 + unavailable 1 used
              ...new pod becomes Ready and passes minReadySeconds...
step 2        2              2              4 -> 3 as next old pod is removed
step 3        1              3
step 4        0              4              4      old RS kept at 0 replicas for rollback
```

The controller only proceeds when new pods become **available** (Ready for `minReadySeconds`). That makes the readiness probe the safety brake of every rollout: a new version that never gets Ready never takes over. Combinations worth knowing:

| maxSurge | maxUnavailable | Behaviour |
| --- | --- | --- |
| 25% | 25% | Default. Balanced speed and capacity. |
| 1 (or 25%) | 0 | Never drops below full capacity; needs spare room on nodes. Best for APIs. |
| 0 | 1 | No extra pods (tight quotas or licences); capacity dips during rollout. |
| 100% | 0 | Brings up a full new set before removing old ones: blue/green-like, needs double capacity. |

`maxSurge` and `maxUnavailable` cannot both be 0.

**Recreate** strategy kills all old pods before creating new ones. You get downtime, but never two versions at once: use it when versions cannot coexist (an app holding an exclusive lock, a single-writer volume with `ReadWriteOnce`, incompatible schema).

### Rollout commands

```bash
kubectl rollout status deploy/shipit-api --timeout=180s   # blocks; non-zero exit on failure/timeout
kubectl rollout history deploy/shipit-api
kubectl rollout history deploy/shipit-api --revision=3      # show that revision's template
kubectl rollout undo deploy/shipit-api                      # back to previous revision
kubectl rollout undo deploy/shipit-api --to-revision=2
kubectl rollout pause deploy/shipit-api                     # batch several changes...
kubectl set image deploy/shipit-api api=ghcr.io/roma/shipit-api:1.5.0
kubectl set env deploy/shipit-api LOG_LEVEL=info
kubectl rollout resume deploy/shipit-api                    # ...into one rollout
kubectl rollout restart deploy/shipit-api
```

The CHANGE-CAUSE column in history comes from the `kubernetes.io/change-cause` annotation on the Deployment. Set it in CI (`kubectl annotate deploy/shipit-api kubernetes.io/change-cause="release 1.5.0 (abc123)" --overwrite`) so history means something.

:::info Rollback is a roll forward
`rollout undo` copies the old ReplicaSet's template back into the Deployment, which creates a new revision number pointing at the old template. If your manifests live in git, a manual undo creates drift: the next `kubectl apply` or GitOps sync will roll forward again. In GitOps setups, roll back by reverting the commit.
:::

### Detecting a failed rollout

If new pods cannot become available (bad image, crash, failing readiness) for `progressDeadlineSeconds`, the Deployment's `Progressing` condition becomes `False` with reason `ProgressDeadlineExceeded`, and `kubectl rollout status` exits non-zero. **Kubernetes does not roll back automatically**: old pods simply keep serving (as long as `maxUnavailable` kept them alive). Your pipeline must react, typically with `kubectl rollout undo` or by failing the release.

:::try Watch a rollout move
```bash
kubectl create deployment roll --image=nginx:1.26-alpine --replicas=4
kubectl rollout status deploy/roll
kubectl get rs -l app=roll -w &
kubectl set image deploy/roll nginx=nginx:1.27-alpine
sleep 20; kill %1
kubectl rollout history deploy/roll
kubectl delete deploy roll
```
Watch the old ReplicaSet's count go down while the new one goes up.
:::

:::deep How the Deployment controller decides each step
Each sync, the Deployment controller lists its ReplicaSets, finds the one whose template hash matches the current template (creating it if missing), and computes two numbers: the maximum total pods (`replicas + maxSurge`) and the minimum available pods (`replicas - maxUnavailable`). It scales the new ReplicaSet up as far as the max-total budget allows, then scales old ReplicaSets down as far as the min-available budget allows, counting only pods that are available (Ready for `minReadySeconds`). Unhealthy old pods are scaled down first. When you scale a Deployment in the middle of a rollout, it distributes the change proportionally across ReplicaSets ("proportional scaling") so the ratio of old to new stays the same. Status fields `updatedReplicas`, `readyReplicas`, `availableReplicas` and `unavailableReplicas` expose this progress, and `observedGeneration` tells you whether the controller has seen your latest change.
:::

## Blue/green and canary with labels

Deployments give you rolling updates. For other release strategies, you can combine two Deployments and a Service, because a **Service selects pods by label** and does not care which Deployment created them.

### Blue/green

Run both versions at full size, switch traffic instantly by changing the Service selector:

```yaml
# Deployment shipit-api-blue: labels app=shipit-api, color=blue  (image 1.4.2)
# Deployment shipit-api-green: labels app=shipit-api, color=green (image 1.5.0)
apiVersion: v1
kind: Service
metadata: { name: shipit-api }
spec:
  selector: { app: shipit-api, color: blue }    # flip to green to switch
  ports: [{ port: 80, targetPort: 3000 }]
```

```bash
kubectl patch svc shipit-api -p '{"spec":{"selector":{"app":"shipit-api","color":"green"}}}'
# instant rollback: patch back to blue
```

Pros: instant switch and rollback, you can test green on a separate Service first. Cons: double capacity, and both versions must work with the same database schema.

### Canary

Run a small number of new pods next to the old ones, all selected by the same Service:

```text
Service selector: app=shipit-api        (no track label)
  Deployment shipit-api-stable  replicas: 9  labels app=shipit-api, track=stable
  Deployment shipit-api-canary  replicas: 1  labels app=shipit-api, track=canary
  => roughly 10% of connections reach the canary
```

Watch error rates and latency for the canary (label your metrics with `track`), then scale it up or roll the new image into stable. Limitations: the split is per connection and only as precise as the replica ratio, so 1% needs 99 stable pods. For precise weights (5%, header-based routing) use Gateway API `HTTPRoute` weights (covered later in the track), a service mesh, or **Argo Rollouts**, which automates canary steps and analysis.

## DaemonSet

A DaemonSet runs one pod on every node (or every node matching a `nodeSelector`/affinity). When a node joins, it gets a pod; when it leaves, the pod is garbage-collected.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: node-agent, namespace: monitoring }
spec:
  selector: { matchLabels: { app: node-agent } }
  updateStrategy:
    type: RollingUpdate
    rollingUpdate: { maxUnavailable: 1 }    # one node at a time (can also use maxSurge)
  template:
    metadata: { labels: { app: node-agent } }
    spec:
      tolerations:
        - key: node-role.kubernetes.io/control-plane   # also run on control-plane nodes
          operator: Exists
          effect: NoSchedule
      containers:
        - name: agent
          image: fluent/fluent-bit:3.2
          volumeMounts:
            - { name: varlog, mountPath: /var/log, readOnly: true }
      volumes:
        - name: varlog
          hostPath: { path: /var/log }
```

Use cases: log collectors (Fluent Bit, Vector), node metrics (node-exporter, Datadog agent), networking (kube-proxy, CNI agents), storage drivers (CSI node plugins). DaemonSet pods are scheduled by the default scheduler but tolerate many node conditions automatically (for example `not-ready` and `unreachable`), so they keep running where other pods would be evicted.

## StatefulSet

Deployments treat pods as interchangeable cattle with random names. Some software needs **pets**: each instance has an identity, its own disk, and peers that address it by name (database replicas, Kafka brokers, etcd members). StatefulSets provide:

1. **Stable, ordinal names**: `postgres-0`, `postgres-1`, `postgres-2`. A replaced pod gets the same name.
2. **Stable network identity** via a **headless Service** (`clusterIP: None`): each pod gets a DNS name `postgres-0.postgres.shipit.svc.cluster.local`.
3. **Stable storage** via `volumeClaimTemplates`: each pod gets its own PVC (`data-postgres-0`), re-attached when the pod is rescheduled.
4. **Ordered operations** (default `podManagementPolicy: OrderedReady`): pods are created 0, 1, 2, each waiting for the previous to be Ready; deleted in reverse order; updated from the highest ordinal down.

```yaml
apiVersion: v1
kind: Service
metadata: { name: postgres, namespace: shipit }
spec:
  clusterIP: None                 # headless: DNS returns pod IPs, one record per pod
  selector: { app: postgres }
  ports: [{ name: pg, port: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres, namespace: shipit }
spec:
  serviceName: postgres           # the headless Service that governs pod DNS
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:17-alpine
          envFrom: [{ secretRef: { name: postgres-auth } }]
          env:
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          ports: [{ name: pg, containerPort: 5432 }]
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "shipit"] }
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: { requests: { storage: 1Gi } }
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain           # keep PVCs when the StatefulSet is deleted (default)
    whenScaled: Retain            # keep PVCs of scaled-down pods (default)
```

Update strategies:

- `RollingUpdate` (default): replaces pods one at a time from the highest ordinal, waiting for each to be Ready. `rollingUpdate.partition: N` only updates pods with ordinal ≥ N, which gives you a manual canary for stateful apps.
- `OnDelete`: pods are only updated when you delete them yourself. Used when an operator or a human must control the order.

:::warning A StatefulSet is not a database operator
A StatefulSet gives you identity and disks. It does **not** set up replication, failover, backups, or safe upgrades. `replicas: 3` of the postgres image is three independent databases, not a cluster. For production Postgres on Kubernetes use an operator (CloudNativePG is a CNCF project) or a managed service such as Amazon RDS, which is what most teams running shipit-like apps on EKS do.
:::

:::warning Deleting a StatefulSet keeps the data
By default PVCs created from `volumeClaimTemplates` survive both scale-down and StatefulSet deletion, so a re-created StatefulSet picks up the old data. Good for safety; surprising when you expected a clean database. Clean up with `kubectl delete pvc -l app=postgres` (the PVCs carry the pod template's labels).
:::

## Job

A Job runs pods until a number of them **complete successfully**.

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: shipit-migrate, namespace: shipit }
spec:
  completions: 1                  # successful pods needed (default 1)
  parallelism: 1                  # pods running at once (default 1)
  backoffLimit: 3                 # retries before the Job is Failed (default 6)
  activeDeadlineSeconds: 600      # hard time limit for the whole Job
  ttlSecondsAfterFinished: 3600   # auto-delete the Job and its pods an hour after finishing
  template:
    spec:
      restartPolicy: Never        # Never or OnFailure (Always is not allowed)
      containers:
        - name: migrate
          image: ghcr.io/roma/shipit-api:1.5.0
          command: ["node", "dist/migrate.js"]
          envFrom: [{ secretRef: { name: shipit-db } }]
```

- `restartPolicy: Never` creates a **new pod** for each retry (failed pods stay for log inspection). `OnFailure` restarts the container in the same pod (logs of earlier attempts are harder to get).
- Retries back off exponentially (10 s, 20 s, 40 s …). After `backoffLimit` failures the Job gets condition `Failed` with reason `BackoffLimitExceeded`.
- **Parallel work queues**: set `parallelism` > 1 and have workers pull from a queue (Redis, SQS).
- **Indexed Jobs** (`completionMode: Indexed`): each pod gets a unique index in the env var `JOB_COMPLETION_INDEX` (0 … completions−1) and a stable hostname. Ideal for static sharding: "pod 3 of 10 processes shard 3".
- Fine-grained failure handling: `podFailurePolicy` (e.g. fail the Job immediately on exit code 42, ignore pod disruptions) and `backoffLimitPerIndex` for indexed Jobs.

Job pods must be **idempotent**: a pod can be retried after doing half its work, or (rarely) run twice. Make migrations transactional and batch jobs safe to re-run.

:::tip Database migrations
Running migrations in an init container means every replica runs them on every restart, concurrently. A dedicated Job before the rollout (in CI, or as a Helm pre-upgrade hook / Argo CD PreSync hook) runs them once. Make the API tolerate both the old and the new schema during the rollout (expand/contract migrations).
:::

## CronJob

A CronJob creates a Job from a template on a cron schedule.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: cleanup-expired, namespace: shipit }
spec:
  schedule: "15 3 * * *"          # 03:15 every day (minute hour day-of-month month day-of-week)
  timeZone: "Asia/Tbilisi"        # IANA name; without it the controller's time zone (usually UTC) applies
  concurrencyPolicy: Forbid       # Allow (default) | Forbid | Replace
  startingDeadlineSeconds: 300    # skip a run if it could not start within 5 min of its time
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  suspend: false
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: cleanup
              image: ghcr.io/roma/shipit-api:1.5.0
              command: ["node", "dist/cleanup.js"]
```

- `concurrencyPolicy`: `Allow` lets runs overlap; `Forbid` skips a run if the previous one is still running; `Replace` kills the running Job and starts the new one.
- The scheduler is **at least once / approximately on time**, not exactly once. Very rarely two Jobs can be created, or a run can be missed (if the controller was down and `startingDeadlineSeconds` has passed). Design jobs to be idempotent.
- Test a CronJob immediately: `kubectl create job manual-1 --from=cronjob/cleanup-expired`.
- Pause it: `kubectl patch cronjob cleanup-expired -p '{"spec":{"suspend":true}}'`.

## Choosing the right controller

```text
Does it run to completion?
├── yes ─> on a schedule? ── yes ─> CronJob
│                         └─ no ──> Job (Indexed if work is statically sharded)
└── no (long-running)
    ├── one per node? ───────────────────────────> DaemonSet
    ├── needs stable identity / per-pod disk / ordered startup? ─> StatefulSet
    │       (for real databases: prefer an operator or a managed service)
    └── otherwise (stateless, interchangeable) ──> Deployment
```

A queue consumer (a BullMQ worker for shipit) is a Deployment, not a Job: it runs forever. A nightly export is a CronJob. Redis as a cache with no persistence can be a Deployment; Redis with persistence or replication needs a StatefulSet (or a managed ElastiCache).

## Pitfalls and production best practices

:::warning Common workload mistakes
- **No readiness probe on a Deployment.** Pods count as available as soon as the container starts, so a broken release replaces all healthy pods. Readiness is your rollout brake.
- **`maxUnavailable` > 0 with few replicas.** With `replicas: 2` and defaults, one pod can be down during every rollout: half your capacity.
- **Selectors that overlap** between Deployments. Two controllers fighting over the same pods causes chaos. Keep selectors unique per workload.
- **Editing the selector.** Immutable for Deployments, StatefulSets and DaemonSets; you must delete and recreate (with `--cascade=orphan` to keep pods).
- **`replicas` in your manifest while an HPA manages it.** Every apply resets the count. Omit `replicas` when autoscaling.
- **Expecting a CronJob to run exactly once.** Make it idempotent and use `concurrencyPolicy: Forbid` for jobs that must not overlap.
- **Forgetting `ttlSecondsAfterFinished`.** Finished Jobs and pods pile up in the namespace.
:::

Best practices:

- Gate deploys on `kubectl rollout status` and alert on `ProgressDeadlineExceeded`.
- Set `revisionHistoryLimit` to a small number (3–5) to avoid clutter.
- Use `maxUnavailable: 0` and a modest `maxSurge` for user-facing APIs; add a PodDisruptionBudget (covered in the scheduling module) for node drains.
- Run at least 2 replicas (3 across zones in production) for anything user-facing.
- Keep stateful systems out of the cluster until you have a reason and an operator; managed databases are usually the right call.

## Summary

- Deployments manage ReplicaSets per template version; rolling updates are bounded by `maxSurge` and `maxUnavailable` and gated by readiness and `minReadySeconds`.
- `rollout status/history/undo/pause/resume` give you control; failed rollouts are detected (`ProgressDeadlineExceeded`) but not auto-reverted.
- Blue/green and canary can be built from labels and Service selectors; use Gateway API or Argo Rollouts for precise traffic control.
- DaemonSets run per-node agents; StatefulSets give stable names, DNS and per-pod volumes, not database clustering.
- Jobs run to completion with retries, parallelism and indexes; CronJobs schedule them with time zones and concurrency policies.
