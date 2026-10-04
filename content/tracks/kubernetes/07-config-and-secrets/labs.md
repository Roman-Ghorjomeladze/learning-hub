You need `docker`, `kind` and `kubectl`. Labs 1 to 5 share one cluster; Lab 6 creates its own.

```bash
kind create cluster --name config-lab
kubectl cluster-info --context kind-config-lab
```

Apps in these labs use public images (`busybox`, `node:22-alpine`) with tiny scripts stored in ConfigMaps, so you do not need to build anything.

## Lab 1: Create ConfigMaps three ways and consume them four ways

:::meta
difficulty: easy
time: 20 min
:::

Goal: create ConfigMaps from literals, a file and an env file, then read them in a pod as single env vars, `envFrom`, a mounted directory and a single file.

### Steps

1. Prepare local files:

```bash
mkdir -p ~/k8s-config-lab && cd ~/k8s-config-lab
printf 'LOG_LEVEL=info\nCACHE_TTL_SECONDS=30\nPORT=3000\n' > shipit.env
printf '{ "newCheckout": false, "maxUploadMb": 10 }\n' > features.json
```

2. Create three ConfigMaps:

```bash
kubectl create configmap from-literals --from-literal=REGION=eu-central-1 --from-literal=TEAM=shipit
kubectl create configmap shipit-env --from-env-file=shipit.env
kubectl create configmap shipit-files --from-file=features.json
kubectl get configmap
kubectl get configmap shipit-env -o yaml
kubectl get configmap shipit-files -o yaml
```

3. Run a pod that uses all four consumption methods:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: config-reader
spec:
  containers:
    - name: reader
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      env:
        - name: REGION
          valueFrom:
            configMapKeyRef:
              name: from-literals
              key: REGION
      envFrom:
        - configMapRef:
            name: shipit-env
      volumeMounts:
        - name: files
          mountPath: /etc/shipit
        - name: files
          mountPath: /app/features.json
          subPath: features.json
  volumes:
    - name: files
      configMap:
        name: shipit-files
EOF
kubectl wait --for=condition=Ready pod/config-reader
```

### Verify

```bash
kubectl exec config-reader -- sh -c 'echo REGION=$REGION LOG_LEVEL=$LOG_LEVEL PORT=$PORT'
kubectl exec config-reader -- ls -la /etc/shipit
kubectl exec config-reader -- cat /etc/shipit/features.json /app/features.json
```

You should see `REGION=eu-central-1 LOG_LEVEL=info PORT=3000`, and in `/etc/shipit` a `features.json` symlink pointing into a `..data` directory.

:::hint
If the pod is stuck in `CreateContainerConfigError`, run `kubectl describe pod config-reader` and read the Events: it names the missing ConfigMap or key.
:::

:::solution
The commands above are the solution. Things to notice in `ls -la /etc/shipit`:

```text
..2026_10_03_10_00_00.123456789/
..data -> ..2026_10_03_10_00_00.123456789
features.json -> ..data/features.json
```

The kubelet writes new content into a fresh timestamped directory and atomically repoints `..data`. That is how mounted ConfigMaps update without a reader ever seeing a half-written file. `/app/features.json` (the `subPath` mount) is a plain bind mount of one file and is not part of that mechanism.
:::

### Clean up

Keep the pod and ConfigMaps for Lab 2.

## Lab 2: What updates at runtime and what does not

:::meta
difficulty: easy
time: 15 min
:::

Goal: prove that mounted directories update, while env vars and `subPath` files do not.

### Steps

1. Change both ConfigMaps:

```bash
kubectl create configmap shipit-env --from-literal=LOG_LEVEL=debug --from-literal=CACHE_TTL_SECONDS=5 --from-literal=PORT=3000 \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create configmap shipit-files --from-literal=features.json='{ "newCheckout": true, "maxUploadMb": 50 }' \
  --dry-run=client -o yaml | kubectl apply -f -
```

The `--dry-run=client -o yaml | kubectl apply -f -` idiom turns an imperative `create` into an idempotent update.

2. Watch the mounted file and the env var for up to two minutes:

```bash
for i in $(seq 1 12); do
  kubectl exec config-reader -- sh -c 'echo "$(date +%T) env=$LOG_LEVEL dir=$(cat /etc/shipit/features.json) subPath=$(cat /app/features.json)"'
  sleep 10
