Each lab is one milestone of the capstone. Read the requirements in the lesson first, attempt the milestone on your own, then compare with the reference solution. Work in one Git repository:

```bash
mkdir -p ~/shipit-k8s && cd ~/shipit-k8s && git init -b main
printf 'tls.key\n*.tgz\nnode_modules\ndist\n' > .gitignore
```

Tools: Docker (6 GB+ memory for the VM), kind, kubectl, Helm, optionally mkcert, k9s and the Argo CD CLI (`brew install mkcert argocd`).

## Milestone 1: Build the shipit-api image

:::meta
difficulty: easy
time: 20 min
:::

**Goal:** have a `shipit-api:1.0.0` image that runs as a numeric non-root user and shuts down gracefully. If you built it in module 12, copy that directory to `app/shipit-api` and skip to Verify.

### Steps

1. Create the app:

```bash
mkdir -p app/shipit-api/src && cd app/shipit-api
cat > package.json <<'EOF'
{
  "name": "shipit-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc", "start": "node dist/index.js" },
  "dependencies": { "express": "^5.1.0", "pg": "^8.13.0", "redis": "^5.0.0" },
  "devDependencies": {
    "@types/express": "^5.0.0", "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0", "typescript": "^5.6.0"
  }
}
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "outDir": "dist", "rootDir": "src", "strict": true,
    "esModuleInterop": true, "skipLibCheck": true
  }
}
EOF
cat > src/index.ts <<'EOF'
import express from "express";
import pg from "pg";
import { createClient } from "redis";

const port = Number(process.env.PORT ?? 3000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL, disableOfflineQueue: true });
redis.on("error", (err: Error) => console.error("redis:", err.message));
redis.connect().catch((err: Error) => console.error("redis connect:", err.message));

// Create the table once Postgres is reachable (retry instead of crashing).
async function ensureSchema(): Promise<void> {
  for (;;) {
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      );
      console.log("schema ready");
      return;
    } catch (err) {
      console.error("db not ready:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
void ensureSchema();

const app = express();
app.use(express.json());

// Liveness: the process is up. Never check dependencies here.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness: can we serve traffic right now?
app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    if (!redis.isReady) throw new Error("redis not connected");
    await redis.ping();
    res.json({ status: "ready" });
  } catch (err) {
    res.status(503).json({ status: "not ready", error: (err as Error).message });
  }
});

app.get("/items", async (_req, res) => {
  const cached = redis.isReady ? await redis.get("items:all") : null;
  if (cached) {
    res.set("x-cache", "hit").json(JSON.parse(String(cached)));
    return;
  }
  const { rows } = await pool.query("SELECT id, name, created_at FROM items ORDER BY id");
  if (redis.isReady) await redis.set("items:all", JSON.stringify(rows), { EX: 30 });
  res.set("x-cache", "miss").json(rows);
});

app.post("/items", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const { rows } = await pool.query(
    "INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at",
    [name],
  );
  if (redis.isReady) await redis.del("items:all");
  res.status(201).json(rows[0]);
});

const server = app.listen(port, () => console.log(`shipit-api listening on :${port}`));

// Kubernetes sends SIGTERM before killing the pod: stop accepting, finish in-flight requests.
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
});
EOF
cat > Dockerfile <<'EOF'
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER 1000
EXPOSE 3000
CMD ["node", "dist/index.js"]
EOF
printf 'node_modules\ndist\n' > .dockerignore
docker build -t shipit-api:1.0.0 .
cd ~/shipit-k8s
```

2. Smoke-test it without Kubernetes:

```bash
docker run --rm -d --name api-test -p 3000:3000 shipit-api:1.0.0
sleep 2; curl -s localhost:3000/healthz; curl -s -w ' %{http_code}\n' localhost:3000/readyz
docker stop api-test        # watch it exit promptly: SIGTERM is handled
```

### Verify

- `/healthz` returns `{"status":"ok"}`; `/readyz` returns 503 (no database yet). That is correct behaviour.
- `docker image inspect shipit-api:1.0.0 --format '{{.Config.User}} {{.Architecture}}'` prints `1000 arm64` on Apple Silicon.

:::hint
If `docker stop` takes 10 seconds, the process did not receive or handle SIGTERM. With `CMD ["node", ...]` in exec form, Node is PID 1 and the `process.on("SIGTERM")` handler runs.
:::

:::solution
The steps above are the solution. Commit: `git add . && git commit -m "shipit-api app"`.
:::

### Clean up

Nothing to clean up; the image is used in the next milestones.

## Milestone 2: Cluster and platform

:::meta
difficulty: medium
time: 30 min
:::

**Goal:** a three-node kind cluster with metrics-server, Envoy Gateway and a GatewayClass, the `shipit` namespace enforcing `restricted`, the TLS Secret, the database Secret, and the API image loaded into the nodes.

### Steps

1. Cluster:

```bash
mkdir -p platform
cat > platform/kind.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: shipit
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --config platform/kind.yaml
kind load docker-image shipit-api:1.0.0 --name shipit
```

2. metrics-server (for the HPA):

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

3. Envoy Gateway (it also installs the Gateway API CRDs). Look up the current version on the Envoy Gateway releases page or docs and pin it:

```bash
EG_VERSION=v1.x.y      # replace with the current release shown in https://gateway.envoyproxy.io/docs/tasks/quickstart/
helm install eg oci://docker.io/envoyproxy/gateway-helm --version "$EG_VERSION" \
  -n envoy-gateway-system --create-namespace
kubectl -n envoy-gateway-system wait --for=condition=Available deployment/envoy-gateway --timeout=5m
```

