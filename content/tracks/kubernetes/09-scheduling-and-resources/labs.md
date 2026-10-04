You need `docker`, `kind` and `kubectl`. All labs share a four-node cluster (one control plane, three workers) so you can see real scheduling decisions:

```bash
cat <<'EOF' > /tmp/sched-lab.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
  - role: worker
EOF
kind create cluster --name sched-lab --config /tmp/sched-lab.yaml
kubectl get nodes
```

Install metrics-server for `kubectl top`. kind's kubelets use self-signed serving certificates, so metrics-server needs `--kubelet-insecure-tls` (fine locally, never in production):

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deployment/metrics-server
sleep 30; kubectl top nodes
```

:::mac Every kind node sees the whole VM
kind nodes are containers sharing your Docker VM, so each one reports the VM's full CPU and memory as capacity (for example 8 CPUs and 8Gi each, even though there is only one VM). Scheduling still works exactly as on a real cluster; just remember the numbers are not independent machines. Adjust Docker Desktop/OrbStack/Colima resources if the VM is very small.
:::

## Lab 1: Requests, limits, QoS and a pod that does not fit

:::meta
difficulty: easy
time: 20 min
:::

Goal: create pods in each QoS class, read allocated resources on a node, and see the scheduler reject a pod whose requests do not fit anywhere.

### Steps

1. Create three pods with different resource settings:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: qos-guaranteed
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sleep", "3600"]
      resources:
        requests: { cpu: 100m, memory: 64Mi }
        limits:   { cpu: 100m, memory: 64Mi }
---
apiVersion: v1
kind: Pod
metadata:
  name: qos-burstable
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sleep", "3600"]
      resources:
        requests: { cpu: 50m, memory: 32Mi }
        limits:   { memory: 128Mi }
---
apiVersion: v1
kind: Pod
metadata:
  name: qos-besteffort
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sleep", "3600"]
EOF
kubectl get pods -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass,NODE:.spec.nodeName
```

2. Look at how much of a node is reserved:

```bash
NODE=$(kubectl get pod qos-guaranteed -o jsonpath='{.spec.nodeName}')
kubectl describe node "$NODE" | sed -n '/Allocatable:/,/System Info:/p'
kubectl describe node "$NODE" | sed -n '/Allocated resources:/,/Events:/p'
```

3. Ask for more CPU than any node has:

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: too-big
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sleep", "3600"]
      resources:
        requests: { cpu: "200", memory: 64Mi }
EOF
sleep 3
kubectl get pod too-big
kubectl describe pod too-big | sed -n '/Events:/,$p'
```

### Verify

- The three pods show `Guaranteed`, `Burstable` and `BestEffort`.
- The node's "Allocated resources" includes the 100m/64Mi of the Guaranteed pod.
- `too-big` is `Pending` with `0/4 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 3 Insufficient cpu`.

:::hint
QoS is computed per pod from all containers. Guaranteed needs CPU **and** memory requests equal to limits in **every** container.
:::

:::solution
The steps are the solution. Two details worth noting:

- In `qos-burstable` the memory limit is set without a CPU limit. That is allowed and common.
- If you set only limits (no requests), Kubernetes copies limits into requests, so a container with `limits: {cpu: 100m, memory: 64Mi}` and nothing else is Guaranteed.

Fix `too-big` by lowering the request to something that fits (`kubectl delete pod too-big` and re-apply with `cpu: 500m`).
:::

### Clean up

```bash
kubectl delete pod qos-guaranteed qos-burstable qos-besteffort too-big
```

## Lab 2: Memory OOMKill vs CPU throttling

:::meta
difficulty: easy
time: 20 min
:::

Goal: see the two different ways limits are enforced: a memory hog gets killed, a CPU hog gets throttled.

### Steps

1. A Node.js process that keeps allocating 16 MB Buffers, with a 128Mi limit:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: mem-hog
spec:
  containers:
    - name: app
      image: node:22-alpine
      command: ["node", "-e"]
      args:
        - |
          const keep = [];
          setInterval(() => {
            keep.push(Buffer.alloc(16 * 1024 * 1024, 1));
            console.log('rss MB', Math.round(process.memoryUsage().rss / 1048576));
          }, 500);
      resources:
        requests: { memory: 128Mi, cpu: 100m }
        limits:   { memory: 128Mi }
EOF
sleep 20
kubectl get pod mem-hog
kubectl logs mem-hog --previous | tail -3
kubectl get pod mem-hog -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'; echo
```

2. A busy loop with a CPU limit of 200m:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: cpu-hog
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "while true; do :; done"]
      resources:
        requests: { cpu: 100m, memory: 16Mi }
        limits:   { cpu: 200m, memory: 32Mi }
