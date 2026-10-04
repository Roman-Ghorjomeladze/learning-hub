You cannot practise EKS upgrades or Karpenter on a laptop for free, but you can practise everything around them: tenant namespaces, drains and disruption budgets, readiness reviews, and extending the API. One multi-node kind cluster serves all labs:

```bash
cat > kind-prod.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --name prod-sim --config kind-prod.yaml
mkdir -p ~/k8s-prod && cd ~/k8s-prod
brew install jq     # used by Lab 3
```

When finished: `kind delete cluster --name prod-sim`.

## Lab 1: A tenant namespace kit

:::meta
difficulty: easy
time: 25 min
:::

**Goal:** give team "payments" a namespace with guardrails: Pod Security, quota, default resources, team RBAC and default-deny networking. Then prove each guardrail works.

### Steps

1. Write `tenant-payments.yaml` with:
   - Namespace `team-payments`, labels `team: payments` and PSA `enforce: baseline`, `warn: restricted`.
   - ResourceQuota `team-quota`: `requests.cpu: "2"`, `requests.memory: 2Gi`, `limits.memory: 4Gi`, `pods: "10"`, `services.loadbalancers: "0"`.
   - LimitRange `defaults`: container default request `cpu: 100m, memory: 128Mi`, default limit `memory: 256Mi`, max `memory: 1Gi`.
   - RoleBinding `payments-devs-edit`: group `payments-devs` → ClusterRole `edit`.
   - NetworkPolicies: default deny ingress, and allow ingress from any pod in the same namespace.

2. Apply and test:

```bash
kubectl apply -f tenant-payments.yaml

# defaults are injected into pods that omit resources
kubectl -n team-payments run probe --image=nginx:1.27
kubectl -n team-payments get pod probe -o jsonpath='{.spec.containers[0].resources}'; echo

# quota accounting
kubectl -n team-payments describe quota team-quota

# too much: 12 replicas x 100m CPU exceeds pods=10 and/or requests.cpu
kubectl -n team-payments create deployment burst --image=nginx:1.27 --replicas=12
sleep 5; kubectl -n team-payments get deploy burst
kubectl -n team-payments describe rs -l app=burst | grep -m2 -i quota

# no LoadBalancer Services for tenants
kubectl -n team-payments expose deployment burst --port 80 --type LoadBalancer

# a container asking for more than the max
kubectl -n team-payments run huge --image=nginx:1.27 --overrides='{"spec":{"containers":[{"name":"huge","image":"nginx:1.27","resources":{"limits":{"memory":"2Gi"}}}]}}'

# RBAC as a team member
kubectl auth can-i create deployments -n team-payments --as dev1 --as-group payments-devs
kubectl auth can-i create deployments -n default       --as dev1 --as-group payments-devs
```

### Verify

- `probe` shows `requests: {cpu: 100m, memory: 128Mi}` and `limits: {memory: 256Mi}` although you did not set them.
- `burst` stays below 12 ready replicas and the ReplicaSet events mention `exceeded quota`.
- The LoadBalancer Service is rejected: `exceeded quota: team-quota, requested: services.loadbalancers=1`.
- `huge` is rejected: `maximum memory usage per Container is 1Gi`.
- `can-i` answers `yes` in `team-payments`, `no` in `default`.

:::hint
LimitRange `default` is the default **limit**, `defaultRequest` the default **request**. Quotas on `requests.cpu` force every pod in the namespace to declare a CPU request, which is why the LimitRange defaults matter: without them, pods without requests would be rejected outright.
:::

:::solution
```yaml
# tenant-payments.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments
  labels:
    team: payments
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: ResourceQuota
metadata: { name: team-quota, namespace: team-payments }
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 2Gi
    limits.memory: 4Gi
    pods: "10"
    services.loadbalancers: "0"
---
apiVersion: v1
kind: LimitRange
metadata: { name: defaults, namespace: team-payments }
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 128Mi }
      default: { memory: 256Mi }
      max: { memory: 1Gi }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: payments-devs-edit, namespace: team-payments }
subjects:
  - { kind: Group, name: payments-devs, apiGroup: rbac.authorization.k8s.io }
roleRef: { kind: ClusterRole, name: edit, apiGroup: rbac.authorization.k8s.io }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-ingress, namespace: team-payments }
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-same-namespace, namespace: team-payments }
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector: {}
```

