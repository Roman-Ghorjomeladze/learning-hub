Kubernetes security is not one feature. It is a set of layers, each answering a different question. If you keep the questions straight, the dozens of objects in this module fall into place:

| Question | Mechanism |
| --- | --- |
| Who are you? | Authentication (certs, OIDC tokens, ServiceAccount tokens) |
| Are you allowed to do this API call? | Authorization (RBAC) |
| Is this object acceptable? | Admission control (Pod Security Admission, ValidatingAdmissionPolicy, Kyverno, Gatekeeper) |
| What can the process do on the node? | `securityContext`, seccomp, capabilities, Linux user |
| Who can talk to whom on the network? | NetworkPolicy |
| Can I trust this image? | Registry controls, scanning, signing, digests |
| What can the pod do in the cloud? | IRSA / EKS Pod Identity |

## The API request path

Every `kubectl` command, every controller and every pod talking to the API goes through the same pipeline in the kube-apiserver:

```text
 request ──► Authentication ──► Authorization ──► Mutating admission ──► Schema validation ──► Validating admission ──► etcd
             "who are you?"      "may you?"        (webhooks, MAP,        (OpenAPI)             (PSA, VAP, webhooks:
             certs, tokens,      RBAC, Node,        defaulting)                                  Kyverno, Gatekeeper)
             OIDC                webhook
                 │                   │                                                              │
               401                 403                                                       rejected with message
```

- **Authentication** turns the request into a username, a UID and a list of groups. Kubernetes has no `User` object. Users are just strings asserted by something the API server trusts: a client certificate signed by the cluster CA (CN = username, O = groups), an OIDC token from your identity provider, or a cloud-specific token (on EKS, an IAM identity mapped through access entries).
- **Authorization** asks: can `username` / `groups` perform `verb` on `resource` in `namespace`? On almost every cluster this is RBAC (plus the Node authorizer for kubelets).
- **Admission** sees the full object. Mutating admission can change it (inject sidecars, add defaults); validating admission can only accept or reject.

A 401 means authentication failed. A 403 means you are known but not allowed. A rejection with a policy message means admission said no. Knowing which stage failed tells you where to look.

:::try Who am I?
Run `kubectl auth whoami`. On kind you are `kubernetes-admin` in group `kubeadm:cluster-admins` (or `system:masters` on older versions). That group is bound to `cluster-admin`, which is why everything works. Now look at how: `kubectl get clusterrolebinding -o wide | grep cluster-admin`.
:::

## Users vs ServiceAccounts

| | Human user | ServiceAccount |
| --- | --- | --- |
| Kubernetes object? | No | Yes, namespaced (`kubectl get sa`) |
| Identity string | whatever the authenticator says (`jane`, `jane@corp.com`) | `system:serviceaccount:<ns>:<name>` |
| Groups | from cert O= or OIDC claims | `system:serviceaccounts`, `system:serviceaccounts:<ns>` |
| Credential | client cert, OIDC token | short-lived JWT issued by the API server |
| Meant for | people, CI systems outside the cluster | workloads inside the cluster (and sometimes CI) |

Every namespace gets a `default` ServiceAccount, and every pod runs as a ServiceAccount (`default` unless you set `spec.serviceAccountName`). The `default` SA has no RBAC permissions beyond basic discovery, which is good. The anti-pattern is granting permissions to `default`, because every pod in the namespace inherits them.

:::tip
In production, humans should authenticate through OIDC (your SSO) or the cloud provider's IAM, never with long-lived client certificates. Certificates cannot be revoked individually; if a cert leaks, it is valid until it expires.
:::

## RBAC

RBAC has four objects. Two define permissions, two grant them:

```text
              defines permissions                     grants them to subjects
  namespaced  Role         ── referenced by ──►  RoleBinding         (users, groups, ServiceAccounts)
  cluster     ClusterRole  ── referenced by ──►  ClusterRoleBinding
                    │
                    └──── can ALSO be referenced by a RoleBinding → permissions apply only in that namespace
```