EOF
sleep 45
kubectl top pod cpu-hog
kubectl exec cpu-hog -- cat /sys/fs/cgroup/cpu.stat
sleep 10
kubectl exec cpu-hog -- cat /sys/fs/cgroup/cpu.stat
```

### Verify

- `mem-hog` restarts repeatedly (`RESTARTS` grows, then `CrashLoopBackOff`); `lastState.terminated` shows `exitCode: 137` and `reason: OOMKilled`. The last log lines show RSS approaching 128 MB.
- `cpu-hog` keeps running. `kubectl top` shows about `200m`, and `nr_throttled` / `throttled_usec` in `cpu.stat` grow between the two reads.

:::hint
If `kubectl top` says metrics are not available yet, wait another 30 seconds; metrics-server needs a couple of scrape intervals. `cpu.stat` is the cgroup v2 file; on old cgroup v1 hosts it lives elsewhere, but Docker Desktop, OrbStack and Colima all use cgroup v2.
:::

:::solution
The steps are the solution. What you saw:

- **Memory is incompressible.** When the container's cgroup reached 128Mi, the kernel's OOM killer killed the process (SIGKILL, exit 137). The kubelet restarted it, and after repeated failures backed off (`CrashLoopBackOff`). The memory here was Buffers (off the V8 heap), so V8's heap limit never triggered.
- **CPU is compressible.** The loop wanted a whole core but got 20 ms per 100 ms period. It never crashed; it just ran slower. In a real API this shows up as higher latency, not errors, which is why throttling metrics matter.
:::

### Clean up

```bash
kubectl delete pod mem-hog cpu-hog
```

## Lab 3: Break and fix: the report worker keeps dying

:::meta
difficulty: medium
time: 25 min
:::

Goal: a Node.js worker needs about 200 MB of JavaScript heap to build a report. It runs in a 256Mi container and keeps crashing. Find out *which* limit kills it and fix the configuration properly.

### Setup

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: report-worker
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
              const v8 = require('v8');
              const target = Number(process.env.TARGET_MB || 200);
              console.log('heap limit MB', Math.round(v8.getHeapStatistics().heap_size_limit / 1048576));
              const keep = [];
              const t = setInterval(() => {
                for (let i = 0; i < 10; i++) keep.push(Array.from({ length: 131072 }, () => Math.random()));
                const m = process.memoryUsage();
                console.log('heapUsed MB', Math.round(m.heapUsed / 1048576), 'rss MB', Math.round(m.rss / 1048576));
                if (m.heapUsed / 1048576 >= target) { console.log('report built, holding it'); clearInterval(t); }
              }, 500);
              setInterval(() => {}, 1 << 30);
          env:
            - name: TARGET_MB
              value: "200"
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { memory: 256Mi }
EOF
```

### Your task

1. Determine how the container dies: V8 heap limit or cgroup memory limit? Use the exit code, reason and logs.
2. Fix it so the worker reaches `report built, holding it` and stays `Running` with zero restarts, with an explicit, sensible relationship between the heap limit and the container limit.

### Verify

```bash
kubectl rollout status deploy/report-worker
sleep 20
kubectl get pods -l app=report-worker
kubectl logs deploy/report-worker | grep -E 'heap limit|report built'
kubectl top pod -l app=report-worker
```

:::hint
`kubectl logs deploy/report-worker --previous` shows the end of the crashed run, and `kubectl get pod -l app=report-worker -o jsonpath='{.items[0].status.containerStatuses[0].lastState.terminated}'` shows exit code and reason. Exit 134 with `JavaScript heap out of memory` is V8; exit 137 with `OOMKilled` is the kernel. The first log line tells you the heap limit Node chose for this container.
:::

:::solution
**Diagnosis.** On current Node versions, the first log line shows a heap limit of roughly half the container limit (around 128 MB for 256Mi), because Node sizes its default heap from the cgroup limit. The worker needs 200 MB of heap, so V8 aborts with `FATAL ERROR: ... Reached heap limit Allocation failed - JavaScript heap out of memory` and **exit code 134** (reason `Error`). If your Node version did not detect the cgroup limit, the heap limit is much larger, the process grows past 256Mi instead, and you see **exit 137, `OOMKilled`**. Either way, the configuration is inconsistent with the workload.

**Fix.** Give the container enough memory for ~200 MB of heap plus off-heap overhead, and set the heap limit explicitly to about 75% of the container limit:

```bash
kubectl set resources deploy/report-worker --requests=cpu=100m,memory=384Mi --limits=memory=384Mi
kubectl set env deploy/report-worker NODE_OPTIONS=--max-old-space-size=288
```

Now `heap limit MB` reports about 288 (plus a little for new space), the heap reaches 200 MB, RSS stays well below 384Mi, and the pod keeps running.

Why not just raise `--max-old-space-size` to 240 and keep 256Mi? Then the heap could legally grow to nearly the whole container limit, and Buffers, code space and thread stacks would push RSS over 256Mi, turning a clear heap error into a kernel OOMKill. Keep the heap at roughly 70 to 80 percent of the limit.
:::

### Clean up

```bash
kubectl delete deploy report-worker
```

## Lab 4: LimitRange and ResourceQuota for a team namespace

:::meta
difficulty: medium
time: 25 min
:::

Goal: give a team namespace defaults and a budget, and learn where quota failures show up (hint: not on pods).

### Steps

1. Create the namespace with a LimitRange and a ResourceQuota:

```bash
kubectl create namespace team-a
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: team-a
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 64Mi }
      default:        { memory: 128Mi }
      max:            { cpu: "1", memory: 512Mi }
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: budget
  namespace: team-a
spec:
  hard:
    requests.cpu: 500m
    requests.memory: 512Mi
    limits.memory: 1Gi
    pods: "10"
EOF
kubectl describe limitrange defaults -n team-a
kubectl describe resourcequota budget -n team-a
```

2. Create a pod without any resources and inspect what it got:

```bash
kubectl -n team-a run plain --image=busybox:1.36 -- sleep 3600
kubectl -n team-a get pod plain -o jsonpath='{.spec.containers[0].resources}'; echo
```

3. Try a pod that exceeds the LimitRange max:

```bash
kubectl -n team-a run greedy --image=busybox:1.36 \
  --overrides='{"spec":{"containers":[{"name":"greedy","image":"busybox:1.36","command":["sleep","3600"],"resources":{"limits":{"memory":"1Gi"}}}]}}'
```

4. Create a Deployment that wants more than the quota allows:

```bash
kubectl -n team-a create deployment api --image=busybox:1.36 --replicas=6 -- sleep 3600
sleep 5
kubectl -n team-a get deploy api
kubectl -n team-a get pods
kubectl describe resourcequota budget -n team-a
```

### Verify

- Step 2: the pod has `requests: {cpu: 100m, memory: 64Mi}` and `limits: {memory: 128Mi}` injected by the LimitRange.
- Step 3 is rejected at admission with a message that the memory limit exceeds the maximum of 512Mi.
- Step 4: `api` shows `READY 4/6` (or similar), there are **no** Pending pods, and the quota shows `requests.cpu 500m/500m`.

Find the exact error message explaining why the remaining replicas do not exist.

:::hint
Who creates pods for a Deployment? Look at that object's events.
:::

:::solution
The ReplicaSet creates the pods, so the quota rejection is recorded on it:

```bash
kubectl -n team-a describe rs -l app=api | sed -n '/Events:/,$p'
# Warning  FailedCreate  ... Error creating: pods "api-..." is forbidden:
#   exceeded quota: budget, requested: requests.cpu=100m, used: requests.cpu=500m, limited: requests.cpu=500m
```

The `plain` pod (100m) plus four `api` pods (4 x 100m) used the 500m CPU budget. Fixes: raise the quota, lower per-pod requests, or scale down. This is a common real-world puzzle: a Deployment is "stuck" with no Pending pods and no events on the Deployment itself.
:::

### Clean up

```bash
kubectl delete namespace team-a
```

## Lab 5: Placement: zones, taints, affinity and topology spread

:::meta
difficulty: medium
time: 35 min
:::

Goal: simulate a three-zone cluster with a dedicated batch node, spread an API evenly across zones, pin batch work to its node, and keep cache replicas apart. Along the way you will hit a real topology-spread gotcha.

### Steps

1. Label nodes with zones and dedicate worker3 to batch work:

```bash
kubectl label node sched-lab-worker  topology.kubernetes.io/zone=zone-a
kubectl label node sched-lab-worker2 topology.kubernetes.io/zone=zone-b
kubectl label node sched-lab-worker3 topology.kubernetes.io/zone=zone-c workload=batch
kubectl taint node sched-lab-worker3 dedicated=batch:NoSchedule
kubectl get nodes -L topology.kubernetes.io/zone,workload
```

2. Deploy an API with 4 replicas and a hard zone spread:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 4
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels: { app: api }
      containers:
        - name: api
          image: busybox:1.36
          command: ["sleep", "3600"]
          resources:
            requests: { cpu: 50m, memory: 32Mi }
