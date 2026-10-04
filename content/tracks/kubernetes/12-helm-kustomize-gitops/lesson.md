By now you have written a lot of YAML for shipit: Deployments, Services, ConfigMaps, Secrets, HPAs, NetworkPolicies. Real teams run the same app in `dev`, `staging` and `prod`, with different replicas, image tags, hostnames and resource limits, and they deploy dozens of third-party components (Argo CD, Prometheus, cert-manager). Copy-pasting YAML per environment does not scale. This module covers the two standard answers to "how do I parameterise manifests" (Helm and Kustomize) and the standard answer to "how do changes get into the cluster" (GitOps).

```text
                 ┌───────────── how manifests are produced ─────────────┐
 values.yaml ──► │  Helm: Go templates + values  →  rendered YAML        │
 overlays/   ──► │  Kustomize: base YAML + patches →  rendered YAML      │
                 └─────────────────────────┬─────────────────────────────┘
                                           │
                 ┌───────────── how they reach the cluster ─────────────┐
                 │  push: you / CI run helm upgrade or kubectl apply     │
                 │  pull (GitOps): Argo CD / Flux in the cluster watches │
                 │                 Git and applies continuously          │
                 └───────────────────────────────────────────────────────┘
```

## Helm: the mental model

Helm is a package manager for Kubernetes. Three terms:

- **Chart**: a package, a directory (or `.tgz`) with templates, default values and metadata.
- **Release**: one installation of a chart in a cluster, with a name (`helm install shipit ./chart` creates release `shipit`). You can install the same chart many times under different release names.
- **Revision**: every install, upgrade or rollback creates a new numbered revision of the release.

Helm has no server component. The CLI renders templates locally, sends the resulting objects to the API server, and records the release state as a Secret in the release's namespace:

```bash
kubectl get secrets -n shipit -l owner=helm
# sh.helm.release.v1.shipit.v1   helm.sh/release.v1   ...
# sh.helm.release.v1.shipit.v2   helm.sh/release.v1   ...
```

Each Secret holds the rendered manifest, the values used and the chart metadata for that revision. That is how `helm rollback` and `helm get values` work, and why deleting those Secrets makes Helm "forget" a release while leaving its resources running.

:::info Helm 4
Helm 4 was released in late 2025, and Helm 3 is in its end-of-life phase. For day-to-day use the commands are the same. Notable changes: new installs use **server-side apply** by default, `--wait` uses kstatus for richer readiness checks, `--atomic` is renamed `--rollback-on-failure` and `--force` is renamed `--force-replace` (the old names still work with a deprecation warning), post-renderers are plugins, and charts can be installed by OCI digest. Charts with `apiVersion: v2` work unchanged. Check yours with `helm version`.
:::

## Using charts

```bash
# OCI registries (the modern way): no "repo add" needed
helm show values oci://ghcr.io/stefanprodan/charts/podinfo | head -40
helm install podinfo oci://ghcr.io/stefanprodan/charts/podinfo -n demo --create-namespace \
  --set replicaCount=2

# Classic HTTP chart repositories
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm search repo prometheus-community/kube-prometheus-stack --versions | head

# Lifecycle
helm list -A
helm status podinfo -n demo
helm upgrade podinfo oci://ghcr.io/stefanprodan/charts/podinfo -n demo --reuse-values --set replicaCount=3
helm history podinfo -n demo
helm rollback podinfo 1 -n demo
helm get values podinfo -n demo          # user-supplied values (add --all for merged)
helm get manifest podinfo -n demo        # exactly what Helm applied
helm uninstall podinfo -n demo
```

The command you will use in CI and scripts is the idempotent form:

```bash
helm upgrade --install shipit ./charts/shipit-api \
  -n shipit --create-namespace \
  -f values/prod.yaml \
  --set image.tag="$GIT_SHA" \
  --wait --timeout 5m \
  --rollback-on-failure          # Helm 3: --atomic
```

- `--wait` blocks until Deployments are rolled out, pods ready, PVCs bound, Jobs done (with hooks).
- `--rollback-on-failure` (`--atomic`) rolls back automatically if the upgrade fails or times out, so a bad deploy does not stay half-applied. It implies `--wait`.
- **Pin chart versions** with `--version` for third-party charts. "Latest" in a pipeline means surprise upgrades.

