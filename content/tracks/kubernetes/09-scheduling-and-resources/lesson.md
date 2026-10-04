Every pod you create goes through the same two questions: **which node should it run on**, and **how much of that node may it use**. Get them wrong and you see the classic production symptoms: pods `Pending` forever, latency spikes from CPU throttling, `OOMKilled` restarts, a single node failure taking out all replicas, or a node drain that hangs. This module explains the machinery behind both questions and how to tune it for real services like `shipit-api`.

## Requests and limits: the contract

Each container can declare, per resource:

```yaml
resources:
  requests:            # what the scheduler reserves for you
    cpu: 250m          # 0.25 of a CPU core
    memory: 256Mi
  limits:              # the hard ceiling enforced on the node
    cpu: "1"
    memory: 512Mi
```

- **Requests** are used for **scheduling**. The scheduler only places a pod on a node whose *allocatable* capacity minus the *sum of requests* already placed there fits the new pod's requests. Actual usage is irrelevant to the scheduler.
- **Limits** are enforced at **runtime** by the kernel (cgroups) through the container runtime.

Units: CPU in cores or millicores (`500m` = half a core, `2` = two cores). Memory in bytes with binary suffixes (`Mi`, `Gi`). Beware `M` vs `Mi` (`256M` is 256,000,000 bytes) and `m` on memory (`256m` means 0.256 bytes, a classic typo).

```text
 Node allocatable: 4 CPU / 8Gi        (capacity minus kubelet/system reservations)
 +-----------------------------------------------------------+
 | pod A req 1 CPU / 2Gi | pod B req 1.5 / 2Gi | free: 1.5 / 4Gi |
 +-----------------------------------------------------------+
 New pod requesting 2 CPU -> does NOT fit on this node, even if A and B are idle.
```

`kubectl describe node <name>` shows "Allocated resources": the sum of requests and limits as a percentage of allocatable. Limits can add up to more than 100% (overcommit); requests cannot.

### CPU is compressible, memory is not

What happens when a container hits its limit differs fundamentally:

| | CPU | Memory |
| --- | --- | --- |
| Request means | Proportional share of CPU time under contention (cgroup weight) | Scheduling reservation; also used to rank pods for eviction |
| Exceeding the limit | **Throttled**: the process is paused until the next period (100 ms CFS period) | **OOMKilled**: the kernel kills the process, exit code 137, reason `OOMKilled` |
| Symptom | Latency goes up, nothing crashes | Restarts, `CrashLoopBackOff` |

CPU throttling is sneaky. A limit of `500m` means 50 ms of CPU time per 100 ms period. A Node.js request handler that needs 80 ms of CPU in a burst runs for 50 ms, sleeps 50 ms, then finishes, so p99 latency jumps even though average CPU usage looks low. Multi-threaded runtimes burn the quota faster (four threads use 50 ms of quota in 12.5 ms of wall time).

:::deep The CPU limits debate
Many experienced operators **set CPU requests but no CPU limits** for latency-sensitive services. Reasoning: requests already guarantee each pod its fair share under contention (via cgroup weights), and limits only add throttling when spare CPU is sitting idle on the node. Others keep limits to make performance predictable (a pod should not get used to free CPU it will not have on a busier node) or for multi-tenant fairness and cost control.

A pragmatic default for web APIs: CPU request sized from observed usage, no CPU limit (or a generous one), and **memory request = memory limit**. Memory limits are non-negotiable, because a pod that overuses memory hurts its neighbours through node-level OOM kills and evictions. Whatever you choose, measure throttling: the cgroup file `cpu.stat` exposes `nr_throttled` and `throttled_usec`, and cAdvisor exports `container_cpu_cfs_throttled_periods_total` to Prometheus.
:::

:::tip In-place resize
Since Kubernetes 1.35, in-place pod resize is GA: you can change a running pod's CPU and memory requests/limits through the `resize` subresource (`kubectl patch pod <name> --subresource resize --patch ...`) without recreating it, subject to the container's `resizePolicy`. Memory decreases may still require a restart. Deployments still roll out new pods when you change their template; in-place resize is mainly used by tools like VPA.
:::