EOF
sleep 10
kubectl get pods -l app=api -o wide
```

3. Investigate the Pending pods:

```bash
kubectl describe pod -l app=api | grep -A3 'Events:' | grep -i warn
```

4. Run a batch Job that must land on the dedicated node:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: nightly-report
spec:
  template:
    spec:
      restartPolicy: Never
      nodeSelector:
        workload: batch
      tolerations:
        - key: dedicated
          operator: Equal
          value: batch
          effect: NoSchedule
      containers:
        - name: report
          image: busybox:1.36
          command: ["sh", "-c", "echo building report on $(hostname); sleep 20"]
EOF
sleep 5
kubectl get pods -l job-name=nightly-report -o wide
```

5. Deploy a cache with 3 replicas that must never share a node:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache
spec:
  replicas: 3
  selector:
    matchLabels: { app: cache }
  template:
    metadata:
      labels: { app: cache }
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels: { app: cache }
              topologyKey: kubernetes.io/hostname
      containers:
        - name: redis
          image: redis:7-alpine
          resources:
            requests: { cpu: 50m, memory: 32Mi }
EOF
sleep 10
kubectl get pods -l app=cache -o wide
```

### Verify

- Step 2: only 2 `api` pods run (one in zone-a, one in zone-b); 2 are Pending.
- Step 4: the Job's pod runs on `sched-lab-worker3`.
- Step 5: two cache pods run on different nodes; the third is Pending with `didn't match pod anti-affinity rules` and `untolerated taint`.

Now fix step 2 so that all 4 `api` pods run, spread 2/2 over zone-a and zone-b, **without** removing the taint or the constraint.

:::hint
Why would zone-c matter for skew if no api pod can run there? Read the warning in the lesson about how topology spread counts tainted nodes, and look at `kubectl explain deployment.spec.template.spec.topologySpreadConstraints.nodeTaintsPolicy`.
:::

:::solution
**Why pods are Pending.** By default (`nodeTaintsPolicy: Ignore`), topology spread counts every node that matches the pod's node affinity when computing skew, ignoring taints. zone-c (worker3) counts as a domain with 0 api pods, even though the api pods cannot tolerate its taint. With `maxSkew: 1`, zone-a and zone-b can each have at most 1 pod more than zone-c, so the 3rd and 4th pods violate the constraint and stay Pending. The event says something like `node(s) didn't match pod topology spread constraints`.

**Fix:** tell the constraint to honour taints, so nodes the pod cannot tolerate are excluded from the calculation:

```bash
kubectl patch deploy api --type=json -p='[
  {"op":"add","path":"/spec/template/spec/topologySpreadConstraints/0/nodeTaintsPolicy","value":"Honor"}]'
kubectl rollout status deploy/api
kubectl get pods -l app=api -o wide
```

Now there are two domains (zone-a, zone-b) and 4 pods spread 2/2.

**Cache:** required anti-affinity per hostname allows at most one cache pod per eligible node. Only two workers are eligible (worker3 is tainted, the control plane is tainted), so the third replica can never run. Options: reduce to 2 replicas, tolerate the taint, or use `preferredDuringScheduling...` / a topology spread constraint with `ScheduleAnyway` instead of a hard rule.
:::

### Clean up

```bash
kubectl delete deploy api cache
kubectl delete job nightly-report
kubectl taint node sched-lab-worker3 dedicated=batch:NoSchedule-
kubectl label node sched-lab-worker3 workload-
```

Keep the zone labels for Lab 6.

## Lab 6: Challenge: survive a node drain and a capacity crunch

:::meta
difficulty: hard
time: 45 min
:::

Goal: make `shipit-api` safe for node maintenance with a PodDisruptionBudget, then use PriorityClasses so that, when the cluster is full, the API preempts batch work instead of staying Pending.

### Requirements

1. Deployment `shipit-api` (image `nginx:1.27-alpine` is fine) with **3 replicas**, spread across zones (`maxSkew: 1`, `ScheduleAnyway` is acceptable here), requests `cpu: 100m, memory: 64Mi`.
2. A PodDisruptionBudget that allows at most **one** `shipit-api` pod to be voluntarily disrupted at a time.
3. Drain the node running the most `shipit-api` pods while watching pods in another terminal. Show that `kubectl drain` respects the PDB, then uncordon.
4. Create PriorityClasses `batch-low` (value 1000) and `api-high` (value 100000). Give `shipit-api` `api-high`.
5. Fill the three workers with a `filler` Deployment at `batch-low`: one pod per worker, each requesting about **70%** of a worker's allocatable CPU.
6. Scale `shipit-api` so that a new pod needs more CPU than is free anywhere, by giving it a CPU request of about 50% of a worker's allocatable CPU. Show that the new `shipit-api` pods preempt `filler` pods, and find the evidence in events.

### Verify

- During the drain, at no point are more than one `shipit-api` pod unavailable; `kubectl drain` output shows it waiting (`Cannot evict pod as it would violate the pod's disruption budget`) if needed.
- After step 6, all `shipit-api` pods are Running, some `filler` pods are Pending, and `kubectl get events --sort-by=.lastTimestamp | grep -i preempt` shows preemption.