With 2 CPU of requests and 100m per pod, the CPU quota would allow 20 pods, so the `pods: "10"` limit is what stops `burst` (one slot is used by `probe`). In a real platform you would render this kit from a template for each team (Helm chart, Kustomize component, or a Kyverno generate rule that fires when a namespace with a `team` label is created).
:::

### Clean up

```bash
kubectl delete ns team-payments
```

## Lab 2: Your first CustomResourceDefinition

:::meta
difficulty: medium
time: 25 min
:::

**Goal:** add a `StaticSite` resource type to the cluster with schema validation, defaults, CEL rules, printer columns, a short name and a status subresource, and see how much the API server does for you before any controller exists.

### Steps

1. Apply the CRD:

```bash
cat > staticsite-crd.yaml <<'EOF'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: staticsites.web.shipit.dev
spec:
  group: web.shipit.dev
  scope: Namespaced
  names:
    kind: StaticSite
    plural: staticsites
    singular: staticsite
    shortNames: ["site"]
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      additionalPrinterColumns:
        - { name: Message, type: string, jsonPath: .spec.message }
        - { name: Replicas, type: integer, jsonPath: .spec.replicas }
        - { name: Ready, type: integer, jsonPath: .status.readyReplicas }
        - { name: Age, type: date, jsonPath: .metadata.creationTimestamp }
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: ["message"]
              properties:
                message:
                  type: string
                  maxLength: 200
                  pattern: '^[A-Za-z0-9 .,!?:-]+$'
                replicas:
                  type: integer
                  minimum: 1
                  maximum: 5
                  default: 1
              x-kubernetes-validations:
                - rule: "!self.message.lowerAscii().contains('password')"
                  message: "do not put secrets in a StaticSite"
            status:
              type: object
              properties:
                readyReplicas: { type: integer }
                url: { type: string }
EOF
kubectl apply -f staticsite-crd.yaml
kubectl get crd staticsites.web.shipit.dev
kubectl api-resources --api-group=web.shipit.dev
kubectl explain staticsite.spec
```

2. Create a valid site and look at it every way you can:

```bash
cat > hello-site.yaml <<'EOF'
apiVersion: web.shipit.dev/v1alpha1
kind: StaticSite
metadata:
  name: hello
  namespace: default
spec:
  message: Hello from a custom resource!
EOF
kubectl apply -f hello-site.yaml
kubectl get site
kubectl get staticsite hello -o yaml | grep -A3 '^spec'
```

3. Try invalid objects and read the error messages:

```bash
kubectl apply -f - <<'EOF'
apiVersion: web.shipit.dev/v1alpha1
kind: StaticSite
metadata: { name: bad1 }
spec: { message: "too many", replicas: 10 }
EOF
kubectl apply -f - <<'EOF'
apiVersion: web.shipit.dev/v1alpha1
kind: StaticSite
metadata: { name: bad2 }
spec: { replicas: 2 }
EOF
kubectl apply -f - <<'EOF'
apiVersion: web.shipit.dev/v1alpha1
kind: StaticSite
metadata: { name: bad3 }
spec: { message: "my Password is hunter2" }
EOF
kubectl apply -f - <<'EOF'
apiVersion: web.shipit.dev/v1alpha1
kind: StaticSite
metadata: { name: bad4 }
spec: { message: "ok", colour: "blue" }
EOF
```

4. Try to set status through a normal update, then through the status subresource:

```bash
kubectl patch staticsite hello --type=merge -p '{"status":{"readyReplicas":3}}'
kubectl get site hello
kubectl patch staticsite hello --subresource=status --type=merge -p '{"status":{"readyReplicas":3}}'
kubectl get site hello
```

### Verify

- `kubectl get site` shows the custom columns, with `Replicas` = 1 (the default was applied).
- bad1, bad2, bad3 are rejected with messages from `maximum`, `required` and your CEL rule respectively.
- bad4 is accepted, but `kubectl get site bad4 -o yaml` shows no `colour` field (unknown fields are pruned; kubectl warns about it).
- The first status patch has no effect; the second sets `Ready` to 3.

