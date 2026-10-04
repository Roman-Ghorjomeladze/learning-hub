Most of your Kubernetes time is spent in a terminal: creating clusters, switching contexts, reading YAML, tailing logs and asking "why is this not working?". This module gives you a solid local lab and turns kubectl from something you look up into something you type without thinking.

## Choosing a local cluster

| Tool | How it runs | Good for |
| --- | --- | --- |
| **kind** | Each node is a Docker container | Multi-node clusters, CI, fast create/delete, upstream Kubernetes. Used in this track. |
| minikube | VM or container, single node by default | Add-ons, beginners |
| k3d | k3s (lightweight distro) in Docker | Very light clusters, built-in registry |
| Docker Desktop / OrbStack Kubernetes | Built into your Docker app | Zero setup, but one node and less control |

kind runs real upstream Kubernetes built with kubeadm, which means what you see (static pods, certificates, kubelet config) matches production clusters built the same way. Clusters start in under a minute and you can throw them away freely.

:::mac kind on Apple Silicon
kind node images are multi-arch, so on an M-series Mac your nodes are arm64 Linux containers inside the Docker VM. Give Docker at least 4 CPUs and 6–8 GB RAM for three-node clusters (Docker Desktop: Settings → Resources; OrbStack adjusts automatically; Colima: `colima start --cpu 4 --memory 8`). Any image you deploy must have an arm64 variant or you will see `exec format error` in the logs.
:::

## kind configuration

A plain `kind create cluster` gives you one node named `kind-control-plane`. For anything realistic, use a config file:

```yaml
# kind-lab.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: lab
nodes:
  - role: control-plane
    extraPortMappings:            # host port -> node container port
      - containerPort: 30080      # a NodePort we will use for Services
        hostPort: 30080
        protocol: TCP
      - containerPort: 30081
        hostPort: 30081
    extraMounts:                  # host directory -> path inside the node
      - hostPath: /Users/roma/k8s-labs/shared
        containerPath: /shared
  - role: worker
    labels:
      tier: apps
  - role: worker
    labels:
      tier: apps
networking:
  # kubeProxyMode: nftables       # iptables (default), ipvs or nftables in recent kind versions
  # podSubnet: "10.244.0.0/16"
  # serviceSubnet: "10.96.0.0/12"
```

What each part buys you:

- **Multiple nodes**: lets you observe scheduling, spreading, DaemonSets, draining and node failure.
- **`extraPortMappings`**: kind nodes are containers on Docker's network, which on a Mac lives inside a VM. Your browser cannot reach them directly. A port mapping publishes a node container port on `localhost`, exactly like `docker run -p`. Map a NodePort (30000–32767) and a NodePort Service becomes reachable at `localhost:30080`.
- **`extraMounts`**: bind-mounts a host directory into the node so `hostPath` volumes can see your files. On Docker Desktop, the host path must be inside a shared directory (`/Users` is shared by default).
- **`labels`**: node labels for `nodeSelector` and affinity experiments.
- **`image`** (per node): pin the Kubernetes version, e.g. `image: kindest/node:v1.34.0@sha256:...`. Check the kind release notes on GitHub for the images built for your kind version.

:::warning Port mappings and mounts are fixed at creation time
You cannot add `extraPortMappings` or `extraMounts` to an existing kind cluster. Plan them up front, or delete and recreate (which is cheap: keep your manifests in files).
:::

Useful kind commands:

```bash
kind create cluster --config kind-lab.yaml
kind get clusters
kind get nodes --name lab
kind export kubeconfig --name lab      # rewrite ~/.kube/config entry if you lost it
kind export logs ./kind-logs --name lab  # collect node logs for debugging
kind delete cluster --name lab
```

## Getting your own images into kind

Your cluster's nodes run containerd, not your Mac's Docker daemon, so an image you just built with `docker build` is **not** visible to the cluster. You have three options:

1. **`kind load docker-image`** copies an image from your Docker daemon into every node's containerd:

```bash
docker build -t shipit-api:dev .
kind load docker-image shipit-api:dev --name lab
docker exec lab-worker crictl images | grep shipit
```

