One kind cluster for the whole module:

```bash
kind create cluster --name gitops
helm version          # Helm 4 assumed; with Helm 3 replace --rollback-on-failure by --atomic
mkdir -p ~/k8s-gitops && cd ~/k8s-gitops
```

Lab 6 needs a GitHub account (a free public repository). When you are done: `kind delete cluster --name gitops`.

## Lab 1: Helm as a consumer — install, upgrade, roll back

:::meta
difficulty: easy
time: 20 min
:::

**Goal:** drive the full release lifecycle with a well-maintained public chart (podinfo, published as an OCI artifact) and see where Helm keeps its state.

### Steps

1. Inspect the chart before installing it:

```bash
helm show chart  oci://ghcr.io/stefanprodan/charts/podinfo
helm show values oci://ghcr.io/stefanprodan/charts/podinfo | less
```

2. Install it with your own values file:

```bash
cat > podinfo-values.yaml <<'EOF'
replicaCount: 2
ui:
  message: "Hello from revision 1"
resources:
  requests: { cpu: 10m, memory: 32Mi }
  limits: { memory: 64Mi }
EOF
helm install podinfo oci://ghcr.io/stefanprodan/charts/podinfo \
  -n demo --create-namespace -f podinfo-values.yaml --wait
helm list -n demo
kubectl -n demo get deploy,svc,pods
```

3. Look at the release state Helm stored:

```bash
kubectl -n demo get secrets -l owner=helm
helm get values podinfo -n demo
helm get manifest podinfo -n demo | head -30
```

4. Upgrade twice: change the message (revision 2), then deliberately break it with a non-existent image tag and a short timeout (revision 3):

```bash
sed -i '' 's/revision 1/revision 2/' podinfo-values.yaml     # macOS sed; on Linux: sed -i
helm upgrade podinfo oci://ghcr.io/stefanprodan/charts/podinfo -n demo -f podinfo-values.yaml --wait

helm upgrade podinfo oci://ghcr.io/stefanprodan/charts/podinfo -n demo -f podinfo-values.yaml \
  --set image.tag=does-not-exist --wait --timeout 60s
helm history podinfo -n demo
```

5. Roll back to revision 2, then repeat the broken upgrade with automatic rollback:

```bash
helm rollback podinfo 2 -n demo --wait
helm upgrade podinfo oci://ghcr.io/stefanprodan/charts/podinfo -n demo -f podinfo-values.yaml \
  --set image.tag=does-not-exist --timeout 60s --rollback-on-failure
helm history podinfo -n demo
```

### Verify

- `helm history` shows revision 3 as `failed`, revision 4 as a rollback to 2, then a failed revision followed by an automatic rollback.
- `kubectl -n demo port-forward svc/podinfo 9898:9898` and `curl -s localhost:9898 | grep message` shows "Hello from revision 2".

:::hint
If `sed -i ''` fails you are on GNU sed; use `sed -i 's/.../.../'`. Each rollback creates a **new** revision number; Helm never rewrites history.
:::

:::solution
Expected `helm history podinfo -n demo` at the end (descriptions abbreviated):

```text
REVISION  STATUS      DESCRIPTION
1         superseded  Install complete
2         superseded  Upgrade complete
3         failed      Upgrade "podinfo" failed: ... context deadline exceeded
4         superseded  Rollback to 2
5         failed      Upgrade "podinfo" failed: ...
6         deployed    Rollback to 4
```

During the failed upgrade without automatic rollback, the Deployment was left mid-rollout: old pods kept serving (thanks to the rolling update strategy) while new pods sat in `ImagePullBackOff`. That half-applied state is what `--rollback-on-failure` (`--atomic` in Helm 3) prevents in pipelines.
:::

### Clean up

```bash
helm uninstall podinfo -n demo && kubectl delete ns demo
```

## Lab 2: Write a Helm chart for shipit-api

:::meta
difficulty: medium
time: 60 min
:::

**Goal:** build the shipit-api image, write a chart for it with secure defaults, probes, a config checksum and a test hook, install it against throwaway Postgres and Redis, then package and push it to a local OCI registry.

### Steps