:::hint
With a status subresource, the main endpoint ignores changes to `.status` and the `/status` endpoint ignores changes to everything else. That separation is what lets users own `spec` and controllers own `status` without overwriting each other.
:::

:::solution
The commands are the solution. Expected rejections:

```text
bad1: spec.replicas: Invalid value: 10: spec.replicas in body should be less than or equal to 5
bad2: spec.message: Required value
bad3: spec: Invalid value: "object": do not put secrets in a StaticSite
```

You now have a fully functional API type (storage, validation, RBAC via `staticsites.web.shipit.dev`, watch, kubectl support) but nothing *happens* when you create one. Behaviour comes from a controller, which you build next.

Delete the leftovers but keep the CRD and `hello` for Lab 3:

```bash
kubectl delete staticsite bad4 --ignore-not-found
```
:::

### Clean up

Keep everything for Lab 3.

## Lab 3: A tiny controller — the operator pattern in bash

:::meta
difficulty: hard
time: 40 min
:::

**Goal:** write a reconcile loop that turns each `StaticSite` into a Deployment and a Service, reports status, recreates things that drift, and lets the garbage collector clean up via owner references. It is deliberately primitive (polling, bash, `kubectl apply`) so the ideas are visible without a framework.

### Steps

1. Create the controller script:

```bash
cat > site-controller.sh <<'SCRIPT'
#!/usr/bin/env bash
# Toy controller: reconcile StaticSite -> Deployment + Service. Polls every 5 seconds.
set -uo pipefail

reconcile() {
  local site="$1"
  local ns name uid msg replicas ready
  ns=$(jq -r .metadata.namespace <<<"$site")
  name=$(jq -r .metadata.name <<<"$site")
  uid=$(jq -r .metadata.uid <<<"$site")
  msg=$(jq -r .spec.message <<<"$site")
  replicas=$(jq -r '.spec.replicas // 1' <<<"$site")

  # Desired state, applied idempotently. ownerReferences make the GC delete these with the site.
  kubectl apply -f - >/dev/null <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: site-$name
  namespace: $ns
  labels: { app.kubernetes.io/managed-by: site-controller, site: $name }
  ownerReferences:
    - { apiVersion: web.shipit.dev/v1alpha1, kind: StaticSite, name: $name, uid: $uid, controller: true, blockOwnerDeletion: true }
spec:
  replicas: $replicas
  selector: { matchLabels: { site: $name } }
  template:
    metadata: { labels: { site: $name } }
    spec:
      containers:
        - name: web
          image: hashicorp/http-echo:1.0
          args: ["-text=$msg", "-listen=:5678"]
          ports: [{ containerPort: 5678 }]
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: site-$name
  namespace: $ns
  labels: { app.kubernetes.io/managed-by: site-controller, site: $name }
  ownerReferences:
    - { apiVersion: web.shipit.dev/v1alpha1, kind: StaticSite, name: $name, uid: $uid, controller: true, blockOwnerDeletion: true }
spec:
  selector: { site: $name }
  ports: [{ port: 80, targetPort: 5678 }]
EOF

  # Observed state -> status subresource
  ready=$(kubectl -n "$ns" get deploy "site-$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  kubectl -n "$ns" patch staticsite "$name" --subresource=status --type=merge \
    -p "{\"status\":{\"readyReplicas\":${ready:-0},\"url\":\"http://site-$name.$ns.svc\"}}" >/dev/null
  echo "$(date +%T) reconciled $ns/$name replicas=$replicas ready=${ready:-0}"
}

while true; do
  kubectl get staticsites -A -o json | jq -c '.items[]' | while read -r site; do
    reconcile "$site"
  done
  sleep 5
done
SCRIPT
chmod +x site-controller.sh
```

2. Run it in a second terminal and leave it running:

```bash
cd ~/k8s-prod && ./site-controller.sh
```

3. In your first terminal, observe and interact:

```bash
kubectl get site
kubectl get deploy,svc -l site=hello
kubectl run t --rm -i --restart=Never --image=curlimages/curl -- curl -s site-hello

# change the spec: scale and new message
kubectl patch site hello --type=merge -p '{"spec":{"replicas":3,"message":"Version two"}}'
sleep 15; kubectl get site hello
kubectl run t --rm -i --restart=Never --image=curlimages/curl -- curl -s site-hello

# drift: delete what the controller owns
kubectl delete deploy site-hello
sleep 10; kubectl get deploy site-hello
```