RBAC is **purely additive**. There are no deny rules. A subject's permissions are the union of every binding that mentions it (directly or via a group). If nothing grants a permission, it is denied.

A Role lists rules made of API groups, resources and verbs:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: dev
rules:
  - apiGroups: [""]              # "" = core group (pods, services, configmaps, secrets...)
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "patch"]
    # resourceNames: ["shipit-api"]   # optionally restrict to named objects
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: jane-pod-reader
  namespace: dev
subjects:
  - kind: User
    name: jane
    apiGroup: rbac.authorization.k8s.io
  - kind: ServiceAccount
    name: ci-deployer
    namespace: dev
roleRef:                          # immutable: to change it, delete and recreate the binding
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

Things that trip people up:

- **Subresources are separate resources.** `pods/log`, `pods/exec`, `pods/portforward`, `deployments/scale` must be listed explicitly. `kubectl exec` needs `create` on `pods/exec`.
- **`list` reveals content.** Listing Secrets returns their data. "Read-only" access to Secrets is full access to their values.
- **Use a ClusterRole + RoleBinding for reusable roles.** Define `app-operator` once as a ClusterRole, then bind it per namespace with RoleBindings. The built-in `view`, `edit`, `admin` and `cluster-admin` ClusterRoles exist for exactly this.
- **Escalation-prone verbs:** `escalate`, `bind`, `impersonate`, `create` on `pods` (a pod can mount any Secret in its namespace and run as any SA there), `create` on `serviceaccounts/token`, wildcards (`*`). Treat these as admin-equivalent.

### Testing permissions: `kubectl auth can-i`

```bash
kubectl auth can-i create deployments -n dev                       # me
kubectl auth can-i list secrets -n dev --as jane                   # impersonate a user
kubectl auth can-i get pods -n dev --as jane --as-group dev-team   # with a group
kubectl auth can-i '*' '*' --as system:serviceaccount:dev:ci-deployer   # SA wildcard check
kubectl auth can-i --list -n dev --as system:serviceaccount:dev:ci-deployer
kubectl auth reconcile -f rbac.yaml                                # apply RBAC safely (creates/updates rules)
```

Impersonation (`--as`) itself requires the `impersonate` verb, which you have as cluster-admin. It is the fastest way to test a policy before handing it to someone.

:::try can-i
Create a namespace and SA: `kubectl create ns dev && kubectl -n dev create sa ci`. Ask `kubectl auth can-i list pods -n dev --as system:serviceaccount:dev:ci` (expect `no`). Then `kubectl -n dev create rolebinding ci-view --clusterrole=view --serviceaccount=dev:ci` and ask again. Finally check `... can-i get secrets ...`: the built-in `view` role deliberately excludes Secrets.
:::

:::mac openssl and base64 on macOS
macOS ships LibreSSL as `openssl`; it is fine for generating keys and CSRs in the labs. macOS `base64` does not wrap lines and decodes with `-d` (older releases used `-D`). When you embed a CSR in YAML, pipe through `tr -d '\n'` so the command works identically on macOS and Linux.
:::

### Least privilege in practice

- Start from zero and add rules until the workload works. Use `kubectl auth can-i --list` and API server audit logs (or 403 errors in the app logs) to find what is missing.
- Prefer namespace-scoped Roles. Cluster-scoped grants are for cluster-level tools (ingress/gateway controllers, operators, monitoring).
- Most application pods need **no** API access at all. Give them a dedicated SA with no bindings and turn token mounting off.
- CI/CD deployers: one SA per environment/namespace with `edit`-like rights in that namespace only. With GitOps (module 12), CI needs no cluster credentials at all.

:::deep How aggregated ClusterRoles work
The built-in `admin`, `edit` and `view` roles are **aggregated**: their rules are assembled by a controller from every ClusterRole carrying a label such as `rbac.authorization.k8s.io/aggregate-to-edit: "true"`. When you install a CRD (say, Argo CD `Application`), the operator can ship a small ClusterRole with that label, and everyone who already has `edit` automatically gains rights on the new resource type. You can see this with `kubectl get clusterrole edit -o yaml`: the `aggregationRule` block lists label selectors, and `rules` is filled in by the controller (any manual edit to `rules` is overwritten).
:::

