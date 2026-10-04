In these labs you build the `lab` cluster that the rest of the track reuses, practise contexts, run the declarative workflow end to end, drill output formats, fix the classic "my local image will not pull" problem, and tour the debugging toolkit.

**Prerequisites:** Docker running, `kind`, `kubectl`, `k9s`. Optional: `jq` (`brew install jq`), `kubectx` (`brew install kubectx`).

Work in `~/k8s-labs/02`:

```bash
mkdir -p ~/k8s-labs/02 ~/k8s-labs/shared && cd ~/k8s-labs/02
```

## Lab 1: Build the reusable lab cluster

:::meta
difficulty: easy
time: 20 min
:::

Goal: create a three-node cluster with NodePort mappings to your Mac, a shared host folder and labelled workers, and prove each feature works.

### Steps

1. Write the config. The heredoc is unquoted so `$HOME` expands to your real path (kind needs an absolute host path):

```bash
cat > kind-lab.yaml <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: lab
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30080
        hostPort: 30080
        protocol: TCP
      - containerPort: 30081
        hostPort: 30081
        protocol: TCP
    extraMounts:
      - hostPath: $HOME/k8s-labs/shared
        containerPath: /shared
  - role: worker
    labels:
      tier: apps
    extraMounts:
      - hostPath: $HOME/k8s-labs/shared
        containerPath: /shared
  - role: worker
    labels:
      tier: apps
    extraMounts:
      - hostPath: $HOME/k8s-labs/shared
        containerPath: /shared
EOF
cat kind-lab.yaml
kind create cluster --config kind-lab.yaml
```

2. Check nodes and labels:

```bash
kubectl get nodes -L tier
docker port lab-control-plane
```

3. Put a file in the shared folder and serve it with nginx through a NodePort Service:

```bash
echo '<h1>Hello from my Mac</h1>' > ~/k8s-labs/shared/index.html

cat > shared-web.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shared-web
spec:
  replicas: 1
  selector:
    matchLabels: { app: shared-web }
  template:
    metadata:
      labels: { app: shared-web }
    spec:
      nodeSelector:
        tier: apps
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          volumeMounts:
            - name: site
              mountPath: /usr/share/nginx/html
      volumes:
        - name: site
          hostPath:
            path: /shared
            type: Directory
---
apiVersion: v1
kind: Service
metadata:
  name: shared-web
spec:
  type: NodePort
  selector: { app: shared-web }
  ports:
    - port: 80
      targetPort: 80
      nodePort: 30080
EOF
kubectl apply -f shared-web.yaml
kubectl rollout status deploy/shared-web
curl -s localhost:30080
```

4. Edit the file on your Mac and curl again:

```bash
echo '<h1>Edited live</h1>' > ~/k8s-labs/shared/index.html
curl -s localhost:30080
```

### Verify

- `kubectl get nodes -L tier` shows `apps` on both workers.
- `curl localhost:30080` returns your HTML, and the edit shows up without restarting anything.
- `kubectl get pod -l app=shared-web -o wide` shows the pod on a worker, not the control plane.

:::hint
If curl hangs or is refused: check `docker port lab-control-plane` lists `30080/tcp -> 0.0.0.0:30080`, the Service shows `80:30080/TCP`, and the pod is `Running`. If the pod is stuck in `ContainerCreating` with a hostPath error, the mount path is wrong; check `docker exec lab-worker ls /shared`.
:::

:::solution
Traffic path: `localhost:30080` on your Mac → Docker publishes it to port 30080 of the `lab-control-plane` container → kube-proxy on that node matches the NodePort rule → forwards to the nginx pod's IP on a worker (even though the pod is on another node, NodePorts are open on every node) → nginx serves `/usr/share/nginx/html`, which is the node's `/shared`, which is your Mac's `~/k8s-labs/shared`.

The nodeSelector `tier: apps` keeps the pod on workers. The control-plane node also has a `node-role.kubernetes.io/control-plane:NoSchedule` taint, so normal pods would not go there anyway.

Keep this cluster; you will reuse it for the rest of the track. If you ever delete it, recreate it with `kind create cluster --config ~/k8s-labs/02/kind-lab.yaml`.
:::

### Clean up

```bash
kubectl delete -f shared-web.yaml
```

## Lab 2: kubeconfig, contexts and namespaces

:::meta
difficulty: easy
time: 20 min
:::

Goal: manage two clusters, switch between them safely, set default namespaces, and keep a cluster in a separate kubeconfig file.

### Steps

1. Look at your kubeconfig:

```bash
kubectl config get-contexts
kubectl config view --minify
kubectl config view -o jsonpath='{.clusters[*].cluster.server}{"\n"}'
```

2. Create a second, single-node cluster but write its credentials to a **separate** file:

```bash
kind create cluster --name scratch --kubeconfig ~/.kube/kind-scratch.yaml
kubectl config get-contexts                              # scratch is NOT here
KUBECONFIG=~/.kube/kind-scratch.yaml kubectl get nodes
```

3. Merge both files for this shell only:

```bash
export KUBECONFIG=~/.kube/config:~/.kube/kind-scratch.yaml
kubectl config get-contexts
kubectl --context kind-scratch get nodes
kubectl --context kind-lab get nodes
```

4. Set a default namespace on the lab context:

```bash
kubectl config use-context kind-lab
kubectl create namespace playground
kubectl config set-context --current --namespace=playground
kubectl create deployment web --image=nginx:1.27-alpine
kubectl get deploy               # no -n needed
kubectl get deploy -n default    # nothing here
```

5. (Optional) do the same with kubectx/kubens:

```bash
kubectx            # list; current one highlighted
kubectx kind-scratch
kubectx -          # back to previous
kubens default
kubens -
```

### Verify

- `kubectl config get-contexts` (with the merged `KUBECONFIG`) lists both `kind-lab` and `kind-scratch`.
- After step 4, `kubectl config view --minify -o jsonpath='{..namespace}'` prints `playground`.
- In a **new** terminal (without the export), `kubectl config get-contexts` shows only `kind-lab` (and any other clusters you had).

:::hint
`export` only affects the current shell. The `namespace` field lives on the context entry, not the cluster, so different contexts pointing at the same cluster can have different default namespaces.
:::

:::solution
- `--kubeconfig` on `kind create` writes the new cluster's entry to that file instead of `~/.kube/config`. Keeping clusters in separate files is a clean pattern for client or production clusters: you only "see" them when you explicitly add them to `KUBECONFIG`.
- Merging rules: kubectl reads files left to right; for duplicate names, the first file wins; `current-context` comes from the first file that sets it. Writes (like `use-context`) go to the first file in the list.
- `set-context --current --namespace=playground` edits the `kind-lab` context in place. Reset it later with `kubectl config set-context --current --namespace=default` or `kubens default`.
:::

### Clean up

```bash
kubectl delete namespace playground
kubectl config set-context --current --namespace=default
kind delete cluster --name scratch --kubeconfig ~/.kube/kind-scratch.yaml
rm -f ~/.kube/kind-scratch.yaml
unset KUBECONFIG
```

## Lab 3: The declarative workflow — generate, diff, apply, patch

:::meta
difficulty: medium
time: 30 min
:::

Goal: produce clean manifests without writing YAML by hand, preview every change, and understand how apply, edit and patch interact.

### Steps

1. Generate manifests into a `k8s/` folder:

```bash
mkdir -p k8s
kubectl create namespace echo --dry-run=client -o yaml > k8s/00-namespace.yaml
kubectl create deployment echo -n echo --image=hashicorp/http-echo --replicas=2 --port=8080 \
  --dry-run=client -o yaml -- /http-echo -text=v1 -listen=:8080 > k8s/10-deployment.yaml
kubectl create service clusterip echo -n echo --tcp=80:8080 --dry-run=client -o yaml > k8s/20-service.yaml
cat k8s/10-deployment.yaml
```

2. Tidy the generated deployment by hand: remove the noise (`creationTimestamp: null`, empty `resources: {}`, `status: {}`), and split the container's `command` so the binary stays in `command` and the flags move to `args` (`command: ["/http-echo"]`, `args: ["-text=v1", "-listen=:8080"]`; see the solution for the full file). Then validate against the server without creating anything:

```bash
kubectl apply -f k8s/ --dry-run=server
kubectl apply -f k8s/
kubectl -n echo rollout status deploy/echo
```

3. Change the text to `v2` in `k8s/10-deployment.yaml` and set `replicas: 3`. Preview, then apply:

```bash
kubectl diff -f k8s/; echo "exit code: $?"
kubectl apply -f k8s/
kubectl diff -f k8s/; echo "exit code: $?"
```

4. Make a live change with `kubectl edit` (set replicas to 5), then re-apply the file and see what wins:

```bash
kubectl -n echo edit deploy echo         # change replicas to 5, save, quit
kubectl -n echo get deploy echo
kubectl diff -f k8s/
kubectl apply -f k8s/
kubectl -n echo get deploy echo
```

5. Practise the three patch types and labels/annotations:

```bash
kubectl -n echo patch deploy echo --type merge -p '{"spec":{"replicas":2}}'
kubectl -n echo patch deploy echo -p '{"spec":{"template":{"spec":{"containers":[{"name":"http-echo","resources":{"requests":{"cpu":"10m","memory":"16Mi"}}}]}}}}'
kubectl -n echo patch deploy echo --type json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args/0","value":"-text=patched"}]'
kubectl -n echo annotate deploy echo kubernetes.io/change-cause="patched text via json patch"
kubectl -n echo label deploy echo owner=roma
kubectl -n echo rollout history deploy echo
```

6. Check the result through the Service from inside the cluster:

```bash
kubectl -n echo run curl --image=curlimages/curl --rm -it --restart=Never -- curl -s echo
```

### Verify

- `kubectl diff` exits with `1` when there are changes and `0` right after applying.
- After step 4 the second apply brings replicas back to 3: the file wins over the live edit.
- Step 6 prints `patched`.
- `kubectl diff -f k8s/` now shows the patch drift (text `patched` vs `v2`, resources, labels).

:::hint
Container name: `kubectl create deployment` names the container after the image (`http-echo`). Strategic merge patches find list entries by `name`, so the name in your patch must match. If the JSON patch fails with "path not found", print `kubectl -n echo get deploy echo -o jsonpath='{.spec.template.spec.containers[0].args}'`.
:::

:::solution
Cleaned deployment file:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: echo
  name: echo
  namespace: echo
spec:
  replicas: 3
  selector:
    matchLabels:
      app: echo
  template:
    metadata:
      labels:
        app: echo
    spec:
      containers:
        - name: http-echo
          image: hashicorp/http-echo
          args: ["-text=v2", "-listen=:8080"]
          command: ["/http-echo"]
          ports:
            - containerPort: 8080
```

`kubectl create deployment ... -- cmd args` puts everything after `--` into `command`. Splitting it into `command` (the executable) and `args` (its flags) mirrors Docker's ENTRYPOINT/CMD and makes the JSON patch path `/spec/template/spec/containers/0/args/0` point at `-text=...`. If you skipped the split, the equivalent path is `/spec/template/spec/containers/0/command/1`.

Why the file wins in step 4: `replicas: 3` is in both the last-applied annotation and your file, so apply sets it back. If you **removed** `replicas` from the file, apply would no longer manage it, and a live value (from `kubectl scale` or an HPA) would be kept. That is exactly how you should write Deployments that are autoscaled.

Patches are drift: the file no longer describes the cluster. In a real team, every patch either goes back into git or is reverted by the next apply.
:::

### Clean up

```bash
kubectl delete -f k8s/
```

## Lab 4: Challenge — output format drills

:::meta
difficulty: medium
time: 30 min
:::

Goal: answer each question with **one** kubectl command (pipes to `sort`, `uniq`, `wc`, `base64` or `jq` allowed). No step-by-step; solutions below.

### Setup

```bash
kubectl create namespace drills
kubectl -n drills create deployment web --image=nginx:1.27-alpine --replicas=3
kubectl -n drills create deployment echo --image=hashicorp/http-echo --replicas=2 -- /http-echo -text=hi
kubectl -n drills create secret generic db --from-literal=password='correct-horse'
kubectl -n drills label deploy web tier=frontend
kubectl -n drills wait --for=condition=Available deploy --all --timeout=90s
```

### Requirements

1. Print just the names of all pods in `drills`, one per line, without the `pod/` prefix.
2. Print a table of pods in `drills` with columns `POD`, `NODE`, `IP`, `IMAGE`.
3. Print each node's name and its `tier` label (empty for the control plane), tab-separated.
4. Decode and print the `password` from the `db` Secret.
5. Count how many pods run on each node across **all** namespaces.
6. List all container images running in the cluster, de-duplicated.
7. Print the names of pods in all namespaces that are not in phase `Running`.
8. Print the pod names in `drills`, sorted by creation time, newest last.
9. Print the `containerPort` of the `web` deployment's first container.
10. Show only the `status.conditions` of the `web` deployment as JSON.

### Verify

Each command prints only the requested data, with no extra headers or YAML.

:::hint
Tools: `-o name`, `-o custom-columns=...`, `-o jsonpath='{range .items[*]}...{end}'`, `--field-selector`, `--sort-by`, `-o json | jq`. For counting, print one field per line and pipe through `sort | uniq -c`.
:::

:::solution
```bash
# 1
kubectl -n drills get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
#   or: kubectl -n drills get pods -o name | cut -d/ -f2