Create the GatewayClass `eg` for Envoy Gateway's controller (`gateway.envoyproxy.io/gatewayclass-controller`) and check it is `Accepted`.

4. Namespace, labelled for Pod Security `restricted` (enforce, warn and audit, version `latest`).

5. TLS certificate for `shipit.localtest.me`, stored as Secret `shipit-tls` in `shipit`. Either with mkcert (trusted by your Mac's browsers) or openssl (self-signed):

```bash
# Option A: mkcert (browser-trusted)
mkcert -install
mkcert -cert-file tls.crt -key-file tls.key shipit.localtest.me
cp "$(mkcert -CAROOT)/rootCA.pem" ca.crt      # for curl --cacert

# Option B: openssl (self-signed; browsers will warn)
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout tls.key -out tls.crt \
  -subj "/CN=shipit.localtest.me" -addext "subjectAltName=DNS:shipit.localtest.me"
cp tls.crt ca.crt
```

6. Database Secret with a random password (keys `password` and `url`), never written to a file in the repo.

### Verify

```bash
kubectl get nodes                                         # 3 Ready
kubectl top nodes                                         # works after ~1 minute
kubectl get gatewayclass eg                               # ACCEPTED True
kubectl get ns shipit --show-labels
kubectl -n shipit get secret shipit-tls shipit-db
docker exec shipit-worker crictl images | grep shipit-api
```

:::hint
`kubectl create secret tls NAME --cert=... --key=...` creates a `kubernetes.io/tls` Secret. For the database Secret, generate the password into a shell variable with `openssl rand -hex 16` and pass both keys with `--from-literal`. The `url` must use the Service name `postgres` and the same user/database as the chart values (`shipit`/`shipit`).
:::

:::solution
```bash
# GatewayClass
cat > platform/gatewayclass.yaml <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
EOF
kubectl apply -f platform/gatewayclass.yaml

# Namespace
cat > platform/namespace.yaml <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: shipit
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
EOF
kubectl apply -f platform/namespace.yaml

# Secrets (not committed)
kubectl -n shipit create secret tls shipit-tls --cert=tls.crt --key=tls.key
PGPASS=$(openssl rand -hex 16)
kubectl -n shipit create secret generic shipit-db \
  --from-literal=password="$PGPASS" \
  --from-literal=url="postgres://shipit:${PGPASS}@postgres:5432/shipit"
unset PGPASS
git add platform .gitignore && git commit -m "platform: kind, gatewayclass, namespace"
```

Production equivalents: the namespace and GatewayClass would be managed by the platform team's GitOps repo, the TLS certificate by cert-manager (a `Certificate` resource producing the same Secret), and `shipit-db` by an `ExternalSecret` pulling from AWS Secrets Manager.
:::

### Clean up

Keep everything.

## Milestone 3: Chart skeleton and the data tier

:::meta
difficulty: medium
time: 45 min
:::

**Goal:** start `charts/shipit` with a values API and helpers, then add Postgres (StatefulSet, headless Service, PVC) and Redis. Install it and prove Postgres data survives the pod being deleted.

### Steps

1. Create `charts/shipit` by hand (not `helm create`; you want a clean chart): `Chart.yaml`, `values.yaml`, `templates/_helpers.tpl`.
2. Write `templates/postgres.yaml`: ServiceAccount (no token), headless Service, StatefulSet with `volumeClaimTemplates`, `PGDATA` in a subdirectory of the mount, `pg_isready` probes, restricted securityContext with a read-only root filesystem (Postgres needs writable `/var/run/postgresql` and `/tmp`).
3. Write `templates/redis.yaml`: ServiceAccount, Service, Deployment running `redis-server` without persistence, `redis-cli ping` probes, writable `/data`.
4. Install and test:

```bash
helm lint charts/shipit
helm template shipit charts/shipit -n shipit | less
helm upgrade --install shipit charts/shipit -n shipit --wait --timeout 5m
kubectl -n shipit get pods,pvc,svc
```

5. Prove persistence:

```bash
kubectl -n shipit exec -it postgres-0 -- psql -U shipit -d shipit -c "CREATE TABLE IF NOT EXISTS ping (t timestamptz default now()); INSERT INTO ping DEFAULT VALUES;"
kubectl -n shipit delete pod postgres-0
kubectl -n shipit wait --for=condition=Ready pod/postgres-0 --timeout=120s
kubectl -n shipit exec -it postgres-0 -- psql -U shipit -d shipit -c "SELECT count(*) FROM ping;"
```

### Verify

- `helm lint` passes, and no Pod Security warnings are printed on install.
- `data-postgres-0` PVC is `Bound`; the row count is still 1 after the pod is recreated.
- `kubectl -n shipit exec deploy/redis -- redis-cli ping` returns `PONG`.

:::hint
The official Debian-based `postgres` image's user is UID 999. Mount the PVC at `/var/lib/postgresql/data` and set `PGDATA=/var/lib/postgresql/data/pgdata` so `initdb` gets an empty directory it owns. Keep selector labels in a helper that takes a component name, e.g. `include "shipit.selectorLabels" (dict "ctx" . "name" "postgres")`.
:::

:::solution
`charts/shipit/Chart.yaml`:

```yaml
apiVersion: v2
name: shipit
description: shipit — API, web, Postgres and Redis
type: application
version: 0.1.0
appVersion: "1.0.0"
```

`charts/shipit/values.yaml` (the full values API for all milestones; later features are switched off for now):

```yaml
host: shipit.localtest.me

api:
  image:
    repository: shipit-api
    tag: "1.0.0"
    pullPolicy: IfNotPresent
  replicas: 2                    # used only when autoscaling is disabled
  logLevel: info
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 5
    targetCPUUtilizationPercentage: 70
  resources:
    requests: { cpu: 100m, memory: 128Mi }
    limits: { memory: 256Mi }

web:
  image:
    repository: nginxinc/nginx-unprivileged
    tag: "1.27-alpine"
  replicas: 2
  resources:
    requests: { cpu: 20m, memory: 32Mi }
    limits: { memory: 64Mi }

postgres:
  image: postgres:17
  user: shipit
  database: shipit
  existingSecret: shipit-db      # keys: password, url (created outside the chart)
  storage: 1Gi
  storageClassName: ""           # empty = cluster default (kind: standard)
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 512Mi }

redis:
  image: redis:7-alpine
  resources:
    requests: { cpu: 50m, memory: 32Mi }
    limits: { memory: 128Mi }

gateway:
  enabled: false                 # milestone 5 turns this on
  className: eg
  tlsSecret: shipit-tls
  httpsRedirectPort: 8443        # local port-forward port; omit/null in a real cluster

networkPolicies:
  enabled: false                 # milestone 6 turns this on
  gatewayNamespace: envoy-gateway-system
```

`charts/shipit/templates/_helpers.tpl`:

```yaml
{{/* Labels shared by every object */}}
{{- define "shipit.labels" -}}
app.kubernetes.io/part-of: shipit
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/* Stable selector labels for one component.
     Usage: include "shipit.selectorLabels" (dict "ctx" . "name" "shipit-api") */}}
{{- define "shipit.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
{{- end }}

{{/* Restricted-compliant container securityContext */}}
{{- define "shipit.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}
```

`charts/shipit/templates/postgres.yaml`:

```yaml
{{- $sel := include "shipit.selectorLabels" (dict "ctx" . "name" "postgres") }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: postgres
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
automountServiceAccountToken: false
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    {{- $sel | nindent 4 }}
spec:
  clusterIP: None                # headless: stable DNS for the StatefulSet pod
  selector:
    {{- $sel | nindent 4 }}
  ports:
    - name: postgres
      port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    {{- $sel | nindent 4 }}
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      {{- $sel | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "shipit.labels" . | nindent 8 }}
        {{- $sel | nindent 8 }}
    spec:
      serviceAccountName: postgres
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 999               # "postgres" user in the Debian-based image
        runAsGroup: 999
        fsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: postgres
          image: {{ .Values.postgres.image | quote }}
          ports:
            - name: postgres
              containerPort: 5432
          env:
            - name: POSTGRES_USER
              value: {{ .Values.postgres.user | quote }}
            - name: POSTGRES_DB
              value: {{ .Values.postgres.database | quote }}
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ required "postgres.existingSecret is required" .Values.postgres.existingSecret }}
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          readinessProbe:
            exec:
              command: ["pg_isready", "-h", "127.0.0.1", "-U", {{ .Values.postgres.user | quote }}, "-d", {{ .Values.postgres.database | quote }}]
            periodSeconds: 5
          livenessProbe:
            exec:
              command: ["pg_isready", "-h", "127.0.0.1", "-U", {{ .Values.postgres.user | quote }}]
            initialDelaySeconds: 30
            periodSeconds: 10
          resources:
            {{- toYaml .Values.postgres.resources | nindent 12 }}
          securityContext:
            {{- include "shipit.containerSecurity" . | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
            - name: run
              mountPath: /var/run/postgresql
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: run
          emptyDir: {}
        - name: tmp
          emptyDir: {}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        {{- with .Values.postgres.storageClassName }}
        storageClassName: {{ . }}
        {{- end }}
        resources:
          requests:
            storage: {{ .Values.postgres.storage }}
```

`charts/shipit/templates/redis.yaml`:

```yaml
{{- $sel := include "shipit.selectorLabels" (dict "ctx" . "name" "redis") }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: redis
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
automountServiceAccountToken: false
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    {{- $sel | nindent 4 }}
spec:
  selector:
    {{- $sel | nindent 4 }}
  ports:
    - name: redis
      port: 6379
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    {{- $sel | nindent 4 }}
spec:
  replicas: 1
  selector:
    matchLabels:
      {{- $sel | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "shipit.labels" . | nindent 8 }}
        {{- $sel | nindent 8 }}
    spec:
      serviceAccountName: redis
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: redis
          image: {{ .Values.redis.image | quote }}
          args: ["redis-server", "--save", "", "--appendonly", "no"]   # pure cache, no persistence
          ports:
            - name: redis
              containerPort: 6379
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 5
          livenessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 10
          resources:
            {{- toYaml .Values.redis.resources | nindent 12 }}
          securityContext:
            {{- include "shipit.containerSecurity" . | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
```

Why the data survives: the StatefulSet's `volumeClaimTemplates` creates PVC `data-postgres-0` once; a recreated `postgres-0` mounts the same claim. On kind, the `standard` StorageClass (local-path provisioner) stores data on the node's disk, which also pins `postgres-0` to that node; the game day will show what that means.

If Postgres crash-loops with permission errors, check `kubectl -n shipit logs postgres-0`: `PGDATA` must be a subdirectory, not the mount point itself (the mount may contain `lost+found` on real disks).

Commit: `git add charts && git commit -m "chart: data tier"`.
:::

### Clean up

Keep everything.

## Milestone 4: API and web with probes, resources, HPA and PDB

:::meta
difficulty: hard
time: 60 min
:::

**Goal:** add shipit-api and shipit-web to the chart with every reliability requirement: startup/liveness/readiness probes, requests and memory limits, HPA 2–5, PDB, topology spread, preStop delay, config checksum, and a Helm smoke test.

### Steps

1. Write `templates/api-configmap.yaml`, `templates/api.yaml` (ServiceAccount, Service, Deployment), `templates/api-hpa-pdb.yaml`.
2. Put the web page in `charts/shipit/files/index.html` and write `templates/web.yaml` (ServiceAccount, ConfigMap from the file, Service, Deployment, PDB).
3. Write `templates/tests/smoke.yaml`: a pod labelled `shipit.dev/role: smoke-test` that curls `http://shipit-api/readyz` and is restricted-compliant.
4. Upgrade and test:

```bash
helm lint charts/shipit
helm upgrade --install shipit charts/shipit -n shipit --wait --timeout 5m --rollback-on-failure
kubectl -n shipit get deploy,hpa,pdb,pods -o wide
helm -n shipit test shipit

kubectl -n shipit port-forward svc/shipit-api 3000:80 &
curl -s localhost:3000/readyz
curl -s -XPOST localhost:3000/items -H 'content-type: application/json' -d '{"name":"from milestone 4"}'
curl -si localhost:3000/items | grep -i x-cache; curl -si localhost:3000/items | grep -i x-cache
kill %1
```

5. Change `api.logLevel` with `--set api.logLevel=debug` and confirm the API pods roll while web pods do not.

### Verify

- API pods are spread over both workers; `kubectl -n shipit get hpa` shows a CPU percentage (not `<unknown>`) after a minute.
- `helm test` succeeds.
- `kubectl -n shipit get pdb` shows `ALLOWED DISRUPTIONS 1` for both PDBs.
- Step 5 restarts only `shipit-api` pods.

:::hint
A template cannot include itself for a checksum, which is why the API ConfigMap lives in its own file. Omit `replicas` from the Deployment when autoscaling is on. The native `lifecycle.preStop.sleep` action works without a shell in the image. `curlimages/curl` declares a non-numeric user, so set `runAsUser: 100` for the smoke test under `restricted`.
:::

:::solution
`charts/shipit/templates/api-configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: shipit-api
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
data:
  PORT: "3000"
  LOG_LEVEL: {{ .Values.api.logLevel | quote }}
  REDIS_URL: "redis://redis:6379"
```

`charts/shipit/templates/api.yaml`:

```yaml
{{- $sel := include "shipit.selectorLabels" (dict "ctx" . "name" "shipit-api") }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: shipit-api
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
automountServiceAccountToken: false
---
apiVersion: v1
kind: Service
metadata:
  name: shipit-api
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    {{- $sel | nindent 4 }}
spec:
  selector:
    {{- $sel | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shipit-api
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    {{- $sel | nindent 4 }}
    app.kubernetes.io/version: {{ .Values.api.image.tag | quote }}
spec:
  {{- if not .Values.api.autoscaling.enabled }}
  replicas: {{ .Values.api.replicas }}
  {{- end }}
  selector:
    matchLabels:
      {{- $sel | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "shipit.labels" . | nindent 8 }}
        {{- $sel | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/api-configmap.yaml") . | sha256sum }}
    spec:
      serviceAccountName: shipit-api
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              {{- $sel | nindent 14 }}
      containers:
        - name: api
          image: "{{ .Values.api.image.repository }}:{{ .Values.api.image.tag }}"
          imagePullPolicy: {{ .Values.api.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 3000
          envFrom:
            - configMapRef:
                name: shipit-api
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.postgres.existingSecret }}
                  key: url
          startupProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 2
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
            failureThreshold: 2
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
          resources:
            {{- toYaml .Values.api.resources | nindent 12 }}
          securityContext:
            {{- include "shipit.containerSecurity" . | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
```

`charts/shipit/templates/api-hpa-pdb.yaml`:

```yaml
{{- $sel := include "shipit.selectorLabels" (dict "ctx" . "name" "shipit-api") }}
{{- if .Values.api.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: shipit-api
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: shipit-api
  minReplicas: {{ .Values.api.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.api.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.api.autoscaling.targetCPUUtilizationPercentage }}
---
{{- end }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shipit-api
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      {{- $sel | nindent 6 }}
```

`charts/shipit/files/index.html`:

```text
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>shipit</title>
  <style>body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }</style>
</head>
<body>
  <h1>shipit</h1>
  <form id="add"><input id="name" placeholder="New item" required> <button>Add</button></form>
  <ul id="items"></ul>
  <script>
    async function load() {
      const res = await fetch('/api/items');
      const list = document.getElementById('items');
      list.replaceChildren();
      for (const item of await res.json()) {
        const li = document.createElement('li');
        li.textContent = item.id + ': ' + item.name;
        list.appendChild(li);
      }
    }
    document.getElementById('add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('name');
      await fetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: input.value }),
      });
      input.value = '';
      load();
    });
    load();
  </script>
</body>
</html>
```

`charts/shipit/templates/web.yaml`:

```yaml
{{- $sel := include "shipit.selectorLabels" (dict "ctx" . "name" "shipit-web") }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: shipit-web
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
automountServiceAccountToken: false
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: shipit-web
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
data:
  index.html: |
    {{- .Files.Get "files/index.html" | nindent 4 }}
---
apiVersion: v1
kind: Service
metadata:
  name: shipit-web
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    {{- $sel | nindent 4 }}
spec:
  selector:
    {{- $sel | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shipit-web
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    {{- $sel | nindent 4 }}
spec:
  replicas: {{ .Values.web.replicas }}
  selector:
    matchLabels:
      {{- $sel | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "shipit.labels" . | nindent 8 }}
        {{- $sel | nindent 8 }}
      annotations:
        checksum/content: {{ .Files.Get "files/index.html" | sha256sum }}
    spec:
      serviceAccountName: shipit-web
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 101
        runAsGroup: 101
        seccompProfile:
          type: RuntimeDefault
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              {{- $sel | nindent 14 }}
      containers:
        - name: nginx
          image: "{{ .Values.web.image.repository }}:{{ .Values.web.image.tag }}"
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 10
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
          resources:
            {{- toYaml .Values.web.resources | nindent 12 }}
          securityContext:
            {{- include "shipit.containerSecurity" . | nindent 12 }}
          volumeMounts:
            - name: html
              mountPath: /usr/share/nginx/html
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: html
          configMap:
            name: shipit-web
        - name: tmp
          emptyDir: {}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shipit-web
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      {{- $sel | nindent 6 }}
```

`charts/shipit/templates/tests/smoke.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shipit-smoke-test
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
    shipit.dev/role: smoke-test
  annotations:
    "helm.sh/hook": test
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 100
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: curl
      image: curlimages/curl
      args: ["-sf", "-m", "5", "http://shipit-api/readyz"]
      securityContext:
        {{- include "shipit.containerSecurity" . | nindent 8 }}
      resources:
        requests: { cpu: 10m, memory: 16Mi }
        limits: { memory: 32Mi }
```

Design choices to be able to defend:

- **startupProbe** gives the API up to 60 s to boot before liveness starts; liveness only checks `/healthz` (process alive), readiness checks dependencies.
- **No CPU limit** for the API (requests only) to avoid CFS throttling latency; memory limits everywhere because memory is not compressible.
- **`ScheduleAnyway`** spread: prefer different nodes, but never block scheduling (important during drains with only two workers).
- **`checksum/content`** on the web pods restarts nginx when the page changes; nginx would otherwise serve the new file anyway (ConfigMap volumes update in place), but the checksum makes the rollout explicit and visible.

Commit: `git add charts && git commit -m "chart: api and web"`.
:::

### Clean up

Keep everything.

## Milestone 5: Gateway API routing with TLS

:::meta
difficulty: hard
time: 40 min
:::

**Goal:** expose the app at `https://shipit.localtest.me:8443` through a Gateway with an HTTPS listener, route `/api/*` to the API with the prefix stripped and everything else to the web, and redirect HTTP to HTTPS.

### Steps

1. Write `templates/gateway.yaml` (guarded by `gateway.enabled`): a Gateway `shipit` with listeners `http` (80) and `https` (443, TLS terminate with `shipit-tls`), an HTTPRoute attached to `http` that only redirects, and an HTTPRoute attached to `https` with the two rules.
2. Enable it and check status conditions:

```bash
helm upgrade shipit charts/shipit -n shipit --set gateway.enabled=true --wait
kubectl -n shipit get gateway shipit
kubectl -n shipit describe httproute shipit | sed -n '/Status/,$p'
```

3. Find the Envoy Service created for your Gateway and port-forward to it (leave running):

```bash
ENVOY_SVC=$(kubectl -n envoy-gateway-system get svc \
  -l gateway.envoyproxy.io/owning-gateway-namespace=shipit,gateway.envoyproxy.io/owning-gateway-name=shipit \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n envoy-gateway-system port-forward "svc/$ENVOY_SVC" 8443:443 8080:80
```

4. Test from another terminal:

```bash
curl -s --cacert ca.crt https://shipit.localtest.me:8443/ | grep '<title>'
curl -s --cacert ca.crt https://shipit.localtest.me:8443/api/items
curl -s --cacert ca.crt https://shipit.localtest.me:8443/api/healthz
curl -sI http://shipit.localtest.me:8080/api/items | grep -iE '^HTTP|^location'
open https://shipit.localtest.me:8443/           # add an item in the browser
```

### Verify

- Gateway `PROGRAMMED` is `True`; both HTTPRoutes have `Accepted: True` and `ResolvedRefs: True` in their status.
- `/api/items` returns JSON, `/` returns the HTML page, HTTP gives `301` with `location: https://shipit.localtest.me:8443/api/items`.
- The browser page lists and adds items.

:::hint
`ReplacePrefixMatch: /` on a `PathPrefix: /api` match turns `/api/items` into `/items`. Use `sectionName` in `parentRefs` to attach each route to one listener. If the Gateway is not programmed, `kubectl -n shipit describe gateway shipit` and the Envoy Gateway controller logs (`kubectl -n envoy-gateway-system logs deploy/envoy-gateway`) explain why (wrong class name, missing Secret).
:::

:::solution
`charts/shipit/templates/gateway.yaml`:

```yaml
{{- if .Values.gateway.enabled }}
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shipit
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
spec:
  gatewayClassName: {{ .Values.gateway.className }}
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      hostname: {{ .Values.host | quote }}
      allowedRoutes:
        namespaces:
          from: Same
    - name: https
      protocol: HTTPS
      port: 443
      hostname: {{ .Values.host | quote }}
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: {{ .Values.gateway.tlsSecret }}
      allowedRoutes:
        namespaces:
          from: Same
---
# Plain HTTP only redirects to HTTPS
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shipit-https-redirect
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
spec:
  parentRefs:
    - name: shipit
      sectionName: http
  hostnames:
    - {{ .Values.host | quote }}
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
            {{- with .Values.gateway.httpsRedirectPort }}
            port: {{ . }}
            {{- end }}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shipit
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
spec:
  parentRefs:
    - name: shipit
      sectionName: https
  hostnames:
    - {{ .Values.host | quote }}
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      backendRefs:
        - name: shipit-api
          port: 80
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: shipit-web
          port: 80
{{- end }}
```

Make it the default by setting `gateway.enabled: true` in `values.yaml`, then commit.

Notes:

- The redirect `port: 8443` exists only because of the local port-forward. In a cloud cluster set `gateway.httpsRedirectPort: null` so clients are sent to the standard port 443.
- Rules are matched by specificity (longest path prefix wins), not by order, so `/api` beats `/` regardless of how you list them.
- With a real load balancer you would point DNS at the Envoy Service's external address and use a publicly trusted certificate (cert-manager with Let's Encrypt, using the Gateway API HTTP-01 solver or DNS-01).
:::