done
```

### Verify

Within roughly a minute (the exact delay depends on the kubelet sync period and cache), `dir=` shows `"newCheckout": true`. `env=` stays `info` and `subPath=` keeps the old JSON forever.

Now restart the container and check again:

```bash
kubectl delete pod config-reader --wait
# re-apply the pod manifest from Lab 1, then:
kubectl exec config-reader -- sh -c 'echo env=$LOG_LEVEL subPath=$(cat /app/features.json)'
```

Both now show the new values, because they are resolved at container start.

:::hint
Nothing changes after five minutes? Check that the update actually happened: `kubectl get configmap shipit-files -o yaml`. The `apply` warning about a missing `last-applied-configuration` annotation is harmless.
:::

:::solution
The lesson: **only directory volume mounts of ConfigMaps/Secrets are refreshed**. Env vars (`env`, `envFrom`) and `subPath` mounts are fixed for the life of the container. Since most apps read config once at startup anyway, the practical rule is to trigger a rollout whenever config changes (Lab 5).
:::

### Clean up

```bash
kubectl delete pod config-reader
kubectl delete configmap from-literals shipit-env shipit-files
```

## Lab 3: Secrets are base64, and who can read them

:::meta
difficulty: medium
time: 30 min
:::

Goal: see that Secrets are stored in plain text in etcd by default, then explore which RBAC permissions expose them, including the less obvious "create pods" path.

### Steps

1. Create a Secret and decode it:

```bash
kubectl create secret generic shipit-db \
  --from-literal=DATABASE_URL='postgres://shipit:hunter2@postgres:5432/shipit'
kubectl get secret shipit-db -o yaml
kubectl get secret shipit-db -o jsonpath='{.data.DATABASE_URL}' | base64 -d; echo
```

2. Read it straight from etcd:

```bash
kubectl -n kube-system exec etcd-config-lab-control-plane -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/shipit-db | strings | grep hunter2
```

3. Create a ServiceAccount `app` and check what it can do:

```bash
kubectl create serviceaccount app
kubectl auth can-i get secrets --as=system:serviceaccount:default:app
kubectl auth can-i list secrets --as=system:serviceaccount:default:app
```

4. Give it a Role that can create pods and read pod logs, but has **no** access to secrets:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-runner
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "list", "delete"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: app-pod-runner
subjects:
  - kind: ServiceAccount
    name: app
    namespace: default
roleRef:
  kind: Role
  name: pod-runner
  apiGroup: rbac.authorization.k8s.io
EOF
kubectl auth can-i get secret/shipit-db --as=system:serviceaccount:default:app
```

5. Now, acting as `app`, read the Secret anyway:

```bash
cat <<'EOF' | kubectl apply --as=system:serviceaccount:default:app -f -
apiVersion: v1
kind: Pod
metadata:
  name: peek
spec:
  restartPolicy: Never
  containers:
    - name: peek
      image: busybox:1.36
      command: ["sh", "-c", "cat /secret/DATABASE_URL"]
      volumeMounts:
        - name: s
          mountPath: /secret
  volumes:
    - name: s
      secret:
        secretName: shipit-db
EOF
sleep 10
kubectl logs peek --as=system:serviceaccount:default:app
```

### Verify

- Step 2 prints the password in clear text from etcd.
- Step 3 and the `can-i` in step 4 print `no`.
- Step 5 prints the full `DATABASE_URL` even though `app` cannot `get` secrets.

:::hint
If `kubectl exec` into etcd fails, check the pod name with `kubectl -n kube-system get pods | grep etcd`. It is `etcd-<cluster-name>-control-plane`.
:::

:::solution
The commands are the solution. Takeaways:

1. **Base64 is encoding.** Without encryption at rest, etcd (and every etcd backup) holds Secrets in readable form. Lab 6 fixes that.
2. **RBAC on `secrets` is necessary but not sufficient.** Anyone who can create pods in a namespace can mount any Secret in it. In real clusters, restrict who can create workloads, and use admission policies (Pod Security, Kyverno/Gatekeeper/ValidatingAdmissionPolicy) to control what pods may do.
3. `kubectl auth can-i ... --as=system:serviceaccount:<ns>:<name>` is the quickest way to audit an identity.

To restrict a CI identity to updating one Secret only:

```yaml
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["shipit-db"]
    verbs: ["get", "update", "patch"]
```
:::

### Clean up

```bash
kubectl delete pod peek
kubectl delete rolebinding app-pod-runner
kubectl delete role pod-runner
kubectl delete serviceaccount app
kubectl delete secret shipit-db
```

## Lab 4: Break and fix: shipit-api will not start