:::warning Avoid --reuse-values in pipelines
`--reuse-values` takes the previous release's values and ignores new defaults added to the chart's `values.yaml`. Upgrading a chart with it can produce templates that reference values that do not exist. In automation, always pass the full set of values files explicitly. (`--reset-then-reuse-values` exists as a middle ground.)
:::

:::warning Third-party chart sources
Bitnami moved most of its free charts and images behind a paid offering in 2025, and many tutorials still point at them. Prefer charts published by the project itself (Argo CD, Prometheus community, Grafana, Kyverno, cert-manager, Envoy Gateway all publish their own), and check where the chart's default images come from.
:::

:::mac Tooling on macOS
`brew install helm kustomize argocd` gets you the CLIs (kubectl already embeds kustomize). When you build a local image for a chart on Apple Silicon and load it with `kind load docker-image`, it is `linux/arm64`, matching the kind nodes. If `kind load` fails with a "content digest not found" error, Docker Desktop's containerd image store is holding a multi-platform image: rebuild with `--platform linux/arm64` (or use `docker save img | docker exec -i <node> ctr -n k8s.io images import -` as a workaround).
:::

### Values precedence

From lowest to highest priority:

```text
chart's values.yaml  <  parent chart's values (for subcharts)  <  -f file1.yaml  <  -f file2.yaml  <  --set / --set-string / --set-file
```

Later `-f` files override earlier ones, and maps merge deeply while lists are replaced wholesale. Use `-f values/base.yaml -f values/prod.yaml` for environment layering, and reserve `--set` for things only known at deploy time, like the image tag.

## Writing a chart

```bash
helm create shipit-api
```

```text
shipit-api/
  Chart.yaml            # name, version (chart), appVersion (app), dependencies
  values.yaml           # defaults, the chart's public API
  values.schema.json    # optional JSON Schema; helm validates values against it
  templates/
    _helpers.tpl        # named templates (no output on its own: files starting with _ are not rendered)
    deployment.yaml
    service.yaml
    serviceaccount.yaml
    hpa.yaml
    ingress.yaml        # delete it if you use Gateway API and add an httproute.yaml
    NOTES.txt           # printed after install
    tests/
      test-connection.yaml
  .helmignore
```

`Chart.yaml`:

```yaml
apiVersion: v2
name: shipit-api
description: shipit HTTP API
type: application
version: 0.1.0        # chart version (SemVer). Bump on every chart change.
appVersion: "1.0.0"   # default image tag; informational otherwise
```

### Templates in five minutes

Templates are Go `text/template` plus the Sprig function library and a few Helm extras. The objects you use most:

| Object | Contains |
| --- | --- |
| `.Values` | merged values |
| `.Release.Name`, `.Release.Namespace`, `.Release.Revision`, `.Release.IsUpgrade` | release info |
| `.Chart.Name`, `.Chart.Version`, `.Chart.AppVersion` | Chart.yaml |
| `.Capabilities.KubeVersion`, `.Capabilities.APIVersions.Has "gateway.networking.k8s.io/v1"` | cluster info |
| `.Files.Get "config/app.json"` | non-template files in the chart |

```yaml
# templates/deployment.yaml (excerpt)
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
      labels:
        {{- include "shipit-api.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ required "database.existingSecret is required" .Values.database.existingSecret }}
                  key: url
          {{- with .Values.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
```

The pieces to know:

- `{{-` and `-}}` trim whitespace before/after. Most indentation bugs come from getting these wrong.
- `include "name" .` renders a named template and returns a string so you can pipe it to `nindent` (newline + indent). Prefer `include` over `template`, which cannot be piped.
- `toYaml` turns a values subtree into YAML; combined with `with`, users can pass any resources/affinity/tolerations block without you templating each field.
- `default`, `required`, `quote`, `ternary`, `tpl`, `lookup` (reads live objects; returns empty in `helm template`).
- The `checksum/config` annotation changes whenever the ConfigMap changes, which changes the pod template, which triggers a rolling restart. This solves "I changed the ConfigMap but pods still use the old values".

Named templates live in `_helpers.tpl`:

```yaml
{{- define "shipit-api.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "shipit-api.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "shipit-api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{ include "shipit-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
```

:::warning Selector labels are forever
A Deployment's `spec.selector` is immutable. If your selector labels include something that changes between releases (chart version, app version), every upgrade fails with `field is immutable`. Keep selector labels to stable identifiers (`app.kubernetes.io/name`, `app.kubernetes.io/instance`) and put versions only in the full label set.
:::