### Clean up

Keep the port-forward handy; you need it in later milestones.

## Milestone 6: Security hardening — NetworkPolicies and RBAC

:::meta
difficulty: hard
time: 45 min
:::

**Goal:** default-deny networking with explicit allows, a least-privilege deployer identity, and evidence that everything still works and that forbidden paths are really blocked.

### Steps

1. Write `templates/networkpolicies.yaml` (guarded by `networkPolicies.enabled`) implementing: default deny all; DNS egress for all pods; Envoy namespace → web:8080 and api:3000; smoke-test pods → api:3000 (both directions); api → postgres:5432 and redis:6379 (both directions).
2. Write `templates/rbac.yaml`: ServiceAccount `shipit-deployer` with a namespaced Role that can manage the app's resource types (including Secrets, because Helm stores releases there) but nothing cluster-wide.
3. Roll out and re-test everything:

```bash
helm upgrade shipit charts/shipit -n shipit --set gateway.enabled=true --set networkPolicies.enabled=true --wait
helm -n shipit test shipit
curl -s --cacert ca.crt https://shipit.localtest.me:8443/api/items     # port-forward from milestone 5
```

4. Prove the blocks:

```bash
# from outside the namespace: postgres and the api are unreachable
kubectl run np1 --rm -i --restart=Never --image=nicolaka/netshoot -- nc -zv -w 3 postgres.shipit 5432 || echo BLOCKED
kubectl run np2 --rm -i --restart=Never --image=curlimages/curl -- curl -s -m 3 http://shipit-api.shipit/healthz || echo BLOCKED
# from web pods: no path to postgres
kubectl -n shipit exec deploy/shipit-web -- sh -c 'nc -w 3 postgres 5432 </dev/null && echo CONNECTED || echo BLOCKED'
```