:::meta
difficulty: medium
time: 30 min
:::

Goal: debug a broken configuration setup. The app is a tiny Node server that validates its config at startup (the fail-fast pattern from the lesson). There are **four** problems; each one shows up differently.

### Setup

```bash
kubectl create namespace shipit
kubectl create secret generic shipit-db \
  --from-literal=database-url='postgres://shipit:hunter2@postgres:5432/shipit'

cat <<'EOF' > broken.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-code
  namespace: shipit
data:
  server.js: |
    const http = require('http');
    const missing = ['DATABASE_URL', 'LOG_LEVEL'].filter((k) => !process.env[k]);
    if (missing.length) { console.error('Missing config:', missing.join(', ')); process.exit(1); }
    const levels = ['debug', 'info', 'warn', 'error'];
    if (!levels.includes(process.env.LOG_LEVEL)) {
      console.error(`Invalid LOG_LEVEL "${process.env.LOG_LEVEL}", expected one of: ${levels.join(', ')}`);
      process.exit(1);
    }
    const port = Number(process.env.PORT || 3000);
    http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        logLevel: process.env.LOG_LEVEL,
        cacheEnabled: process.env.ENABLE_CACHE,
        db: process.env.DATABASE_URL.replace(/:[^:@/]*@/, ':***@'),
      }) + '\n');
    }).listen(port, () => console.log(`shipit-api listening on ${port}`));
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: shipit-config
  namespace: shipit
data:
  LOG_LEVEL: INFO
  PORT: "3000"
  ENABLE_CACHE: true
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shipit-api
  namespace: shipit
spec:
  replicas: 1
  selector:
    matchLabels: { app: shipit-api }
  template:
    metadata:
      labels: { app: shipit-api }
    spec:
      containers:
        - name: api
          image: node:22-alpine
          command: ["node", "/app/server.js"]
          envFrom:
            - configMapRef:
                name: shipit-config
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: shipit-db
                  key: DATABASE_URL
          volumeMounts:
            - name: code
              mountPath: /app
      volumes:
        - name: code
          configMap:
            name: app-code
EOF
kubectl apply -f broken.yaml
```

### Your task

Get `shipit-api` to `Running` and answering on port 3000 with `logLevel: "info"` and `cacheEnabled: "true"`. Fix the manifests (and the Secret) rather than working around the app's validation.

### Verify

```bash
kubectl -n shipit rollout status deploy/shipit-api
kubectl -n shipit port-forward deploy/shipit-api 3000:3000 &
sleep 2; curl -s localhost:3000; kill %1
```

Expected: `{"logLevel":"info","cacheEnabled":"true","db":"postgres://shipit:***@postgres:5432/shipit"}`

:::hint
Work in the order Kubernetes hits the problems: first `kubectl apply` itself (read its error), then `kubectl -n shipit get pods` and `kubectl -n shipit describe pod -l app=shipit-api` (Events), then `kubectl -n shipit logs deploy/shipit-api`. Secrets are namespaced. Key names are case-sensitive.
:::

:::solution
**Problem 1: `kubectl apply` rejects the ConfigMap.** `ENABLE_CACHE: true` is a YAML boolean, but ConfigMap `data` values must be strings. The error is similar to `cannot unmarshal bool into Go struct field ConfigMap.data of type string`. Fix: `ENABLE_CACHE: "true"`.

**Problem 2: `CreateContainerConfigError`, secret not found.** The Secret was created in `default`, but the pod is in `shipit`. Pods can only reference Secrets in their own namespace. `describe` shows `secret "shipit-db" not found`.

**Problem 3: `CreateContainerConfigError`, key not found.** The Secret's key is `database-url` but the Deployment asks for `DATABASE_URL`. `describe` shows `couldn't find key DATABASE_URL in Secret shipit/shipit-db`.

Fix 2 and 3 together by recreating the Secret in the right namespace with the right key:

```bash
kubectl delete secret shipit-db
kubectl -n shipit create secret generic shipit-db \
  --from-literal=DATABASE_URL='postgres://shipit:hunter2@postgres:5432/shipit'
```

(Alternatively keep `database-url` and change `key:` in the Deployment.)

**Problem 4: `CrashLoopBackOff`.** The logs say `Invalid LOG_LEVEL "INFO", expected one of: debug, info, warn, error`. Fix: `LOG_LEVEL: info`. This is the fail-fast validation doing its job: the error is obvious from `kubectl logs` instead of surfacing later as odd behaviour.

Corrected ConfigMap:

```yaml
data:
  LOG_LEVEL: info
  PORT: "3000"
  ENABLE_CACHE: "true"
