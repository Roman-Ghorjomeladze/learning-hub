These labs make the architecture visible. You will build a three-node kind cluster, look at the control plane from inside a node, watch controllers fight back, talk to the API with raw HTTP, break the scheduler on purpose, and read keys straight out of etcd.

**Prerequisites:** Docker running (Docker Desktop, OrbStack or Colima), `kind`, `kubectl`. Check with:

```bash
docker info --format '{{.ServerVersion}} {{.Architecture}}'
kind version
kubectl version --client
```

All labs use one cluster named `arch`. Lab 1 creates it; the last section tells you how to delete it.

## Lab 1: Build a multi-node kind cluster

:::meta
difficulty: easy
time: 15 min
:::

Goal: create a cluster with one control-plane node and two workers, and map what you see in Docker to what you see in Kubernetes.

### Steps

1. Write a kind config:

```bash
mkdir -p ~/k8s-labs/01 && cd ~/k8s-labs/01
cat > kind-arch.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: arch
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
```

2. Create the cluster (takes a minute or two the first time while the node image downloads):

```bash
kind create cluster --config kind-arch.yaml
```

3. Look at it from both sides:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
kubectl cluster-info --context kind-arch
kubectl get nodes -o wide
```

4. Check which Kubernetes version and container runtime the nodes run:

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion,RUNTIME:.status.nodeInfo.containerRuntimeVersion,ARCH:.status.nodeInfo.architecture
```

5. List everything in `kube-system` with the node each pod runs on:

```bash
kubectl get pods -n kube-system -o wide
```

### Verify

- `docker ps` shows three containers: `arch-control-plane`, `arch-worker`, `arch-worker2`.
- `kubectl get nodes` shows three `Ready` nodes, and the runtime column says `containerd://...`.
- On Apple Silicon the ARCH column says `arm64`.

:::hint
If nodes stay `NotReady` for more than a minute, the CNI (kindnet) pods are probably still starting: `kubectl get pods -n kube-system -l app=kindnet`. If `kind create` fails, make sure Docker has at least 4 GB of memory assigned.
:::

:::solution
Expected output (versions will differ):

```text
NAME                 VERSION   RUNTIME                ARCH
arch-control-plane   v1.3x.y   containerd://2.x.y     arm64
arch-worker          v1.3x.y   containerd://2.x.y     arm64
arch-worker2         v1.3x.y   containerd://2.x.y     arm64
```

Mapping: each Docker container is a "node". Inside the control-plane container run the static pods `etcd`, `kube-apiserver`, `kube-controller-manager` and `kube-scheduler`. Every node (including the control plane) runs a `kube-proxy` pod (DaemonSet) and a `kindnet` pod (CNI DaemonSet). `coredns` runs as a Deployment with 2 replicas. kind also installs `local-path-provisioner` in the `local-path-storage` namespace for PersistentVolumes.
:::

### Clean up

Keep the cluster; the next labs use it.

## Lab 2: The control plane is just static pods

:::meta
difficulty: easy
time: 20 min
:::

Goal: see how the kubelet runs the control plane from files on disk, and understand mirror pods.

### Steps

1. Get a shell "on the node":

```bash
docker exec -it arch-control-plane bash
```

2. Inside the node, find where the kubelet looks for static pod manifests and list them:

```bash
grep -i staticPodPath /var/lib/kubelet/config.yaml
ls -l /etc/kubernetes/manifests/
grep -E 'image:|- --' /etc/kubernetes/manifests/kube-apiserver.yaml | head -25
```

3. Still inside the node, look at the containers through the CRI with `crictl` (this is what the kubelet sees):

```bash
crictl pods
crictl ps
systemctl status kubelet --no-pager | head -5
exit
```

4. Back on your Mac, delete the API object for the scheduler pod and watch what happens:

```bash
kubectl -n kube-system get pod kube-scheduler-arch-control-plane -o jsonpath='{.metadata.uid}{"\n"}{.metadata.ownerReferences}{"\n"}'
kubectl -n kube-system delete pod kube-scheduler-arch-control-plane
kubectl -n kube-system get pod kube-scheduler-arch-control-plane -o jsonpath='{.metadata.uid}{"\n"}'
```

5. Check whether the scheduler container actually restarted:

```bash
docker exec arch-control-plane crictl ps --name kube-scheduler
```

6. See leader election at work:

```bash
kubectl -n kube-system get leases
kubectl -n kube-system get lease kube-scheduler -o jsonpath='{.spec.holderIdentity}{"  "}{.spec.renewTime}{"\n"}'
```

### Verify

- You found four YAML files in `/etc/kubernetes/manifests/`.
- After deleting the scheduler pod, a pod with the same name reappears almost instantly, with a different uid, and its `ownerReferences` points to the `Node`.
- `crictl ps` shows the scheduler container's "CREATED" time did not change.

:::hint
A static pod's object in the API is only a **mirror**: a read-only reflection the kubelet publishes so you can see it. The source of truth is the file on disk. What do you think happens if you delete the mirror pod?
:::

:::solution
- `staticPodPath: /etc/kubernetes/manifests` in the kubelet config. The files are `etcd.yaml`, `kube-apiserver.yaml`, `kube-controller-manager.yaml`, `kube-scheduler.yaml`, written by kubeadm (which kind uses under the hood).
- The kubelet watches that directory and runs whatever pods are defined there, even if the API server is down. That is how the API server can itself run as a pod: there is no chicken-and-egg problem.
- Deleting the mirror pod only deletes the API representation. The kubelet notices the mirror is gone and recreates it (new uid), but the real container keeps running. To really stop a static pod you must remove its manifest file from the node.
- The mirror pod's owner reference is `kind: Node, name: arch-control-plane`.
- Leases: `kube-scheduler` and `kube-controller-manager` leases record which instance is the active leader. In `kube-node-lease` there is one lease per node for heartbeats: `kubectl -n kube-node-lease get leases`.
:::

### Clean up

Nothing to clean up.

## Lab 3: Watch reconciliation happen

:::meta
difficulty: easy
time: 20 min
:::

Goal: see the Deployment → ReplicaSet → Pod chain and watch controllers restore desired state after you break it.

### Steps

1. Create a namespace and a Deployment imperatively (we will go declarative in the next module):

```bash
kubectl create namespace arch-lab
kubectl -n arch-lab create deployment whoami --image=traefik/whoami --replicas=3
kubectl -n arch-lab rollout status deployment/whoami
```

2. Open a **second terminal** and keep a watch running:

```bash
kubectl -n arch-lab get pods -o wide -w
```

3. In the first terminal, follow the ownership chain:

```bash
kubectl -n arch-lab get deploy,rs,pods --show-labels
POD=$(kubectl -n arch-lab get pods -o jsonpath='{.items[0].metadata.name}')
kubectl -n arch-lab get pod "$POD" -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}{"\n"}'
RS=$(kubectl -n arch-lab get rs -o jsonpath='{.items[0].metadata.name}')
kubectl -n arch-lab get rs "$RS" -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}{"\n"}'
```

4. Delete a pod and watch the second terminal:

```bash
kubectl -n arch-lab delete pod "$POD"
```

5. Now delete *all* pods at once, then the ReplicaSet itself:

```bash
kubectl -n arch-lab delete pods --all
kubectl -n arch-lab delete rs "$RS"
kubectl -n arch-lab get rs
```

6. Remove a pod from the ReplicaSet by changing its label (the controller only counts pods that match its selector):

```bash
POD=$(kubectl -n arch-lab get pods -o jsonpath='{.items[0].metadata.name}')
kubectl -n arch-lab label pod "$POD" app=detached --overwrite
kubectl -n arch-lab get pods --show-labels
```

7. Read the event history that controllers left behind:

```bash
kubectl -n arch-lab events --types=Normal | tail -20
```

### Verify

- After each deletion, the count of `Running` pods with `app=whoami` returns to 3.
- After deleting the ReplicaSet, a new ReplicaSet with the **same** name appears (same pod-template-hash).
- After relabelling, there are 4 pods in total: 3 with `app=whoami` and 1 with `app=detached`.

:::hint
The pod template has not changed, so the Deployment controller computes the same pod-template-hash when it recreates the ReplicaSet. For step 6, think about what "matching pods" means to a ReplicaSet.
:::