## ServiceAccount tokens

Since Kubernetes 1.24 the API server no longer creates a long-lived token Secret for each ServiceAccount. Instead pods get **bound, projected tokens**:

```text
kubelet ──TokenRequest API──► kube-apiserver
   │        (sa, audience, expiry, bound to THIS pod)
   ▼
/var/run/secrets/kubernetes.io/serviceaccount/
   token      ← JWT, short-lived, rotated by kubelet before expiry
   ca.crt     ← cluster CA to verify the API server
   namespace  ← the pod's namespace
```

- **Bound**: the token references the pod (and node). Delete the pod and the token becomes invalid, even before it expires.
- **Time-limited**: kubelet requests a token and refreshes it automatically. Client libraries (including `@kubernetes/client-node`) re-read the file; do not cache the token forever in your app.
- **Audience-scoped**: a token for audience `vault` or `sts.amazonaws.com` is not accepted by the API server and vice versa.

You can mint one yourself:

```bash
kubectl -n dev create token ci --duration 10m
kubectl -n dev create token ci --audience vault
```

If you truly need a non-expiring token (for an old external system), create a Secret of type `kubernetes.io/service-account-token` with the annotation `kubernetes.io/service-account.name`. Avoid it when you can.

### Turn off what you do not use

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: shipit-api
  namespace: shipit
automountServiceAccountToken: false     # default for all pods using this SA
---
# or per pod:
spec:
  serviceAccountName: shipit-api
  automountServiceAccountToken: false
```

A NestJS or Express API that only talks to Postgres and Redis has no reason to carry an API credential. If an attacker gets remote code execution in your container, the mounted token is the first thing they look for.

You can also project extra tokens with a custom audience and expiry, for example for Vault or a service mesh:

```yaml
volumes:
  - name: vault-token
    projected:
      sources:
        - serviceAccountToken:
            audience: vault
            expirationSeconds: 3600
            path: token
```

## Pod hardening with securityContext

Containers are processes on a shared kernel. `securityContext` controls the Linux-level privileges of those processes. Settings exist at pod level (apply to all containers) and container level (override).

```yaml
spec:
  securityContext:                    # pod level
    runAsNonRoot: true                # kubelet refuses to start a container whose user is 0
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000                     # group ownership for mounted volumes that support it
    seccompProfile:
      type: RuntimeDefault            # container runtime's default syscall filter
  containers:
    - name: api
      image: shipit-api:1.0.0
      securityContext:                # container level
        allowPrivilegeEscalation: false   # no setuid/sudo tricks (sets no_new_privs)
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
          # add: ["NET_BIND_SERVICE"]     # only if you must bind <1024 as non-root
      volumeMounts:
        - name: tmp
          mountPath: /tmp             # writable scratch space
  volumes:
    - name: tmp
      emptyDir: {}