```

Then `kubectl apply -f broken.yaml`. Because `envFrom` values are read at container start, a crash-looping container picks up the fixed ConfigMap on its next restart; to be sure, run `kubectl -n shipit rollout restart deploy/shipit-api`.
:::

### Clean up

Keep the `shipit` namespace and its resources for Lab 5.

## Lab 5: Roll pods automatically when config changes

:::meta
difficulty: medium
time: 25 min
:::

Goal: compare `kubectl rollout restart` with Kustomize's hash-suffixed ConfigMaps, and see why the latter makes rollbacks restore config too.

### Steps

1. With the fixed Lab 4 app running, change the log level and observe that nothing happens:

```bash
kubectl -n shipit patch configmap shipit-config -p '{"data":{"LOG_LEVEL":"debug"}}'
kubectl -n shipit port-forward deploy/shipit-api 3000:3000 & sleep 2; curl -s localhost:3000; kill %1
```

2. Restart and check again:

```bash
kubectl -n shipit rollout restart deploy/shipit-api
kubectl -n shipit rollout status deploy/shipit-api
kubectl -n shipit get deploy shipit-api -o jsonpath='{.spec.template.metadata.annotations}'; echo
kubectl -n shipit port-forward deploy/shipit-api 3000:3000 & sleep 2; curl -s localhost:3000; kill %1
```

3. Switch to Kustomize. Create a directory with a generator:

```bash
mkdir -p ~/k8s-config-lab/kustomize && cd ~/k8s-config-lab/kustomize
cat <<'EOF' > deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shipit-api
spec:
  replicas: 2
  selector:
    matchLabels: { app: shipit-api }
  template:
    metadata:
      labels: { app: shipit-api }
    spec:
      containers:
        - name: api
          image: node:22-alpine
          command: ["node", "/app/server.js"]
          envFrom:
            - configMapRef:
                name: shipit-config
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: shipit-db
                  key: DATABASE_URL
          volumeMounts:
            - name: code
              mountPath: /app
      volumes:
        - name: code
          configMap:
            name: app-code
EOF
cat <<'EOF' > kustomization.yaml
namespace: shipit
resources:
  - deployment.yaml
configMapGenerator:
  - name: shipit-config
    literals:
      - LOG_LEVEL=info
      - PORT=3000
      - ENABLE_CACHE=true