:::solution
- Pod deletion: the ReplicaSet controller sees 2 matching pods but wants 3, so it creates a replacement immediately (you see `Pending` → `ContainerCreating` → `Running`). The replacement might land on a different node.
- ReplicaSet deletion: the garbage collector cascades the deletion to its pods; the Deployment controller notices there is no ReplicaSet for its current template and creates one with the same hash name; that ReplicaSet creates 3 new pods.
- Relabelling: the ReplicaSet selector is `app=whoami,pod-template-hash=<hash>`. The relabelled pod no longer matches, so the controller creates a new one. It also removes its ownerReference from the detached pod (it "releases" it). The detached pod keeps running as an orphan, which is a handy trick for debugging a misbehaving pod without it receiving traffic or being replaced. Delete it when you are done: `kubectl -n arch-lab delete pod -l app=detached`.
- Events show `SuccessfulCreate` from `replicaset-controller` and `Scheduled` from `default-scheduler`, followed by `Pulled`, `Created`, `Started` from the kubelet.
:::

### Clean up

```bash
kubectl delete namespace arch-lab
```

## Lab 4: Explore the API directly

:::meta
difficulty: medium
time: 25 min
:::

Goal: use the API without kubectl's pretty printing: discovery, raw GETs, a proxy, a watch stream, and writes with curl.

### Steps

1. Discovery: what resources exist and which group/version do they belong to?

```bash
kubectl api-resources | head -30
kubectl api-resources --namespaced=false
kubectl api-versions | head -30
```

2. Use `explain` to read the schema served by the cluster:

```bash
kubectl explain pod.spec.restartPolicy
kubectl explain deployment.spec --recursive | head -40
```

3. Raw GETs through kubectl's authenticated client:

```bash
kubectl get --raw /version
kubectl get --raw /healthz; echo
kubectl get --raw '/readyz?verbose' | tail -5
kubectl get --raw /api/v1/namespaces/kube-system/pods | python3 -m json.tool | head -40
```

4. See which HTTP calls kubectl makes:

```bash
kubectl get deploy -n kube-system -v=6 2>&1 | grep -E 'GET|POST'
```

5. Start `kubectl proxy` in a second terminal. It handles authentication and exposes the API on localhost over plain HTTP:

```bash
kubectl proxy --port=8001
```

6. In the first terminal, use curl:

```bash
curl -s http://127.0.0.1:8001/apis/apps/v1 | head -30
curl -s http://127.0.0.1:8001/api/v1/nodes | python3 -c 'import json,sys; [print(n["metadata"]["name"], n["status"]["nodeInfo"]["kubeletVersion"]) for n in json.load(sys.stdin)["items"]]'
```

7. Open a watch stream in a third terminal (it stays open and prints one JSON event per line):

```bash
curl -sN 'http://127.0.0.1:8001/api/v1/namespaces/default/configmaps?watch=true' | cut -c1-160
```

8. In the first terminal, create, change and delete a ConfigMap and watch the stream:

```bash
kubectl create configmap watch-me --from-literal=color=blue
kubectl patch configmap watch-me --type merge -p '{"data":{"color":"green"}}'
kubectl delete configmap watch-me
```

### Verify

- The watch terminal printed `ADDED`, `MODIFIED` and `DELETED` events (plus an `ADDED` for the existing `kube-root-ca.crt` ConfigMap when the watch started).
- You can name the API group and version for Deployments, Jobs, and NetworkPolicies without looking.

:::hint
Pipe JSON through `python3 -m json.tool` or `jq` (install with `brew install jq`) to make it readable. When the watch stream starts, it first sends the current state as `ADDED` events. That is the "list" part of list-then-watch.
:::

:::solution
- Deployments: `apps/v1`. Jobs: `batch/v1`. NetworkPolicies: `networking.k8s.io/v1`. Pods, Services, ConfigMaps: core `v1` (path prefix `/api/v1` instead of `/apis/<group>/<version>`).
- `-v=6` shows lines like `GET https://127.0.0.1:XXXXX/apis/apps/v1/namespaces/kube-system/deployments?limit=500 200 OK`. kubectl paginates with `limit` and `continue`.
- `kubectl proxy` uses your kubeconfig credentials, so anything on your Mac that can reach `127.0.0.1:8001` acts as cluster-admin. Never bind it to `0.0.0.0` on a shared network.
- The watch stream emits lines like `{"type":"MODIFIED","object":{"kind":"ConfigMap",...,"resourceVersion":"12345",...}}`. Each event carries a new `resourceVersion`. This is exactly what every controller and kubelet consumes.
:::