```

What each setting buys you:

| Setting | Protects against |
| --- | --- |
| `runAsNonRoot` / `runAsUser` | Root in the container is root on the kernel (namespaced, but still the strongest starting point for an escape). |
| `allowPrivilegeEscalation: false` | setuid binaries and similar raising privileges after start. |
| `capabilities.drop: [ALL]` | Default capabilities like `NET_RAW` (packet spoofing), `CHOWN`, `SETUID`. |
| `readOnlyRootFilesystem` | Attackers dropping binaries or modifying app code at runtime. |
| `seccompProfile: RuntimeDefault` | Blocks rarely needed, often exploited syscalls. |
| `privileged: true` (never) | Gives the container almost full host access. |
| `hostNetwork`, `hostPID`, `hostPath` | Break the isolation boundary; reserved for node agents (CNI, log shippers). |

:::warning runAsNonRoot and non-numeric users
A Dockerfile with `USER node` sets a **name**, not a UID. With `runAsNonRoot: true` and no `runAsUser`, the kubelet cannot prove `node` is not root and fails the container with `CreateContainerConfigError: container has runAsNonRoot and image has non-numeric user (node), cannot verify user is non-root`. Fix it with `USER 1000` in the Dockerfile (the `node` user in official Node images is UID 1000) or set `runAsUser: 1000` in the pod spec.
:::

:::warning readOnlyRootFilesystem breaks naive images
Many images write to `/tmp`, `/var/cache/nginx`, `/var/run`, or their own directories. Mount an `emptyDir` on each path that needs to be writable. The stock `nginx` image also wants to run as root and bind port 80: use `nginxinc/nginx-unprivileged` (UID 101, port 8080) instead.
:::

## Pod Security Standards and Pod Security Admission

Writing a perfect `securityContext` in every manifest is a discipline problem. **Pod Security Admission (PSA)** is a built-in admission controller that enforces the **Pod Security Standards**, three predefined levels:

| Level | Meaning |
| --- | --- |
| `privileged` | No restrictions. For system namespaces (CNI, storage drivers). |
| `baseline` | Blocks known privilege escalations: privileged containers, host namespaces, hostPath, adding dangerous capabilities. Most unmodified images pass. |
| `restricted` | Current hardening best practice: must run as non-root, drop ALL capabilities, `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault`/`Localhost`, limited volume types. |

You opt in per namespace with labels, in three modes:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: shipit
  labels:
    pod-security.kubernetes.io/enforce: restricted     # reject violating pods
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted        # warning shown to kubectl users
    pod-security.kubernetes.io/audit: restricted       # annotation in audit log
```

```bash
# Dry-run a label change against existing pods before enforcing it
kubectl label --dry-run=server --overwrite ns shipit pod-security.kubernetes.io/enforce=restricted
```

:::warning Deployments are admitted, pods are not
PSA checks **pods**. A Deployment with a non-compliant template is accepted (you get a warning), but its ReplicaSet fails to create pods. `kubectl get pods` shows nothing. The error is in `kubectl describe rs <name>` events: `pods "web-..." is forbidden: violates PodSecurity "restricted:latest": ...`. When "my Deployment has zero pods", always describe the ReplicaSet.
:::

A good rollout: label every namespace with `warn` and `audit` at `restricted`, fix workloads, then flip `enforce` to `baseline` and finally `restricted`. Keep `privileged` only for namespaces that run node agents.

## NetworkPolicies

By default, every pod can reach every other pod in the cluster, across namespaces. A NetworkPolicy selects pods and declares which traffic is allowed to (ingress) or from (egress) them. Rules:

1. Pods not selected by any policy: everything allowed.
2. Once a pod is selected by a policy for a direction (Ingress/Egress), only traffic explicitly allowed by some policy is permitted in that direction.
3. Policies are additive (union). There is no "deny" rule in the core API.
4. Replies to allowed connections are automatically allowed (stateful).
5. **Enforcement is done by the CNI plugin.** If the CNI does not implement NetworkPolicy, the objects are accepted and silently ignored.

:::info NetworkPolicy on kind
kind's default CNI, **kindnet**, has enforced NetworkPolicy out of the box since kind v0.24 (it embeds `kube-network-policies`). Check with `kind version`. On older kind versions, or if you want features such as Calico's `GlobalNetworkPolicy` or Cilium's L7 policies, create the cluster with `networking.disableDefaultCNI: true` and install Calico or Cilium. Always test enforcement with a real connection attempt rather than trusting that the object exists.
:::

The standard pattern is **default deny, then allow**:

```yaml
# 1. Deny all ingress and egress for every pod in the namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: shipit
spec:
  podSelector: {}               # all pods in the namespace
  policyTypes: ["Ingress", "Egress"]
---
# 2. Everyone may resolve DNS
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: shipit
spec:
  podSelector: {}
  policyTypes: ["Egress"]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
---
# 3. Only the API may reach Postgres
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgres-from-api
  namespace: shipit
spec:
  podSelector:
    matchLabels: { app: postgres }
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: shipit-api }
      ports:
        - { protocol: TCP, port: 5432 }
```