4. Prove the loop is level-triggered: stop the controller (Ctrl-C), create a second site, wait a minute, then start the controller again.

```bash
kubectl apply -f - <<'EOF'
apiVersion: web.shipit.dev/v1alpha1
kind: StaticSite
metadata: { name: docs }
spec: { message: "Docs site", replicas: 2 }
EOF
kubectl get deploy site-docs        # NotFound while the controller is stopped
# restart ./site-controller.sh in the other terminal, then:
sleep 15; kubectl get site
```

5. Delete a site and watch garbage collection:

```bash
kubectl delete site docs
kubectl get deploy,svc -l site=docs     # gone, removed by the garbage collector, not by your script
```

### Verify

- `kubectl get site` shows `Ready` matching `Replicas` for each site.
- Deleting `site-hello` Deployment results in a new one within one loop.
- `docs` resources appear after the controller restarts, although it never saw the "create" event.
- After deleting `docs`, its Deployment and Service disappear while the controller does nothing.

:::hint
If the status never updates, check that the CRD has `subresources.status` and that `status.url` exists in the schema (fields not in the schema are pruned). If `kubectl apply` complains about ownerReferences, the `uid` must be the StaticSite's current UID.
:::

:::solution
The script above is the solution. Mapping it to real operator concepts:

| Toy controller | controller-runtime / Kubebuilder |
| --- | --- |
| `while true; sleep 5` polling | Informers watching StaticSites and owned Deployments/Services, with a work queue and periodic resync |
| `kubectl apply` of the full desired state | `CreateOrUpdate` / server-side apply in `Reconcile()` |
| `ownerReferences` in the manifest | `controllerutil.SetControllerReference(...)` |
| `kubectl patch --subresource=status` | `r.Status().Update(ctx, &site)` with `status.conditions` and `observedGeneration` |
| Messages validated by CRD `pattern` so bash quoting cannot break | Typed Go structs, no YAML string templating |
| Runs on your laptop with your admin kubeconfig | Runs as a Deployment with a ServiceAccount and a narrowly scoped ClusterRole generated from RBAC markers |

What the toy lacks: watching instead of polling (scales to thousands of objects), leader election (only one replica reconciles at a time), finalizers for external cleanup, events, metrics, backoff on errors, and conversion webhooks for new CRD versions. Kubebuilder scaffolds all of these: `kubebuilder init --domain shipit.dev && kubebuilder create api --group web --version v1alpha1 --kind StaticSite`.
:::

### Clean up

Stop the controller with Ctrl-C, then:

```bash
kubectl delete site --all
kubectl delete crd staticsites.web.shipit.dev
```

## Lab 4: Break & fix — the node drain that never finishes

:::meta
difficulty: medium
time: 30 min
:::

**Goal:** rehearse the node part of a cluster upgrade (cordon, drain, uncordon), hit the classic PodDisruptionBudget deadlock, and fix the workload so drains are safe.

### Steps

1. Check versions the way you would before an upgrade:

```bash
kubectl version
kubectl get nodes -o custom-columns=NAME:.metadata.name,KUBELET:.status.nodeInfo.kubeletVersion,OS:.status.nodeInfo.osImage
kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis | head    # empty is good
```

2. Deploy a "critical" service with a well-meaning but broken disruption setup:

```bash
cat > checkout.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: checkout }
spec:
  replicas: 1
  selector: { matchLabels: { app: checkout } }
  template:
    metadata: { labels: { app: checkout } }
    spec:
      containers:
        - name: web
          image: nginx:1.27
          resources:
            requests: { cpu: 50m, memory: 32Mi }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: checkout }
spec:
  minAvailable: 1
  selector:
    matchLabels: { app: checkout }
EOF
kubectl apply -f checkout.yaml
kubectl rollout status deploy/checkout
NODE=$(kubectl get pod -l app=checkout -o jsonpath='{.items[0].spec.nodeName}'); echo $NODE
```

3. "Upgrade" that node: drain it.

```bash
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data --timeout=60s
```

Watch the output for a minute. Then answer: why does it fail, and is `--disable-eviction` or deleting the PDB the right fix?