# 2
kubectl -n drills get pods -o custom-columns='POD:.metadata.name,NODE:.spec.nodeName,IP:.status.podIP,IMAGE:.spec.containers[*].image'

# 3
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.tier}{"\n"}{end}'

# 4
kubectl -n drills get secret db -o jsonpath='{.data.password}' | base64 -d; echo

# 5
kubectl get pods -A -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c

# 6
kubectl get pods -A -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' | sort -u

# 7
kubectl get pods -A --field-selector=status.phase!=Running -o name

# 8
kubectl -n drills get pods --sort-by=.metadata.creationTimestamp -o name

# 9
kubectl -n drills get deploy web -o jsonpath='{.spec.template.spec.containers[0].ports[0].containerPort}{"\n"}'
#   prints nothing: we never set --port. Recreate with --port=80 or patch it, then retry.

# 10
kubectl -n drills get deploy web -o json | jq '.status.conditions'
```

Note on 9: an empty result is a correct answer and a useful lesson: `containerPort` is informational and optional. nginx listens on 80 regardless. Services target the port the process actually listens on.
:::

### Clean up

```bash
kubectl delete namespace drills
```

## Lab 5: Break & fix — the local image that will not start

:::meta
difficulty: medium
time: 25 min
:::

Goal: build an image on your Mac, run it on kind, and diagnose why it ends up in `ImagePullBackOff`.

### Steps

1. Create a tiny Node.js service:

```bash
mkdir -p hello && cd hello
cat > server.js <<'EOF'
const http = require('node:http');
const os = require('node:os');
const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return res.end('ok\n');
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ app: 'shipit-hello', host: os.hostname() }) + '\n');
});
server.listen(port, () => console.log(`listening on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
EOF
cat > Dockerfile <<'EOF'
FROM node:22-alpine
WORKDIR /app
COPY server.js .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
EOF
docker build -t shipit-hello .
cd ..
```

2. Load it into kind and deploy it:

```bash
kind load docker-image shipit-hello --name lab
kubectl create deployment hello --image=shipit-hello --port=3000
sleep 20
kubectl get pods -l app=hello
```

3. The pods are not running. Diagnose and fix it **without** pushing to any registry.

### Verify

- `kubectl get pods -l app=hello` shows `Running`.
- `kubectl port-forward deploy/hello 3000:3000` then `curl localhost:3000` returns JSON with the pod's hostname.

:::hint
Read the events in `kubectl describe pod -l app=hello`. Which registry and which full image reference is the kubelet trying to pull? Then check whether the image is on the node: `docker exec lab-worker crictl images | grep hello`. What is the default `imagePullPolicy` for an image with no tag?
:::

:::solution
Diagnosis:

```bash
kubectl describe pod -l app=hello | sed -n '/Events:/,$p'
# Failed to pull image "shipit-hello": ... docker.io/library/shipit-hello:latest ... pull access denied / not found
kubectl get pod -l app=hello -o jsonpath='{.items[0].spec.containers[0].imagePullPolicy}{"\n"}'
# Always
docker exec lab-worker crictl images | grep hello
# docker.io/library/shipit-hello   latest   ...   <- the image IS on the node
```

The image was loaded successfully, but with no tag it means `:latest`, and the default pull policy for `:latest` is `Always`. The kubelet therefore ignores the local copy and tries Docker Hub, where `library/shipit-hello` does not exist. Events go `ErrImagePull` → `ImagePullBackOff` with increasing back-off delays.

Fix (preferred): use an explicit tag.

```bash
docker tag shipit-hello shipit-hello:0.1.0
kind load docker-image shipit-hello:0.1.0 --name lab
kubectl set image deploy/hello shipit-hello=shipit-hello:0.1.0
kubectl rollout status deploy/hello
```

Alternative: keep the tag and set the policy:

```bash
kubectl patch deploy hello -p '{"spec":{"template":{"spec":{"containers":[{"name":"shipit-hello","imagePullPolicy":"IfNotPresent"}]}}}}'
```

If `kind load` itself fails with a "content digest not found" error on Docker Desktop, rebuild with `docker build --platform linux/arm64 -t shipit-hello:0.1.0 hello/` (use `linux/amd64` on an Intel Mac) and load again.

Real-world lesson: never deploy `:latest` anywhere. Tags should be immutable (a version or git SHA), and production manifests often pin digests (`image@sha256:...`).
:::

### Clean up

Keep the `hello` deployment for the next lab.

## Lab 6: The debugging toolkit tour

:::meta
difficulty: medium
time: 35 min
:::

Goal: practise every interaction command on real workloads, including a crashing one, and do the same tasks in k9s.

### Steps

1. Install metrics-server (kind does not ship it):

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deploy/metrics-server --timeout=120s
```

2. Create a pod that crashes every few seconds:

```bash
kubectl run crashy --image=busybox:1.37 --restart=Always -- sh -c 'echo "starting up"; sleep 5; echo "FATAL: cannot connect to postgres" >&2; exit 1'
```

3. Logs: current, previous, follow, by label:

```bash
kubectl scale deploy hello --replicas=2
kubectl port-forward deploy/hello 3000:3000 >/dev/null & sleep 2
for i in 1 2 3; do curl -s localhost:3000/items/$i; done; kill %1
kubectl logs -l app=hello --prefix --tail=20
sleep 30
kubectl get pod crashy
kubectl logs crashy --previous
kubectl logs -f crashy        # Ctrl+C after it exits
```

4. Exec and copy:

```bash
POD=$(kubectl get pod -l app=hello -o jsonpath='{.items[0].metadata.name}')
kubectl exec "$POD" -- env | grep -E 'HOSTNAME|KUBERNETES_SERVICE'
kubectl exec -it "$POD" -- sh -c 'id; ls -la /app; wget -qO- localhost:3000/healthz'
kubectl cp "$POD":/app/server.js ./server-from-pod.js && head -3 server-from-pod.js
```

5. Events, wait, rollout, top:

```bash
kubectl events --for pod/crashy
kubectl get events --sort-by=.metadata.creationTimestamp | tail -15
kubectl rollout restart deploy/hello
kubectl rollout status deploy/hello
kubectl wait --for=condition=Ready pod -l app=hello --timeout=60s
kubectl top nodes
kubectl top pods -A --sort-by=memory | head
```

6. Repeat the tour in k9s. Start `k9s`, then:
   - `:pods` → select `crashy` → `l` for logs, `p` for previous logs, `d` for describe.
   - `:deploy` → select `hello` → `Enter` to see its pods → `s` to get a shell.
   - On a `hello` pod press `Shift-f` to port-forward 3000, curl it from another terminal.
   - `:xray deploy default` to see the ownership tree.
   - `:events` (or `:ev`) to see events.

7. Set up aliases and completion (append to `~/.zshrc`, then `source ~/.zshrc`):

```bash
cat >> ~/.zshrc <<'EOF'

# kubectl
source <(kubectl completion zsh)
alias k=kubectl
compdef __start_kubectl k
export do='--dry-run=client -o yaml'
EOF
```

### Verify

- `kubectl logs crashy --previous` prints both `starting up` and the FATAL line.
- `kubectl get pod crashy` shows a growing `RESTARTS` count and status alternating between `Running`, `Error` and `CrashLoopBackOff`.
- `kubectl top pods` returns numbers (it may take a minute after installing metrics-server).
- `k get po` with Tab completion works in a new terminal.

:::hint
If `kubectl top` says "metrics not available yet", wait 60 seconds: metrics-server scrapes every 15–60 s. If `kubectl cp` fails with "tar: not found", the image has no `tar`; `node:22-alpine` has it via busybox. If `compdef` is not found, your zsh completion system is not initialised: add `autoload -Uz compinit && compinit` before those lines.
:::

:::solution
Key observations:

- `kubectl logs crashy` shows only the current container's output. After a crash, the interesting line is in `--previous`. This is the first command to run for any `CrashLoopBackOff`.
- `CrashLoopBackOff` is not an error itself; it is the kubelet waiting before the next restart, with an exponential back-off (10 s, 20 s, 40 s ... capped at 5 minutes).
- `kubectl logs -l app=hello --prefix` merges logs from all matching pods, each line prefixed with `[pod/name/container]`. By default it reads up to 5 pods concurrently (`--max-log-requests`).
- `kubectl exec` runs inside the container's namespaces as the image's user (`node`, uid 1000 here).
- `kubectl cp` is `tar` over `exec`. It needs `tar` in the container, which distroless images do not have (you will use ephemeral debug containers for those in the next module).
- `kubectl events --for` filters to one object, newest last. `kubectl get events` sorted by `.metadata.creationTimestamp` is the portable alternative.
- `rollout restart` changes an annotation (`kubectl.kubernetes.io/restartedAt`) in the pod template, which triggers a normal rolling update.
:::

### Clean up

```bash
kubectl delete pod crashy
kubectl delete deploy hello
rm -f server-from-pod.js
```

Keep the `lab` cluster for the following modules.
