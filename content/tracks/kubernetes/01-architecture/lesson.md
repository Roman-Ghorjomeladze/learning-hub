You already know how to package an app into an image and run it with `docker run` or `docker compose up`. Kubernetes starts where that stops: many machines, many replicas, failures that happen while you sleep, and deployments that must not drop traffic. This module builds the mental model you will use for the rest of the track. Every later topic (Services, storage, autoscaling, operators) is "just another controller reconciling another object" once this clicks.

## Why Kubernetes exists

Picture running `shipit-api` in production with plain Docker:

- You have 6 VMs. Which one should the next container go on? The one with free memory. Someone has to track that.
- A VM dies at 3 a.m. Its containers are gone. Someone has to notice and start them elsewhere.
- You release v2. You need to start new containers, wait until they are healthy, shift traffic, stop old ones, and roll back if error rates spike.
- Containers get new IPs every time they restart. Clients need a stable name and load balancing.
- Secrets, config, disks and log collection need to follow containers wherever they land.

Docker Compose solves this on one host. Kubernetes solves it for a fleet by turning operations into **data**: you write down what you want ("3 replicas of `shipit-api:1.4.2`, each with 256 MiB memory, reachable as `shipit-api` on port 80") and a set of programs work continuously to make the world match.

| Concern | Plain Docker / Compose | Kubernetes |
| --- | --- | --- |
| Placement | You pick the host | Scheduler picks a node based on resources and constraints |
| Self-healing | `restart: always` on one host | Controllers recreate pods on healthy nodes |
| Rollouts | Scripts | Deployment controller does rolling updates and rollbacks |
| Discovery | Compose DNS on one network | Services + cluster DNS across all nodes |
| Config | env files | ConfigMaps, Secrets, mounted or injected |
| Extensibility | Limited | Custom resources + controllers (operators) |

:::info Where it came from
Kubernetes was open-sourced by Google in 2014, inspired by its internal systems Borg and Omega, and donated to the CNCF in 2015. The name is Greek for "helmsman"; "k8s" is k + 8 letters + s.
:::

## Desired state and reconciliation loops

This is the most important idea in Kubernetes. Instead of issuing commands ("start container X on host Y"), you **declare** a desired state and store it in the API. **Controllers** then run a loop forever:

```text
          +-----------------------------------------------+
          |                                               |
          v                                               |
   +-------------+     +--------------+     +---------------------+
   |  OBSERVE    | --> |    DIFF      | --> |        ACT          |
   | actual state|     | desired vs   |     | create / delete /   |
   | (via API)   |     | actual       |     | update something    |
   +-------------+     +--------------+     +---------------------+
          ^                                               |
          |            (wait for change or resync)        |
          +-----------------------------------------------+
```

A ReplicaSet says `replicas: 3`. The ReplicaSet controller counts matching pods. Two exist, so it creates one. Four exist, so it deletes one. It does not care *why* the count is wrong: a crashed node, a human running `kubectl delete pod`, or a bug. That is what makes the system robust.

Three properties of this design matter in practice:

1. **Level-triggered, not edge-triggered.** Controllers react to the *current state*, not to a stream of events they must never miss. If a controller restarts and misses ten events, it simply looks at the world again and converges. Compare that to a queue consumer in your NestJS app that loses messages when it crashes.
2. **Eventually consistent.** `kubectl apply` returns as soon as the desired state is stored. The real work happens afterwards, asynchronously. That is why you use `kubectl rollout status` or `kubectl wait` to block until things are actually done.
3. **Small, composable controllers.** No single program "runs a deployment". The Deployment controller manages ReplicaSets, the ReplicaSet controller manages Pods, the scheduler assigns Pods to nodes, the kubelet runs containers. Each one watches its own objects and writes its own results.

:::tip Think in two fields
Almost every object has a `spec` (what you want; written by you) and a `status` (what is; written by controllers). When something is wrong, compare them: `kubectl get deploy shipit-api -o yaml` and look at both halves.
:::

## The big picture

