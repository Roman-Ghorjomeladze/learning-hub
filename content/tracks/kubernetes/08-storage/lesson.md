A container's filesystem is a thin writable layer on top of the image. It disappears when the container is replaced, and Kubernetes replaces containers all the time: crashes, rollouts, node drains, rescheduling. Anything you want to keep, or share between containers, needs a **volume**. This module goes from throwaway scratch space to a PostgreSQL StatefulSet with persistent disks, and ends with the honest question every senior engineer should ask: should this database run on Kubernetes at all?

## The mental model: three layers of storage

```text
 Lifetime                     Examples                               Where it lives
 --------                     --------                               --------------
 container                    writable layer                         node disk, lost on restart
 pod                          emptyDir, configMap/secret/projected   node (disk or RAM), lost when pod is deleted
 independent of any pod       PersistentVolume (EBS, local-path...)  external disk/storage system
```

Volumes are declared at the **pod** level (`spec.volumes`) and mounted into containers (`volumeMounts`). The kubelet prepares them before containers start. A volume lives at least as long as the pod, so containers in the pod can restart without losing it.

## Ephemeral volumes

### emptyDir

An empty directory created when the pod is scheduled to a node and deleted when the pod is removed. Perfect for scratch space, caches and sharing files between containers:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-with-sidecar
spec:
  containers:
    - name: app
      image: busybox:1.36
      # trap: PID 1 ignores SIGTERM unless it installs a handler (used in the try-it below)
      command: ["sh", "-c", "trap 'exit 1' TERM; while true; do date >> /data/log.txt; sleep 2; done"]
      volumeMounts:
        - name: shared
          mountPath: /data
    - name: shipper
      image: busybox:1.36
      command: ["sh", "-c", "tail -F /data/log.txt"]
      volumeMounts:
        - name: shared
          mountPath: /data
  volumes:
    - name: shared
      emptyDir:
        sizeLimit: 500Mi          # pod is evicted if it exceeds this
        # medium: Memory          # tmpfs in RAM; counts against the container memory limit
```

Uses: a log-shipping sidecar, unpacked uploads before processing, a Next.js build cache, or a writable `/tmp` when the root filesystem is read-only (`readOnlyRootFilesystem: true`, module on security).

:::warning emptyDir counts against ephemeral storage
Disk-backed emptyDir uses the node's ephemeral storage. If many pods fill it, the kubelet evicts pods under `DiskPressure`. Set `sizeLimit` and `resources.requests/limits.ephemeral-storage`. With `medium: Memory`, writes consume RAM and count toward the container's memory limit, so a big file can OOMKill your pod.
:::

:::try Container restart vs pod deletion
Apply the `web-with-sidecar` pod, wait a few seconds, then make the app container exit with `kubectl exec web-with-sidecar -c app -- kill 1` (the `trap` in its command turns SIGTERM into `exit 1`). After the container restarts (`RESTARTS` goes to 1), `kubectl exec web-with-sidecar -c shipper -- wc -l /data/log.txt` still shows the old lines: the emptyDir belongs to the pod. Now `kubectl delete pod web-with-sidecar`, re-apply, and check again: the file starts from zero.
:::

### configMap, secret, downwardAPI, projected

You met these in module 07: read-only volumes that the kubelet fills from API objects. Secret volumes are always tmpfs.

### hostPath

Mounts a path from the **node** filesystem into the pod:

```yaml
volumes:
  - name: node-logs
    hostPath:
      path: /var/log
      type: Directory
```

It is for node-level agents (log collectors, monitoring, CSI drivers themselves), not for applications. Data is tied to one node, the pod can read or overwrite host files, and Pod Security "baseline" forbids it. If you catch yourself using hostPath for app data, you want a PersistentVolume.

### Generic ephemeral volumes

A middle ground: a per-pod PVC created from a template and deleted with the pod. Useful when you need a fast, provisioned disk (for example a large scratch volume on a specific StorageClass) that does not need to survive the pod:

```yaml
volumes:
  - name: scratch
    ephemeral:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          storageClassName: standard
          resources:
            requests:
              storage: 5Gi
```

## Persistent storage: PV, PVC, StorageClass

Kubernetes separates **what an app needs** from **how storage is provided**:

```text
   App developer                     Cluster / platform                       Storage system
   -------------                     ------------------                       --------------
   PersistentVolumeClaim  --bind-->  PersistentVolume  <--provisioned by--    CSI driver -> EBS volume,
   "I need 10Gi RWO of               "this exact 10Gi disk,                    local directory, NFS share...
    class gp3"                        here is how to attach it"
          |                                 ^
          | storageClassName                | dynamic provisioning
          v                                 |
   StorageClass "gp3"  ---------------------+
   "provisioner: ebs.csi.aws.com, parameters: type=gp3, binding mode, reclaim policy"
