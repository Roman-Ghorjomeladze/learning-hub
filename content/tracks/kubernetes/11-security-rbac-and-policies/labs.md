These labs use one dedicated kind cluster so you can break things freely.

```bash
kind version                      # v0.24+ enforces NetworkPolicy with the default CNI
kind create cluster --name sec
kubectl config current-context    # kind-sec
```

You also need `openssl` (preinstalled on macOS) and Node.js (used once to decode a JWT). When you finish all labs: `kind delete cluster --name sec`.

## Lab 1: A human user with least-privilege RBAC

:::meta
difficulty: medium
time: 25 min
:::

**Goal:** create a user `jane` (group `dev-team`) authenticated by a client certificate, give her read-only access to pods and Deployments in `dev`, then broaden access via her group, verifying every step with `kubectl auth can-i`.

### Steps

1. Create the namespace and a workload to look at:

```bash
kubectl create namespace dev
kubectl -n dev create deployment web --image=nginx:1.27 --replicas=2
```

2. Generate a key and a certificate signing request. `CN` becomes the username, `O` the group:

```bash
mkdir -p ~/k8s-sec && cd ~/k8s-sec
openssl genrsa -out jane.key 2048
openssl req -new -key jane.key -out jane.csr -subj "/CN=jane/O=dev-team"
```

3. Submit it to the Kubernetes CSR API, approve it and download the signed cert:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: jane
spec:
  request: $(base64 < jane.csr | tr -d '\n')
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400
  usages: ["client auth"]
EOF
kubectl get csr jane                 # Pending
kubectl certificate approve jane
kubectl get csr jane -o jsonpath='{.status.certificate}' | base64 -d > jane.crt
openssl x509 -in jane.crt -noout -subject -enddate
```

4. Add jane to your kubeconfig as a separate context:

```bash
kubectl config set-credentials jane --client-key=jane.key --client-certificate=jane.crt --embed-certs=true
kubectl config set-context jane@sec --cluster=kind-sec --user=jane --namespace=dev
kubectl --context jane@sec auth whoami
kubectl --context jane@sec get pods          # Forbidden: authenticated, not authorized
```

5. Write `jane-rbac.yaml` with a Role `app-reader` (get/list/watch on `pods`, `pods/log`, `deployments`) and a RoleBinding to user `jane`. Apply it.

6. Verify as admin with impersonation, then as jane herself:

```bash
kubectl auth can-i list pods -n dev --as jane
kubectl auth can-i delete pods -n dev --as jane
kubectl auth can-i list pods -n default --as jane
kubectl --context jane@sec get pods,deploy
kubectl --context jane@sec logs deploy/web --tail=3
kubectl --context jane@sec delete pod --all      # should be Forbidden
```

7. The team now needs to deploy in `dev`. Instead of editing jane's Role, bind the built-in `edit` ClusterRole to the **group** `dev-team` in `dev` only:

```bash
kubectl -n dev create rolebinding dev-team-edit --clusterrole=edit --group=dev-team
kubectl --context jane@sec scale deploy web --replicas=3
kubectl --context jane@sec get secrets      # allowed? edit includes secrets
kubectl auth can-i create rolebindings -n dev --as jane --as-group dev-team
```

### Verify

- `kubectl auth can-i list pods -n dev --as jane` → `yes`; `-n default` → `no`.
- After step 7, jane can scale `web` in `dev`, but `kubectl --context jane@sec -n default get pods` is still forbidden.
- `can-i create rolebindings` is `no`: `edit` deliberately cannot grant permissions (that is `admin`).

:::hint
Pods and logs are in the core API group (`""`), Deployments in `apps`. Logs are the subresource `pods/log`. `roleRef.kind` is `Role` and the subject kind is `User` with `apiGroup: rbac.authorization.k8s.io`.
:::

:::solution
```yaml
# jane-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: app-reader
  namespace: dev
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: jane-app-reader
  namespace: dev