:::hint
Read a node's allocatable CPU with `kubectl get node sched-lab-worker -o jsonpath='{.status.allocatable.cpu}'` (it may be a plain number of cores or millicores with an `m` suffix). Use pod anti-affinity or a hostname topology spread on `filler` so you get one pod per worker. To make the drain interesting, watch with `kubectl get pods -l app=shipit-api -o wide -w` in a second terminal. `kubectl set resources` changes requests and triggers a rollout.
:::

:::solution
```bash
# 1 + 2: Deployment and PDB
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shipit-api
spec:
  replicas: 3
  selector:
    matchLabels: { app: shipit-api }
  template:
    metadata:
      labels: { app: shipit-api }
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: { app: shipit-api }
      containers:
        - name: api
          image: nginx:1.27-alpine
          resources:
            requests: { cpu: 100m, memory: 64Mi }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shipit-api
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app: shipit-api }
EOF
kubectl rollout status deploy/shipit-api
kubectl get pdb shipit-api        # ALLOWED DISRUPTIONS = 1

# 3: drain (watch in another terminal: kubectl get pods -l app=shipit-api -o wide -w)
NODE=$(kubectl get pods -l app=shipit-api -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data
kubectl get pods -l app=shipit-api -o wide
kubectl uncordon "$NODE"

# 4: PriorityClasses
cat <<'EOF' | kubectl apply -f -
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-low
value: 1000
description: "Batch work that may be preempted"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: api-high
value: 100000
description: "Customer-facing APIs"
EOF
kubectl patch deploy shipit-api -p '{"spec":{"template":{"spec":{"priorityClassName":"api-high"}}}}'
kubectl rollout status deploy/shipit-api

# 5: filler at ~70% of a worker's CPU, one per worker
CPU=$(kubectl get node sched-lab-worker -o jsonpath='{.status.allocatable.cpu}')
case "$CPU" in *m) MILLI=${CPU%m} ;; *) MILLI=$((CPU * 1000)) ;; esac
FILL=$((MILLI * 70 / 100))m
HALF=$((MILLI * 50 / 100))m
echo "allocatable=${MILLI}m filler=$FILL api=$HALF"

cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: filler
spec:
  replicas: 3
  selector:
    matchLabels: { app: filler }
  template:
    metadata:
      labels: { app: filler }
    spec:
      priorityClassName: batch-low
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels: { app: filler }
              topologyKey: kubernetes.io/hostname
      containers:
        - name: batch
          image: busybox:1.36
          command: ["sleep", "36000"]
          resources:
            requests: { cpu: "$FILL", memory: 32Mi }
EOF
kubectl rollout status deploy/filler
kubectl get pods -o wide

# 6: make each API pod need ~50% of a node -> nothing fits without preemption
kubectl set resources deploy/shipit-api --requests=cpu=$HALF,memory=64Mi
kubectl rollout status deploy/shipit-api --timeout=180s
kubectl get pods -o wide
kubectl get events --sort-by=.lastTimestamp | grep -iE 'preempt|FailedScheduling' | tail -10
```

What happens: each worker has 30% CPU free (minus small system requests), so a pod requesting 50% fits nowhere. The scheduler finds that evicting a lower-priority `filler` pod on a node makes room, sets `status.nominatedNodeName` on the API pod, gracefully deletes the victim, and binds the API pod. The evicted fillers become Pending (their anti-affinity and size leave no space). Events show `Preempted by pod ...` on the victims.

Notes:

- The drain may be instant if the evicted pods reschedule quickly; the PDB is what keeps it from evicting a second pod before the first replacement is Ready.
- Preemption only considers lower-priority pods and tries to respect PDBs, but PDBs are not a hard guarantee against preemption.
- In a cloud cluster, the Pending fillers would also trigger the cluster autoscaler or Karpenter to add a node (module 10).
:::

### Clean up

```bash
kind delete cluster --name sched-lab
rm -f /tmp/sched-lab.yaml
```