```text
                         CONTROL PLANE
  +--------------------------------------------------------------+
  |                                                              |
  |   kubectl / CI / controllers                                 |
  |          |                                                   |
  |          v                                                   |
  |   +----------------+   only component that talks to etcd     |
  |   | kube-apiserver | <-------------------------+             |
  |   +----------------+                           |             |
  |      ^     ^     ^                       +-----------+       |
  |      |     |     |                       |   etcd    |       |
  |      |     |     +-------------+         +-----------+       |
  |      |     |                   |                             |
  |  +-----------+   +-------------------------+  +-----------+  |
  |  | scheduler |   | kube-controller-manager |  | cloud-    |  |
  |  +-----------+   | (deployment, replicaset,|  | controller|  |
  |                  |  node, job, endpoints..)|  | -manager  |  |
  |                  +-------------------------+  +-----------+  |
  +--------------------------------------------------------------+
            ^ watch / update (HTTPS)
            |
  +---------+----------------------+   +----------------------------+
  | WORKER NODE                    |   | WORKER NODE                |
  |  kubelet ---CRI---> containerd |   |  kubelet ---> containerd   |
  |                       |        |   |                 |          |
  |                     runc       |   |               runc         |
  |   [pod] [pod] [pod]            |   |   [pod] [pod]              |
  |  kube-proxy (iptables/nftables)|   |  kube-proxy                |
  |  CNI plugin (pod networking)   |   |  CNI plugin                |
  +--------------------------------+   +----------------------------+
```

Notice the shape: **everything talks to the API server, and nothing talks to each other directly.** The scheduler never calls the kubelet. The Deployment controller never calls the scheduler. They coordinate entirely by reading and writing objects through the API. This hub-and-spoke design is why you can replace or add components (a different scheduler, a custom controller) without touching the rest.

## Control plane components

### kube-apiserver

The front door and the only component that reads and writes etcd. Every request goes through the same pipeline:

```text
request -> authentication -> authorization -> mutating admission
        -> schema validation -> validating admission -> etcd -> response
                (who?)          (allowed?)    (defaults,     (policy
                                               injection)     checks)
```

- **Authentication**: client certificates (what kind uses for you), bearer tokens, OIDC (common with EKS/GKE SSO), service account tokens for pods.
- **Authorization**: almost always RBAC. "Can user `roma` `create` `deployments` in namespace `shipit`?"
- **Admission**: plugins and webhooks that mutate (add defaults, inject sidecars) or reject (policy engines like Kyverno, built-in `ValidatingAdmissionPolicy`) requests.

It also serves **watches**: long-lived HTTP streams that push every change to an object type. Every controller and every kubelet holds watches open. The API server is stateless, so you scale it horizontally behind a load balancer.

### etcd

A distributed, strongly consistent key-value store using the Raft consensus algorithm. It holds *all* cluster state: every object you create lives under keys like `/registry/deployments/default/shipit-api`. Things to know:

- It needs a **quorum** (majority) to accept writes. Run 3 or 5 members; 3 tolerates one failure, 5 tolerates two. An even number buys you nothing.
- It is latency-sensitive (fsync on every write). Slow disks make the whole cluster feel slow.
- **Back it up.** Losing etcd without a backup means losing the cluster's definition. Managed services (EKS, GKE, AKS) run and back up etcd for you, and you never see it.

### kube-scheduler

Watches for Pods with no `spec.nodeName` and picks a node for each in two phases:

1. **Filter**: drop nodes that cannot run the pod (not enough CPU/memory requested, taints the pod does not tolerate, node selector or affinity mismatch, volume zone constraints).
2. **Score**: rank the remaining nodes (spread replicas, balance utilisation, prefer nodes with the image cached) and pick the best.

It then writes a **Binding** that sets `spec.nodeName`. That is all. It does not start anything. If no node fits, the pod stays `Pending` with an event like `0/3 nodes are available: 3 Insufficient memory`.

### kube-controller-manager

One binary that runs dozens of built-in controllers as goroutines: Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob, Node (notices dead nodes), EndpointSlice, Namespace (cleans up deleted namespaces), ServiceAccount, garbage collector, and more. In HA setups several copies run, but only one is active at a time thanks to **leader election** using `Lease` objects.

