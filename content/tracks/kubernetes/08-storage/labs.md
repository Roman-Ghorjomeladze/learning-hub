You need `docker`, `kind` and `kubectl`. All labs use one cluster with a control plane and two workers, so you can see how local volumes pin pods to nodes:

```bash
cat <<'EOF' > /tmp/storage-lab.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --name storage-lab --config /tmp/storage-lab.yaml
kubectl get nodes
kubectl get storageclass
```

You should see the default `standard` StorageClass (`rancher.io/local-path`, `WaitForFirstConsumer`, reclaim `Delete`).

## Lab 1: emptyDir: shared scratch space with a pod lifetime

:::meta
difficulty: easy
time: 15 min
:::

Goal: share files between two containers with an `emptyDir`, then prove the data survives a container restart but not pod deletion. Also try a RAM-backed emptyDir.

### Steps

1. Create a pod with a writer and a reader container sharing an emptyDir:

```bash
cat <<'EOF' > /tmp/emptydir.yaml
apiVersion: v1
kind: Pod
metadata:
  name: shared-scratch
spec:
  containers:
    - name: writer
      image: busybox:1.36
      command: ["sh", "-c", "trap 'exit 1' TERM; while true; do date >> /scratch/log.txt; sleep 2; done"]
      volumeMounts:
        - name: scratch
          mountPath: /scratch
    - name: reader
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - name: scratch
          mountPath: /scratch
        - name: ram
          mountPath: /ram
  volumes:
    - name: scratch
      emptyDir:
        sizeLimit: 100Mi
    - name: ram
      emptyDir:
        medium: Memory
        sizeLimit: 64Mi
EOF
kubectl apply -f /tmp/emptydir.yaml
kubectl wait --for=condition=Ready pod/shared-scratch
```

2. Read the writer's file from the reader container, and check the mounts:

```bash
sleep 6
kubectl exec shared-scratch -c reader -- wc -l /scratch/log.txt
kubectl exec shared-scratch -c reader -- df -h /scratch /ram
```

3. Make the writer container exit (its `trap` turns SIGTERM into `exit 1`) and check the file again after it restarts:

```bash
kubectl exec shared-scratch -c writer -- kill 1
sleep 5
kubectl get pod shared-scratch            # RESTARTS = 1
kubectl exec shared-scratch -c reader -- wc -l /scratch/log.txt
```

4. Delete and recreate the pod:

```bash
kubectl delete pod shared-scratch
kubectl apply -f /tmp/emptydir.yaml
kubectl wait --for=condition=Ready pod/shared-scratch
kubectl exec shared-scratch -c reader -- wc -l /scratch/log.txt
```

### Verify

- Step 2: the reader sees lines written by the writer. `df` shows `/ram` as `tmpfs`.
- Step 3: the line count keeps growing from where it was; the restart did not wipe the volume.
- Step 4: the count starts again from a few lines; the volume died with the pod.

:::hint
`kill 1` only works because the writer installs a `trap`. A process running as PID 1 in a container ignores signals it has no handler for, which is also why Node apps need explicit SIGTERM handling (module 10).
:::

:::solution
The steps are the solution. Optional extra: find the emptyDir on the node. Get the pod UID and node, then look under the kubelet directory inside the kind node container:

```bash
UID_=$(kubectl get pod shared-scratch -o jsonpath='{.metadata.uid}')
NODE=$(kubectl get pod shared-scratch -o jsonpath='{.spec.nodeName}')
docker exec "$NODE" ls /var/lib/kubelet/pods/$UID_/volumes/kubernetes.io~empty-dir/
```
:::

### Clean up

```bash
kubectl delete pod shared-scratch
```

## Lab 2: Dynamic provisioning and WaitForFirstConsumer

:::meta
difficulty: easy
time: 25 min
:::

Goal: create a PVC, watch it wait for a consumer, see local-path create a PV pinned to one node, prove data outlives pods, and see what node pinning means when that node is unavailable.

### Steps