```

- **PersistentVolume (PV)**: a cluster-scoped object representing a real piece of storage (an EBS volume ID, an NFS path, a directory on a node).
- **PersistentVolumeClaim (PVC)**: a namespaced request for storage. Pods reference PVCs, never PVs directly.
- **StorageClass**: a template that tells a provisioner how to create PVs on demand. One can be marked default (`storageclass.kubernetes.io/is-default-class: "true"`).

A PVC and a PV bind **one-to-one**. Once bound, that PV belongs to that claim until the claim is deleted.

### A PVC and a pod using it

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: uploads
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: standard     # omit to use the default class
  resources:
    requests:
      storage: 1Gi
---
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
```

In real apps you put the PVC in a Deployment (single replica, see access modes) or, more often, use a StatefulSet's `volumeClaimTemplates`.

### Static vs dynamic provisioning

- **Static**: an admin creates PVs up front; PVCs bind to a matching one (size, access mode, class, selector). Rare today except for pre-existing disks or NFS shares.
- **Dynamic**: a PVC names a StorageClass; its provisioner creates a disk and a PV automatically. This is the norm everywhere.

### kind's storage: local-path-provisioner

kind installs Rancher's **local-path-provisioner** and a default StorageClass called `standard`:

```bash
kubectl get storageclass
# NAME                 PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION
# standard (default)   rancher.io/local-path   Delete          WaitForFirstConsumer   false
```

It creates a directory on the node where the pod is scheduled and a PV with **node affinity** to that node. That is great for learning and terrible for availability: if that node dies, the data is gone, and the pod can only ever run on that node. It does not support expansion or snapshots. On a cloud cluster the same manifests work with a network-attached class like EBS gp3.

:::mac Where the data physically lives
kind nodes are Docker containers inside the Docker Desktop/OrbStack/Colima Linux VM. local-path volumes live under `/var/local-path-provisioner/` **inside the node container**, so you can inspect them with `docker exec -it <cluster>-worker ls /var/local-path-provisioner`. They are not on your Mac's filesystem, and `kind delete cluster` deletes them.
:::

### Access modes

| Mode | Short | Meaning | Typical backing |
| --- | --- | --- | --- |
| `ReadWriteOnce` | RWO | Mounted read-write by **one node** (several pods on that node can share it) | EBS, GCE PD, local disks |
| `ReadWriteOncePod` | RWOP | Read-write by **one pod** in the whole cluster | CSI volumes; stricter RWO |
| `ReadOnlyMany` | ROX | Read-only by many nodes | NFS, some CSI |
| `ReadWriteMany` | RWX | Read-write by many nodes | NFS, Amazon EFS, CephFS |

Access modes describe **capabilities**; Kubernetes does not enforce file locking. Two important consequences:

- A Deployment with `replicas: 3` and one RWO PVC works only while all pods land on the same node, and a rolling update can deadlock if the new pod is scheduled to another node while the old one still holds the volume. Use `strategy: Recreate` for single-replica apps with RWO disks, or a StatefulSet.
- EBS is RWO and **zonal**. A pod using an EBS volume in `eu-central-1a` can only run on nodes in `eu-central-1a`.

### Reclaim policies

What happens to the PV (and the real disk) when its PVC is deleted:

- **`Delete`** (default for dynamic provisioning): the PV and the underlying disk are deleted. Deleting a PVC deletes your data.
- **`Retain`**: the PV becomes `Released` and the disk stays. An admin must clean up or manually rebind (remove `spec.claimRef`) to reuse it.
- `Recycle` (basic `rm -rf`) is deprecated; do not use it.

You can change it on an existing PV: `kubectl patch pv <name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`. Production StorageClasses for databases often use `reclaimPolicy: Retain` as a safety net.

### volumeBindingMode: Immediate vs WaitForFirstConsumer

```text
Immediate:              PVC created -> disk provisioned NOW (in some zone)  -> pod scheduled later
                        Risk: disk in zone A, but the pod only fits on nodes in zone B -> Pending forever

WaitForFirstConsumer:   PVC created -> stays Pending
                        Pod using it is scheduled -> scheduler picks node (zone B)
                        -> disk provisioned in zone B -> bound -> pod starts
```

With topology-constrained storage (EBS, local disks), always use `WaitForFirstConsumer`. A PVC that is `Pending` with the event `waiting for first consumer to be created before binding` is **normal**, not an error.

:::try Watch WaitForFirstConsumer
On any kind cluster: apply only the `uploads` PVC above and run `kubectl get pvc uploads` (Pending) and `kubectl describe pvc uploads` (the "waiting for first consumer" event). Then apply the pod and watch `kubectl get pvc,pv -w` until it binds. Finally, `kubectl get pv -o yaml | grep -A8 nodeAffinity` shows which node the volume is now pinned to.
:::

### Volume expansion