## QoS classes and eviction

From your requests and limits, Kubernetes derives a **Quality of Service class** for each pod:

| QoS class | Rule | Eviction priority |
| --- | --- | --- |
| **Guaranteed** | Every container has CPU and memory requests **equal** to limits | Last to be evicted |
| **Burstable** | At least one request or limit set, but not Guaranteed | Middle; those using most above their requests go first |
| **BestEffort** | No requests or limits at all | First to be evicted |

```bash
kubectl get pod shipit-api-7d9f -o jsonpath='{.status.qosClass}'
```

Two different "killers" exist, and it helps to tell them apart:

- **Container OOM kill** (kernel, cgroup level): the container exceeded *its own* memory limit. Status shows `OOMKilled`, the container restarts in place.
- **Node-pressure eviction** (kubelet): the *node* is running low on memory, disk or PIDs. The kubelet evicts whole pods, ranked by QoS and usage above requests, sets the pod status to `Failed` with reason `Evicted`, and the controller creates a replacement elsewhere.

:::warning BestEffort in production
A pod with no requests can be scheduled on a node that is already full, and it is the first thing evicted under pressure. Always set requests for production workloads. LimitRange (below) can enforce that.
:::

## LimitRange and ResourceQuota

Both are namespace-scoped policies, typically managed by the platform team.

**LimitRange** sets per-container defaults and bounds, applied at admission time:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: team-shipit
spec:
  limits:
    - type: Container
      defaultRequest:       # used when a container sets no request
        cpu: 100m
        memory: 128Mi
      default:              # used when a container sets no limit
        memory: 256Mi
      max:
        cpu: "2"
        memory: 2Gi
      min:
        memory: 32Mi
```

**ResourceQuota** caps the total for the whole namespace:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-budget
  namespace: team-shipit
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.memory: 12Gi
    pods: "30"
    persistentvolumeclaims: "10"
    requests.storage: 100Gi
    services.loadbalancers: "1"
```

Once a quota covers `requests.cpu` or `requests.memory`, **every** new pod in the namespace must specify them (or get them from a LimitRange), otherwise it is rejected.

:::warning Quota failures do not create Pending pods
When a Deployment would exceed the quota, the ReplicaSet controller cannot create the pod at all. You see `READY 2/5` but no Pending pods. The reason is in the **ReplicaSet's** events: `kubectl describe rs <name>` shows `exceeded quota: team-budget`. Check `kubectl describe resourcequota -n <ns>` for used vs hard.
:::

## How the scheduler works

kube-scheduler watches for pods with no `spec.nodeName`, picks a node and writes a **Binding**. For each pod it runs a pipeline of plugins:

```text
 Pending pod (no nodeName)
        |
        v
 PreFilter / Filter   "which nodes CAN run it?"   (hard constraints)
   NodeResourcesFit     requests fit allocatable?
   NodeAffinity         nodeSelector / required affinity match?
   TaintToleration      all NoSchedule taints tolerated?
   PodTopologySpread    DoNotSchedule constraints satisfied?
   InterPodAffinity     required (anti-)affinity satisfied?
   VolumeBinding/Zone   can its volumes attach there?
        |
        v   feasible nodes (if none -> preemption attempt, else stays Pending)
 Score                "which node is BEST?"        (soft preferences, weighted)
   NodeResourcesFit (LeastAllocated by default: spread load)
   ImageLocality, preferred affinities, ScheduleAnyway spread, ...
        |
        v
 Reserve -> Permit -> Bind   (pod.spec.nodeName = chosen node)
        |
        v
 kubelet on that node starts the containers
```

When no node passes the filters, the pod stays `Pending` and the scheduler records an event that summarises why each node was rejected:

```text
0/4 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: },
2 Insufficient memory, 1 node(s) didn't match Pod's node affinity/selector.
preemption: 0/4 nodes are available: ...
```