Remember that the API also needs an **egress** rule to Postgres, because default-deny covers egress too. Each connection must be allowed on both ends if both pods are covered by egress/ingress policies.

:::warning The AND/OR trap
In a `from` list, **separate items are OR'ed**; selectors **inside one item are AND'ed**:

```yaml
from:
  - namespaceSelector: { matchLabels: { team: web } }   # item 1
  - podSelector: { matchLabels: { app: gateway } }       # item 2 → OR: any pod in team:web namespaces, OR app=gateway in THIS namespace
from:
  - namespaceSelector: { matchLabels: { team: web } }
    podSelector: { matchLabels: { app: gateway } }       # one item → AND: app=gateway pods inside team:web namespaces
```
One dash makes the difference between "tight" and "wide open".
:::

Other details: `namespaceSelector` uses namespace labels, and every namespace automatically has `kubernetes.io/metadata.name: <name>`. Policies match pod IPs, so traffic through a Service is evaluated against the backing pods, and `ipBlock` is meant for traffic leaving or entering the cluster, not for pod IPs. Traffic from a Gateway or ingress controller comes from the controller's pods, so allow its namespace.

## Admission control and policy engines

PSA covers pod security. Everything else your organisation cares about ("images must come from our ECR", "every Deployment needs resource limits and an `owner` label", "no `:latest` tags", "Services of type LoadBalancer only in namespace X") needs a policy engine. Options:

| | ValidatingAdmissionPolicy (VAP) | Kyverno | OPA Gatekeeper |
| --- | --- | --- | --- |
| Where it runs | Inside kube-apiserver | Webhook + controllers | Webhook + controllers |
| Language | CEL expressions | YAML policies with CEL (new `ValidatingPolicy` etc.) or classic pattern syntax | Rego (`ConstraintTemplate` + `Constraint`) |
| Validate | Yes | Yes | Yes |
| Mutate | `MutatingAdmissionPolicy` (newer, check your version) | Yes | Yes (assign/modify) |
| Generate resources | No | Yes (e.g. default NetworkPolicy per namespace) | No |
| Verify image signatures | No | Yes (cosign/notary) | Via external data |
| Background audit reports | No (audit annotations only) | Yes (PolicyReports) | Yes (audit) |
| Extra moving parts | None | A few deployments | A few deployments |

Webhook-based engines add latency and a failure mode: if the webhook is down and `failurePolicy: Fail`, nobody can create pods. VAP runs in-process, so it has no availability risk, which makes it the default choice for simple validation rules.

A VAP is two objects: the policy (what to check) and the binding (where, and what to do on failure):

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-limits-no-latest
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets"]
  validations:
    - expression: >-
        object.spec.template.spec.containers.all(c,
          !c.image.endsWith(':latest') && c.image.contains(':'))
      message: "Use an explicit image tag (not :latest)."
    - expression: >-
        object.spec.template.spec.containers.all(c,
          has(c.resources) && has(c.resources.limits) && 'memory' in c.resources.limits)
      message: "Every container needs a memory limit."
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-limits-no-latest
spec:
  policyName: require-limits-no-latest
  validationActions: ["Deny"]          # or ["Warn"], ["Audit"] while rolling out
  matchResources:
    namespaceSelector:
      matchLabels:
        policy.shipit.dev/enforce: "true"
```

Kyverno's modern policy types use the same CEL shape, adding features VAP lacks (reports, generate, image verification):

```yaml
apiVersion: policies.kyverno.io/v1      # older Kyverno releases: v1alpha1/v1beta1; check `kubectl api-resources | grep kyverno`
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

You will still meet Kyverno's classic `ClusterPolicy` (`kyverno.io/v1`, pattern-based YAML) in many repos; it is now marked deprecated in favour of the CEL-based types. Gatekeeper is common in organisations that already use OPA/Rego elsewhere.