1. Create the app (skip if you have shipit-api from earlier tracks):

```bash
mkdir -p ~/k8s-gitops/shipit-api/src && cd ~/k8s-gitops/shipit-api
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
kind load docker-image shipit-api:1.0.0 --name gitops
```

2. Start throwaway dependencies (dev only: no persistence):

```bash
cd ~/k8s-gitops
cat > deps.yaml <<'EOF'
apiVersion: v1
kind: Secret
metadata: { name: shipit-db }
stringData:
  url: postgres://shipit:shipit@postgres:5432/shipit
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: postgres }
spec:
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:17
          env:
            - { name: POSTGRES_USER, value: shipit }
            - { name: POSTGRES_PASSWORD, value: shipit }
            - { name: POSTGRES_DB, value: shipit }
          ports: [{ containerPort: 5432 }]
---
apiVersion: v1
kind: Service
metadata: { name: postgres }
spec:
  selector: { app: postgres }
  ports: [{ port: 5432 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: redis }
spec:
  selector: { matchLabels: { app: redis } }
  template:
    metadata: { labels: { app: redis } }
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports: [{ containerPort: 6379 }]
---
apiVersion: v1
kind: Service
metadata: { name: redis }
spec:
  selector: { app: redis }
  ports: [{ port: 6379 }]
EOF
kubectl create namespace shipit
kubectl -n shipit apply -f deps.yaml
```

3. Scaffold the chart and remove what you will not use yet:

```bash
mkdir -p charts && cd charts && helm create shipit-api && cd shipit-api
rm -f templates/ingress.yaml templates/httproute.yaml     # recent Helm versions also scaffold an HTTPRoute
ls templates templates/tests
```

4. Now make it yours. Requirements:
   - `appVersion: "1.0.0"`, image `shipit-api` with `pullPolicy: IfNotPresent` (it was loaded into kind, not pulled).
   - Container port 3000 named `http`; Service port 80 → `http`.
   - Liveness probe `GET /healthz`, readiness probe `GET /readyz`.
   - A ConfigMap with `PORT`, `REDIS_URL` and `LOG_LEVEL` from values, loaded with `envFrom`, plus a `checksum/config` pod annotation.
   - `DATABASE_URL` from an existing Secret named by `.Values.database.existingSecret` (key `url`), failing rendering with a clear message if unset.
   - Restricted-compliant security context, read-only root filesystem, no ServiceAccount token.
   - `replicas` omitted when autoscaling is enabled.
   - A test hook that calls `/healthz` through the Service.

5. Render, lint and install:

```bash
cd ~/k8s-gitops
helm lint charts/shipit-api
helm template shipit charts/shipit-api | less
helm upgrade --install shipit charts/shipit-api -n shipit --wait --timeout 3m --rollback-on-failure
helm test shipit -n shipit
```

6. Exercise it:

```bash
kubectl -n shipit port-forward svc/shipit-shipit-api 8080:80 &
curl -s localhost:8080/readyz
curl -s -XPOST localhost:8080/items -H 'content-type: application/json' -d '{"name":"first"}'
curl -si localhost:8080/items | grep -i x-cache     # miss
curl -si localhost:8080/items | grep -i x-cache     # hit (cached in Redis for 30 s)
kill %1
```

7. Change `config.logLevel` in values, `helm upgrade` again and watch the pods roll (`kubectl -n shipit get pods -w`) because the checksum changed.

8. Package and push to a local OCI registry, then install from it:

```bash
docker run -d --name registry -p 5001:5000 registry:2
helm package charts/shipit-api               # shipit-api-0.1.0.tgz
helm push shipit-api-0.1.0.tgz oci://localhost:5001/charts --plain-http
helm show chart oci://localhost:5001/charts/shipit-api --version 0.1.0 --plain-http
```

### Verify

- `helm test shipit -n shipit` reports `Phase: Succeeded`.
- `/readyz` returns `{"status":"ready"}`; the second `GET /items` shows `x-cache: hit`.
- `helm template shipit charts/shipit-api --set database.existingSecret=` fails with your `required` message.
- `kubectl -n shipit get pod -l app.kubernetes.io/name=shipit-api -o jsonpath='{.items[0].spec.automountServiceAccountToken}'` prints `false`.