subjects:
  - kind: User
    name: jane
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: app-reader
  apiGroup: rbac.authorization.k8s.io
```

```bash
kubectl apply -f jane-rbac.yaml
kubectl auth can-i --list -n dev --as jane --as-group dev-team
```

Note that `edit` lets jane read Secrets in `dev`. If that is unacceptable, write your own ClusterRole without `secrets` instead of using `edit`. Also note what you could **not** do: revoke jane's certificate. Until it expires (24 h here), the only way to cut her off is removing her bindings. That is why real clusters use OIDC for humans.
:::

### Clean up

```bash
kubectl config delete-context jane@sec
kubectl config delete-user jane
kubectl delete csr jane
kubectl delete ns dev
```

## Lab 2: A ServiceAccount that talks to the API

:::meta
difficulty: medium
time: 25 min
:::

**Goal:** understand what a pod's token is, call the API from inside a pod with it, grant the minimum permission, then remove the token from pods that do not need it.

### Steps

1. Set up a namespace, a ServiceAccount, and a pod using it:

```bash
kubectl create namespace tools
kubectl -n tools create serviceaccount pod-lister
kubectl -n tools run api-client --image=curlimages/curl --overrides='{"spec":{"serviceAccountName":"pod-lister"}}' --command -- sleep 3600
kubectl -n tools wait --for=condition=Ready pod/api-client
```

2. Look at the mounted credentials:

```bash
kubectl -n tools exec api-client -- ls /var/run/secrets/kubernetes.io/serviceaccount
kubectl -n tools get pod api-client -o jsonpath='{.spec.volumes[0]}' | head -c 600; echo
```

The volume is a `projected` volume with a `serviceAccountToken` source and `expirationSeconds`, not a Secret.

3. Decode the token's claims (Node.js is on your Mac):

```bash
TOKEN=$(kubectl -n tools exec api-client -- cat /var/run/secrets/kubernetes.io/serviceaccount/token)
node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64url")))' "$TOKEN"
```

Find the `aud`, `exp`, `sub` and the `kubernetes.io.pod` claim binding it to this pod.

4. Call the API from inside the pod:

```bash
kubectl -n tools exec api-client -- sh -c '
  SA=/var/run/secrets/kubernetes.io/serviceaccount
  curl -s --cacert $SA/ca.crt -H "Authorization: Bearer $(cat $SA/token)" \
    https://kubernetes.default.svc/api/v1/namespaces/tools/pods | head -20'
```

You get a 403 `Status` object naming `system:serviceaccount:tools:pod-lister`.

5. Grant only `list` on pods in `tools` and repeat step 4. Then confirm the SA cannot list pods in `kube-system` and cannot `delete` pods.

6. Mint a short-lived token yourself and use it from your laptop:

```bash
kubectl -n tools create token pod-lister --duration 10m > /tmp/sa.token
kubectl --token="$(cat /tmp/sa.token)" auth whoami
kubectl --token="$(cat /tmp/sa.token)" -n tools get pods
```

7. Now the opposite case. Create a SA `quiet` with `automountServiceAccountToken: false`, run a pod with it and confirm the token directory does not exist.

8. Delete the `api-client` pod and try to use its old `$TOKEN` from your laptop: `kubectl --token="$TOKEN" -n tools get pods`.

### Verify

- Step 5: the API returns a `PodList` JSON; `kubectl auth can-i delete pods -n tools --as system:serviceaccount:tools:pod-lister` is `no`.
- Step 7: `ls /var/run/secrets/kubernetes.io/serviceaccount` fails with "No such file or directory".
- Step 8: the old token is rejected (`Unauthorized`) because it was bound to a pod that no longer exists.

:::hint
`kubectl -n tools create role pod-list --verb=list --resource=pods` and `kubectl -n tools create rolebinding ... --role=pod-list --serviceaccount=tools:pod-lister` do step 5 in two lines.
:::

:::solution
```bash
# step 5
kubectl -n tools create role pod-list --verb=list --resource=pods
kubectl -n tools create rolebinding pod-lister-list --role=pod-list --serviceaccount=tools:pod-lister
kubectl auth can-i list pods -n tools --as system:serviceaccount:tools:pod-lister        # yes
kubectl auth can-i list pods -n kube-system --as system:serviceaccount:tools:pod-lister  # no
```

```yaml
# step 7: quiet.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: quiet
  namespace: tools