If the StorageClass has `allowVolumeExpansion: true`, you grow a volume by editing the PVC:

```bash
kubectl patch pvc data-postgres-0 -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
kubectl get pvc data-postgres-0 -w
```

The CSI driver resizes the disk, and the filesystem is grown when the volume is (re)mounted or online if the driver supports it. Shrinking is not supported. For StatefulSets, `volumeClaimTemplates` cannot be edited, so you patch each PVC individually (and optionally recreate the StatefulSet with `--cascade=orphan` to update the template).

### File permissions: fsGroup

Many images run as a non-root user. A freshly provisioned volume is often owned by root, so the app gets `permission denied`. Set the pod's `securityContext.fsGroup` so the kubelet makes the volume group-writable for that GID:

```yaml
spec:
  securityContext:
    fsGroup: 999                       # e.g. the postgres group in the official image
    fsGroupChangePolicy: OnRootMismatch  # skip the slow recursive chown when already correct
```

Support depends on the volume type (local-path ignores it; EBS honours it).

## StatefulSets: stable identity plus stable storage

Deployments treat pods as interchangeable. Databases, brokers and anything with replication need each replica to keep **its own identity and its own disk**. A StatefulSet gives you:

- **Stable names**: `postgres-0`, `postgres-1`, ... recreated with the same name.
- **Stable DNS** through a headless Service: `postgres-0.postgres.<ns>.svc.cluster.local` (module 05).
- **Per-replica PVCs** from `volumeClaimTemplates`: `data-postgres-0`, `data-postgres-1`. A recreated `postgres-0` reattaches `data-postgres-0`.
- **Ordered** creation, scaling and rolling updates (by default), so replica 0 can bootstrap before 1 joins.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  clusterIP: None                 # headless: DNS returns pod IPs, per-pod records
  selector:
    app: postgres
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres           # must match the headless Service
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain           # keep PVCs if the StatefulSet is deleted (default)
    whenScaled: Retain            # keep PVCs of scaled-down replicas (default)
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
              mountPath: /var/lib/postgresql   # PostgreSQL 18+ image layout (see warning)
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "shipit", "-d", "shipit"]
            periodSeconds: 5
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              memory: 1Gi
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 2Gi
```

Your `shipit-api` then uses `DATABASE_URL=postgres://shipit:<password>@postgres-0.postgres:5432/shipit` (or the Service name `postgres`, which resolves to the ready pod IPs).

:::warning PostgreSQL 18 moved the data directory
Up to PostgreSQL 17, the official image used `PGDATA=/var/lib/postgresql/data`, and everyone mounted volumes there. Starting with **18**, `PGDATA` is `/var/lib/postgresql/18/docker` and the image's declared volume is `/var/lib/postgresql`, so major-version upgrades with `pg_upgrade --link` can work inside one volume. If you mount your PVC at the old `/var/lib/postgresql/data` path with `postgres:18`, the entrypoint detects the mount and refuses to start with an error beginning `in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster"`, so the pod crash-loops. That is the friendly failure. The unfriendly one is mounting the volume at any path the image does not use: the database (or your app) happily writes into the container's ephemeral filesystem, the PVC stays empty, and you lose everything on the next restart. Mount at `/var/lib/postgresql` for 18+, check the image docs for the version you run, and verify with `df -h` inside the container. Lab 5 makes you debug both.

A related classic: on ext4-formatted volumes (EBS), the mount root contains `lost+found`, and older Postgres images refused to `initdb` into a non-empty directory. The fix was to point `PGDATA` at a subdirectory of the mount. The 18+ layout avoids this because PGDATA is already a subdirectory.
:::

:::deep What a StatefulSet does not do for a database
A StatefulSet gives each replica a name and a disk. It knows nothing about PostgreSQL. Scale `replicas: 3` and you get three **independent** databases with three empty disks, not a primary with two streaming replicas. Everything that makes a database highly available is application logic:

- initialising replicas from a base backup of the primary,
- configuring streaming replication and replication slots,
- detecting primary failure and promoting a replica (without split brain),
- re-pointing clients to the new primary (a `-rw` Service that follows the primary),
- continuous WAL archiving and point-in-time recovery,
- coordinated minor and major version upgrades.

That logic lives in **operators**: controllers with custom resources that encode a DBA's runbook. For PostgreSQL the leading open-source option is **CloudNativePG** (a CNCF project). You declare:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: shipit-db
spec:
  instances: 3
  storage:
    size: 20Gi
  backup:
    barmanObjectStore:          # newer releases move this to the Barman Cloud plugin
      destinationPath: s3://shipit-backups/db