1. Create a PVC on its own:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: uploads
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
EOF
kubectl get pvc uploads
kubectl describe pvc uploads | tail -5
kubectl get pv
```

2. Create a pod that uses it and writes a file:

```bash
cat <<'EOF' > /tmp/uploader.yaml
apiVersion: v1
kind: Pod
metadata:
  name: uploader
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: uploads
EOF
kubectl apply -f /tmp/uploader.yaml
kubectl wait --for=condition=Ready pod/uploader
kubectl get pvc,pv
kubectl exec uploader -- sh -c 'echo "invoice-42.pdf" > /data/manifest.txt; df -h /data'
```

3. Inspect the PV it created:

```bash
PV=$(kubectl get pvc uploads -o jsonpath='{.spec.volumeName}')
kubectl get pv "$PV" -o yaml | grep -A12 -E 'hostPath|local:|nodeAffinity'
NODE=$(kubectl get pod uploader -o jsonpath='{.spec.nodeName}')
echo "pinned to $NODE"
docker exec "$NODE" sh -c 'ls /var/local-path-provisioner/ && cat /var/local-path-provisioner/*/manifest.txt'
```

4. Delete and recreate the pod; the data is still there:

```bash
kubectl delete pod uploader
kubectl apply -f /tmp/uploader.yaml
kubectl wait --for=condition=Ready pod/uploader
kubectl exec uploader -- cat /data/manifest.txt
kubectl get pod uploader -o wide
```

5. Now simulate the node being unavailable: cordon it and recreate the pod:

```bash
kubectl cordon "$NODE"
kubectl delete pod uploader
kubectl apply -f /tmp/uploader.yaml
sleep 5
kubectl get pod uploader
kubectl describe pod uploader | tail -5
```

### Verify

- Step 1: PVC `Pending`, event `waiting for first consumer to be created before binding`, no PV yet.
- Step 2: PVC `Bound`, a PV with a generated `pvc-...` name exists.
- Step 3: the PV has `nodeAffinity` for a single node, and the file is visible on that node container's disk.
- Step 4: the file survives, and the pod lands on the same node.
- Step 5: the pod is `Pending`, with a scheduling message mentioning the unschedulable node and `volume node affinity conflict`.

:::hint
The scheduler treats a PV's `nodeAffinity` as a hard constraint. With local storage, a pod can only run where its data is.
:::

:::solution
The steps are the solution. Fix step 5 with `kubectl uncordon "$NODE"`; the pending pod then schedules onto that node.

This is the core trade-off of local storage. On EKS with EBS the same thing happens at **zone** level: an EBS volume lives in one AZ, so the pod can move to another node in that AZ but never to another AZ. If all nodes in that AZ are gone, the pod waits.
:::

### Clean up

```bash
kubectl uncordon "$NODE"
kubectl delete pod uploader
kubectl delete pvc uploads
kubectl get pv         # the PV disappears: reclaim policy Delete
```

## Lab 3: Static PVs, reclaim policies and re-binding

:::meta
difficulty: medium
time: 25 min
:::

Goal: create a PersistentVolume by hand (a `local` volume on one node), bind a claim to it, see what `Retain` does when the claim is deleted, and reuse the retained data.

### Steps

1. Create a directory on one worker and a PV pointing at it:

```bash
docker exec storage-lab-worker mkdir -p /mnt/disks/vol1
docker exec storage-lab-worker sh -c 'echo "precious data" > /mnt/disks/vol1/README'

cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolume
metadata:
  name: static-pv
spec:
  capacity:
    storage: 2Gi
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: manual
  local:
    path: /mnt/disks/vol1
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: ["storage-lab-worker"]
EOF
kubectl get pv static-pv
```

2. Claim it and use it:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: reports
spec:
  storageClassName: manual
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: reporter
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "cat /reports/README; echo 'report-2026-10.csv' >> /reports/index; sleep 3600"]
      volumeMounts:
        - name: r
          mountPath: /reports
  volumes:
    - name: r
      persistentVolumeClaim:
        claimName: reports
EOF
kubectl wait --for=condition=Ready pod/reporter
kubectl logs reporter
kubectl get pvc reports
kubectl get pv static-pv
```

3. Delete the pod and the claim, then look at the PV:

```bash
kubectl delete pod reporter
kubectl delete pvc reports
kubectl get pv static-pv
docker exec storage-lab-worker ls /mnt/disks/vol1
```

4. Try to claim it again:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: reports-v2
spec:
  storageClassName: manual
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
EOF
sleep 5
kubectl get pvc reports-v2
kubectl get pv static-pv -o jsonpath='{.spec.claimRef}'; echo
```

### Verify

- Step 2: the PVC binds to `static-pv` even though it asked for 1Gi (a claim can bind to a larger PV; it gets the whole 2Gi).
- Step 3: the PV is `Released`, and the files are still on the node.
- Step 4: `reports-v2` stays `Pending`: a Released PV still remembers its old claim in `spec.claimRef` and will not bind to a new one.

Make `reports-v2` bind without losing the data.

:::hint
An admin "recycles" a retained PV by deciding the old data is safe to reuse (or wiping it) and then removing the stale `claimRef`.
:::

:::solution
```bash
kubectl patch pv static-pv --type=json -p='[{"op":"remove","path":"/spec/claimRef"}]'
kubectl get pv static-pv           # Available, then Bound to default/reports-v2
kubectl get pvc reports-v2
```

Mount `reports-v2` in a pod and you will find `README` and `index` intact.

Bonus: protect a **dynamically** provisioned volume before deleting its claim by switching its PV to Retain:

```bash
kubectl patch pv <pv-name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