2. **`kind load image-archive`** loads a tarball (`docker save -o img.tar shipit-api:dev`).
3. **A local registry** container connected to the kind network, configured via `containerdConfigPatches`. Best when you push often or use tools like Tilt/Skaffold. The kind docs have a ready-made script ("Local Registry").

Then, the crucial part, the **image pull policy**:

| `imagePullPolicy` | Behaviour |
| --- | --- |
| `IfNotPresent` | Use the image on the node if it exists; pull otherwise |
| `Always` | Always contact the registry to resolve the tag (uses the cached layers if digest matches) |
| `Never` | Only use the local image; fail if missing |

If you omit the field, the default is `Always` when the tag is `:latest` (or no tag) and `IfNotPresent` otherwise. So `image: shipit-api` (implicitly `:latest`) loaded with kind will **fail** with `ErrImagePull`: the kubelet tries to pull `docker.io/library/shipit-api:latest` from Docker Hub. Use an explicit tag like `:dev` or `:0.1.0`, or set `imagePullPolicy: IfNotPresent`.

:::mac Multi-platform images and kind load
If Docker Desktop uses the containerd image store, `docker build` may produce a multi-platform image index, and `kind load docker-image` can fail with digest errors. Build for the node's platform explicitly (`docker build --platform linux/arm64 -t shipit-api:dev .`) or use `docker save` + `kind load image-archive`. Also remember: an image built on your Mac is arm64. It will not run on amd64 production nodes unless you build multi-arch with `docker buildx build --platform linux/amd64,linux/arm64`.
:::

## kubeconfig, contexts and namespaces

kubectl finds clusters through a kubeconfig file, by default `~/.kube/config`. It has three lists and a pointer:

```yaml
apiVersion: v1
kind: Config
clusters:                      # where: API server URL + CA certificate
  - name: kind-lab
    cluster:
      server: https://127.0.0.1:53412
      certificate-authority-data: LS0t...
users:                         # who: client cert, token, or exec plugin (aws eks get-token)
  - name: kind-lab
    user:
      client-certificate-data: LS0t...
      client-key-data: LS0t...
contexts:                      # a named (cluster, user, namespace) triple
  - name: kind-lab
    context:
      cluster: kind-lab
      user: kind-lab
      namespace: shipit
current-context: kind-lab      # the pointer
```

kind adds an entry named `kind-<cluster-name>` and switches to it. On EKS, `aws eks update-kubeconfig --name prod` adds a user with an `exec` plugin that fetches short-lived tokens.

```bash
kubectl config get-contexts
kubectl config current-context
kubectl config use-context kind-lab
kubectl config set-context --current --namespace=shipit   # change default namespace
kubectl config view --minify                               # only the current context
kubectl --context kind-other get nodes                     # one-off override
```

The `KUBECONFIG` environment variable can list several files separated by `:`; kubectl merges them. Many people keep one file per cluster and set `KUBECONFIG` per shell or per project (for example with direnv).

:::tip kubectx and kubens
`brew install kubectx` gives you `kubectx` (switch context, `kubectx -` for the previous one) and `kubens` (switch namespace). With `fzf` installed they become interactive pickers. Optional, but you will use them a hundred times a day on real projects.
:::

:::warning Know which cluster you are pointing at
The most expensive kubectl mistake is running `kubectl delete` against production when you thought you were on kind. Show the current context in your prompt (`kube-ps1`, or the Kubernetes segment of Starship / Powerlevel10k), give prod contexts loud names, and prefer `--context` in scripts instead of relying on `current-context`.
:::

## kubectl grammar

Almost every command follows one shape:

```text
kubectl <verb> <resource>[/<name>] [name...] [-n namespace | -A] [flags]

kubectl get pods
kubectl get pod web-7d9f-abcde -o yaml
kubectl get deploy,svc -n shipit
kubectl describe node lab-worker
kubectl delete -f k8s/
```

Resources have short names (`po`, `deploy`, `rs`, `svc`, `ns`, `cm`, `sa`, `ing`, `pvc`, `pv`, `ds`, `sts`, `cj`, `no`) listed in `kubectl api-resources`. `-A` means all namespaces. `-l` filters by label; `--field-selector` filters by a few fields:

```bash
kubectl get pods -A --field-selector status.phase!=Running
kubectl get pods -A --field-selector spec.nodeName=lab-worker
```