automountServiceAccountToken: false
---
apiVersion: v1
kind: Pod
metadata:
  name: quiet
  namespace: tools
spec:
  serviceAccountName: quiet
  containers:
    - name: app
      image: busybox:1.36
      command: ["sleep", "3600"]
```

```bash
kubectl apply -f quiet.yaml
kubectl -n tools exec quiet -- ls /var/run/secrets/kubernetes.io/serviceaccount
# step 8
kubectl -n tools delete pod api-client
kubectl --token="$TOKEN" -n tools get pods      # error: You must be logged in to the server (Unauthorized)
```

Takeaway: tokens are short-lived, audience-scoped and bound to a pod. Your Node.js clients must re-read the token file rather than caching it at startup (the official `@kubernetes/client-node` does this when loaded with `loadFromCluster()`).
:::

### Clean up

```bash
kubectl delete ns tools; rm -f /tmp/sa.token
```

## Lab 3: Break & fix — pods rejected by Pod Security Admission

:::meta
difficulty: medium
time: 30 min
:::

**Goal:** a team applied a Deployment to a namespace that enforces the `restricted` Pod Security Standard. "kubectl apply worked, but nothing is running." Diagnose and fix it without weakening the namespace.

### Steps

1. Create the namespace and apply the team's manifest:

```bash
kubectl create namespace hardened
kubectl label ns hardened \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted

cat > web.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: hardened
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
          ports:
            - containerPort: 80
EOF
kubectl apply -f web.yaml
```

2. Notice the warning printed by `apply`, then investigate as if you had missed it:

```bash
kubectl -n hardened get deploy,rs,pods
kubectl -n hardened describe rs -l app=web | sed -n '/Events/,$p'
```

3. Fix the manifest so the pods are admitted **and** actually run. Constraints: keep `enforce=restricted`; the container root filesystem must be read-only.

4. Second incident in the same namespace. Apply this and explain the status:

```bash
cat > worker.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: worker
  namespace: hardened