That is the standard move before risky operations such as deleting and recreating a StatefulSet.
:::

### Clean up

```bash
kubectl delete pvc reports-v2
kubectl delete pv static-pv
docker exec storage-lab-worker rm -rf /mnt/disks/vol1
```

## Lab 4: PostgreSQL in a StatefulSet

:::meta
difficulty: medium
time: 30 min
:::

Goal: run the official `postgres:18` image in a StatefulSet with a headless Service and `volumeClaimTemplates`, prove the data survives pod deletion, and see that scaling up does **not** create replicas of your data.

### Steps

1. Create a namespace, a Secret and the StatefulSet:

```bash
kubectl create namespace db
kubectl -n db create secret generic postgres-auth --from-literal=password='change-me-locally'

cat <<'EOF' > /tmp/postgres.yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: db
spec:
  clusterIP: None
  selector:
    app: postgres
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: db
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: postgres
          image: postgres:18
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_USER
              value: shipit
            - name: POSTGRES_DB
              value: shipit
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-auth
                  key: password
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "shipit", "-d", "shipit"]
            periodSeconds: 5
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              memory: 512Mi
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
EOF
kubectl apply -f /tmp/postgres.yaml
kubectl -n db rollout status statefulset/postgres
kubectl -n db get pods,pvc
```

2. Create data and check where Postgres keeps it:

```bash
kubectl -n db exec postgres-0 -- psql -U shipit -d shipit -c \
  "CREATE TABLE items (id serial PRIMARY KEY, name text); INSERT INTO items (name) VALUES ('first'), ('second');"
kubectl -n db exec postgres-0 -- psql -U shipit -d shipit -c "SHOW data_directory;"
kubectl -n db exec postgres-0 -- df -h /var/lib/postgresql
```

3. Connect from another pod through the stable DNS name, the way `shipit-api` would:

```bash
kubectl -n db run psql-client --rm -it --restart=Never --image=postgres:18 -- \
  psql "postgres://shipit:change-me-locally@postgres-0.postgres.db.svc.cluster.local:5432/shipit" -c "SELECT * FROM items;"
```

4. Delete the pod and check the data after it comes back:

```bash
kubectl -n db delete pod postgres-0
kubectl -n db wait --for=condition=Ready pod/postgres-0 --timeout=120s
kubectl -n db exec postgres-0 -- psql -U shipit -d shipit -c "SELECT * FROM items;"
```

5. Scale to 2 and query the new replica:

```bash
kubectl -n db scale statefulset postgres --replicas=2
kubectl -n db wait --for=condition=Ready pod/postgres-1 --timeout=120s
kubectl -n db get pvc
kubectl -n db exec postgres-1 -- psql -U shipit -d shipit -c "SELECT * FROM items;"
kubectl -n db scale statefulset postgres --replicas=1
kubectl -n db get pods,pvc
```

### Verify

- `data_directory` is `/var/lib/postgresql/18/docker`, inside the PVC mounted at `/var/lib/postgresql`.
- After deleting `postgres-0`, a new pod with the **same name** reattaches `data-postgres-0` and both rows are there.
- `postgres-1` gets its own new PVC `data-postgres-1` and the query fails with `relation "items" does not exist`: it is a separate, empty database.
- After scaling back to 1, `data-postgres-1` still exists (default `whenScaled: Retain`).

:::hint
If `postgres-0` is stuck `Pending`, describe its PVC: `kubectl -n db describe pvc data-postgres-0`. If it crash-loops, read `kubectl -n db logs postgres-0`.
:::

:::solution
The steps are the full solution. The key insight is in step 5: StatefulSets provide identity and per-replica storage, **not** replication. Real Postgres HA needs streaming replication, failover and backups, which is what operators like CloudNativePG implement.

To remove the leftover claim: `kubectl -n db delete pvc data-postgres-1`. To have Kubernetes do that automatically on scale-down, set:

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenScaled: Delete
    whenDeleted: Retain
