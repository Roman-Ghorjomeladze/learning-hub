Your `shipit-api` image should be identical in dev, staging and production. What changes between environments (database URL, Redis URL, log level, feature flags, API keys) must come from outside the image. Kubernetes gives you two objects for that, **ConfigMaps** for non-sensitive data and **Secrets** for sensitive data, plus several ways to hand them to containers. This module is about choosing the right way, knowing what updates at runtime, and not fooling yourself about how "secret" a Secret is.

## The mental model: config is data in the API server

```text
                       kube-apiserver  ---- stored in ---->  etcd
                         |       ^
           kubectl apply |       | kubelet watches ConfigMaps/Secrets
                         v       |  used by pods on its node
  ConfigMap / Secret objects     |
                                 |
              node: kubelet -----+----> container start:  env vars (copied ONCE)
                                 |
                                 +----> volume: files in a tmpfs/emptyDir-like dir
                                          (kubelet refreshes these periodically)
```

Two facts drive everything else:

1. **ConfigMaps and Secrets are ordinary API objects** stored in etcd, namespaced, limited to **1 MiB** each. A pod can only use the ones in its own namespace.
2. **The kubelet delivers them to containers** either as environment variables (resolved once when the container starts) or as files in a volume (kept in sync by the kubelet). This difference decides whether a change reaches a running process.