### Clean up

Stop the proxy and the watch with Ctrl+C.

## Lab 5: Break & fix — pods stuck in Pending with no events

:::meta
difficulty: medium
time: 25 min
:::

Goal: diagnose a cluster where new pods never get scheduled, using what you know about each component's job.

### Steps

1. Break the cluster. (In real life someone else would have done this. Try to forget what this command does.)

```bash
docker exec arch-control-plane sh -c 'mv /etc/kubernetes/manifests/kube-scheduler.yaml /root/'
sleep 20
```

2. Deploy something:

```bash
kubectl create namespace broken
kubectl -n broken create deployment web --image=nginx:1.27-alpine --replicas=2
sleep 15
kubectl -n broken get deploy,rs,pods -o wide
```

3. Now diagnose as if you did not know the cause. Use only kubectl first.

### Verify

You are done when you can explain, from evidence:

- which objects exist (Deployment? ReplicaSet? Pods?) and therefore which controllers are working,
- why the pods are `Pending`,
- which component is missing and how it was supposed to be running,

and after your fix the two `web` pods are `Running`.

:::hint
Work along the chain: Deployment created a ReplicaSet (so the Deployment controller works), ReplicaSet created Pods (so the ReplicaSet controller works). Pods have no node. Which component sets `spec.nodeName`? Normally an unschedulable pod gets a `FailedScheduling` event. What does it mean if there is no event at all? Look at `kube-system` and at the `kube-scheduler` Lease's `renewTime`.
:::

:::solution
Evidence:

```bash
kubectl -n broken describe pod -l app=web | sed -n '/Node:/p;/Events:/,$p'
# Node:  <none>
# Events: <none>      <- not even a FailedScheduling event
kubectl -n broken get pods -o jsonpath='{range .items[*]}{.metadata.name}{" nodeName="}{.spec.nodeName}{"\n"}{end}'
kubectl -n kube-system get pods | grep -E 'scheduler|controller|apiserver|etcd'
# kube-scheduler-arch-control-plane is missing
kubectl -n kube-system get lease kube-scheduler -o jsonpath='{.spec.renewTime}{"\n"}'
# renewTime is stale (minutes old)
```

Reasoning: the Deployment and ReplicaSet controllers did their jobs (both objects exist and pods were created). Pods have an empty `nodeName` and no events, which means nothing even *tried* to schedule them. A broken scheduler with a resource problem would emit `FailedScheduling`; silence means no scheduler is running. The scheduler is a static pod, so its mirror pod disappearing means its manifest is gone from the node.

Fix by restoring the manifest:

```bash
docker exec arch-control-plane ls /etc/kubernetes/manifests/
docker exec arch-control-plane sh -c 'mv /root/kube-scheduler.yaml /etc/kubernetes/manifests/'
kubectl -n kube-system wait --for=condition=Ready pod/kube-scheduler-arch-control-plane --timeout=90s
kubectl -n broken get pods -o wide
```

Within seconds of the scheduler starting, it picks up the pending pods (it watches for pods with no node), binds them, and the kubelets start them. Note that nothing had to be "retried" manually: level-triggered reconciliation picked up the existing desired state.

Real-world variants of this symptom: a custom `schedulerName` in the pod spec that no scheduler serves, or the scheduler unable to reach the API server due to an expired certificate.
:::

### Clean up

```bash
kubectl delete namespace broken
```

## Lab 6: Challenge — read etcd and drive the API with curl only

:::meta
difficulty: hard
time: 40 min
:::

Goal: prove to yourself that "Kubernetes is an API over a database". No step-by-step this time.

### Requirements