```
:::

### Clean up

Keep the `db` namespace and `postgres-0` for Lab 6. Delete the extra claim:

```bash
kubectl -n db delete pvc data-postgres-1
```

## Lab 5: Break and fix: Postgres won't start and uploads vanish

:::meta
difficulty: medium
time: 30 min
:::

Goal: debug three storage problems in a namespace a colleague set up. Each one has a different symptom: a crash loop, a stuck pod, and silent data loss.

### Setup

```bash
kubectl create namespace broken
kubectl -n broken create secret generic postgres-auth --from-literal=password=pw

cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg
  namespace: broken
spec:
  serviceName: pg
  replicas: 1
  selector:
    matchLabels: { app: pg }
  template:
    metadata:
      labels: { app: pg }
    spec:
      containers:
        - name: postgres
          image: postgres:18
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef: { name: postgres-auth, key: password }
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: media
  namespace: broken
spec:
  storageClassName: fast-ssd
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: media-worker
  namespace: broken
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: { app: media-worker }
  template:
    metadata:
      labels: { app: media-worker }
    spec:
      containers:
        - name: worker
          image: busybox:1.36
          command: ["sh", "-c", "mkdir -p /var/media && date >> /var/media/processed.log && cat /var/media/processed.log && sleep 3600"]
          volumeMounts:
            - name: media
              mountPath: /media
      volumes:
        - name: media
          persistentVolumeClaim:
            claimName: media
EOF
```

### Your task

1. Get `pg-0` running with its data on the PVC.
2. Get `media-worker` running.
3. Make sure `processed.log` really persists: after deleting the `media-worker` pod twice, the log must show three lines.

Do not use `kubectl delete namespace`; fix the objects.

### Verify

```bash
kubectl -n broken get pods,pvc
kubectl -n broken exec pg-0 -- psql -U postgres -c "SHOW data_directory;"
kubectl -n broken exec pg-0 -- df -h /var/lib/postgresql
for i in 1 2; do kubectl -n broken delete pod -l app=media-worker --wait; kubectl -n broken rollout status deploy/media-worker; done
kubectl -n broken logs deploy/media-worker
```

:::hint
For each symptom, pick the right tool: a crash loop means `kubectl logs` (add `--previous`); a Pending pod means `kubectl describe pod` and then `kubectl describe pvc`; for suspected data loss, compare where the app writes with where the volume is mounted (`df -h <path>` inside the container tells you whether a path is on the volume). StatefulSet `volumeClaimTemplates` are immutable, but the pod template is not.
:::

:::solution
**Problem 1: `pg-0` in CrashLoopBackOff.** `kubectl -n broken logs pg-0` shows the PostgreSQL 18 image error: `in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster"` ... `there appears to be PostgreSQL data in: /var/lib/postgresql/data (unused mount/volume)`. The volume is mounted at the pre-18 path. Fix the mount path (the pod template is editable even though `volumeClaimTemplates` are not):

```bash
kubectl -n broken patch statefulset pg --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/volumeMounts/0/mountPath","value":"/var/lib/postgresql"}]'
kubectl -n broken delete pod pg-0   # a crash-looping pod may block the ordered rollout; recreate it
kubectl -n broken wait --for=condition=Ready pod/pg-0 --timeout=120s
```

`SHOW data_directory` now returns `/var/lib/postgresql/18/docker`, and `df -h /var/lib/postgresql` shows the PVC.

**Problem 2: `media-worker` Pending.** `kubectl -n broken describe pvc media` shows the claim waits for StorageClass `fast-ssd`, which does not exist (`kubectl get storageclass`), so no provisioner will ever act on it. `storageClassName` is immutable on a PVC, so recreate it:

```bash
kubectl -n broken scale deploy media-worker --replicas=0
kubectl -n broken delete pvc media
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: media
  namespace: broken
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
EOF
kubectl -n broken scale deploy media-worker --replicas=1
```

(Omitting `storageClassName` uses the default class `standard`. In a real cluster you might instead create the missing `fast-ssd` class.)

**Problem 3: silent data loss.** The worker writes to `/var/media`, but the volume is mounted at `/media`. The log lives in the container's writable layer and starts over with every new pod, while the PVC stays empty. Nothing errors. Fix the mount path:

```bash
kubectl -n broken patch deploy media-worker --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/volumeMounts/0/mountPath","value":"/var/media"}]'
```

After two more pod deletions, `kubectl -n broken logs deploy/media-worker` shows three lines. Lesson: always verify persistence explicitly (`df -h`, restart test) when you set up stateful workloads.
:::

### Clean up

```bash
kubectl delete namespace broken
```

## Lab 6: Challenge: scheduled backups and a restore drill