4. Uncordon the node, fix the workload, and drain again until it succeeds without errors. Then uncordon.

### Verify

- The second drain completes with `node/<name> drained`.
- During the drain, `kubectl get pdb checkout` shows `ALLOWED DISRUPTIONS` ≥ 1 and `kubectl get deploy checkout` never drops below 2 available.
- `kubectl get nodes` shows all nodes `Ready` (no `SchedulingDisabled`) at the end.

:::hint
`ALLOWED DISRUPTIONS` in `kubectl get pdb` is the number of pods the eviction API may remove right now. With 1 replica and `minAvailable: 1` it is always 0. You need more replicas, on different nodes, and a PDB expressed so that one pod may go at a time.
:::

:::solution
The drain loops on `error when evicting pods/"checkout-..." (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.` and finally times out. The PDB promises at least one available pod, there is only one, so eviction can never be allowed. In a managed node group upgrade, this blocks the rollout until a timeout, after which some tools force-terminate the node anyway, so you get the outage you wanted to avoid, just later.

`--disable-eviction` (delete instead of evict) or deleting the PDB "works" but throws away the protection. The real fix is the workload:

```bash
kubectl uncordon "$NODE"
cat > checkout.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: checkout }
spec:
  replicas: 3
  selector: { matchLabels: { app: checkout } }
  template:
    metadata: { labels: { app: checkout } }
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels: { app: checkout }
      containers:
        - name: web
          image: nginx:1.27
          resources:
            requests: { cpu: 50m, memory: 32Mi }
          readinessProbe:
            httpGet: { path: /, port: 80 }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: checkout }
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app: checkout }
EOF
kubectl apply -f checkout.yaml && kubectl rollout status deploy/checkout
kubectl get pods -l app=checkout -o wide        # spread over both workers
kubectl get pdb checkout                        # ALLOWED DISRUPTIONS 1
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data --timeout=120s
kubectl get pods -l app=checkout -o wide        # all on the other worker for now
kubectl uncordon "$NODE"
```

Note that after uncordoning, pods do not move back automatically; the scheduler only places new pods. A rollout restart (or the next deploy) rebalances them. Tools like the descheduler or Karpenter consolidation handle this continuously.

The readiness probe matters too: the eviction API counts only **ready** pods as available, so a replacement must become ready before the next eviction is allowed.
:::

### Clean up

```bash
kubectl delete -f checkout.yaml
```

## Lab 5: Challenge — production readiness review

:::meta
difficulty: hard
time: 50 min
:::

**Goal:** a team asks you to approve their service for production. Review it against the checklist from the lesson and rewrite it. No step-by-step; the solution shows one good answer.

### The submission

```yaml
# orders.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 1
  selector:
    matchLabels: { app: orders }
  template:
    metadata:
      labels: { app: orders }
    spec:
      containers:
        - name: orders
          image: hashicorp/http-echo:latest
          args: ["-text=orders-ok", "-listen=:5678"]
          env:
            - name: DB_PASSWORD
              value: "SuperSecret123"
---
apiVersion: v1
kind: Service
metadata:
  name: orders
spec:
  type: LoadBalancer
  selector: { app: orders }
  ports:
    - port: 80
      targetPort: 5678
```

### Requirements

Produce `orders-prod.yaml` for namespace `orders` that:

1. Pins the image to a version tag (`1.0`).
2. Runs 3 replicas spread across nodes; survives a node drain with at most one pod unavailable.
3. Sets requests and a memory limit.
4. Has readiness and liveness probes, and a short pre-stop delay so endpoints are removed before shutdown (the image has no shell, so you cannot exec `sleep`).
5. Autoscales between 3 and 6 replicas on CPU.
6. Passes Pod Security `restricted` (label the namespace with `enforce`), with a read-only root filesystem.
7. Uses its own ServiceAccount without an API token.
8. Takes the password from a Secret, not a literal.
9. Is only reachable inside the cluster (ClusterIP), and only from namespace `frontend` on the app port; everything else into `orders` is denied.
10. Carries `app.kubernetes.io/name`, `app.kubernetes.io/version` and `team` labels.

### Verify