1. Using `etcdctl` inside the `etcd-arch-control-plane` pod, list the etcd **keys** for all Deployments in the cluster, and count how many keys exist under `/registry` in total.
2. Create a ConfigMap `secret-ish` in `default` with `password=hunter2` using kubectl, then read its raw value from etcd and confirm you can see `hunter2` in plain text. Explain what this means for Secrets.
3. With `kubectl proxy` running and **only curl** (no kubectl for writes), create a Deployment called `curl-made` in `default` (image `traefik/whoami`, label `app=curl-made`, 1 replica), then scale it to 3 by PATCHing the `scale` subresource, while a curl watch on pods with label `app=curl-made` prints the events.
4. Confirm with kubectl that the Deployment has 3 ready replicas and that its `metadata.managedFields` shows a manager other than `kubectl`.

### Verify

- You have a list of keys like `/registry/deployments/kube-system/coredns`.
- You saw `hunter2` in etcd output.
- `kubectl get deploy curl-made` shows `3/3`.

:::hint
etcd runs with TLS. The certificates are in `/etc/kubernetes/pki/etcd/` on the control-plane node, which is mounted into the etcd pod. Use `--keys-only` and `--prefix`. Values for built-in types are protobuf, so pipe through `strings` (on your Mac; it comes with the Xcode command line tools, otherwise use `LC_ALL=C tr -cd '[:print:]\n'`) to make them readable. For curl writes, send JSON with `Content-Type: application/json` for POST and `application/merge-patch+json` for PATCH.
:::

:::solution
1. etcd keys:

A small shell function keeps the commands readable (works in both zsh, the macOS default, and bash). The etcd image has no shell, so arguments are passed straight to `etcdctl`:

```bash
ectl() {
  kubectl -n kube-system exec etcd-arch-control-plane -- etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key "$@"
}
ectl get /registry/deployments --prefix --keys-only | grep .
ectl get /registry --prefix --keys-only | grep -c '^/registry'
```

2. Plain-text values:

```bash
kubectl create configmap secret-ish --from-literal=password=hunter2
ectl get /registry/configmaps/default/secret-ish --print-value-only | strings
```

You see `hunter2`. A Secret is stored the same way: base64 in the API is just encoding, and by default etcd stores it unencrypted. Production clusters must enable **encryption at rest** (an `EncryptionConfiguration` with a KMS provider; EKS offers envelope encryption with AWS KMS) and restrict who can read etcd backups and Secrets via RBAC.

3. curl only. Terminal A: `kubectl proxy --port=8001`. Terminal B (watch):

```bash
curl -sN 'http://127.0.0.1:8001/api/v1/namespaces/default/pods?watch=true&labelSelector=app%3Dcurl-made' \
  | python3 -u -c 'import json,sys
for l in sys.stdin:
    e=json.loads(l); o=e["object"]; print(e["type"], o["metadata"]["name"], o["status"].get("phase"))'
```

Terminal C (writes):

```bash
cat > curl-made.json <<'EOF'
{
  "apiVersion": "apps/v1",
  "kind": "Deployment",
  "metadata": { "name": "curl-made", "labels": { "app": "curl-made" } },
  "spec": {
    "replicas": 1,
    "selector": { "matchLabels": { "app": "curl-made" } },
    "template": {
      "metadata": { "labels": { "app": "curl-made" } },
      "spec": { "containers": [ { "name": "whoami", "image": "traefik/whoami" } ] }
    }
  }
}
EOF
curl -s -X POST -H 'Content-Type: application/json' --data-binary @curl-made.json \
  http://127.0.0.1:8001/apis/apps/v1/namespaces/default/deployments | head -5

curl -s -X PATCH -H 'Content-Type: application/merge-patch+json' -d '{"spec":{"replicas":3}}' \
  http://127.0.0.1:8001/apis/apps/v1/namespaces/default/deployments/curl-made/scale
```

The watch prints `ADDED curl-made-xxxx Pending`, several `MODIFIED` lines as the scheduler binds and the kubelet updates status, then `Running`, and two more pods after the scale.

4. Check:

```bash
kubectl get deploy curl-made
kubectl get deploy curl-made -o yaml --show-managed-fields | grep -E 'manager:|operation:'
```

The manager for the create is `curl` (the API server takes it from the User-Agent), and `kube-controller-manager` owns the `status` fields.
:::

### Clean up

```bash
kubectl delete deploy curl-made
kubectl delete configmap secret-ish
```

When you have finished all labs in this module, delete the cluster (module 02 builds a new one with more features):

```bash
kind delete cluster --name arch
```