Read this message carefully; it is almost always the answer. `kubectl describe pod <name>` shows it under Events, as does `kubectl get events --field-selector reason=FailedScheduling`.

:::info The scheduler does not rebalance
Scheduling happens once. If you add a node, existing pods do not move to it; if you change affinity rules, running pods stay where they are until recreated. The **descheduler** project can evict pods that violate current policies so they get rescheduled.
:::

## Placing pods on nodes

### nodeSelector

The simplest constraint: the node must have all listed labels.

```yaml
spec:
  nodeSelector:
    kubernetes.io/arch: arm64          # e.g. Graviton nodes on AWS
```

Well-known labels worth knowing: `kubernetes.io/hostname`, `kubernetes.io/os`, `kubernetes.io/arch`, `topology.kubernetes.io/zone`, `topology.kubernetes.io/region`, `node.kubernetes.io/instance-type`. Karpenter and EKS add more (`karpenter.sh/capacity-type: spot`, `eks.amazonaws.com/nodegroup`).

### Node affinity

A more expressive nodeSelector, with hard and soft rules:

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:            # terms are ORed
          - matchExpressions:         # expressions in a term are ANDed
              - key: kubernetes.io/arch
                operator: In
                values: ["arm64", "amd64"]
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80
          preference:
            matchExpressions:
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["spot"]
```

Operators: `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt`. "IgnoredDuringExecution" means that if node labels change later, running pods are not evicted.

### Pod affinity and anti-affinity

Rules relative to **other pods**, within a topology domain defined by a node label:

```yaml
spec:
  affinity:
    podAntiAffinity:
      # Never put two shipit-api pods on the same node
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: shipit-api
          topologyKey: kubernetes.io/hostname
    podAffinity:
      # Prefer running in the same zone as the Redis cache (lower latency, no cross-AZ data charges)
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 50
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: redis
            topologyKey: topology.kubernetes.io/zone
```

Required anti-affinity per hostname caps your replicas at the number of nodes: the fourth replica on a three-node cluster stays Pending. For spreading, `topologySpreadConstraints` is usually the better tool. Inter-pod affinity is also comparatively expensive for the scheduler in large clusters.

### Taints and tolerations

Affinity *attracts* pods to nodes. Taints let a node *repel* pods, unless a pod explicitly tolerates the taint:

```bash
kubectl taint nodes gpu-node-1 dedicated=gpu:NoSchedule
kubectl taint nodes gpu-node-1 dedicated=gpu:NoSchedule-     # remove (trailing dash)
```

```yaml
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: gpu
      effect: NoSchedule
```

Effects:

- `NoSchedule`: new pods without a toleration are not scheduled here; running pods stay.
- `PreferNoSchedule`: soft version.
- `NoExecute`: also **evicts** running pods that do not tolerate it (optionally after `tolerationSeconds`).

A toleration only *allows* a pod onto a tainted node; it does not *send* it there. For dedicated nodes you combine a taint (keep others out) with node affinity or a nodeSelector (pull your pods in).

Kubernetes uses taints itself: control-plane nodes carry `node-role.kubernetes.io/control-plane:NoSchedule`, and unhealthy nodes get `node.kubernetes.io/not-ready` or `node.kubernetes.io/unreachable` with `NoExecute`. Every pod gets default tolerations for those two with `tolerationSeconds: 300`, which is why pods on a dead node are only replaced after about five minutes. DaemonSets tolerate them indefinitely.

### Topology spread constraints

The recommended way to spread replicas across zones and nodes:

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule      # hard; ScheduleAnyway = soft
      labelSelector:
        matchLabels:
          app: shipit-api
      matchLabelKeys: ["pod-template-hash"] # count only pods of the same rollout revision
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app: shipit-api
```

`maxSkew: 1` means the difference in matching pods between the most and least loaded domain may be at most 1. With 6 replicas over 3 zones you get 2/2/2; zone outage leaves 4 running.

```text
 zone-a: [api][api]    zone-b: [api][api]    zone-c: [api][api]     skew = 0  OK
 zone-a: [api][api][api]  zone-b: [api]  zone-c: [api][api]          skew = 2  violates maxSkew 1
```