5. Use the deployer identity like CI would:

```bash
kubectl auth can-i --list -n shipit --as system:serviceaccount:shipit:shipit-deployer | head -20
kubectl auth can-i create clusterroles --as system:serviceaccount:shipit:shipit-deployer
TOKEN=$(kubectl -n shipit create token shipit-deployer --duration 15m)
kubectl --token "$TOKEN" -n shipit get deploy
helm --kube-token "$TOKEN" -n shipit list
kubectl --token "$TOKEN" -n default get pods        # Forbidden
```

### Verify

- All acceptance tests from the lesson's Security section pass.
- `helm test` still succeeds (smoke tests are explicitly allowed).
- The three block tests print `BLOCKED`.

:::hint
Remember that with default-deny on both directions, each allowed connection needs an **egress** rule on the client and an **ingress** rule on the server, unless one side is outside the namespace (Envoy's namespace has no policies). Policy ports are **pod** ports (3000, 8080), not Service ports. If pods start failing probes after you enable the policies, your CNI is filtering node-to-pod traffic; add an `ipBlock` allow for the node CIDR (on kind, `docker network inspect kind` shows it).
:::

:::solution
`charts/shipit/templates/networkpolicies.yaml`:

```yaml
{{- if .Values.networkPolicies.enabled }}
{{- $gwNs := .Values.networkPolicies.gatewayNamespace }}
{{- $api := include "shipit.selectorLabels" (dict "ctx" . "name" "shipit-api") }}
{{- $web := include "shipit.selectorLabels" (dict "ctx" . "name" "shipit-web") }}
{{- $pg := include "shipit.selectorLabels" (dict "ctx" . "name" "postgres") }}
{{- $redis := include "shipit.selectorLabels" (dict "ctx" . "name" "redis") }}
# 1. Nothing in, nothing out, unless allowed below
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
spec:
  podSelector: {}
  policyTypes: ["Ingress", "Egress"]
---
# 2. Every pod may resolve names
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
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
# 3. Gateway (Envoy) -> web
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: web-from-gateway
spec:
  podSelector:
    matchLabels:
      {{- $web | nindent 6 }}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ $gwNs }}
      ports:
        - { protocol: TCP, port: 8080 }
---
# 4. Gateway and smoke tests -> api
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-ingress
spec:
  podSelector:
    matchLabels:
      {{- $api | nindent 6 }}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ $gwNs }}
        - podSelector:
            matchLabels:
              shipit.dev/role: smoke-test
      ports:
        - { protocol: TCP, port: 3000 }
---
# 5. api -> postgres and redis
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-egress
spec:
  podSelector:
    matchLabels:
      {{- $api | nindent 6 }}
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector:
            matchLabels:
              {{- $pg | nindent 14 }}
      ports:
        - { protocol: TCP, port: 5432 }
    - to:
        - podSelector:
            matchLabels:
              {{- $redis | nindent 14 }}
      ports:
        - { protocol: TCP, port: 6379 }
---
# 6. postgres <- api only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgres-from-api
spec:
  podSelector:
    matchLabels:
      {{- $pg | nindent 6 }}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              {{- $api | nindent 14 }}
      ports:
        - { protocol: TCP, port: 5432 }
---
# 7. redis <- api only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: redis-from-api
spec:
  podSelector:
    matchLabels:
      {{- $redis | nindent 6 }}
  policyTypes: ["Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              {{- $api | nindent 14 }}
      ports:
        - { protocol: TCP, port: 6379 }
---
# 8. smoke tests / game-day load -> api
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: smoke-test-egress
spec:
  podSelector:
    matchLabels:
      shipit.dev/role: smoke-test
  policyTypes: ["Egress"]
  egress:
    - to:
        - podSelector:
            matchLabels:
              {{- $api | nindent 14 }}
      ports:
        - { protocol: TCP, port: 3000 }
{{- end }}
```

`charts/shipit/templates/rbac.yaml`:

```yaml
# Identity for CI or an operator to deploy this app into this namespace only.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: shipit-deployer
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: shipit-deployer
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "replicasets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["services", "configmaps", "serviceaccounts", "persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["secrets"]          # Helm stores release state in Secrets in this namespace
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods", "pods/log", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "httproutes"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "rolebindings"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: shipit-deployer
  labels:
    {{- include "shipit.labels" . | nindent 4 }}
subjects:
  - kind: ServiceAccount
    name: shipit-deployer
    namespace: {{ .Release.Namespace }}
roleRef:
  kind: Role
  name: shipit-deployer
  apiGroup: rbac.authorization.k8s.io
```

Set `networkPolicies.enabled: true` in `values.yaml` and commit.

Notes:

- The Role grants Secrets access because Helm needs it. That makes the deployer effectively able to read the database password; with GitOps (next milestone) no CI identity needs cluster access at all, which is a strong argument for it.
- The deployer can `get` Roles and RoleBindings but not change them, so it cannot escalate its own permissions. Changing RBAC is a platform-team action.
- `helm --kube-token` works for any Helm command; CI would usually write a kubeconfig with the token instead.
:::

### Clean up

Keep everything.

## Milestone 7 (optional): Deliver it with Argo CD

:::meta
difficulty: hard
time: 40 min
:::

**Goal:** Argo CD owns the release: the chart in your Git repository is the source of truth, with automated sync, pruning and self-heal.

### Steps

1. Push your repository to GitHub (public, or add credentials to Argo CD for a private repo).
2. Install Argo CD as in module 12 (server-side apply), and log in to the UI.
3. Hand over the release: uninstall the Helm release **without** deleting data, then create an Argo CD `Application` for `charts/shipit`.

```bash
helm -n shipit uninstall shipit       # the PVC from volumeClaimTemplates is kept
kubectl -n shipit get pvc             # data-postgres-0 still Bound
```

4. Write `argocd/shipit-app.yaml` and apply it. Wait for `Synced` / `Healthy`.
5. Change something in Git (for example `web.replicas: 3`), push, and watch Argo CD apply it. Then `kubectl -n shipit scale deploy shipit-web --replicas=1` and watch self-heal revert it.

### Verify

- `kubectl -n argocd get application shipit` shows `Synced Healthy`.
- Items created before the hand-over are still listed (same PVC).
- Git changes reach the cluster without running Helm yourself.

:::hint
Argo CD renders the chart with `helm template` and applies the result; it does not create Helm release Secrets, so `helm list` shows nothing afterwards. Helm test hooks are not run by Argo CD; run your smoke test separately (for example as a post-sync Job). The image `shipit-api:1.0.0` only exists on your kind nodes, which is fine because `pullPolicy` is `IfNotPresent`.
:::

:::solution
```yaml
# argocd/shipit-app.yaml (replace <you>)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shipit
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/<you>/shipit-k8s.git
    targetRevision: main
    path: charts/shipit
    helm:
      releaseName: shipit
      valueFiles: ["values.yaml"]
  destination:
    server: https://kubernetes.default.svc
    namespace: shipit
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - ServerSideApply=true
```

```bash
kubectl apply -f argocd/shipit-app.yaml
kubectl -n argocd get application shipit -w
```

The namespace and Secrets stay outside the Application on purpose: the namespace belongs to the platform (with its PSA labels), and Secrets must not be in Git. In a full setup a second Application (or an app-of-apps) would manage `platform/`, and External Secrets would create `shipit-db` from a secret store.

`releaseName: shipit` keeps the `app.kubernetes.io/instance: shipit` label identical to the Helm install, so selectors match and the existing PVC is adopted by the StatefulSet.
:::

### Clean up

Keep everything for the game day. (If you skipped this milestone, continue with the Helm-managed release.)

## Milestone 8: Game day

:::meta
difficulty: hard
time: 60 min
:::

**Goal:** break the system on purpose, observe, and write down what happened versus what you expected. This is how teams find weaknesses before customers do. Record findings in `RUNBOOK.md`.

### Setup

Keep the Envoy port-forward running. In a dedicated terminal, run a probe loop that prints one status code per request:

```bash
while true; do
  printf '%s %s\n' "$(date +%T)" "$(curl -s -o /dev/null -m 2 -w '%{http_code}' --cacert ca.crt https://shipit.localtest.me:8443/api/items)"
  sleep 0.5
done
```

Open k9s in another terminal (`k9s -n shipit`) to watch pods.

### Scenarios

For each scenario: write your **prediction** first, run it, record the **observation**, and propose a **fix** if reality was worse than the requirement.

| # | Action | Command |
| --- | --- | --- |
| 1 | Kill an API pod | `kubectl -n shipit delete $(kubectl -n shipit get pod -l app.kubernetes.io/name=shipit-api -o name \| head -1)` |
| 2 | Bad deploy with automatic rollback | `helm upgrade shipit charts/shipit -n shipit --reuse-values --set api.image.tag=9.9.9 --wait --timeout 90s --rollback-on-failure` (with Argo CD: change the tag in Git and observe instead) |
| 3 | Load spike and autoscaling | `kubectl -n shipit run load --image=busybox:1.36 --labels=shipit.dev/role=smoke-test --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"load","image":"busybox:1.36","command":["sh","-c","while true; do wget -q -O /dev/null http://shipit-api/items; done"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"resources":{"requests":{"cpu":"100m","memory":"16Mi"},"limits":{"memory":"32Mi"}}}]}}'` then `kubectl -n shipit get hpa -w` |
| 4 | Redis dies | `kubectl -n shipit scale deploy redis --replicas=0`, wait 30 s, then scale back to 1 |
| 5 | Postgres pod dies | `kubectl -n shipit delete pod postgres-0` |
| 6 | Drain the node that runs Postgres | `kubectl drain $(kubectl -n shipit get pod postgres-0 -o jsonpath='{.spec.nodeName}') --ignore-daemonsets --delete-emptydir-data --timeout=120s`, observe, then `kubectl uncordon` it |
| 7 | Someone edits the cluster by hand | `kubectl -n shipit set env deploy/shipit-api LOG_LEVEL=trace` (Helm: drift persists; Argo CD: reverted) |
| 8 | Network path check | From a pod in `default`, try to reach `postgres.shipit:5432` and `redis.shipit:6379` |

### Verify

Your `RUNBOOK.md` has a table with prediction / observation / fix for every scenario, and at least two concrete improvements you would make before production.

:::hint
Watch the status codes, `kubectl -n shipit get endpointslices -w`, pod readiness and events. For scenario 6, check which node the PV is bound to: `kubectl get pv -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]`. Delete the `load` pod after scenario 3.
:::

:::solution
Expected observations and the lessons behind them:

1. **Kill an API pod**: no errors, or at most one, in the probe loop. The other replica serves; the Deployment replaces the pod; the new pod only gets traffic once `/readyz` passes. If you saw several 5xx, check the preStop delay and readiness `failureThreshold`.
2. **Bad deploy**: new pods sit in `ErrImagePull`, old pods keep serving (rolling update never removes ready pods before new ones are ready), and after 90 s Helm rolls back. Zero user impact. Without `--rollback-on-failure`, the release stays `failed` but traffic is still fine; the risk is the next deploy building on a broken state.
3. **Load spike**: CPU rises, the HPA scales the API towards 5 replicas within a minute or two; new pods spread across nodes. Cached reads are cheap, so you may need several load pods to cross 70%. After you delete the load, scale-down waits about 5 minutes (stabilisation window) by design.
4. **Redis dies**: every API pod's `/readyz` fails (it checks Redis), all endpoints become not ready, and the probe loop shows **503 for every request**, although Postgres could have served them. Finding: the readiness check treats an optional cache as a hard dependency. Fix: readiness should check only what the pod cannot work without (Postgres), and the code should fall back to the database when Redis is down (it already does for reads when `redis.isReady` is false). This is the single most valuable finding of the day.
5. **Postgres pod dies**: a short burst of 503s (API readiness fails while Postgres restarts), then recovery with all data intact. Finding: a single database instance means downtime on every restart. Fix: a managed database (RDS Multi-AZ) or an operator with replicas and automatic failover (CloudNativePG).
6. **Drain the Postgres node**: the drain evicts `postgres-0` (no PDB protects it; with `maxUnavailable: 1` on a 1-replica StatefulSet, eviction would be allowed anyway), and the new `postgres-0` stays **Pending**: its local-path PV has node affinity to the drained node. Outage until you uncordon. In AWS the equivalent is an EBS volume bound to one AZ: the pod can only move within that AZ. Fix: replicated database across zones, or managed database; never assume storage can follow a pod anywhere.
7. **Manual edit**: with Helm, the change silently stays until the next `helm upgrade` overwrites it (or does not, if you used `--reuse-values` on unrelated fields). With Argo CD self-heal it is reverted in seconds and visible in the UI history. Finding: restrict humans to read-only in prod; changes go through Git.
8. **Network path**: both connections time out from `default`. If they do not, your NetworkPolicies are not enforced or a rule is too broad.

A good `RUNBOOK.md` ends with prioritised actions, e.g.: (1) make `/readyz` independent of Redis; (2) move Postgres to a managed or replicated setup; (3) add a ServiceMonitor and alerts on 5xx ratio and `kube_deployment_status_replicas_available`; (4) add a PDB for Postgres once it has replicas; (5) manage Secrets with External Secrets.

Congratulations: you have shipped a realistic multi-tier application to Kubernetes, secured it, and broken it on purpose.
:::

### Clean up

```bash
kubectl -n shipit delete pod load --ignore-not-found
kind delete cluster --name shipit
```

Keep the repository; it is a strong portfolio piece and interview talking point.