:::info 12-factor config
The [Twelve-Factor App](https://12factor.net/config) says: store config in the environment, strictly separated from code, so the same build runs everywhere. In Kubernetes the "environment" is the pod spec, fed from ConfigMaps and Secrets. Your Node code should only ever read `process.env` (or files), never know whether it runs in kind, EKS or Docker Compose.
:::

## ConfigMaps

### Creating them

```bash
# From literals
kubectl create configmap shipit-config \
  --from-literal=LOG_LEVEL=info \
  --from-literal=CACHE_TTL_SECONDS=30

# From a file: key = file name, value = file content
kubectl create configmap nginx-conf --from-file=default.conf

# From a file with a custom key
kubectl create configmap nginx-conf --from-file=site.conf=./default.conf

# From an env file: each KEY=VALUE line becomes a key
kubectl create configmap shipit-config --from-env-file=./shipit.env

# Generate YAML instead of creating (great for committing to Git)
kubectl create configmap shipit-config --from-literal=LOG_LEVEL=info \
  --dry-run=client -o yaml > configmap.yaml
```

Declaratively:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: shipit-config
data:
  LOG_LEVEL: info
  CACHE_TTL_SECONDS: "30"          # values are always strings: quote numbers and booleans
  features.json: |
    { "newCheckout": false, "maxUploadMb": 10 }
```

`data` holds UTF-8 strings; `binaryData` holds base64 for binary files.

### Consuming them: four ways

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shipit-api
spec:
  containers:
    - name: api
      image: node:22-alpine
      env:
        # 1. A single key as one env var
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: shipit-config
              key: LOG_LEVEL
        # Plain values and references to other vars also work
        - name: NODE_ENV
          value: production
      # 2. All keys as env vars (keys must be valid env var names)
      envFrom:
        - configMapRef:
            name: shipit-config
          prefix: CFG_                    # optional
      volumeMounts:
        # 3. All keys as files in a directory
        - name: config
          mountPath: /etc/shipit
          readOnly: true
        # 4. One key as one file via subPath (does NOT auto-update)
        - name: config
          mountPath: /app/features.json
          subPath: features.json
  volumes:
    - name: config
      configMap:
        name: shipit-config
        # items:                         # optional: pick keys and rename files
        #   - key: features.json
        #     path: features.json
        # defaultMode: 0444
```

Behaviour you must know:

| Method | Updates in a running container? | Notes |
| --- | --- | --- |
| `env` / `envFrom` | **Never.** Only on container restart | Values copied at container start |
| Volume mount (directory) | **Yes, eventually** | kubelet sync period + cache delay, typically up to a minute or two |
| Volume mount with `subPath` | **Never** | The file is bind-mounted once |
| Missing ConfigMap or key | Pod stays in `CreateContainerConfigError` | Unless the reference has `optional: true` |

For mounted volumes the kubelet writes files into a timestamped directory and atomically swaps a `..data` symlink, so your app never sees a half-written file. That is also why tools like `fs.watch` on the file path can be unreliable: the file is replaced, not modified. Watch the directory or poll.

:::warning envFrom and odd key names
Historically, `envFrom` skipped keys that were not valid C-style identifiers (such as `features.json`) and recorded an `InvalidEnvironmentVariableNames` event. Relaxed env var validation (on by default since Kubernetes 1.32) allows almost any printable character, so on current clusters `features.json` becomes an env var literally named `features.json`. Either way, `envFrom` works best with a ConfigMap that holds only `UPPER_SNAKE` keys; keep file-like keys in a separate ConfigMap mounted as a volume.
:::

:::try Watch the difference
After Lab 2 you will see this live, but you can reason first: you mount `shipit-config` as a directory and also load it with `envFrom`, then `kubectl edit configmap shipit-config` to change `LOG_LEVEL`. After a minute, `cat /etc/shipit/LOG_LEVEL` shows the new value but `echo $LOG_LEVEL` shows the old one. Which of the two would your Node process see if it read config once at boot? (Neither change: it read `process.env` at startup.)
:::

### Immutable ConfigMaps and Secrets

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: shipit-config-v7
immutable: true
data:
  LOG_LEVEL: info
```

`immutable: true` means the data can never be changed (only deleted and recreated). Benefits: protection against accidental edits, and the kubelet stops watching it, which reduces API server load in large clusters. It pairs naturally with **versioned names** (`shipit-config-v7` or a content hash) that you change on every update, which also forces a rollout (see below).

## Secrets

A Secret looks almost identical to a ConfigMap:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: shipit-db
type: Opaque
stringData:                        # write plain text; the API server stores it base64-encoded in data
  DATABASE_URL: postgres://shipit:s3cret@postgres:5432/shipit
```

```bash
kubectl create secret generic shipit-db \
  --from-literal=DATABASE_URL='postgres://shipit:s3cret@postgres:5432/shipit'
kubectl get secret shipit-db -o jsonpath='{.data.DATABASE_URL}' | base64 -d
```

Consumption is the same: `secretKeyRef`, `envFrom.secretRef`, or a `secret` volume. Secret volumes are always backed by **tmpfs** (RAM) on the node, so they are not written to the node's disk.

### Secret types

| Type | Used for | Required keys |
| --- | --- | --- |
| `Opaque` | Anything (default) | none |
| `kubernetes.io/tls` | TLS cert and key (Gateways, Ingress, cert-manager output) | `tls.crt`, `tls.key` |
| `kubernetes.io/dockerconfigjson` | Image pull credentials (`imagePullSecrets`) | `.dockerconfigjson` |
| `kubernetes.io/basic-auth` | Username/password | `username`, `password` |
| `kubernetes.io/ssh-auth` | SSH private key | `ssh-privatekey` |
| `kubernetes.io/service-account-token` | Legacy long-lived SA tokens | managed by Kubernetes |

```bash
kubectl create secret tls shipit-tls --cert=tls.crt --key=tls.key
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=roma --docker-password="$GHCR_TOKEN"
```

The type mainly adds validation and tells tools what to expect.

### Base64 is not encryption

`data` values are base64 only so that binary content fits in JSON/YAML. Anyone who can `get` the Secret can read it in one command. The real protections are elsewhere:

```text
 Who can read a Secret?
 ----------------------
 1. Anyone with RBAC get/list/watch on secrets in that namespace     -> lock down RBAC
 2. Anyone who can create a pod in that namespace (mount it, print it) -> limit pod creation
 3. Anyone with access to etcd or its backups                         -> encryption at rest
 4. Anyone with root on a node running a pod that uses it             -> node hardening
 5. Anyone who reads your Git repo, if you committed it               -> never commit plain Secrets
```

:::warning `list` is as good as `get`
Granting `list` or `watch` on secrets returns the full contents of every Secret in the namespace, not just their names. When writing Roles, treat `get`, `list` and `watch` on `secrets` as equally sensitive, and do not give them to app ServiceAccounts that do not need the API at all. Also remember point 2: `create pods` in a namespace effectively means read access to all its Secrets.
:::

### Encryption at rest

By default, kube-apiserver writes Secrets to etcd **in plain text** (base64 inside a protobuf). Encryption at rest is configured with an `EncryptionConfiguration` file passed to the API server:

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources: ["secrets"]
    providers:
      - kms:                       # production: envelope encryption with an external KMS
          apiVersion: v2
          name: aws-kms
          endpoint: unix:///var/run/kmsplugin/socket.sock
      - aescbc:                    # or a local key (key lives on the control plane disk)
          keys:
            - name: key1
              secret: <base64 32-byte key>
      - identity: {}               # plain text; allows reading old unencrypted data
```

The **first** provider encrypts new writes; all providers are tried for reads. Existing Secrets are re-encrypted only when rewritten (`kubectl get secrets -A -o json | kubectl replace -f -`). KMS v2 uses envelope encryption: a data encryption key (DEK) encrypts the data, and the cloud KMS key encrypts the DEK, so the master key never leaves the KMS.

On managed clusters you do not edit API server flags. **Amazon EKS** envelope-encrypts all Kubernetes API data with KMS by default on clusters running Kubernetes 1.28 or later (using an AWS-owned key unless you supply your own customer-managed KMS key). GKE and AKS have equivalent options.

:::deep Seeing Secrets in etcd yourself
On kind you can read etcd directly, which makes "base64 is not encryption" concrete. The etcd image includes `etcdctl`. For a cluster named `kind` the etcd pod is `etcd-kind-control-plane` (in general `etcd-<cluster>-control-plane`):

```bash
kubectl create secret generic demo --from-literal=password=hunter2
kubectl -n kube-system exec etcd-kind-control-plane -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/demo | strings | grep hunter2
```

You will see `hunter2` in clear text. After enabling an `aescbc` provider (Lab 6), the stored value starts with `k8s:enc:aescbc:v1:key1:` followed by ciphertext. The keys under `/registry/` mirror the API: `/registry/<resource>/<namespace>/<name>`. This is also why etcd backups must be treated as secret material.
:::

### Secrets and RBAC in practice

A namespace-scoped Role that lets a CI deployer manage one Secret by name but not read all others:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: shipit-secret-updater
  namespace: shipit
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["shipit-db"]   # only this Secret
    verbs: ["get", "update", "patch"]
```

`resourceNames` cannot restrict `create` or `list` (the name is not known in advance / the request covers all objects), so plan around that. Check what an identity can do with `kubectl auth can-i`:

```bash
kubectl auth can-i list secrets -n shipit --as=system:serviceaccount:shipit:default
kubectl auth can-i get secret/shipit-db -n shipit --as=system:serviceaccount:shipit:ci
```

The security module covers RBAC in depth. For app pods, the usual rule is: the app's ServiceAccount needs **no** Secret permissions at all, because the kubelet mounts Secrets for it. Also set `automountServiceAccountToken: false` on pods that never talk to the API.

## Projected volumes and the downward API

A **projected** volume merges several sources into one directory:

```yaml
volumes:
  - name: app-config
    projected:
      defaultMode: 0440
      sources:
        - configMap:
            name: shipit-config
            items:
              - key: features.json
                path: features.json
        - secret:
            name: shipit-db
            items:
              - key: DATABASE_URL
                path: secrets/database-url
        - downwardAPI:
            items:
              - path: pod/labels
                fieldRef:
                  fieldPath: metadata.labels
              - path: pod/mem-limit
                resourceFieldRef:
                  containerName: api
                  resource: limits.memory
        - serviceAccountToken:
            path: tokens/vault
            audience: vault           # short-lived, audience-bound token
            expirationSeconds: 3600
```

The **downward API** exposes pod metadata (name, namespace, labels, annotations, node name, pod IP, resource requests/limits) either as env vars or files:

```yaml
env:
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
  - name: MEMORY_LIMIT_BYTES
    valueFrom:
      resourceFieldRef:
        resource: limits.memory
```

`POD_NAME` is handy for log lines and metrics labels in your NestJS app; the memory limit lets a Node process size caches (module 09).

**Projected service account tokens** are how workloads authenticate to external systems without static credentials: EKS IRSA and Vault's Kubernetes auth both rely on short-lived, audience-scoped tokens that the kubelet refreshes automatically. (EKS Pod Identity uses an agent instead but follows the same idea.)

## 12-factor config for a NestJS/Node service

Make the app strict and boring about configuration:

1. **Read everything from env vars** (or files for large/secret values).
2. **Validate at startup and crash fast** with a clear message. A pod in `CrashLoopBackOff` with "DATABASE_URL is required" beats one that starts and fails on the first request.
3. **No environment names in code** (`if (env === 'staging')`). Use explicit settings (`CACHE_TTL_SECONDS`, `FEATURE_NEW_CHECKOUT`).
4. **Secrets never in logs.** Log which keys are set, not their values.

A minimal plain Node/TypeScript version using zod:

```typescript
// src/config.ts
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;
```

In NestJS, `@nestjs/config` does the same with `ConfigModule.forRoot({ isGlobal: true, validate })` (pass the zod parse as `validate`) or a Joi `validationSchema`. Inject `ConfigService` instead of reading `process.env` across the codebase.

The matching Deployment fragment:

```yaml
containers:
  - name: api
    image: ghcr.io/roma/shipit-api:1.4.2
    envFrom:
      - configMapRef:
          name: shipit-config        # LOG_LEVEL, CACHE_TTL_SECONDS, PORT
    env:
      - name: DATABASE_URL
        valueFrom:
          secretKeyRef:
            name: shipit-db
            key: DATABASE_URL
      - name: REDIS_URL
        valueFrom:
          secretKeyRef:
            name: shipit-redis
            key: REDIS_URL
```

:::tip Env vars or files for secrets?
Env vars are simple and what most Node libraries expect, but they leak more easily: crash reporters, `/proc/<pid>/environ`, child processes and debug endpoints can expose them. Files in a tmpfs Secret volume are a bit safer and can be rotated without a restart if your app re-reads them. A common compromise: env vars for ordinary config, files for high-value credentials and certificates.
:::

## Rolling out config changes

Because env vars never update and most apps read config once, **changing a ConfigMap does not change running pods**. Changing the pod template does: any change to `spec.template` creates a new ReplicaSet and a rolling update. So the trick is to make config changes show up in the template.

### 1. `kubectl rollout restart`

```bash
kubectl apply -f configmap.yaml
kubectl rollout restart deployment/shipit-api
kubectl rollout status deployment/shipit-api
```

`rollout restart` just sets the annotation `kubectl.kubernetes.io/restartedAt` in the pod template, which triggers a normal rolling update. Fine for manual changes; easy to forget.

### 2. Checksum annotation (the Helm pattern)

```yaml
# templates/deployment.yaml in a Helm chart
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

When the rendered ConfigMap changes, the hash changes, the pod template changes, and Helm's upgrade rolls the pods. The Helm module covers this in detail.

### 3. Hash-suffixed names (the Kustomize pattern)

```yaml
# kustomization.yaml
resources:
  - deployment.yaml
configMapGenerator:
  - name: shipit-config
    literals:
      - LOG_LEVEL=info
      - CACHE_TTL_SECONDS=30
```

`kubectl apply -k .` creates `shipit-config-<hash>` and rewrites references in the Deployment to that name. New content means a new name, which means a new pod template and a rollout. Old ConfigMaps stay around for rollbacks (prune them eventually). Combined with `immutable: true`, this is the most robust approach: a rollback of the Deployment also rolls back the config.

### 4. A controller that watches

Tools like **Stakater Reloader** watch ConfigMaps/Secrets and trigger rollouts for Deployments annotated with, for example, `reloader.stakater.com/auto: "true"`. Useful for Secrets that change outside your deploy pipeline (rotated by External Secrets Operator).

### 5. Hot reload in the app

If the config is a mounted directory, the app can re-read files on change (polling or watching the directory). Good for feature flags and log levels; risky for things like database pools. Most teams prefer restarts because they are predictable and visible.

:::try Spot the trigger
`kubectl get deploy shipit-api -o jsonpath='{.spec.template.metadata.annotations}'` after a `rollout restart` shows the `restartedAt` annotation. Then `kubectl rollout history deploy/shipit-api` shows a new revision. Rolling back (`kubectl rollout undo`) reverts the template, but **not** a ConfigMap you edited in place, which is the argument for hash-named config.
:::

## External secret management

Plain Secrets in Git are a non-starter, and creating them by hand does not scale. Four common approaches:

| Tool | How it works | Source of truth | Good fit |
| --- | --- | --- | --- |
| **External Secrets Operator (ESO)** | A controller reads from AWS Secrets Manager, SSM Parameter Store, Vault, GCP, Azure, 1Password... and writes regular Kubernetes Secrets, refreshing on an interval | External secret store | Teams already using a cloud secret manager; rotation |
| **Sealed Secrets** | You encrypt a Secret with the cluster's public key (`kubeseal`) and commit the `SealedSecret`; only the in-cluster controller can decrypt it | Git (encrypted) | Simple GitOps without a cloud secret store |
| **SOPS** (+ age/KMS) | Encrypts values inside YAML files; Flux decrypts natively, Argo CD via plugins, or you decrypt in CI | Git (encrypted) | GitOps with KMS-backed keys; also for Helm values and Terraform |
| **Secrets Store CSI Driver** | Mounts secrets from an external store directly into the pod as files via a CSI volume (`SecretProviderClass`); optional sync to a Kubernetes Secret | External secret store | Avoiding Kubernetes Secrets entirely; AWS provider (ASCP) on EKS |

An ESO example pulling the database URL from AWS Secrets Manager:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: shipit-db
  namespace: shipit
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager      # a SecretStore/ClusterSecretStore configured with IRSA or Pod Identity
    kind: ClusterSecretStore
  target:
    name: shipit-db                # the Kubernetes Secret ESO creates and keeps updated
  data:
    - secretKey: DATABASE_URL
      remoteRef:
        key: prod/shipit/db
        property: url
```

The app still consumes a normal Secret named `shipit-db`, so your manifests do not change between local (a hand-made Secret) and production (ESO-managed).

:::info Which one would you choose?
On AWS with EKS, a common and defensible answer is: AWS Secrets Manager as the source of truth, ESO to sync into namespaced Secrets, IRSA or EKS Pod Identity for ESO's AWS access, KMS envelope encryption in etcd (on by default), tight RBAC, and Reloader or hash-based rollouts for rotation. Sealed Secrets or SOPS fit smaller setups or GitOps without a cloud secret store.
:::

## Pitfalls and best practices

:::warning Common mistakes
- **Editing a ConfigMap and expecting the app to change.** Env vars never update; most apps need a rollout.
- **`subPath` mounts** never receive updates. Mount the directory instead if you need updates.
- **Unquoted YAML values.** `ENABLED: true` or `PORT: 3000` in `data` fails validation ("cannot unmarshal bool/number into string"). Quote them.
- **Trailing newlines.** `--from-file` keeps the file's trailing newline; a password read from a file may end in `\n`. Use `echo -n` or `printf` when creating files, or trim in code.
- **Missing references.** A pod referencing a non-existent ConfigMap/Secret or key sits in `CreateContainerConfigError`. `kubectl describe pod` names the missing object.
- **Committing Secret manifests**, even "temporary" ones. Rotate any credential that ever hit Git history.
- **Giving app ServiceAccounts `list secrets`** "just in case".
:::

Best practices:

- Keep ConfigMaps small and purpose-specific; one per app is typical.
- Validate config at startup and fail fast.
- Prefer versioned or hash-named, immutable ConfigMaps so rollbacks restore config.
- Encrypt Secrets at rest (on by default on EKS), and restrict `get/list/watch secrets` RBAC.
- Use an external store (ESO or CSI driver) or encrypted-in-Git (Sealed Secrets/SOPS) for anything real.
- Use short-lived, projected service account tokens (IRSA, Pod Identity, Vault auth) instead of long-lived cloud keys in Secrets.