:::warning Tainted nodes count as empty domains
By default, topology spread counts **all** nodes that match the pod's node affinity when computing skew, **including nodes with taints the pod does not tolerate** (`nodeTaintsPolicy: Ignore`). If a zone only has tainted nodes, it counts as a domain with zero pods, and with `DoNotSchedule` your other zones are capped and pods stay Pending. Set `nodeTaintsPolicy: Honor` on the constraint to exclude nodes the pod cannot tolerate. Lab 5 shows this.
:::

:::try Look at your node labels
On any cluster run `kubectl get nodes --show-labels` and `kubectl get nodes -L topology.kubernetes.io/zone,kubernetes.io/arch`. On kind there are no zone labels until you add them (`kubectl label node <name> topology.kubernetes.io/zone=zone-a`), which is exactly what Lab 5 does to simulate a multi-AZ cluster.
:::

## Priority and preemption

A **PriorityClass** gives pods an integer priority. When a high-priority pod cannot be scheduled, the scheduler may **preempt** (evict) lower-priority pods to make room.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: business-critical
value: 100000
globalDefault: false
preemptionPolicy: PreemptLowerPriority   # or Never: high priority in the queue, but never evicts others
description: "Customer-facing APIs"
---
# In the pod spec
spec:
  priorityClassName: business-critical
```

Built-in classes `system-cluster-critical` and `system-node-critical` protect components such as CoreDNS and CNI agents. Typical use: give APIs a higher priority than batch jobs and preview environments, so that under capacity pressure the batch work yields. Preemption respects PodDisruptionBudgets on a best-effort basis only, and the preempted pods get their graceful termination period.

A related trick is **overprovisioning**: run "balloon" pods with negative priority that only reserve capacity. When real pods arrive they preempt the balloons instantly, and the cluster autoscaler adds a node for the evicted balloons in the background (module 10).

## Disruptions: PDBs, cordon and drain

**Voluntary disruptions** are the ones you or automation cause: node drains for upgrades, Karpenter consolidation, cluster autoscaler scale-down. **Involuntary** ones are hardware failures, kernel panics and OOM. A **PodDisruptionBudget** limits how many pods of an app voluntary disruptions may take down at once:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shipit-api
spec:
  minAvailable: 2               # or maxUnavailable: 1 (usually the better choice)
  selector:
    matchLabels:
      app: shipit-api
  unhealthyPodEvictionPolicy: AlwaysAllow   # let drains evict pods that are not Ready anyway
```

Drain workflow:

```bash
kubectl cordon node-1          # mark unschedulable (no new pods)
kubectl drain node-1 --ignore-daemonsets --delete-emptydir-data
#   uses the Eviction API for each pod; blocks/retries while a PDB would be violated
kubectl uncordon node-1        # make schedulable again after maintenance
```

`drain` calls the Eviction API, which returns HTTP 429 when evicting a pod would violate its PDB, and `kubectl` retries until the budget allows it. Pods not managed by a controller are refused unless you add `--force` (they would be gone forever).

:::warning PDBs that block everything
`minAvailable: 3` on a 3-replica Deployment (or `maxUnavailable: 0`) means **no** pod can ever be evicted voluntarily: node drains, upgrades and Karpenter consolidation hang forever. A PDB on a single-replica app has the same effect. Use `maxUnavailable: 1` with at least two replicas, and make sure replacement pods can actually be scheduled elsewhere.
:::

## Right-sizing: measuring real usage

You cannot set good requests without data. **metrics-server** collects CPU and memory usage from each kubelet every few seconds and serves the `metrics.k8s.io` API used by `kubectl top` and the HPA (module 10). It keeps only the latest values; for history use Prometheus.

```bash
kubectl top nodes
kubectl top pods -A --sort-by=memory
kubectl top pod -l app=shipit-api --containers
```

A sizing loop that works:

1. Start with a reasonable guess (for a small Node API: `cpu: 100m-250m`, `memory: 256Mi` request and limit).
2. Run realistic load (module 10 uses k6) and watch `kubectl top` or Prometheus for p95 usage over days, not minutes.
3. Set CPU request near typical usage under normal load, memory request/limit with headroom above the observed peak (20 to 30 percent).
4. Revisit after major releases. The **Vertical Pod Autoscaler** in recommendation mode can do the analysis for you (module 10).

## Node.js memory: heap vs container limit

A Node process's memory has several parts, and only one of them is the V8 heap:

```text
 Container memory limit (cgroup): 512Mi  -> exceed it and the kernel OOMKills (exit 137)
 +------------------------------------------------------------+
 | V8 heap (old + new space)   bounded by --max-old-space-size |  exceed it: "FATAL ERROR: ... JavaScript heap
 |                                                            |   out of memory", process aborts (exit 134)
 +------------------------------------------------------------+
 | Off-heap: Buffers/ArrayBuffers, native addons, libuv,      |  not limited by the heap setting
 | thread stacks, code space, JIT                             |
 +------------------------------------------------------------+
```

Recent Node.js versions read the cgroup memory limit and size the default heap from it (roughly half of the limit on small containers, capped at a couple of GB), but the exact heuristic depends on the Node/V8 version. Do not guess, check:

```bash
kubectl exec deploy/shipit-api -- node -e \
  "console.log(Math.round(require('v8').getHeapStatistics().heap_size_limit/1048576) + ' MB heap limit')"
```

Guidelines:

- Set `--max-old-space-size` explicitly (via `NODE_OPTIONS`) to about **70 to 80 percent** of the container memory limit, leaving room for Buffers and native memory. For a 512Mi limit, `--max-old-space-size=384`. Newer Node releases also offer a percentage-based flag (`--max-old-space-size-percentage`); check `node --help` for your version.
- A heap OOM (exit 134, stack trace in logs) means your code needs more heap or has a leak. A kernel OOMKill (exit 137, no JS stack trace, `lastState.terminated.reason: OOMKilled`) means total memory (often Buffers, streams, image processing) exceeded the limit.
- Prefer several small replicas with ~1 CPU or less over one huge pod: Node runs JavaScript on one thread, so a 4-CPU request mostly sits idle unless you use worker threads or the cluster module.
- `os.cpus().length` returns the node's CPUs, not your limit. If you fork workers, size the count from an env var (or the downward API `limits.cpu`), not from the host.

```yaml
containers:
  - name: api
    image: ghcr.io/roma/shipit-api:1.4.2
    env:
      - name: NODE_OPTIONS
        value: "--max-old-space-size=384"
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        memory: 512Mi
```

:::try Read a container's exit reason
After any crash, `kubectl get pod <name> -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'` prints the exit code and reason. 137 with `OOMKilled` points at the cgroup limit; 134 points at the V8 heap; 1 is your own `process.exit(1)` or an uncaught exception. Lab 3 lets you produce all of them.
:::

## Pitfalls and best practices

:::warning Common mistakes
- **No requests**: BestEffort pods, overloaded nodes, early eviction.
- **Requests far above usage**: nodes look full while CPUs idle; you pay for empty capacity. The scheduler only sees requests.
- **Tight CPU limits on latency-sensitive services**: throttling with low average CPU.
- **Memory limit below the real peak** or a Node heap limit larger than the container limit: OOMKills under load.
- **Required anti-affinity with more replicas than nodes**: permanently Pending pods.
- **PDB with `maxUnavailable: 0`**: drains and upgrades never finish.
- **Forgetting the control-plane taint** when wondering why kind's control-plane node gets no pods.
:::

Best practices for a production service:

- Requests on every container; memory limit = memory request; CPU limit optional and generous.
- At least 2 replicas (3 for critical APIs), spread across zones with `topologySpreadConstraints`, plus a PDB with `maxUnavailable: 1`.
- PriorityClasses that rank customer-facing workloads above batch.
- LimitRange defaults and ResourceQuotas per team namespace.
- Measure with metrics-server/Prometheus, size from data, and revisit regularly.