:::hint
Keep `_helpers.tpl`, `serviceaccount.yaml` and `hpa.yaml` from the scaffold; they only need the `nameOverride`, `fullnameOverride`, `serviceAccount.*` and `autoscaling.*` values to exist. Rewrite `values.yaml`, `deployment.yaml`, `service.yaml`, `NOTES.txt` (the scaffold's version references `ingress`/`httpRoute` values you removed) and the test. Use `include (print $.Template.BasePath "/configmap.yaml") . | sha256sum` for the checksum.
:::

:::solution
`charts/shipit-api/Chart.yaml`:

```yaml
apiVersion: v2
name: shipit-api
description: shipit HTTP API (Node.js, Postgres, Redis)
type: application
version: 0.1.0
appVersion: "1.0.0"
```

`charts/shipit-api/values.yaml`:

```yaml
replicaCount: 2

image:
  repository: shipit-api
  tag: ""                 # defaults to .Chart.AppVersion
  pullPolicy: IfNotPresent

nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  automount: false
  annotations: {}
  name: ""

podAnnotations: {}

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  seccompProfile:
    type: RuntimeDefault

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]

service:
  type: ClusterIP
  port: 80

config:
  logLevel: info
  redisUrl: redis://redis:6379

database:
  existingSecret: shipit-db     # Secret with key "url"

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    memory: 256Mi

autoscaling:
  enabled: false
  minReplicas: 2
  maxReplicas: 5
  targetCPUUtilizationPercentage: 70

nodeSelector: {}
tolerations: []
affinity: {}
```

`templates/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
data:
  PORT: "3000"
  LOG_LEVEL: {{ .Values.config.logLevel | quote }}
  REDIS_URL: {{ .Values.config.redisUrl | quote }}
```

`templates/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "shipit-api.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      labels:
        {{- include "shipit-api.selectorLabels" . | nindent 8 }}
    spec:
      serviceAccountName: {{ include "shipit-api.serviceAccountName" . }}
      automountServiceAccountToken: false
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          securityContext:
            {{- toYaml .Values.securityContext | nindent 12 }}
          ports:
            - name: http
              containerPort: 3000
          envFrom:
            - configMapRef:
                name: {{ include "shipit-api.fullname" . }}
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ required "database.existingSecret is required" .Values.database.existingSecret }}
                  key: url
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
            failureThreshold: 3
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

`templates/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  selector:
    {{- include "shipit-api.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
```

`templates/tests/test-connection.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: "{{ include "shipit-api.fullname" . }}-test"
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
  annotations:
    "helm.sh/hook": test
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  restartPolicy: Never
  containers:
    - name: curl
      image: curlimages/curl
      args: ["-sf", "-m", "5", "http://{{ include "shipit-api.fullname" . }}:{{ .Values.service.port }}/healthz"]
```

`templates/NOTES.txt`:

```text
shipit-api {{ .Chart.AppVersion }} installed as release {{ .Release.Name }}.

Try it:
  kubectl -n {{ .Release.Namespace }} port-forward svc/{{ include "shipit-api.fullname" . }} 8080:{{ .Values.service.port }}
  curl localhost:8080/readyz
```

With release name `shipit` and chart name `shipit-api`, the `fullname` helper produces `shipit-shipit-api` (release name does not contain the chart name). Use `--set fullnameOverride=shipit-api` if you prefer a shorter name.

If the pods are not ready, check `kubectl -n shipit logs deploy/shipit-shipit-api`: the API logs `db not ready` until Postgres accepts connections, and `/readyz` stays 503 until both dependencies respond, which is exactly what readiness is for.
:::

### Clean up

Keep the release and the `shipit` namespace if you continue with Lab 3 right away; otherwise:

```bash
helm uninstall shipit -n shipit; kubectl delete ns shipit
docker rm -f registry
```

## Lab 3: Break & fix — a chart that will not render, test or upgrade

:::meta
difficulty: medium
time: 35 min
:::

**Goal:** a colleague's chart `greeter` has four bugs that surface at different stages: rendering, YAML parsing, `helm test`, and the second upgrade. Find and fix each from the error messages alone.

### Steps

1. Create the chart exactly as given:

```bash
mkdir -p ~/k8s-gitops/greeter/templates/tests && cd ~/k8s-gitops/greeter
cat > Chart.yaml <<'EOF'
apiVersion: v2
name: greeter
version: 0.1.0
appVersion: "1.0"
EOF
cat > values.yaml <<'EOF'
replicaCount: 2
image: hashicorp/http-echo:1.0
message: hello from greeter
service:
  port: 80
EOF
cat > templates/_helpers.tpl <<'EOF'
{{- define "greeter.labels" -}}
app.kubernetes.io/name: greeter
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
EOF
cat > templates/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-greeter
  labels: {{ include "greeter.labels" . | indent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "greeter.labels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "greeter.labels" . | nindent 8 }}
    spec:
      containers:
        - name: greeter
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          args: ["-text={{ .Values.message }}", "-listen=:5678"]
          ports:
            - name: http
              containerPort: 5678
EOF
cat > templates/service.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-greeter
spec:
  selector:
    {{- include "greeter.labels" . | nindent 4 }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: 8080
EOF
cat > templates/tests/test-greeting.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: {{ .Release.Name }}-greeter-test
  annotations:
    "helm.sh/hook": test
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  restartPolicy: Never
  containers:
    - name: curl
      image: curlimages/curl
      args: ["-sf", "-m", "5", "http://{{ .Release.Name }}-greeter:{{ .Values.service.port }}"]
EOF
cd ..
```

2. Try to render it. Fix errors one at a time until `helm template g ./greeter` produces valid YAML and `helm lint ./greeter` passes.

3. Install and test:

```bash
helm install g ./greeter -n greet --create-namespace --wait
helm test g -n greet
```

Fix the chart so the test passes (`helm upgrade g ./greeter -n greet --wait`, then test again).

4. Ship "version 1.1": set `appVersion: "1.1"` and `version: 0.2.0` in `Chart.yaml`, then:

```bash
helm upgrade g ./greeter -n greet --wait
```

Read the error, fix the chart so future version bumps never cause it again, and get release `g` running the new version.

### Verify

- `helm lint ./greeter` → `0 chart(s) failed`.
- `helm test g -n greet` → `Phase: Succeeded`.
- Bumping `appVersion` again (say `"1.2"`) and upgrading succeeds without errors.

:::hint
Error 1 mentions `can't evaluate field repository in type interface {}`: what type is `.Values.image`? Error 2 is a YAML parse error: render with `--debug` to see the broken output, and compare `indent` with `nindent`. For the test, compare the Service's `targetPort` with the container's port. For the upgrade, the message contains `field is immutable`: which field contains the version?
:::

:::solution
**Bug 1 (render):** `values.yaml` defines `image` as a string, but the template reads `.Values.image.repository`. Make values match the template:

```yaml
image:
  repository: hashicorp/http-echo
  tag: "1.0"
```

**Bug 2 (YAML):** `labels: {{ include ... | indent 4 }}` puts the first label on the same line as `labels:`. Use `nindent` on its own line:

```yaml
  labels:
    {{- include "greeter.labels" . | nindent 4 }}
```

**Bug 3 (`helm test`):** the Service sends traffic to `targetPort: 8080`, but http-echo listens on 5678. Use the named port: `targetPort: http`.

**Bug 4 (upgrade):** the selector uses `greeter.labels`, which includes `app.kubernetes.io/version`. Bumping `appVersion` changes `spec.selector`, which is immutable: `Deployment.apps "g-greeter" is invalid: spec.selector: ... field is immutable`. Split the helpers:

```yaml
{{- define "greeter.selectorLabels" -}}
app.kubernetes.io/name: greeter
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "greeter.labels" -}}
{{ include "greeter.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
```

Use `greeter.selectorLabels` in `spec.selector.matchLabels` and in the Service's `selector`; keep `greeter.labels` for `metadata.labels` and the pod template labels.

The existing Deployment still has the old selector, so this upgrade also changes it and fails once more. You must replace the object. In dev the simple path is:

```bash
helm uninstall g -n greet && helm install g ./greeter -n greet --wait && helm test g -n greet
```

In production you would avoid downtime by deleting only the Deployment object while keeping its pods (`kubectl delete deploy g-greeter --cascade=orphan -n greet`) and then running the upgrade, or by rolling out under a new Deployment name. This is why getting selector labels right on day one matters.
:::

### Clean up

```bash
helm uninstall g -n greet; kubectl delete ns greet
```

## Lab 4: Kustomize bases and overlays

:::meta
difficulty: medium
time: 30 min
:::

**Goal:** model `dev` and `prod` for the greeter app with plain YAML: a shared base, overlays that change namespace, replicas, resources, configuration and naming, using generators and the images transformer.

### Steps

1. Create the base:

```bash
mkdir -p ~/k8s-gitops/greeter-kustomize/{base,overlays/dev,overlays/prod} && cd ~/k8s-gitops/greeter-kustomize
cat > base/deployment.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: greeter
spec:
  replicas: 1
  selector:
    matchLabels: { app: greeter }
  template:
    metadata:
      labels: { app: greeter }
    spec:
      containers:
        - name: greeter
          image: greeter                      # placeholder, set by the images transformer
          args: ["-text=$(GREETING)", "-listen=:5678"]
          env:
            - name: GREETING
              valueFrom:
                configMapKeyRef: { name: greeter-config, key: GREETING }
          ports:
            - containerPort: 5678
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
EOF
cat > base/service.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: greeter
spec:
  selector: { app: greeter }
  ports:
    - port: 80
      targetPort: 5678
EOF
cat > base/kustomization.yaml <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
labels:
  - pairs:
      app.kubernetes.io/part-of: greeter
images:
  - name: greeter
    newName: hashicorp/http-echo
    newTag: "1.0"
configMapGenerator:
  - name: greeter-config
    literals:
      - GREETING=hello from base
EOF
kubectl kustomize base
```

2. Write the overlays:
   - **dev**: namespace `greeter-dev`, name prefix `dev-`, GREETING `hello from dev`.
   - **prod**: namespace `greeter-prod`, 3 replicas, memory limit 64Mi and request 32Mi via a strategic-merge patch, GREETING `hello from prod`, an extra label `env: prod`.

3. Render both and diff them:

```bash
diff <(kubectl kustomize overlays/dev) <(kubectl kustomize overlays/prod)
```

4. Apply both and test:

```bash
kubectl create ns greeter-dev; kubectl create ns greeter-prod
kubectl apply -k overlays/dev && kubectl apply -k overlays/prod
kubectl -n greeter-prod run t --rm -i --restart=Never --image=curlimages/curl -- curl -s greeter
kubectl -n greeter-dev  run t --rm -i --restart=Never --image=curlimages/curl -- curl -s dev-greeter
```

5. Change the prod greeting, re-apply, and watch the generated ConfigMap name change and the Deployment roll:

```bash
kubectl -n greeter-prod get cm
kubectl -n greeter-prod get pods -w
```

### Verify

- Prod returns `hello from prod` with 3 pods; dev returns `hello from dev` from `dev-greeter`.
- After step 5 there are two `greeter-config-<hash>` ConfigMaps in `greeter-prod` and new pods.

:::hint
Overlay generators need `behavior: merge` to modify a ConfigMap defined in the base. `namePrefix` also renames the ConfigMap and kustomize rewrites the `configMapKeyRef` for you. A strategic merge patch only needs `apiVersion`, `kind`, `metadata.name` and the fields you change; containers are matched by `name`.
:::

:::solution
```yaml
# overlays/dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: greeter-dev
namePrefix: dev-
resources:
  - ../../base
configMapGenerator:
  - name: greeter-config
    behavior: merge
    literals:
      - GREETING=hello from dev
```

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: greeter-prod
resources:
  - ../../base
labels:
  - pairs:
      env: prod
replicas:
  - name: greeter
    count: 3
configMapGenerator:
  - name: greeter-config
    behavior: merge
    literals:
      - GREETING=hello from prod
patches:
  - path: resources.yaml
```

```yaml
# overlays/prod/resources.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: greeter
spec:
  template:
    spec:
      containers:
        - name: greeter
          resources:
            requests: { cpu: 20m, memory: 32Mi }
            limits: { memory: 64Mi }
```

Notes: `labels` without `includeSelectors: true` adds labels to metadata only, so the immutable selector is untouched. Old generated ConfigMaps are not deleted by `kubectl apply -k`; GitOps tools with pruning (next labs) clean them up.
:::

### Clean up

```bash
kubectl delete -k overlays/dev; kubectl delete -k overlays/prod; kubectl delete ns greeter-dev greeter-prod
```

## Lab 5: GitOps with Argo CD on kind

:::meta
difficulty: hard
time: 45 min
:::

**Goal:** install Argo CD, deploy an app from a public Git repository, and watch sync status, health, drift detection and self-heal.

### Steps

1. Install Argo CD (server-side apply is required because its CRDs are large):

```bash
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deploy/argocd-server --timeout=5m
kubectl -n argocd get pods
```

2. Open the UI (keep this terminal running) and log in as `admin`:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n argocd port-forward svc/argocd-server 8443:443
```

Browse to https://localhost:8443 and accept the self-signed certificate. Optionally install the CLI: `brew install argocd`, then `argocd login localhost:8443 --insecure --username admin`.

3. Create an Application **without** automated sync, pointing at podinfo's Kustomize directory:

```bash
cat > podinfo-app.yaml <<'EOF'
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: podinfo
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/stefanprodan/podinfo.git
    targetRevision: master
    path: kustomize
  destination:
    server: https://kubernetes.default.svc
    namespace: podinfo
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
EOF
kubectl apply -f podinfo-app.yaml
kubectl -n argocd get application podinfo
```

The app is `OutOfSync` / `Missing`: Argo CD knows the desired state but has not applied it.

4. Sync manually (UI "Sync" button, or `argocd app sync podinfo`, or with kubectl):

```bash
kubectl -n argocd patch application podinfo --type merge \
  -p '{"operation":{"initiatedBy":{"username":"admin"},"sync":{"revision":"master"}}}'
kubectl -n argocd get application podinfo -w      # wait for Synced / Healthy, then Ctrl-C
kubectl -n podinfo get deploy,svc,hpa
```

5. Create drift and observe detection without self-heal:

```bash
kubectl -n podinfo delete svc podinfo
kubectl -n argocd get application podinfo          # OutOfSync
```

In the UI, open the app and click "Diff".

6. Turn on automated sync with self-heal and prune, then drift again:

```bash
kubectl -n argocd patch application podinfo --type merge \
  -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'
kubectl -n podinfo get svc podinfo                  # recreated by the automated sync
kubectl -n podinfo delete svc podinfo; sleep 10; kubectl -n podinfo get svc podinfo
kubectl -n podinfo set image deploy/podinfo podinfod=ghcr.io/stefanprodan/podinfo:6.0.0
kubectl -n podinfo get deploy podinfo -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

### Verify

- The Service comes back within seconds after deletion once self-heal is on.
- The image reverts to the tag in Git shortly after your `set image`.
- `kubectl -n argocd get application podinfo -o jsonpath='{.status.sync.status} {.status.health.status}'` prints `Synced Healthy`.

:::hint
If health stays `Progressing`, check `kubectl -n podinfo get pods`: podinfo's HPA needs metrics-server for its status, but the Deployment itself should become ready. If the Application shows a `ComparisonError`, check `kubectl -n argocd logs deploy/argocd-repo-server` for Git access problems (proxy, DNS).
:::

:::solution
The commands above are the solution. What happened underneath:

- The **repo-server** cloned the repo and ran `kustomize build kustomize/`.
- The **application-controller** compared the rendered objects with live objects (sync status) and evaluated resource health (health status).
- A manual sync is an `operation` on the Application. With `automated`, the controller starts a sync whenever Git changes or, with `selfHeal: true`, whenever live state drifts from Git.
- `prune: true` would delete resources that disappear from Git; without it they are shown as orphaned/OutOfSync but left alone.

The same Application could point at a Helm chart in Git (`source.helm.valueFiles`) or at a chart in a Helm/OCI repository (`source.chart` + `targetRevision: <chart version>`).
:::

### Clean up

Keep Argo CD for Lab 6. Remove the app (its resources are not deleted unless the Application has the resources finalizer):

```bash
kubectl -n argocd delete application podinfo
kubectl delete ns podinfo
```

## Lab 6: Challenge — your own GitOps repository with dev and prod

:::meta
difficulty: hard
time: 60 min
:::

**Goal:** run the greeter app from Lab 4 entirely through Git. No step-by-step; the solution shows one way.

### Requirements

1. A public GitHub repository `shipit-config` containing the Kustomize base and overlays from Lab 4 under `greeter/`.
2. Argo CD deploys **both** environments from that repo using **one** `ApplicationSet` (list generator with `dev` and `prod`).
3. Automated sync with pruning and self-heal; namespaces are created automatically.
4. Prove each GitOps property with a commit:
   - **Promotion:** change the prod greeting in Git; prod changes, dev does not.
   - **Rollback:** `git revert` the change; prod returns to the previous greeting.
   - **Pruning:** add a ConfigMap `greeter-extra` to the base, push, see it in both namespaces; remove it from Git, push, see it disappear.
   - **Self-heal:** `kubectl scale` the prod Deployment to 1; it returns to 3.

### Verify

```bash
kubectl -n argocd get applicationset,applications
kubectl -n greeter-prod run t --rm -i --restart=Never --image=curlimages/curl -- curl -s greeter
kubectl -n greeter-dev  run t --rm -i --restart=Never --image=curlimages/curl -- curl -s dev-greeter
```

:::hint
Argo CD polls Git about every 3 minutes by default. To speed things up, click "Refresh" in the UI or annotate the Application: `kubectl -n argocd annotate application greeter-prod argocd.argoproj.io/refresh=normal --overwrite`. ApplicationSets with `goTemplate: true` use `{{.env}}` placeholders.
:::

:::solution
Repository setup:

```bash
cd ~/k8s-gitops
mkdir shipit-config && cp -r greeter-kustomize shipit-config/greeter && cd shipit-config
git init -b main && git add . && git commit -m "greeter base and overlays"
gh repo create shipit-config --public --source . --push      # or create it in the GitHub UI and git push
```

`greeter-appset.yaml` (replace `<you>`):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: greeter
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - list:
        elements:
          - env: dev
          - env: prod
  template:
    metadata:
      name: 'greeter-{{.env}}'
    spec:
      project: default
      source:
        repoURL: https://github.com/<you>/shipit-config.git
        targetRevision: main
        path: 'greeter/overlays/{{.env}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: 'greeter-{{.env}}'
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

```bash
kubectl apply -f greeter-appset.yaml
kubectl -n argocd get applications            # greeter-dev, greeter-prod
```

Promotion and rollback:

```bash
sed -i '' 's/hello from prod/hello from prod v2/' greeter/overlays/prod/kustomization.yaml
git commit -am "prod: new greeting" && git push
# wait / refresh, then curl prod: "hello from prod v2"; dev unchanged
git revert --no-edit HEAD && git push
```

Pruning:

```bash
cat > greeter/base/extra.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: greeter-extra
data:
  note: managed by git
EOF
# add "- extra.yaml" under resources: in greeter/base/kustomization.yaml (edit by hand), then:
git add . && git commit -m "add extra cm" && git push
# appears as greeter-extra in greeter-prod and dev-greeter-extra in greeter-dev
git rm greeter/base/extra.yaml && sed -i '' '/extra.yaml/d' greeter/base/kustomization.yaml
git commit -am "remove extra cm" && git push
```

Self-heal:

```bash
kubectl -n greeter-prod scale deploy greeter --replicas=1
kubectl -n greeter-prod get deploy greeter -w     # back to 3 within seconds
```

Notice what you never needed: cluster credentials outside the cluster. In a real setup CI would only push commits (image tag bumps) to this repository.
:::

### Clean up

```bash
kubectl -n argocd delete applicationset greeter
kubectl delete ns greeter-dev greeter-prod --ignore-not-found
kind delete cluster --name gitops
docker rm -f registry 2>/dev/null
```