### cloud-controller-manager

Contains controllers that talk to a cloud provider's API: create a cloud load balancer for a `type: LoadBalancer` Service, label nodes with their zone, remove Node objects when the VM is deleted. It was split out of the core so cloud vendors can ship their own release cycle. On kind there is none by default; in module 05 you will run `cloud-provider-kind` to play this role locally.

## Node components

### kubelet

The agent on every node. It watches the API for Pods bound to its node and makes them real by calling the container runtime. It also:

- runs liveness, readiness and startup probes and restarts containers when needed,
- mounts volumes, injects Secrets and ConfigMaps,
- reports node and pod status back to the API (`Ready`, IPs, container states),
- renews the node's heartbeat `Lease` so the control plane knows it is alive,
- runs **static pods** from manifest files on disk without needing the API server (this is how kubeadm and kind run the control plane itself).

The kubelet runs as a system service (systemd) on the host, not as a pod.

### Container runtime and the CRI

The kubelet does not know how to run containers. It speaks the **Container Runtime Interface (CRI)**, a gRPC API, to a runtime such as **containerd** or **CRI-O**. The runtime pulls images and asks a low-level OCI runtime (usually **runc**) to create the Linux namespaces and cgroups.

```text
kubelet --(CRI gRPC)--> containerd --> containerd-shim --> runc --> your process
```

:::info "Kubernetes dropped Docker" — what that really meant
Until v1.24, the kubelet had a built-in adapter called dockershim to talk to Docker Engine. It was removed. Images built with `docker build` are standard OCI images and run exactly the same on containerd; only the daemon on the node changed. Docker itself uses containerd underneath anyway.
:::

### kube-proxy

Implements Services on each node. It watches Services and EndpointSlices and programs the kernel (iptables or nftables rules) so that traffic to a Service's virtual IP is load-balanced to healthy pod IPs. It does not proxy traffic in user space despite its name. Some CNI plugins (Cilium in eBPF mode) replace kube-proxy entirely. You will dig into this in module 05.

### Add-ons that every cluster has

- **CNI plugin** (kindnet on kind; VPC CNI on EKS; Calico, Cilium elsewhere): gives each pod an IP and connects pods across nodes.
- **CoreDNS**: cluster DNS so `shipit-api.shipit.svc.cluster.local` resolves to a Service IP.
- Often **metrics-server** (for `kubectl top` and autoscaling).

:::try Peek at the control plane
With a kind cluster running (`kind create cluster` if you do not have one yet), list the system pods and the nodes:

```bash
kubectl get nodes -o wide
kubectl get pods -n kube-system -o wide
```

Find the four control-plane pods whose names end in `-control-plane`: `etcd-…`, `kube-apiserver-…`, `kube-controller-manager-…`, `kube-scheduler-…`. These are static pods. Then find `kube-proxy-…` (one per node: a DaemonSet), `coredns-…` (a Deployment) and `kindnet-…` (the CNI).
:::

:::mac Nodes are containers
On your Mac, Docker runs inside a Linux VM (Docker Desktop, OrbStack or Colima). kind creates one Docker container per Kubernetes "node", and inside each one runs systemd, the kubelet and containerd. So `docker ps` shows your nodes, and `docker exec -it kind-control-plane bash` puts you "on the node". On Apple Silicon the node images and most public images are arm64; amd64-only images will fail with `exec format error`.
:::

## What happens when you `kubectl apply` a Deployment

This walk-through ties every component together. You run:

```bash
kubectl apply -f shipit-api-deployment.yaml   # replicas: 3
```