spec:
  securityContext:
    runAsNonRoot: true
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: worker
      image: node:22-alpine
      command: ["node", "-e", "setInterval(() => console.log('tick'), 5000)"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
EOF
kubectl apply -f worker.yaml
kubectl -n hardened get pod worker
```

### Verify

- `kubectl -n hardened get pods -l app=web` shows 2/2 Running.
- `kubectl -n hardened exec deploy/web -- touch /usr/share/nginx/html/x` fails with "Read-only file system".
- `kubectl -n hardened exec deploy/web -- id` shows a non-zero UID.
- `worker` reaches Running after your fix and logs `tick`.

:::hint
The ReplicaSet events list every violation: privilege escalation, capabilities, runAsNonRoot, seccomp. The stock `nginx` image runs as root and binds port 80, so switch to `nginxinc/nginx-unprivileged` (UID 101, port 8080). With a read-only root filesystem it needs a writable `/tmp`. For `worker`, read the exact message in `kubectl describe pod worker`, then check which user the image runs as by default: `docker image inspect node:22-alpine --format '{{.Config.User}}'` (pull it first; an empty result means root).
:::

:::solution
**Web.** The RS events say something like `violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile`. Fixed manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: hardened
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 101
        runAsGroup: 101
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: nginx
          image: nginxinc/nginx-unprivileged:1.27-alpine
          ports:
            - containerPort: 8080
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: {}
```

```bash
kubectl apply -f web.yaml
kubectl -n hardened rollout status deploy/web
kubectl -n hardened logs deploy/web | tail -5   # entrypoint notes it cannot modify default.conf (read-only) and continues
```

**Worker.** It is admitted (it satisfies `restricted`) but stuck in `CreateContainerConfigError`. `describe` says `container has runAsNonRoot and image will run as root`. The official `node` image runs as root by default (`Config.User` is empty); the `node` user (UID 1000) exists but is not the default. Add `runAsUser: 1000` (pod or container level):

```yaml
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    seccompProfile: { type: RuntimeDefault }
```

```bash
kubectl delete pod worker -n hardened && kubectl apply -f worker.yaml
kubectl -n hardened logs worker
```

The same error with the wording `image has non-numeric user (node), cannot verify user is non-root` appears when a Dockerfile says `USER node`. The fix is the same: numeric `USER 1000` in the Dockerfile or `runAsUser` in the pod.

Lesson: PSA rejects **pods**, so a bad Deployment shows up as a ReplicaSet with zero pods. `kubectl describe rs` is where the reason lives.
:::

### Clean up

```bash
kubectl delete ns hardened
```

## Lab 4: NetworkPolicies — default deny, then allow

:::meta
difficulty: medium
time: 35 min
:::

**Goal:** prove that NetworkPolicy is enforced on your cluster, lock a namespace down, then allow exactly: any pod labelled `role=api` → `db` on port 5678, DNS for everyone, and Prometheus-style scraping from a `monitoring` namespace.

### Steps

1. Deploy a fake database (an HTTP echo server standing in for Postgres) and a test helper:

```bash
kubectl create namespace shop
kubectl -n shop create deployment db --image=hashicorp/http-echo:1.0 -- /http-echo -text=db-ok -listen=:5678
kubectl -n shop expose deployment db --port 5678
kubectl -n shop rollout status deploy/db

# helper: run a one-off curl pod with given labels in a given namespace
probe() { kubectl -n "$1" run "probe-$RANDOM" --rm -i --restart=Never --quiet \
  --image=curlimages/curl --labels="$2" -- curl -s -m 3 "$3" || echo "BLOCKED ($3)"; }
```

2. Baseline: everything is open.

```bash
probe shop role=api   http://db:5678
probe shop role=web   http://db:5678
kubectl create namespace monitoring
probe monitoring app=prometheus http://db.shop:5678
```

All three print `db-ok`.

3. Apply a default-deny policy for **ingress and egress** in `shop` and re-run the three probes. Everything should be blocked, including DNS.

4. Add policies so that:
   - all pods in `shop` can resolve DNS via CoreDNS,
   - pods labelled `role=api` may send traffic to `app=db` on TCP 5678 (egress), and `db` accepts it (ingress),
   - pods in namespace `monitoring` with label `app=prometheus` may reach `db` on 5678.

5. Re-run all probes plus a negative one from `monitoring` with the wrong label:

```bash
probe shop       role=api        http://db:5678       # db-ok
probe shop       role=web        http://db:5678       # BLOCKED
probe monitoring app=prometheus  http://db.shop:5678  # db-ok
probe monitoring app=grafana     http://db.shop:5678  # BLOCKED
```

### Verify

The four results match the comments. `kubectl -n shop get netpol` lists your policies.

:::hint
The `deployment db` gets label `app=db` automatically. Every namespace has the label `kubernetes.io/metadata.name`. For "pods with label X in namespace Y", put `namespaceSelector` and `podSelector` in the **same** list item. If even step 2 after default deny still passes, your CNI is not enforcing: check `kind version` (needs v0.24+) or install Calico.
:::

:::solution
```yaml
# netpol.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: shop
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: shop
spec:
  podSelector: {}
  policyTypes: ["Egress"]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
          podSelector:
            matchLabels: { k8s-app: kube-dns }
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-egress-to-db
  namespace: shop
spec:
  podSelector:
    matchLabels: { role: api }
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector:
            matchLabels: { app: db }
      ports:
        - { protocol: TCP, port: 5678 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-ingress
  namespace: shop
spec:
  podSelector:
    matchLabels: { app: db }
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels: { role: api }
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: monitoring }
          podSelector:
            matchLabels: { app: prometheus }
      ports:
        - { protocol: TCP, port: 5678 }
```

```bash
kubectl apply -f netpol.yaml
```

Why the `monitoring` probe needs no egress policy: `monitoring` has no policies, so its pods may send anywhere; only `db`'s ingress rule matters. The `shop` probe with `role=api` needs both its own egress allow (because default deny covers egress in `shop`) and `db`'s ingress allow.

If enforcement does not work on your kind version, recreate the cluster with Calico:

```yaml
# kind-calico.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: 192.168.0.0/16
```

Then `kind create cluster --name sec --config kind-calico.yaml` and install Calico using the manifest URL from the Calico docs (pick the current release there).
:::

### Clean up

```bash
kubectl delete ns shop monitoring
```

## Lab 5: Custom guardrails with ValidatingAdmissionPolicy (CEL)

:::meta
difficulty: medium
time: 30 min
:::

**Goal:** enforce two organisation rules in labelled namespaces without installing anything: no `:latest` or untagged images, and every container must have a memory limit. Roll it out in `Warn` mode first, then `Deny`.

### Steps

1. Create a team namespace and opt it in:

```bash
kubectl create namespace team-a
kubectl label ns team-a policy.shipit.dev/enforce=true
```

2. Write `vap.yaml` with a `ValidatingAdmissionPolicy` named `image-and-limits` matching `apps/v1` Deployments, StatefulSets and DaemonSets on CREATE/UPDATE, with two CEL validations. Add a `ValidatingAdmissionPolicyBinding` with `validationActions: ["Warn"]` selecting namespaces labelled `policy.shipit.dev/enforce=true`.

3. Test in Warn mode:

```bash
kubectl -n team-a create deployment bad --image=nginx          # warning, but created
kubectl -n team-a get deploy bad
```

4. Switch the binding to `["Deny"]` and test again:

```bash
kubectl -n team-a delete deploy bad
kubectl -n team-a create deployment bad --image=nginx          # denied
kubectl -n team-a create deployment bad2 --image=nginx:1.27    # denied: no memory limit
kubectl create deployment elsewhere --image=nginx -n default   # allowed: namespace not opted in
```

5. Write a compliant Deployment `good` (nginx:1.27, memory limit 128Mi) and apply it.

6. Optional, with Kyverno: install it and add a `ValidatingPolicy` that requires a `team` label on Deployments.

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update
helm install kyverno kyverno/kyverno -n kyverno --create-namespace
kubectl -n kyverno rollout status deploy/kyverno-admission-controller
```

### Verify

- In Deny mode, both bad deployments fail with your custom messages; `good` is created.
- `kubectl get validatingadmissionpolicy,validatingadmissionpolicybinding` lists both objects.

:::hint
CEL macros: `list.all(x, predicate)`, `string.endsWith()`, `string.contains()`, `has(obj.field)`, `'key' in map`. Guard nested optional fields with `has()` before reading them. The pod template lives at `object.spec.template.spec`.
:::

:::solution
```yaml
# vap.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: image-and-limits
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets", "daemonsets"]
  validations:
    - expression: >-
        object.spec.template.spec.containers.all(c,
          c.image.contains(':') && !c.image.endsWith(':latest'))
      message: "Images must have an explicit tag that is not :latest."
    - expression: >-
        object.spec.template.spec.containers.all(c,
          has(c.resources) && has(c.resources.limits) && 'memory' in c.resources.limits)
      message: "Every container must set resources.limits.memory."
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: image-and-limits
spec:
  policyName: image-and-limits
  validationActions: ["Warn"]      # step 4: change to ["Deny"] and re-apply
  matchResources:
    namespaceSelector:
      matchLabels:
        policy.shipit.dev/enforce: "true"
```

```yaml
# good.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: good
  namespace: team-a
  labels: { team: payments }
spec:
  replicas: 1
  selector:
    matchLabels: { app: good }
  template:
    metadata:
      labels: { app: good }
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
```

Known gap: `c.image.contains(':')` is fooled by a registry port (`localhost:5001/app` has a colon but no tag). A stricter rule checks the part after the last `/`, or requires digests (`c.image.contains('@sha256:')`).

Optional Kyverno policy:

```yaml
apiVersion: policies.kyverno.io/v1
kind: ValidatingPolicy
metadata:
  name: require-team-label
spec:
  validationActions: ["Deny"]
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
  validations:
    - expression: "'team' in object.metadata.?labels.orValue({})"
      message: "Deployments need a 'team' label."
```

If your Kyverno version rejects `policies.kyverno.io/v1`, run `kubectl api-resources | grep -i validatingpolic` to see the served version. Remove Kyverno afterwards with `helm uninstall kyverno -n kyverno` (its webhooks otherwise affect later labs).
:::

### Clean up

```bash
kubectl delete -f vap.yaml; kubectl delete ns team-a; kubectl delete deploy elsewhere -n default
```

## Lab 6: Challenge — lock down a namespace end to end

:::meta
difficulty: hard
time: 60 min
:::

**Goal:** apply everything from this module to one namespace. No step-by-step: write the manifests yourself, then check them against the solution.

### Requirements

Namespace `bank` runs two workloads:

- `frontend`: `nginxinc/nginx-unprivileged:1.27-alpine` on port 8080, Service `frontend:80 → 8080`, 2 replicas.
- `ledger`: `hashicorp/http-echo:1.0` with args `-text=ledger-ok -listen=:5678`, Service `ledger:5678`, 1 replica.

Security requirements:

1. `bank` enforces Pod Security `restricted` (latest). Both workloads run with read-only root filesystems.
2. Each workload has its own ServiceAccount; neither gets an API token mounted.
3. Network: default deny ingress and egress. Allowed: DNS for all pods; `frontend` → `ledger:5678`; anyone in any namespace → `frontend:8080`. Nothing else may reach `ledger`.
4. RBAC: group `auditors` can view everything in `bank` **except Secrets**, and can read pod logs. User `ops-bot` (a ServiceAccount `ops-bot` in `bank`) can only restart Deployments in `bank` (`kubectl rollout restart` needs `patch` on deployments).
5. Admission: in `bank`, images with `:latest` or no tag are denied.

### Verify

```bash
kubectl -n bank get pods                                     # all Running
kubectl -n bank exec deploy/frontend -- sh -c 'wget -qO- -T 3 http://ledger:5678'   # ledger-ok
kubectl run t --rm -i --restart=Never --image=curlimages/curl -- curl -s -m 3 http://frontend.bank   # nginx HTML
kubectl run t --rm -i --restart=Never --image=curlimages/curl -- curl -s -m 3 http://ledger.bank:5678 || echo BLOCKED
kubectl auth can-i get secrets -n bank --as alice --as-group auditors       # no
kubectl auth can-i get pods --subresource=log -n bank --as alice --as-group auditors   # yes
kubectl auth can-i patch deployments -n bank --as system:serviceaccount:bank:ops-bot  # yes
kubectl auth can-i delete deployments -n bank --as system:serviceaccount:bank:ops-bot # no
kubectl -n bank create deployment x --image=nginx            # denied
```

:::hint
`frontend` needs egress to `ledger` and to DNS; `ledger` needs ingress from `frontend` only. `http-echo` has no user configured (runs as root by default) but does not need root: give it `runAsUser: 65532`. Do not use the built-in `view` role for auditors if you are unsure what it includes: write a small ClusterRole and bind it with a RoleBinding.
:::

:::solution
```yaml
# bank.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: bank
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    policy.shipit.dev/enforce: "true"
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: frontend, namespace: bank }
automountServiceAccountToken: false
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: ledger, namespace: bank }
automountServiceAccountToken: false
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: ops-bot, namespace: bank }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: frontend, namespace: bank }
spec:
  replicas: 2
  selector: { matchLabels: { app: frontend } }
  template:
    metadata: { labels: { app: frontend } }
    spec:
      serviceAccountName: frontend
      securityContext:
        runAsNonRoot: true
        runAsUser: 101
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: nginx
          image: nginxinc/nginx-unprivileged:1.27-alpine
          ports: [{ containerPort: 8080 }]
          resources:
            requests: { cpu: 50m, memory: 32Mi }
            limits: { memory: 64Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      volumes: [{ name: tmp, emptyDir: {} }]
---
apiVersion: v1
kind: Service
metadata: { name: frontend, namespace: bank }
spec:
  selector: { app: frontend }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: ledger, namespace: bank }