### Reading: get and describe

- `kubectl get` lists objects. Add `-o wide` for IPs and nodes, `--show-labels` for labels, `-w` to watch.
- `kubectl describe` is the human-friendly deep view: spec summary, status, conditions, related objects and, crucially, **recent events** at the bottom. When something is wrong, `describe` first.

### Writing: the verbs

| Verb | What it does | Typical use |
| --- | --- | --- |
| `create` | Create from flags or a file; fails if it exists | Quick objects, generating YAML |
| `apply` | Create or update from a file to match it (declarative) | Everyday deployments, GitOps |
| `delete` | Delete by name, label or file | Cleanup |
| `edit` | Open the live object in `$EDITOR`, save to update | Emergency tweaks (not for permanent changes) |
| `patch` | Send a partial update | Scripts, one-field changes |
| `label` / `annotate` | Add/change/remove (`key-`) labels or annotations | Organising, triggering tools |
| `scale` | Change replicas | Quick tests |
| `set image` | Change a container image | Quick rollouts |

```bash
kubectl label pod web-abc tier=frontend
kubectl label pod web-abc tier=backend --overwrite
kubectl label pod web-abc tier-                         # remove
kubectl annotate deploy web kubernetes.io/change-cause="bump to 1.27.3"
kubectl scale deploy web --replicas=5
kubectl set image deploy/web nginx=nginx:1.27-alpine
```

**Patch types** matter when you script:

```bash
# strategic merge (default): understands lists keyed by "name", e.g. containers
kubectl patch deploy web -p '{"spec":{"template":{"spec":{"containers":[{"name":"nginx","image":"nginx:1.27-alpine"}]}}}}'
# JSON merge patch (RFC 7386): lists are replaced wholesale
kubectl patch deploy web --type merge -p '{"spec":{"replicas":2}}'
# JSON patch (RFC 6902): explicit operations with paths
kubectl patch deploy web --type json -p '[{"op":"add","path":"/spec/template/spec/containers/0/args","value":["-v"]}]'
```

:::try Your first fluent minute
```bash
kubectl create namespace scratch
kubectl -n scratch create deployment web --image=nginx:1.27-alpine --replicas=2
kubectl -n scratch get deploy,rs,pods -o wide --show-labels
kubectl -n scratch label deploy web owner=roma
kubectl -n scratch get deploy -l owner=roma
kubectl delete namespace scratch
```
:::

## Output formats

Getting exactly the data you need is a superpower in debugging and scripts.

```bash
kubectl get pods -o wide                    # extra columns: IP, node
kubectl get pod web-abc -o yaml             # full object, good for reading/copying
kubectl get pod web-abc -o json | jq '.status.containerStatuses[0].state'
kubectl get pods -o name                    # pod/web-abc  (great for xargs)
kubectl get pods --sort-by=.metadata.creationTimestamp
```

**JSONPath** pulls fields out:

```bash
kubectl get pod web-abc -o jsonpath='{.status.podIP}{"\n"}'
kubectl get pods -o jsonpath='{.items[*].metadata.name}{"\n"}'
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\n"}{end}'
kubectl get nodes -o jsonpath='{.items[?(@.metadata.labels.tier=="apps")].metadata.name}{"\n"}'
kubectl get secret db -o jsonpath='{.data.password}' | base64 -d; echo
```

**custom-columns** gives you your own table:

```bash
kubectl get pods -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,IMAGE:.spec.containers[*].image,RESTARTS:.status.containerStatuses[*].restartCount'
```

:::tip Quote JSONPath in single quotes
Both zsh and bash will mangle `{}`, `[]`, `*` and `?` otherwise. Inside, use double quotes for string literals like `{"\n"}`. For complex logic, switch to `-o json | jq`.
:::

## Generating manifests and previewing changes

Nobody writes Deployment YAML from memory. Let kubectl generate a skeleton:

```bash
kubectl create deployment shipit-api --image=shipit-api:dev --port=3000 --replicas=2 \
  --dry-run=client -o yaml > deployment.yaml
kubectl create service clusterip shipit-api --tcp=80:3000 --dry-run=client -o yaml > service.yaml
kubectl create configmap shipit-config --from-literal=LOG_LEVEL=debug --dry-run=client -o yaml
kubectl create secret generic shipit-db --from-literal=password=s3cr3t --dry-run=client -o yaml
kubectl run debug --image=busybox:1.37 --restart=Never --dry-run=client -o yaml -- sleep 3600
kubectl create job migrate --image=shipit-api:dev --dry-run=client -o yaml -- npm run migrate
kubectl create cronjob cleanup --image=busybox:1.37 --schedule="*/5 * * * *" --dry-run=client -o yaml -- echo hi
```

- `--dry-run=client` builds the object locally without contacting the server.
- `--dry-run=server` sends it through the full API pipeline (admission, validation, defaults) without persisting. Great for catching errors a webhook or schema would reject.

Then preview what an apply would change:

```bash
kubectl diff -f deployment.yaml      # exit code 0 = no changes, 1 = changes, >1 = error
```

`kubectl diff` does a server-side dry run and shows a unified diff between the live object and what it would become. Use it in CI and before every manual apply to a shared cluster.

## Imperative vs declarative

```text
Imperative commands     kubectl create/run/scale/set image/expose ...
                        "do this now". Fast, not reproducible, not reviewable.

Imperative object config kubectl create -f / replace -f / delete -f
                        Files, but you choose the operation.

Declarative             kubectl apply -f dir/    (or GitOps tools)
                        "make it look like this". Idempotent, diffable, reviewable.
```

Use imperative commands to explore and to generate YAML; use declarative files for everything that matters. With `kubectl apply`, kubectl stores the last applied config in an annotation and computes a three-way merge (last applied, live, new) so it can delete fields you removed from the file without touching fields set by others (like `replicas` changed by an autoscaler, if you leave `replicas` out of your file).

**Server-side apply** (`kubectl apply --server-side`) moves that merge into the API server and tracks field ownership per manager in `managedFields`. It handles large objects (CRDs that exceed the annotation size limit) and reports conflicts when two managers want the same field. Many GitOps tools use it.

:::deep Three-way merge and why `kubectl edit` changes get lost
Client-side apply compares three things: the `last-applied-configuration` annotation (what *you* last applied), the live object, and your new file. A field present in last-applied but missing in the new file is deleted. A field in the live object that never appeared in last-applied (set by a controller or by `kubectl edit`) is left alone, unless your file sets it, in which case your file wins on the next apply. That is why a hotfix made with `kubectl edit` silently disappears on the next CI deploy if the file still has the old value. The rule: anything you change live must also go into git.
:::

## Interacting with running workloads

```bash
# logs
kubectl logs deploy/shipit-api                 # picks one pod of the deployment
kubectl logs -f pod/shipit-api-abc             # follow
kubectl logs pod/shipit-api-abc -c migrate     # specific container
kubectl logs pod/shipit-api-abc --previous     # the crashed previous instance
kubectl logs -l app=shipit-api --all-containers --prefix --since=10m --tail=100

# exec and copy
kubectl exec -it deploy/shipit-api -- sh
kubectl exec shipit-api-abc -c api -- env | sort
kubectl cp ./seed.sql shipit/postgres-0:/tmp/seed.sql    # needs tar in the container

# port-forward: localhost -> pod (through the API server, for debugging only)
kubectl port-forward svc/shipit-api 8080:80
kubectl port-forward pod/postgres-0 5432:5432

# events
kubectl events -n shipit --for deploy/shipit-api
kubectl get events -n shipit --sort-by=.metadata.creationTimestamp
kubectl events -A --types=Warning

# waiting and rollouts
kubectl wait --for=condition=Available deploy/shipit-api --timeout=120s
kubectl wait --for=condition=Ready pod -l app=shipit-api --timeout=60s
kubectl wait --for=delete pod/old-pod --timeout=60s
kubectl rollout status deploy/shipit-api
kubectl rollout restart deploy/shipit-api      # re-create pods, e.g. after a Secret change

# resource usage (needs metrics-server)
kubectl top nodes
kubectl top pods -A --sort-by=memory
```