:::meta
difficulty: hard
time: 45 min
:::

Goal: protect the Lab 4 database with logical backups and prove you can restore them, the way you would before trusting any stateful setup.

### Requirements

1. A PVC `pg-backups` (1Gi) in namespace `db`.
2. A CronJob `pg-backup` that runs every 2 minutes, uses the `postgres:18` image, writes a custom-format dump (`pg_dump -Fc`) of database `shipit` from `postgres-0.postgres` to `/backups/shipit-<timestamp>.dump`, and keeps only the 5 newest files. Credentials come from the existing `postgres-auth` Secret. Failed jobs must not retry forever (`backoffLimit`) and only a few finished jobs should be kept.
3. After at least one successful backup, simulate a disaster: `DROP TABLE items;`.
4. A Job `pg-restore` restores the **latest** dump into the running database so that `SELECT * FROM items` returns the original rows.
5. Explain in one sentence why this backup PVC on local-path storage would not be enough in production.

### Verify

```bash
kubectl -n db get cronjob,jobs
kubectl -n db logs job/pg-restore
kubectl -n db exec postgres-0 -- psql -U shipit -d shipit -c "SELECT * FROM items;"
```

:::hint
Set `PGPASSWORD` from the Secret with `secretKeyRef`, and use `pg_dump -h postgres-0.postgres -U shipit -d shipit -Fc -f ...`. To trigger a run without waiting: `kubectl -n db create job --from=cronjob/pg-backup manual-1`. `ls -1t /backups/*.dump | head -1` gives the newest file; `pg_restore --clean --if-exists` drops and recreates objects. The backup PVC is RWO on one node; local-path pins it, and the scheduler will put every job pod on that node automatically.
:::

:::solution
```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pg-backups
  namespace: db
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pg-backup
  namespace: db
spec:
  schedule: "*/2 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: backup
              image: postgres:18
              env:
                - name: PGPASSWORD
                  valueFrom:
                    secretKeyRef: { name: postgres-auth, key: password }
              command:
                - sh
                - -c
                - |
                  set -e
                  f=/backups/shipit-$(date +%Y%m%d-%H%M%S).dump
                  pg_dump -h postgres-0.postgres -U shipit -d shipit -Fc -f "$f"
                  echo "wrote $f ($(du -h "$f" | cut -f1))"
                  ls -1t /backups/*.dump | tail -n +6 | xargs -r rm -f
                  ls -lt /backups
              volumeMounts:
                - name: backups
                  mountPath: /backups
          volumes:
            - name: backups
              persistentVolumeClaim:
                claimName: pg-backups
EOF

# Do not wait two minutes: trigger one now
kubectl -n db create job --from=cronjob/pg-backup manual-1
kubectl -n db wait --for=condition=complete job/manual-1 --timeout=120s
kubectl -n db logs job/manual-1

# Disaster
kubectl -n db exec postgres-0 -- psql -U shipit -d shipit -c "DROP TABLE items;"

# Restore the newest dump
cat <<'EOF' | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: pg-restore
  namespace: db
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: restore
          image: postgres:18
          env:
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef: { name: postgres-auth, key: password }
          command:
            - sh
            - -c
            - |
              set -e
              latest=$(ls -1t /backups/*.dump | head -1)
              echo "restoring $latest"
              pg_restore -h postgres-0.postgres -U shipit -d shipit --clean --if-exists --no-owner "$latest"
              psql -h postgres-0.postgres -U shipit -d shipit -c "SELECT count(*) FROM items;"
          volumeMounts:
            - name: backups
              mountPath: /backups
      volumes:
        - name: backups
          persistentVolumeClaim:
            claimName: pg-backups
EOF
kubectl -n db wait --for=condition=complete job/pg-restore --timeout=120s
kubectl -n db logs job/pg-restore
kubectl -n db exec postgres-0 -- psql -U shipit -d shipit -c "SELECT * FROM items;"
```

Answer to requirement 5: the backups sit on the same kind of single-node, in-cluster storage as the database, so losing that node or the cluster loses the backups too; production backups go off-cluster (S3 with versioning/Object Lock, ideally another account or region), plus WAL archiving for point-in-time recovery, for example with CloudNativePG's Barman integration.

`concurrencyPolicy: Forbid` prevents overlapping dumps if one runs long; `--no-owner` avoids errors when restoring as a different role.
:::

### Clean up

```bash
kind delete cluster --name storage-lab
rm -f /tmp/storage-lab.yaml /tmp/emptydir.yaml /tmp/uploader.yaml /tmp/postgres.yaml
```