```bash
kubectl apply -f orders-prod.yaml
kubectl -n orders rollout status deploy/orders
kubectl -n orders get deploy,hpa,pdb,svc,netpol,sa
kubectl -n orders get pods -o wide                      # spread over workers
kubectl create ns frontend --dry-run=client -o yaml | kubectl apply -f -
kubectl -n frontend run t --rm -i --restart=Never --image=curlimages/curl -- curl -s -m 3 http://orders.orders      # orders-ok
kubectl -n default  run t --rm -i --restart=Never --image=curlimages/curl -- curl -s -m 3 http://orders.orders || echo BLOCKED
kubectl drain prod-sim-worker --ignore-daemonsets --delete-emptydir-data --timeout=120s && kubectl uncordon prod-sim-worker
```

Optional: run a static checker such as `kube-score score orders-prod.yaml` (`brew install kube-score`) and compare its findings with your review.

:::hint
Kubernetes supports a native `lifecycle.preStop.sleep` action (no binary needed in the image). The HPA needs metrics-server for CPU metrics; on kind install it as in module 13 (with `--kubelet-insecure-tls`). For `restricted`, the scratch-based http-echo has no user configured: set a numeric `runAsUser`.
:::

:::solution
Findings in the original: `:latest` tag; single replica; no resources; no probes; no graceful shutdown; password in plain text in the manifest; default ServiceAccount with a token; root user and default capabilities; public LoadBalancer (cost and exposure); no PDB, HPA or NetworkPolicy; no ownership labels.

```yaml
# orders-prod.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: orders
  labels:
    team: orders
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
---
apiVersion: v1
kind: Secret
metadata: { name: orders-db, namespace: orders }
type: Opaque
stringData:
  password: change-me      # in production: created by External Secrets Operator, never committed
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: orders, namespace: orders }
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
  namespace: orders
  labels: &labels
    app.kubernetes.io/name: orders
    app.kubernetes.io/version: "1.0"
    team: orders
spec:
  selector:
    matchLabels: { app.kubernetes.io/name: orders }
  template:
    metadata:
      labels: *labels
    spec:
      serviceAccountName: orders
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: { app.kubernetes.io/name: orders }
      containers:
        - name: orders
          image: hashicorp/http-echo:1.0
          args: ["-text=orders-ok", "-listen=:5678"]
          ports:
            - { name: http, containerPort: 5678 }
          env:
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef: { name: orders-db, key: password }
          resources:
            requests: { cpu: 50m, memory: 32Mi }
            limits: { memory: 64Mi }
          readinessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
---
apiVersion: v1
kind: Service
metadata:
  name: orders
  namespace: orders
  labels: { app.kubernetes.io/name: orders, team: orders }
spec:
  type: ClusterIP
  selector: { app.kubernetes.io/name: orders }
  ports:
    - { name: http, port: 80, targetPort: http }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: orders, namespace: orders }
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app.kubernetes.io/name: orders }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: orders, namespace: orders }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: orders }
  minReplicas: 3
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-ingress, namespace: orders }
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-frontend, namespace: orders }
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/name: orders }
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: frontend }
      ports:
        - { protocol: TCP, port: 5678 }
```

Design notes:

- `replicas` is omitted because the HPA owns it (`minReplicas: 3` sets the floor). Applying the Deployment first creates 1 replica until the HPA scales it up, which takes a few seconds; in a GitOps setup that is fine. If you prefer, set `replicas: 3` for the first apply only.
- `whenUnsatisfiable: ScheduleAnyway` keeps pods schedulable when a node is drained (with `DoNotSchedule` and two workers, a drain could leave pods Pending). It is a trade-off; with three or more zones in production you would spread on `topology.kubernetes.io/zone` too.
- `preStop.sleep` gives kube-proxy and load balancers time to remove the pod from endpoints before SIGTERM, avoiding errors during rollouts. The native sleep action needs a recent Kubernetes version (enabled by default since 1.30); older clusters need an image with a `sleep` binary.
- The `&labels` / `*labels` YAML anchor reuses the label block; Kubernetes sees the expanded result.
- The liveness probe is identical to readiness here only because http-echo has no separate health endpoint. For shipit-api you would use `/healthz` for liveness and `/readyz` for readiness.
:::

### Clean up

```bash
kubectl delete ns orders frontend
kind delete cluster --name prod-sim
```