:::info port-forward is a debugging tool
`kubectl port-forward` tunnels through the API server and kubelet. It handles one connection target, does not load-balance across pods (even when you forward to a Service it picks one pod), and dies when the pod restarts. Use Services, Gateways or NodePorts for real traffic.
:::

kind does not ship metrics-server. Install it with one extra flag because kind's kubelet certificates are self-signed:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deploy/metrics-server
```

:::try Debug loop in 60 seconds
```bash
kubectl create deployment echo --image=hashicorp/http-echo -- /http-echo -text=hello -listen=:8080
kubectl wait --for=condition=Available deploy/echo --timeout=60s
kubectl port-forward deploy/echo 8080:8080 &
sleep 2; curl -s localhost:8080; kill %1
kubectl logs deploy/echo
kubectl delete deploy echo
```
:::

## k9s basics

k9s is a terminal UI that wraps all of the above. Start it with `k9s` (or `k9s -n shipit`, `k9s --context kind-lab`).

| Key | Action |
| --- | --- |
| `:` then `pods`, `deploy`, `svc`, `ns`, `ctx`... | Switch resource view (tab-completes) |
| `/` | Filter the list (supports `-l app=web` too) |
| `0` | All namespaces |
| `Enter` | Drill down (deployment → pods → containers) |
| `d` / `y` / `e` | Describe / YAML / edit |
| `l` | Logs (`0` for all history, `w` to wrap) |
| `s` | Shell into container |
| `Shift-f` | Port-forward |
| `Ctrl-d` / `Ctrl-k` | Delete / kill |
| `:xray deploy` | Tree view of a deployment and everything it owns |
| `?` / `Esc` / `:q` | Help / back / quit |

Use k9s for exploring and live debugging; use kubectl for anything you want to script, paste into a ticket, or reproduce.

## Aliases and completion

Add this to `~/.zshrc` on your Mac:

```bash
source <(kubectl completion zsh)
alias k=kubectl
compdef __start_kubectl k            # completion for the alias too
alias kgp='kubectl get pods'
alias kd='kubectl describe'
alias kaf='kubectl apply -f'
export do='--dry-run=client -o yaml' # usage: k create deploy x --image=nginx $do
```

:::tip Plugins with krew
`krew` is kubectl's plugin manager (`brew install krew`). Useful plugins: `ctx`/`ns` (same as kubectx), `neat` (strip noise from `-o yaml`), `tree` (ownership tree), `stern`-style multi-pod logs via `kubectl stern` or the standalone `stern` tool.
:::

## Pitfalls and good habits

:::warning Common mistakes
- **Wrong context or namespace.** Commands run against the current context/namespace silently. Show both in your prompt.
- **`:latest` + kind load.** Default pull policy for `:latest` is `Always`, so the node ignores your loaded image. Use explicit tags.
- **`kubectl edit` in shared environments.** Changes drift from git and get overwritten by the next apply.
- **`kubectl delete -f dir/` on the wrong directory.** It deletes everything the files describe, including PVCs (and with them data, depending on the reclaim policy).
- **`kubectl apply --prune`.** It deletes objects not in your files that match a label selector. Powerful and dangerous; prefer GitOps tools for pruning.
- **Copying `-o yaml` output back into git verbatim.** It contains `status`, `uid`, `resourceVersion`, `managedFields` and defaults. Generate with `--dry-run=client` or clean it (`kubectl neat`).
:::

Good habits:

- Keep manifests in a repo folder per app (`k8s/`), apply with `kubectl apply -f k8s/` after `kubectl diff -f k8s/`.
- Always pass `-n` explicitly in docs and scripts.
- Use `kubectl explain` instead of searching the web for field names.
- When stuck: `get` → `describe` → `events` → `logs` (`--previous`) → `exec`.

## Summary

- kind gives you real multi-node clusters in Docker; port mappings and mounts are set at creation time.
- Load local images with `kind load docker-image` and use explicit tags or `IfNotPresent`.
- kubeconfig = clusters + users + contexts; switch with `kubectl config use-context` or kubectx/kubens, and always know where you are.
- Generate YAML with `--dry-run=client -o yaml`, preview with `kubectl diff`, apply declaratively.
- Learn the read path (`get -o ...`, `describe`, `events`, `logs`) as well as the write path; k9s speeds up exploration.