:::try Render without a cluster
Run `helm create demo && helm template my demo | head -60`. Then `helm template my demo --set replicaCount=5 --show-only templates/deployment.yaml | grep replicas`. Rendering locally is the fastest feedback loop for template work, and `helm template` output is also what you would commit for a GitOps tool if you prefer rendered manifests.
:::

### Quality tools

```bash
helm lint ./shipit-api                         # structure + template errors
helm lint ./shipit-api -f values/prod.yaml --strict
helm template t ./shipit-api -f values/prod.yaml | kubectl apply --dry-run=server -f -   # validate against the real API
helm install t ./shipit-api --dry-run=server --debug        # full server-side dry run (Helm 3.13+)
helm test shipit -n shipit                     # run test hooks against a live release
```

A **test** is a pod (or Job) template annotated `"helm.sh/hook": test`. `helm test` runs it and reports success if it exits 0. A smoke test that curls `/healthz` through the Service catches broken Services and ports. For CI, the community tools are `ct` (chart-testing: lint + install changed charts in a kind cluster) and the `helm-unittest` plugin for asserting on rendered output.

### Hooks

Annotate a resource with `helm.sh/hook: pre-install,pre-upgrade` and Helm runs it before the main manifests, waiting for it to finish. The classic use is a database migration Job for your NestJS/TypeORM or Prisma app. Use `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded` to clean up old Jobs. Note that hooks are not part of the release's managed resources (Helm does not upgrade or delete them like normal objects), and GitOps tools map them to their own concepts (Argo CD translates Helm hooks into sync hooks).

### Dependencies and OCI

A chart can depend on other charts:

```yaml
# Chart.yaml
dependencies:
  - name: redis-lite              # hypothetical internal chart
    version: "1.2.x"
    repository: "oci://ghcr.io/acme/charts"
    condition: redis.enabled      # subchart only installed if .Values.redis.enabled
```

`helm dependency update` downloads them into `charts/` and writes `Chart.lock`. Values for a subchart go under its name (`redis-lite: {...}`) in the parent's values. For your own services, prefer managed databases or separate releases over bundling Postgres as a subchart.

Charts are distributed as OCI artifacts in the same registries as images (ECR, GHCR, Docker Hub, Harbor):

```bash
helm package ./shipit-api                       # shipit-api-0.1.0.tgz
helm registry login ghcr.io -u <user>           # or aws ecr get-login-password | helm registry login ...
helm push shipit-api-0.1.0.tgz oci://ghcr.io/<user>/charts
helm install shipit oci://ghcr.io/<user>/charts/shipit-api --version 0.1.0
```

## Kustomize: patching instead of templating

Kustomize takes the opposite approach: no templates. You write plain, valid Kubernetes YAML (the **base**), and **overlays** describe transformations: patches, name prefixes, labels, image tags, generated ConfigMaps. It is built into kubectl (`kubectl apply -k`, `kubectl kustomize`).

```text
k8s/
  base/
    kustomization.yaml
    deployment.yaml
    service.yaml
  overlays/
    dev/
      kustomization.yaml
    prod/
      kustomization.yaml
      replicas-and-resources.yaml
```

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
labels:
  - pairs:
      app.kubernetes.io/part-of: shipit
    includeSelectors: false      # do not touch immutable selectors
```

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shipit-prod
resources:
  - ../../base
images:
  - name: shipit-api                       # matches the image name in the base
    newName: 123456789012.dkr.ecr.eu-central-1.amazonaws.com/shipit-api
    newTag: "1.4.2"
replicas:
  - name: shipit-api
    count: 4
configMapGenerator:
  - name: shipit-api-config
    literals:
      - LOG_LEVEL=info
      - CACHE_TTL_SECONDS=60
patches:
  - path: replicas-and-resources.yaml      # strategic merge patch (partial object)
  - target:                                # JSON 6902 patch for surgical edits
      kind: Deployment
      name: shipit-api
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value: { name: NODE_OPTIONS, value: "--max-old-space-size=384" }
```

```bash
kubectl kustomize overlays/prod          # render
kubectl apply -k overlays/prod           # render + apply
kubectl diff -k overlays/prod            # what would change
```

Features worth knowing:

- **Generators** (`configMapGenerator`, `secretGenerator`) append a content hash to the name (`shipit-api-config-7g2k9f8m4c`) and rewrite references to it. Changing a value creates a new ConfigMap name, so the Deployment rolls automatically. This is Kustomize's version of Helm's checksum annotation.
- **`images`** overrides image names/tags/digests without patching. CI can run `kustomize edit set image shipit-api=...:$SHA` and commit.
- **Components** (`kind: Component`) are reusable optional bundles, for example "add the Redis sidecar" or "enable debug logging", that overlays opt into.
- Kustomize can inflate Helm charts (`helmCharts:` field, needs `--enable-helm`), which is useful for patching a third-party chart's output the chart author did not make configurable.

:::tip
`commonLabels`, `patchesStrategicMerge` and `patchesJson6902` are deprecated fields you will see in older repos. Use `labels` and `patches`. `kustomize edit fix` migrates a kustomization. The kustomize embedded in kubectl can lag behind the standalone `kustomize` binary; `kubectl version` prints the embedded version.
:::

:::try Generators roll pods
In any kustomization with a `configMapGenerator`, run `kubectl kustomize . | grep -A2 'kind: ConfigMap'`, change one literal, and render again. The name suffix changes, and so does the reference inside the Deployment. Applying it would trigger a rollout and keep the old ConfigMap for running pods.
:::

## Helm or Kustomize?

| | Helm | Kustomize |
| --- | --- | --- |
| Approach | Templates + values | Plain YAML + patches |
| Best for | Distributing software to others (unknown users, many knobs); third-party apps | Your own apps across a few environments |
| Release tracking | Yes (revisions, rollback, hooks, tests) | No (just apply) |
| Readability | Templates can get hard to read | Base is valid YAML; overlays are small |
| Learning curve | Go templates, whitespace control | Patch semantics, merge rules |
| Packaging | Charts in OCI/HTTP repos | Git directories (or OCI via Flux) |

Common real-world combinations:

- Install third-party software with Helm (Argo CD, kube-prometheus-stack, cert-manager), configure your own apps with Kustomize.
- Write a Helm chart for your service (one chart, many environments via values files) and let Argo CD render it.
- Use Kustomize on top of Helm output for last-mile patches.

There is no wrong answer; consistency inside a team matters more. If you write a chart, keep it boring: few conditionals, sensible defaults, `toYaml` passthroughs.

## GitOps

GitOps is an operating model, defined by the OpenGitOps project in four principles:

1. **Declarative**: the desired state of the system is expressed declaratively (manifests, charts, overlays).
2. **Versioned and immutable**: that state is stored in a way that keeps full history (Git).
3. **Pulled automatically**: software agents pull the desired state from the source.
4. **Continuously reconciled**: agents continuously compare actual and desired state and correct drift.

Compare it with the push model you probably use today:

```text
PUSH (CI deploys)                               PULL (GitOps)
──────────────────                              ──────────────
git push → CI builds image → CI runs            git push (app) → CI builds image → CI commits new tag
  helm upgrade with cluster-admin creds           to config repo (or opens a PR)
                                                Argo CD in the cluster sees the commit → syncs
cluster creds live in CI                        no cluster creds outside the cluster
drift (kubectl edit) goes unnoticed             drift detected and optionally reverted
"what's deployed?" → ask the cluster            "what's deployed?" → read Git
rollback = re-run old pipeline                  rollback = git revert
```

It is the same reconcile loop you saw in module 01, applied one level up: Git is the spec, the cluster is the status, Argo CD is the controller.

### Argo CD

Argo CD runs in the cluster. Its main components:

```text
 ┌─────────────── namespace argocd ────────────────────────────────────────┐
 │ argocd-server          UI + API + CLI endpoint (SSO via Dex/OIDC)       │
 │ argocd-repo-server     clones Git, renders Helm/Kustomize/plain YAML    │
 │ application-controller compares rendered vs live, syncs, reports health │
 │ applicationset-ctrl    generates Applications from templates            │
 │ redis                  cache                                            │
 └─────────────────────────────────────────────────────────────────────────┘
```

The core object is the `Application` CRD:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shipit-api-prod
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io   # deleting the app deletes its resources
spec:
  project: default
  source:
    repoURL: https://github.com/acme/shipit-config.git
    targetRevision: main
    path: charts/shipit-api
    helm:
      valueFiles: ["values-prod.yaml"]
  destination:
    server: https://kubernetes.default.svc
    namespace: shipit-prod
  syncPolicy:
    automated:
      prune: true        # delete resources removed from Git
      selfHeal: true     # revert manual changes in the cluster
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