```text
 you                apiserver/etcd          controllers / scheduler            node
  |  1. PATCH/POST        |                          |                            |
  |---------------------->| 2. authn/authz/admission |                            |
  |      201 Created      |    store Deployment      |                            |
  |<----------------------|                          |                            |
  |                       |--3. watch event--------->| Deployment controller      |
  |                       |<--create ReplicaSet------|                            |
  |                       |--4. watch event--------->| ReplicaSet controller      |
  |                       |<--create 3 Pods (no node)|                            |
  |                       |--5. watch event--------->| scheduler: filter + score  |
  |                       |<--Binding: nodeName=w1---|                            |
  |                       |--6. watch event (pod on w1)-------------------------->| kubelet
  |                       |                          |      CRI: sandbox, CNI IP, |
  |                       |                          |      pull, create, start   |
  |                       |<--7. pod status: Running, Ready-----------------------|
  |                       |--8. EndpointSlice ctrl adds IP; kube-proxy updates rules
  |                       |<--9. Deployment status: availableReplicas=3           |
```

Step by step:

1. **kubectl** reads `~/.kube/config` to find the API server and credentials, converts YAML to JSON and sends it. With `kubectl apply` it either creates the object or sends a patch computed against the last applied configuration (or uses server-side apply with `--server-side`).
2. **kube-apiserver** authenticates you, checks RBAC, runs mutating admission (defaults such as `strategy: RollingUpdate`, `revisionHistoryLimit: 10` are filled in), validates the schema, runs validating admission, and writes the object to **etcd**. You get `deployment.apps/shipit-api created`. Nothing is running yet.
3. The **Deployment controller** gets a watch event. There is no ReplicaSet matching the current pod template, so it creates one, named `shipit-api-<pod-template-hash>`.
4. The **ReplicaSet controller** sees a ReplicaSet wanting 3 pods and owning 0. It creates 3 Pod objects with `ownerReferences` pointing at the ReplicaSet. They have no `nodeName`, so they are `Pending`.
5. The **scheduler** sees unscheduled pods, filters and scores nodes, and posts a Binding for each pod.
6. The **kubelet** on each chosen node sees a pod bound to it. Through CRI it asks containerd to create a **pod sandbox** (a `pause` container that holds the network namespace), the **CNI plugin** assigns the pod IP, the image is pulled, then each container is created and started.
7. The kubelet reports status: container states, pod IP, and `Ready=True` once readiness probes pass.
8. The **EndpointSlice controller** adds ready pod IPs to the Service's EndpointSlices; **kube-proxy** on every node updates its rules. Traffic can now reach the pods.
9. The Deployment controller updates `status.availableReplicas`. `kubectl rollout status` returns.

:::tip Use this as an interview answer
"What happens when you create a Deployment?" is a classic senior interview question. Mention the API server pipeline, etcd, the chain Deployment → ReplicaSet → Pod controllers, the scheduler's binding, kubelet + CRI + CNI, and the fact that everything is asynchronous and coordinated through watches. Bonus: mention that `kubectl apply` returning does not mean the app is running.
:::

## API objects: the anatomy

Every Kubernetes object has the same skeleton:

```yaml
apiVersion: apps/v1          # API group "apps", version "v1"  (core group: just "v1")
kind: Deployment             # the type
metadata:                    # identity and organisation
  name: shipit-api
  namespace: shipit
  labels:
    app.kubernetes.io/name: shipit-api
    app.kubernetes.io/part-of: shipit
  annotations:
    team.example.com/owner: "backend"
spec:                        # desired state (you write this)
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: shipit-api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: shipit-api
    spec:
      containers:
        - name: api
          image: ghcr.io/roma/shipit-api:1.4.2
          ports:
            - containerPort: 3000
status:                      # actual state (controllers write this; never put it in your YAML)
  replicas: 3
  readyReplicas: 3
  observedGeneration: 4
```

Fields the system adds to `metadata` that you should recognise:

| Field | Meaning |
| --- | --- |
| `uid` | Unique ID for this incarnation. Delete and recreate with the same name and you get a new uid. |
| `resourceVersion` | Opaque version used for optimistic concurrency and watches. Changes on every write. |
| `generation` | Incremented when `spec` changes. Compare with `status.observedGeneration` to see whether the controller has caught up. |
| `creationTimestamp` | When it was created. |
| `ownerReferences` | Who owns this object (a Pod's owner is a ReplicaSet). Used by garbage collection. |
| `finalizers` | Keys that block deletion until a controller has cleaned up (for example, deleting a cloud load balancer). |
| `managedFields` | Which manager (kubectl, a controller) owns which fields. Used by server-side apply. Hide it with `kubectl get ... -o yaml --show-managed-fields=false` (the default in recent kubectl). |

**API groups and versions.** The core group (Pods, Services, ConfigMaps, Secrets, Namespaces, Nodes) has `apiVersion: v1`. Everything else is `group/version`: `apps/v1` (Deployments), `batch/v1` (Jobs), `networking.k8s.io/v1` (NetworkPolicy, Ingress), `gateway.networking.k8s.io/v1` (Gateway API). Versions move through `v1alpha1` → `v1beta1` → `v1`. Old versions get removed, which is why upgrades sometimes break manifests.

**Ownership and garbage collection.** Delete a Deployment and its ReplicaSets and Pods disappear too, because each child has an `ownerReference` to its parent. The garbage collector deletes orphans in the background (cascading deletion). `kubectl delete deploy x --cascade=orphan` leaves the children behind.

:::try Read the schema from the cluster
`kubectl explain` reads the OpenAPI schema served by your own cluster, so it is always correct for your version:

```bash
kubectl explain deployment.spec.strategy
kubectl explain pod.spec.containers.resources --recursive | head -30
kubectl api-resources --api-group=apps
```
:::

:::deep Watches, resourceVersion and optimistic concurrency
Controllers do not poll. They use the **list-then-watch** pattern: `GET /apis/apps/v1/deployments` returns the full list plus a `resourceVersion`; then `GET ...?watch=true&resourceVersion=N` streams `ADDED`, `MODIFIED`, `DELETED` events from that point. Client libraries wrap this in **informers**, which keep a local in-memory cache and call handlers that push object keys onto a **work queue**. A worker pops a key, reads the latest object from the cache, and reconciles. If the same object changes ten times quickly, the key sits in the queue once: this is how level-triggering collapses bursts.

Writes use **optimistic concurrency**. When you `PUT` an object, the `resourceVersion` you send must match the stored one; if another writer got there first, you get `409 Conflict` and must re-read and retry. This is why two controllers can safely update the same object, and why `kubectl edit` occasionally says "the object has been modified; please apply your changes to the latest version".

Inside etcd, objects are stored under `/registry/<resource>/<namespace>/<name>`, encoded as protobuf (not JSON) for built-in types, and optionally encrypted at rest. Each etcd revision corresponds to a `resourceVersion`. etcd keeps a history window, which lets watches resume after a short disconnect; if a client asks for a version that has been compacted away, it gets `410 Gone` and must re-list.
:::

## Namespaces

A namespace is a scope for names and a unit for policy. Two Deployments called `api` can coexist in `shipit-dev` and `shipit-prod`. Namespaces are where you attach RBAC permissions, ResourceQuotas, LimitRanges and NetworkPolicies.

Built-in namespaces:

- `default`: where things go when you do not specify one. Avoid using it for real work.
- `kube-system`: control-plane and system add-ons.
- `kube-public`: readable by everyone, rarely used.
- `kube-node-lease`: node heartbeat Leases.

Not everything is namespaced. Nodes, PersistentVolumes, StorageClasses, ClusterRoles, Namespaces themselves and CRDs are **cluster-scoped**. Check with `kubectl api-resources --namespaced=false`.

:::warning Namespaces are not a security boundary by themselves
Pods in different namespaces can talk to each other over the network by default, and a node runs pods from any namespace. Isolation requires RBAC, NetworkPolicies, Pod Security admission and sometimes separate node pools or clusters. Treat namespaces as folders with permissions, not as walls.
:::

## Labels, selectors and annotations

**Labels** are key/value pairs used to *identify and select* objects. They are how loosely coupled objects find each other:

- A Deployment's `spec.selector` finds its pods by label.
- A Service's `spec.selector` decides which pods receive traffic.
- `kubectl get pods -l app.kubernetes.io/name=shipit-api` filters by label.

Selectors support equality and set-based expressions:

```bash
kubectl get pods -l 'app.kubernetes.io/name=shipit-api,tier!=cache'
kubectl get pods -l 'environment in (staging,prod)'
kubectl get pods -l '!canary'          # pods without the label
```

```yaml
selector:
  matchLabels:
    app.kubernetes.io/name: shipit-api
  matchExpressions:
    - { key: track, operator: In, values: [stable, canary] }
```

Use the **recommended labels** so tools (Helm, dashboards, Argo CD) understand your objects: `app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/version`, `app.kubernetes.io/component`, `app.kubernetes.io/part-of`, `app.kubernetes.io/managed-by`.

**Annotations** are also key/value pairs but are *not* used for selection. They carry metadata for tools and humans: a git commit SHA, `kubectl.kubernetes.io/last-applied-configuration`, `kubernetes.io/change-cause`, controller configuration, a contact email. Values can be large (up to 256 KiB total), labels values cannot (63 characters).

:::warning Selectors on Deployments are immutable
After creation you cannot change a Deployment's `spec.selector`. Also, its selector must match the pod template labels. Pick stable, minimal selector labels (like `app.kubernetes.io/name`) and put changing things like `version` in other labels, not in the selector.
:::

## The API is the center

Everything is a REST resource with a predictable path:

```text
/api/v1/namespaces/{ns}/pods/{name}                    core group
/apis/apps/v1/namespaces/{ns}/deployments/{name}       named group
/apis/apps/v1/namespaces/{ns}/deployments/{name}/scale subresource
/api/v1/nodes/{name}                                   cluster-scoped
```

kubectl is just a friendly HTTP client. Run any command with `-v=6` (or `-v=8` to see bodies) to see the requests:

```bash
kubectl get pods -v=6 2>&1 | grep GET
```

Because the API is uniform and extensible, you can add your own types with **CustomResourceDefinitions (CRDs)** and write controllers for them. That is what an **operator** is: a CRD such as `PostgresCluster` plus a controller that reconciles it into StatefulSets, Services and backups. Gateway API, cert-manager, Argo CD and Prometheus Operator all work this way. You will meet them later in the track, and they will feel familiar because they follow the same pattern you learned here.

:::try Talk to the API without kubectl's formatting
```bash
kubectl get --raw /version
kubectl get --raw /apis/apps/v1 | head -c 600; echo
kubectl get --raw "/api/v1/namespaces/kube-system/pods?limit=1" | head -c 600; echo
```
The JSON you see is exactly what controllers see.
:::

## Pitfalls and production best practices

:::warning Common misconceptions
- **"apply succeeded, so it is deployed."** Apply only stores desired state. Gate CI on `kubectl rollout status deploy/x --timeout=120s`.
- **Editing pods owned by a controller.** Changes to a pod managed by a ReplicaSet are overwritten or lost when the pod is replaced. Change the Deployment instead.
- **Fighting a controller.** If you `kubectl scale` a Deployment that an HPA or GitOps tool manages, they will put it back. Find the owner of the desired state.
- **Running one etcd member or an even number.** Use 3 or 5, on fast SSDs, with tested backups (or use a managed control plane).
:::

Best practices to adopt from day one:

- Keep manifests in git and treat the cluster as a cache of that desired state (GitOps comes later in the track).
- Use namespaces per app or team and environment, never `default`.
- Apply the recommended `app.kubernetes.io/*` labels consistently.
- Learn to read `status` and `events` before guessing: `kubectl describe` and `kubectl events` show what controllers think.
- On managed Kubernetes (EKS/GKE/AKS) you do not operate the control plane, but you still need to understand it: API rate limits, admission webhooks that time out, and version skew all show up as your problems.

## Summary

- Kubernetes stores desired state as API objects; controllers continuously reconcile actual state towards it.
- The API server is the hub: authn, authz, admission, validation, persistence to etcd, and watches. Nothing else touches etcd.
- The scheduler only assigns `nodeName`; controllers create and manage objects; the kubelet runs pods through CRI; kube-proxy implements Services.
- Every object has apiVersion, kind, metadata, spec and status. Labels select, annotations describe, namespaces scope.
- Everything is asynchronous, so you verify outcomes with `rollout status`, `wait`, `describe` and events.