```

and the operator creates pods and PVCs (it manages pods directly rather than through a StatefulSet), configures replication, exposes `shipit-db-rw` and `shipit-db-ro` Services, fails over automatically and ships WAL to object storage. Other operators: Zalando postgres-operator, Crunchy PGO, Percona; for Redis, MongoDB, Kafka (Strimzi) and others there are equivalents.

Even with an operator, you now own the database: capacity, upgrades, backups, restore drills, and on-call. On AWS, **RDS or Aurora** is often the right answer for production relational data, with Kubernetes running the stateless `shipit-api`. Databases in Kubernetes make most sense when you need portability across clouds or on-prem, many small databases (per-tenant or per-preview-environment), or tight cost control, and you have the skills to operate them.
:::

## CSI: how real storage plugs in

The **Container Storage Interface** is the standard plugin API between Kubernetes and storage systems. Old in-tree drivers (AWS EBS, GCE PD, Azure Disk) have been migrated to CSI drivers.

```text
   PVC created
       |
       v
   external-provisioner (sidecar) --CreateVolume--> CSI controller plugin --> cloud API: create EBS vol
       |
   PV created & bound;  pod scheduled to node X
       |
   external-attacher --ControllerPublish--> attach EBS volume to EC2 instance X
       |
   kubelet on X --NodeStage/NodePublish--> CSI node plugin (DaemonSet): format + mount into pod
```

A CSI driver runs as a controller Deployment (with sidecars such as external-provisioner, external-attacher, external-resizer, external-snapshotter) plus a node DaemonSet.

### EBS on EKS

- Install the **Amazon EBS CSI driver** as an EKS add-on (`aws-ebs-csi-driver`) and give its controller IAM permissions via IRSA or EKS Pod Identity. EKS Auto Mode ships block storage built in with its own provisioner name (`ebs.csi.eks.amazonaws.com`).
- Create a gp3 StorageClass:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
```

- Remember the constraints: **RWO, single AZ**, attach limits per instance type, and a node in another AZ can never mount the volume. For RWX across AZs use **Amazon EFS** with the EFS CSI driver (NFS semantics, higher latency, not for databases).

## Snapshots and backups

**VolumeSnapshots** are the Kubernetes API for point-in-time disk snapshots (EBS snapshots under the hood). They need the snapshot CRDs, the snapshot controller, and a CSI driver that supports snapshots (local-path does not):

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapshots
driver: ebs.csi.aws.com
deletionPolicy: Retain
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-before-migration
spec:
  volumeSnapshotClassName: ebs-snapshots
  source:
    persistentVolumeClaimName: data-postgres-0
---
# Restore: a new PVC whose dataSource is the snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-postgres-restore
spec:
  storageClassName: gp3
  dataSource:
    name: postgres-before-migration
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 20Gi
```

Snapshots are **crash-consistent** (like pulling the power cord). Postgres recovers from that via WAL replay, but for guaranteed application consistency use the database's own tools.

A practical backup strategy has layers:

| Layer | Tool | Protects against |
| --- | --- | --- |
| Logical dumps | `pg_dump` in a CronJob to object storage | Bad migrations, accidental deletes, moving data between versions |
| Physical + WAL archiving | CloudNativePG/Barman, pgBackRest, WAL-G | Point-in-time recovery to any second |
| Volume snapshots | VolumeSnapshot / EBS snapshots, AWS Backup | Fast restore of a whole disk |
| Cluster resources + volumes | Velero | Losing the cluster or namespace |
| Manifests | Git (GitOps) | Losing configuration |

A backup you have never restored is a hope, not a backup. Schedule restore drills.

## Pitfalls and best practices

:::warning Common mistakes
- **Deleting a PVC with reclaim policy `Delete`** destroys the disk. Use `Retain` for important data, and RBAC to limit who can delete PVCs.
- **RWO volume with a multi-replica Deployment** or a `RollingUpdate` that schedules the new pod on another node: `Multi-Attach error for volume` events and a stuck rollout.
- **`Immediate` binding with zonal disks**: PV in one zone, pod schedulable only in another, pod Pending forever with `volume node affinity conflict`.
- **Wrong mount path** (PostgreSQL 18 layout, or any image that writes elsewhere): silent data loss. Verify with `df -h` in the container and the app's own data-directory setting.
- **Typo in `storageClassName`**: the PVC stays `Pending` with no provisioner ever acting on it.
- **Expecting StatefulSet replicas to replicate data**. They do not; use an operator.
- **Running your only production database on local-path or hostPath** storage.
:::

Best practices:

- Keep apps stateless; put state in managed services (RDS, ElastiCache, S3) or operator-managed stateful sets.
- Use `WaitForFirstConsumer`, `allowVolumeExpansion: true` and an explicit reclaim policy in your StorageClasses.
- Set resource requests and a PodDisruptionBudget on stateful pods, and spread replicas across zones (module 09).
- Monitor volume usage (`kubelet_volume_stats_used_bytes` in Prometheus) and alert before disks fill.
- Test restores regularly.