Two independent statuses per Application:

- **Sync status**: `Synced` (live matches Git) or `OutOfSync`.
- **Health status**: `Healthy`, `Progressing`, `Degraded`, `Missing`, `Suspended`, computed per resource kind (a Deployment is healthy when rolled out, a PVC when bound).

Other concepts: **sync waves** (`argocd.argoproj.io/sync-wave: "-1"`) order resources, e.g. a migration Job before the Deployment; **AppProject** restricts which repos, clusters and namespaces an app may use (multi-tenancy); **ApplicationSet** generates many Applications from a template (one per cluster, per environment, per directory); **app-of-apps** is an Application whose manifests are other Applications, used to bootstrap a whole cluster from one root.

:::deep Drift, self-heal and the fields Argo CD should ignore
Self-heal reverts any difference between Git and the cluster, which conflicts with controllers that legitimately change fields. The classic example: an HPA changes `spec.replicas` on a Deployment whose manifest also sets `replicas: 2`. Argo CD sees drift, resets to 2, the HPA scales back up, forever. Fixes: do not set `replicas` in the manifest when an HPA owns it (the shipit chart's `{{- if not .Values.autoscaling.enabled }}` does exactly this), or configure `ignoreDifferences` for that JSON path with `RespectIgnoreDifferences=true`. Similar issues appear with mutating webhooks that inject fields and with defaulted values. Server-side apply reduces most of this noise, because Argo CD then compares only the fields it manages.
:::

### Secrets in GitOps

You cannot commit plain Secrets. Options, in rough order of popularity:

- **External Secrets Operator**: commit an `ExternalSecret` that references AWS Secrets Manager / SSM / Vault; the operator creates the Secret (module 07).
- **Sealed Secrets**: encrypt with the controller's public key (`kubeseal`); only the cluster can decrypt.
- **SOPS** (with age or KMS): encrypted values in Git, decrypted by Flux natively or by Argo CD via a plugin.

### Flux in brief

Flux is the other CNCF-graduated GitOps engine. Instead of one `Application` type it composes smaller controllers: a `GitRepository` or `OCIRepository` (source), a `Kustomization` (apply a path, with health checks and pruning) and a `HelmRelease` (install a chart). `flux bootstrap github --owner=<you> --repository=fleet --path=clusters/dev` installs Flux and commits its own manifests to the repo, so Flux manages itself. Flux has no built-in UI and is more CLI/Git-centric; Argo CD's UI and Application model make it the more common choice for app teams. Both work well.

### Repository layout

A common setup separates code and configuration:

```text
shipit (app repo)                    shipit-config (config repo, watched by Argo CD)
  src/ Dockerfile .github/workflows    apps/
  CI: test → build → push image          shipit-api/
      → bump tag in shipit-config          base/  overlays/dev  overlays/prod
                                         platform/
                                           argocd/ kube-prometheus-stack/ envoy-gateway/
                                         bootstrap/root-app.yaml   (app-of-apps)
```

Promotion between environments is then a Git change (a PR that bumps the tag in `overlays/prod`), reviewed like code, with full history and one-click revert. Tools like Argo CD Image Updater or Flux image automation can do the tag bumps for you.

## Pitfalls and best practices

- Keep charts and overlays boring. Every `if` in a template is a branch someone must test.
- Never put secrets in `values.yaml` or `--set` in CI logs; reference existing Secrets.
- Bump `version` in `Chart.yaml` on every chart change; publish immutable versions.
- Pin third-party chart versions and upgrade deliberately (read the chart's changelog; CRDs in `crds/` are installed but never upgraded by Helm).
- `helm upgrade --install --wait --rollback-on-failure` in push pipelines; in GitOps, let Argo CD own the release and do not mix in manual `helm upgrade`.
- With GitOps, turn on self-heal only after `ignoreDifferences` is right, and protect the cluster from humans "fixing" things with `kubectl edit` (RBAC: humans get `view` in prod).
- Render in CI (`helm template` / `kubectl kustomize`) and validate against schemas (`kubeconform`) or a server-side dry run, so broken YAML never reaches the cluster.