:::deep Webhook admission and why it can take down a cluster
A validating or mutating **webhook** is an HTTPS service (usually in the cluster) that the API server calls for matching requests. If it is slow, every matching API call is slow. If it is down and its `failurePolicy` is `Fail`, matching requests fail. Classic outage: a webhook matching **all pods in all namespaces**, including `kube-system`, whose own pods cannot be recreated because the webhook that must approve them is not running. Mitigations: exclude `kube-system` and the engine's own namespace with `namespaceSelector`, run the engine with multiple replicas and a PDB, set `timeoutSeconds` low, and consider `failurePolicy: Ignore` for non-critical rules. VAP avoids this class of problem entirely.
:::

## Image security

The image is code you run with your app's credentials. Controls, from cheapest to strongest:

1. **Minimal base images**: distroless, Chainguard/Wolfi, or Alpine/slim. Fewer packages, fewer CVEs, often no shell.
2. **Pin versions, ideally by digest**: `ghcr.io/acme/shipit-api:1.4.2@sha256:...`. Tags are mutable; digests are not.
3. **Scan** in CI and in the registry: Trivy, Grype, Amazon ECR scanning, Docker Scout. Fail builds on critical, fixable CVEs.
4. **Restrict registries** with admission policy (`image.startsWith('123456789012.dkr.ecr.eu-central-1.amazonaws.com/')`).
5. **Sign and verify**: sign images in CI with Sigstore `cosign` (keyless via OIDC) and verify signatures at admission with Kyverno or the Sigstore policy-controller.
6. **SBOM and provenance**: BuildKit can attach SBOM and SLSA provenance attestations (`docker buildx build --sbom=true --provenance=true`).
7. **Private registries**: `imagePullSecrets` on the pod or, better, on the ServiceAccount. On EKS, nodes pull from ECR via the node IAM role.

## Cloud identity: IRSA and EKS Pod Identity

Your shipit-api on EKS needs to read from S3 or SQS. The wrong answer is putting AWS access keys in a Secret or giving the node role broad permissions (every pod on the node then has them). The right answer is mapping a **Kubernetes ServiceAccount to an IAM role**:

```text
IRSA (IAM Roles for Service Accounts)              EKS Pod Identity (newer, simpler)
──────────────────────────────────────            ─────────────────────────────────────
cluster OIDC issuer registered in IAM              eks-pod-identity-agent add-on on nodes
IAM role trust policy trusts that OIDC             IAM role trusts pods.eks.amazonaws.com
  provider + "system:serviceaccount:ns:sa"         association: (cluster, ns, sa) → role
SA annotated eks.amazonaws.com/role-arn            no SA annotation needed
pod gets projected token (aud sts.amazonaws.com)   pod gets creds from the local agent
SDK calls AssumeRoleWithWebIdentity                SDK uses container credentials endpoint
```

Both give each workload its own short-lived AWS credentials, picked up automatically by the AWS SDK for JavaScript v3 default credential chain. Pod Identity avoids per-cluster OIDC setup and trust-policy edits, so it is the default for new EKS clusters; IRSA is still everywhere and works outside EKS-managed setups. GKE (Workload Identity Federation) and AKS (Microsoft Entra Workload ID) have equivalents. Module 14 returns to EKS.

## Production checklist

- Humans via SSO/OIDC or cloud IAM; no shared admin kubeconfigs; `cluster-admin` for a break-glass group only.
- One ServiceAccount per workload; `automountServiceAccountToken: false` unless it calls the API; no permissions on `default`.
- RBAC reviewed for `secrets`, `pods/exec`, `create pods`, `bind`, `escalate`, `impersonate`, wildcards.
- Every app namespace labelled with PSA `restricted` (enforce), system namespaces documented exceptions.
- Default-deny NetworkPolicy per namespace plus explicit allows, including DNS egress.
- Admission policies for registries, tags, limits, labels, rolled out `Warn` → `Deny`.
- Images: minimal, scanned, pinned by digest, signed; pulled only from approved registries.
- Secrets encrypted at rest (KMS on managed clusters), external secret store where possible (module 07).
- Audit logging enabled and shipped somewhere you can search.