spec:
  replicas: 1
  selector: { matchLabels: { app: ledger } }
  template:
    metadata: { labels: { app: ledger } }
    spec:
      serviceAccountName: ledger
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: echo
          image: hashicorp/http-echo:1.0
          args: ["-text=ledger-ok", "-listen=:5678"]
          ports: [{ containerPort: 5678 }]
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
---
apiVersion: v1
kind: Service
metadata: { name: ledger, namespace: bank }
spec:
  selector: { app: ledger }
  ports: [{ port: 5678, targetPort: 5678 }]
---
# ---------- NetworkPolicies ----------
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-all, namespace: bank }
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-dns, namespace: bank }
spec:
  podSelector: {}
  policyTypes: ["Egress"]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: frontend-ingress-any, namespace: bank }
spec:
  podSelector: { matchLabels: { app: frontend } }
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector: {}      # any pod in any namespace
      ports: [{ protocol: TCP, port: 8080 }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: frontend-egress-ledger, namespace: bank }
spec:
  podSelector: { matchLabels: { app: frontend } }
  policyTypes: ["Egress"]
  egress:
    - to: [{ podSelector: { matchLabels: { app: ledger } } }]
      ports: [{ protocol: TCP, port: 5678 }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: ledger-ingress-frontend, namespace: bank }