EOF
kubectl kustomize .            # preview: note the hash suffix and the rewritten reference
kubectl apply -k .
kubectl -n shipit rollout status deploy/shipit-api
kubectl -n shipit get configmap
```

4. Change `LOG_LEVEL=info` to `LOG_LEVEL=warn` in `kustomization.yaml` and apply again:

```bash
sed -i '' 's/LOG_LEVEL=info/LOG_LEVEL=warn/' kustomization.yaml   # macOS sed; on Linux use sed -i
kubectl apply -k .
kubectl -n shipit rollout status deploy/shipit-api
kubectl -n shipit get configmap
kubectl -n shipit rollout history deploy/shipit-api
```

5. Roll back the Deployment and check which config the pods use:

```bash
kubectl -n shipit rollout undo deploy/shipit-api
kubectl -n shipit rollout status deploy/shipit-api
kubectl -n shipit port-forward deploy/shipit-api 3000:3000 & sleep 2; curl -s localhost:3000; kill %1
```

### Verify

- Step 1 still shows `info`; step 2 shows `debug` and a `kubectl.kubernetes.io/restartedAt` annotation.
- After step 4 there are two `shipit-config-<hash>` ConfigMaps and a new rollout happened without any restart command.
- After step 5 the app reports `"logLevel":"info"` again: the rollback restored the old config because the old pod template references the old ConfigMap name.

:::hint
`kubectl kustomize .` shows exactly what will be applied. Look for `name: shipit-config-` followed by a hash in both the ConfigMap and the Deployment's `configMapRef`.
:::

:::solution
The steps contain the full solution. Why it works: the generator names the ConfigMap after a hash of its content, and Kustomize rewrites every reference to it. A content change produces a new name, so the Deployment's pod template changes and Kubernetes rolls the pods. Old ConfigMaps remain (until pruned), so `rollout undo` brings back a template that points at the old, still-existing config.

With `kubectl rollout restart` and an edited-in-place ConfigMap, `rollout undo` would roll back the template but the pods would still read the *current* ConfigMap. Helm's `checksum/config` annotation solves the "trigger a rollout" half; hash names also solve the rollback half.
:::

### Clean up

```bash
kubectl delete namespace shipit
rm -rf ~/k8s-config-lab
kind delete cluster --name config-lab
```

## Lab 6: Challenge: turn on encryption at rest in kind

:::meta
difficulty: hard
time: 40 min
:::

Goal: configure kube-apiserver to encrypt Secrets in etcd with `aescbc`, prove new Secrets are encrypted, and re-encrypt existing ones. This is what managed services such as EKS do for you with KMS.

### Requirements

1. Create a new cluster `enc-lab` and a Secret `before` **before** enabling encryption. Show it is plain text in etcd.
2. Write an `EncryptionConfiguration` that encrypts `secrets` with `aescbc` using a random 32-byte key, keeping `identity` as a fallback for reading old data.
3. Make kube-apiserver use it. Hints: kind nodes are Docker containers (`docker exec`, `docker cp`); the API server is a static pod defined in `/etc/kubernetes/manifests/kube-apiserver.yaml`; `/etc/kubernetes/pki` on the node is already mounted into the API server pod.
4. Show that a new Secret `after` is stored with the prefix `k8s:enc:aescbc:v1:`.
5. Re-encrypt all existing Secrets and show that `before` is now encrypted too.
6. Show that `kubectl get secret before -o yaml` still returns the decoded value (encryption is transparent to API clients).

### Verify

`etcdctl get /registry/secrets/default/after | strings | head -3` shows `k8s:enc:aescbc:v1:key1` and no readable password; the same for `before` after step 5.

:::hint
Use GNU `sed` *inside* the node container (via `docker exec`) to add a flag after the `- kube-apiserver` line; macOS `sed` behaves differently. The kubelet notices the changed static pod manifest and restarts the API server within about 30 seconds; `kubectl` fails while it restarts. If the API server never comes back, check `docker exec enc-lab-control-plane crictl ps -a | grep kube-apiserver` and its logs with `crictl logs <id>`.
:::

:::solution
```bash
# 1. Cluster and a pre-existing Secret
kind create cluster --name enc-lab
kubectl create secret generic before --from-literal=password=old-plaintext

etcdget() {
  kubectl -n kube-system exec etcd-enc-lab-control-plane -- etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    get "/registry/secrets/default/$1" | strings | head -5
}
etcdget before          # shows old-plaintext

# 2. Encryption config with a random key
KEY=$(head -c 32 /dev/urandom | base64)
cat <<EOF > enc.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources: ["secrets"]
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: ${KEY}
      - identity: {}
EOF

# 3. Copy it into the node and add the flag to the static pod manifest
docker cp enc.yaml enc-lab-control-plane:/etc/kubernetes/pki/enc.yaml
docker exec enc-lab-control-plane sed -i \
  's#^\(\s*\)- kube-apiserver$#&\n\1- --encryption-provider-config=/etc/kubernetes/pki/enc.yaml#' \
  /etc/kubernetes/manifests/kube-apiserver.yaml
docker exec enc-lab-control-plane grep -n encryption-provider /etc/kubernetes/manifests/kube-apiserver.yaml

# Wait for the API server to restart
sleep 40
until kubectl get --raw /readyz >/dev/null 2>&1; do echo "waiting for apiserver"; sleep 5; done

# 4. New Secrets are encrypted
kubectl create secret generic after --from-literal=password=new-secret
etcdget after           # k8s:enc:aescbc:v1:key1 ... binary
etcdget before          # still plain text: not rewritten yet

# 5. Rewrite all Secrets so they are stored with the new provider
kubectl get secrets --all-namespaces -o json | kubectl replace -f -
etcdget before          # now encrypted

# 6. Transparent for clients
kubectl get secret before -o jsonpath='{.data.password}' | base64 -d; echo
```

Notes:

- Provider order matters: the **first** provider encrypts writes; reads try each in turn. With `identity` first nothing would be encrypted.
- The key sits on the control plane disk next to the data it protects, which is why production uses the `kms` v2 provider (envelope encryption with a key in AWS KMS or similar).
- Key rotation: add `key2` as the first key, restart the API server, rewrite all Secrets, then remove `key1`.
- The flag added via `sed` would be lost if kind recreated the node; for a permanent setup, use a kind config with `kubeadmConfigPatches` and `extraMounts`.
:::

### Clean up

```bash
kind delete cluster --name enc-lab
rm -f enc.yaml
```