spec:
  podSelector: { matchLabels: { app: ledger } }
  policyTypes: ["Ingress"]
  ingress:
    - from: [{ podSelector: { matchLabels: { app: frontend } } }]
      ports: [{ protocol: TCP, port: 5678 }]
---
# ---------- RBAC ----------
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: auditor-no-secrets }
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services", "endpoints", "configmaps", "serviceaccounts", "events", "persistentvolumeclaims"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "rolebindings"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: auditors, namespace: bank }
subjects: [{ kind: Group, name: auditors, apiGroup: rbac.authorization.k8s.io }]
roleRef: { kind: ClusterRole, name: auditor-no-secrets, apiGroup: rbac.authorization.k8s.io }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: deployment-restarter, namespace: bank }
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ops-bot-restarter, namespace: bank }
subjects: [{ kind: ServiceAccount, name: ops-bot, namespace: bank }]
roleRef: { kind: Role, name: deployment-restarter, apiGroup: rbac.authorization.k8s.io }
```

For requirement 5, reuse the policy from Lab 5 with the binding in `Deny` mode; the namespace already carries `policy.shipit.dev/enforce: "true"`:

```bash
kubectl apply -f vap.yaml          # from Lab 5, with validationActions: ["Deny"]
kubectl apply -f bank.yaml
kubectl -n bank rollout status deploy/frontend && kubectl -n bank rollout status deploy/ledger
```

Note: the built-in `view` ClusterRole also excludes Secrets, so `--clusterrole=view` would have satisfied requirement 4 too; writing your own makes the intent explicit and survives aggregation surprises from CRDs.
:::

### Clean up

```bash
kubectl delete ns bank
kubectl delete clusterrole auditor-no-secrets
kubectl delete -f vap.yaml --ignore-not-found
kind delete cluster --name sec     # when you are done with the module
```
