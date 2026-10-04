Each lab below is one milestone of the capstone. Read the brief in the lesson first. Every milestone lists requirements, then a full reference solution. You get the most out of it by building each milestone yourself and only then comparing.

**Prerequisites**: Terraform 1.10+, Docker (4 CPUs / 6–8 GB RAM for the VM), `kind`, `kubectl`, `helm`, AWS CLI v2 (used only to talk to the local state store), `jq`, and for Milestone 4 `tflint`, `trivy`, `pre-commit`, `gh`.

**Work folder**: `~/tf-labs/platform-capstone`. Commit after each milestone.

**Full teardown at any point**

```bash
cd ~/tf-labs/platform-capstone && source env.sh
for e in prod dev; do for s in app platform cluster; do ./tf.sh $e $s destroy -auto-approve || true; done; done
docker compose -f bootstrap/compose.yaml down        # add -v to also delete all state
```

## Milestone 0: Bootstrap the repository and the state store

:::meta
difficulty: easy
time: 30 min
:::

Goal: a repository skeleton, an S3-compatible state store running locally with a versioned `tfstate` bucket, and a wrapper script that pairs each environment's backend config with its variables.

### Requirements

1. Folder layout from the lesson, `git init`, and a `.gitignore` that excludes state, plans, `.terraform*` directories and `env.sh`.
2. `bootstrap/compose.yaml` running MinIO on ports 9000 (S3 API) and 9001 (console) with a named volume.
3. `env.sh` exporting credentials for the store and clearing any `AWS_PROFILE`.
4. Bucket `tfstate` with versioning enabled.
5. `tf.sh <env> <stack> <command> [args]` that runs `init` with `envs/<env>/<stack>.s3.tfbackend` (and `-reconfigure`), passes `-var-file=envs/<env>/<stack>.tfvars` to `plan`/`apply`/`destroy`, uses a separate `TF_DATA_DIR` per environment, and refuses to run if `env.sh` has not been sourced.

### Verify

```bash
aws --endpoint-url $S3_ENDPOINT s3api get-bucket-versioning --bucket tfstate   # "Status": "Enabled"
./tf.sh dev nope plan        # fails with a clear message
```

Open `http://localhost:9001` and log in with the credentials from `env.sh`.

:::hint
The AWS CLI and Terraform both read `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`. MinIO accepts any region name; use `us-east-1`. Recent AWS SDKs send extra checksum headers by default; setting `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` avoids compatibility issues with S3-compatible stores.
:::

:::solution
```bash
mkdir -p ~/tf-labs/platform-capstone && cd ~/tf-labs/platform-capstone
mkdir -p bootstrap modules/{kind-cluster,platform,app} stacks/{cluster,platform,app} envs/{dev,prod} charts/shipit/templates app/shipit-api/src .github/workflows
git init -q
```

`.gitignore`:

```text
.terraform*/
*.tfstate
*.tfstate.*
*.tfplan
tfplan
env.sh
node_modules/
```

`bootstrap/compose.yaml`:

```yaml
services:
  minio:
    image: pgsty/silo:RELEASE.2026-09-16T00-00-00Z   # maintained MinIO fork (minio/minio left Docker Hub in 2026); check for newer tags
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: tfadmin
      MINIO_ROOT_PASSWORD: tfadmin-change-me
    volumes:
      - state-data:/data
    restart: unless-stopped

volumes:
  state-data:
```

`env.sh` (git-ignored):

```bash
unset AWS_PROFILE AWS_SESSION_TOKEN
export AWS_ACCESS_KEY_ID=tfadmin
export AWS_SECRET_ACCESS_KEY=tfadmin-change-me
export AWS_REGION=us-east-1
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export S3_ENDPOINT=http://localhost:9000
```

```bash
docker compose -f bootstrap/compose.yaml up -d
source env.sh
aws --endpoint-url $S3_ENDPOINT s3 mb s3://tfstate
aws --endpoint-url $S3_ENDPOINT s3api put-bucket-versioning --bucket tfstate \
  --versioning-configuration Status=Enabled
```

`tf.sh` (then `chmod +x tf.sh`):

```bash
#!/usr/bin/env bash
# Usage: ./tf.sh <env> <stack> <terraform-command> [extra args]
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <dev|prod> <cluster|platform|app> <command> [args]" >&2
  exit 1
fi

env="$1"; stack="$2"; cmd="$3"; shift 3
root="$(cd "$(dirname "$0")" && pwd)"
cfg="$root/envs/$env"

[[ -n "${S3_ENDPOINT:-}" ]] || { echo "source env.sh first" >&2; exit 1; }
[[ -f "$cfg/$stack.tfvars" && -f "$cfg/$stack.s3.tfbackend" ]] || {
  echo "unknown env/stack: $env/$stack" >&2; exit 1; }

cd "$root/stacks/$stack"
export TF_DATA_DIR=".terraform-$env"   # one working dir per env: no accidental backend mix-ups

case "$cmd" in
  init)
    terraform init -reconfigure -backend-config="$cfg/$stack.s3.tfbackend" "$@" ;;
  plan|apply|destroy|import|console)
    terraform "$cmd" -var-file="$cfg/$stack.tfvars" "$@" ;;
  *)
    terraform "$cmd" "$@" ;;
esac
```

Why the separate `TF_DATA_DIR`: the `.terraform` directory remembers which backend (and which state key) a working directory is initialised with. Sharing one between environments is how people apply dev variables to prod state.
:::

### Clean up

Leave the store running; every later milestone uses it.

## Milestone 1: Cluster module and stack for dev and prod

:::meta
difficulty: medium
time: 60 min
:::

Goal: a reusable `kind-cluster` module, a thin `cluster` stack with an S3 backend, and dev and prod clusters whose state lives in the bucket. Prove locking works and recover from a stale lock.

### Requirements

1. `modules/kind-cluster`: inputs `name`, `http_host_port` (validated 1024–65535), `gateway_node_port` (default 30080, validated 30000–32767), `workers` (default 0, validated 0–3), `node_image` (default `null`). Writes kubeconfig to `~/.kube/kind-<name>`. Outputs `name`, `endpoint`, `cluster_ca_certificate`, `client_certificate` and `client_key` (sensitive), `kubeconfig_path`, `http_url`.
2. `stacks/cluster`: `backend "s3" {}`, input `environment` (validated dev/prod), calls the module with name `shipit-<env>`, re-exports outputs.
3. `envs/dev`: host port 8080, 0 workers. `envs/prod`: host port 8081, 1 worker. Backend files with keys `<env>/cluster.tfstate` and `use_lockfile = true`.
4. Both clusters applied; six commands, no `-target`.
5. Locking: show that a second run is blocked while the first holds the lock. Then create a stale lock on purpose and remove it safely.

### Verify

```bash
aws --endpoint-url $S3_ENDPOINT s3 ls s3://tfstate --recursive
# dev/cluster.tfstate  prod/cluster.tfstate
kind get clusters                       # shipit-dev, shipit-prod
kubectl --kubeconfig ~/.kube/kind-shipit-prod get nodes   # control-plane + worker
ls stacks/cluster/*.tfstate 2>/dev/null || echo "no local state files"
```

:::hint
- Partial backend files are plain HCL assignments; maps work: `endpoints = { s3 = "http://localhost:9000" }`.
- For the lock test, run `./tf.sh dev cluster apply` and leave it waiting at the `Enter a value:` prompt (the lock is held there). In a second terminal run `./tf.sh dev cluster plan`.
- For the stale lock: while the first apply waits at the prompt, kill it with `pkill -9 terraform`. The lock object stays behind.
:::

:::solution
`modules/kind-cluster/main.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.11"
    }
  }
}

resource "kind_cluster" "this" {
  name            = var.name
  node_image      = var.node_image
  wait_for_ready  = true
  kubeconfig_path = pathexpand("~/.kube/kind-${var.name}")

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"
      extra_port_mappings {
        container_port = var.gateway_node_port
        host_port      = var.http_host_port
      }
    }

    dynamic "node" {
      for_each = range(var.workers)
      content {
        role = "worker"
      }
    }
  }
}
```

`modules/kind-cluster/variables.tf`:

```hcl
variable "name" {
  type        = string
  description = "kind cluster name; also used for the kubeconfig file name"
}

variable "http_host_port" {
  type        = number
  description = "Port on your Mac that forwards to the gateway NodePort"
  validation {
    condition     = var.http_host_port >= 1024 && var.http_host_port <= 65535
    error_message = "http_host_port must be between 1024 and 65535 (no privileged ports)."
  }
}

variable "gateway_node_port" {
  type        = number
  description = "NodePort the gateway Service listens on inside the cluster"
  default     = 30080
  validation {
    condition     = var.gateway_node_port >= 30000 && var.gateway_node_port <= 32767
    error_message = "gateway_node_port must be in the NodePort range 30000-32767."
  }
}

variable "workers" {
  type        = number
  description = "Number of worker nodes in addition to the control plane"
  default     = 0
  validation {
    condition     = var.workers >= 0 && var.workers <= 3
    error_message = "workers must be between 0 and 3."
  }
}

variable "node_image" {
  type        = string
  description = "kindest/node image; null uses the provider's default"
  default     = null
}
```

`modules/kind-cluster/outputs.tf`:

```hcl
output "name" {
  value = kind_cluster.this.name
}

output "endpoint" {
  value = kind_cluster.this.endpoint
}

output "cluster_ca_certificate" {
  value = kind_cluster.this.cluster_ca_certificate
}

output "client_certificate" {
  value     = kind_cluster.this.client_certificate
  sensitive = true
}

output "client_key" {
  value     = kind_cluster.this.client_key
  sensitive = true
}

output "kubeconfig_path" {
  value = kind_cluster.this.kubeconfig_path
}

output "http_url" {
  value = "http://localhost:${var.http_host_port}"
}
```

`stacks/cluster/main.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  backend "s3" {}
  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.11"
    }
  }
}

provider "kind" {}

variable "environment" {
  type        = string
  description = "dev or prod"
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "http_host_port" {
  type        = number
  description = "Host port for this environment's gateway"
}

variable "workers" {
  type        = number
  description = "Worker nodes"
  default     = 0
}

module "cluster" {
  source         = "../../modules/kind-cluster"
  name           = "shipit-${var.environment}"
  http_host_port = var.http_host_port
  workers        = var.workers
}

output "name" {
  value = module.cluster.name
}

output "endpoint" {
  value = module.cluster.endpoint
}

output "cluster_ca_certificate" {
  value = module.cluster.cluster_ca_certificate
}

output "client_certificate" {
  value     = module.cluster.client_certificate
  sensitive = true
}

output "client_key" {
  value     = module.cluster.client_key
  sensitive = true
}

output "kubeconfig_path" {
  value = module.cluster.kubeconfig_path
}

output "http_url" {
  value = module.cluster.http_url
}
```

`envs/dev/cluster.tfvars` and `envs/prod/cluster.tfvars`:

```hcl
# dev
environment    = "dev"
http_host_port = 8080
workers        = 0
```

```hcl
# prod
environment    = "prod"
http_host_port = 8081
workers        = 1
```

`envs/dev/cluster.s3.tfbackend` (create the same file for prod with `key = "prod/cluster.tfstate"`; the platform and app files differ only in the key: `<env>/platform.tfstate`, `<env>/app.tfstate`):

```hcl
bucket                      = "tfstate"
key                         = "dev/cluster.tfstate"
region                      = "us-east-1"
endpoints                   = { s3 = "http://localhost:9000" }
use_path_style              = true
use_lockfile                = true
skip_credentials_validation = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_s3_checksum            = true
```

Create all six backend files now (cluster, platform, app × dev, prod) so later milestones only need tfvars.

Apply:

```bash
./tf.sh dev cluster init  && ./tf.sh dev cluster apply
./tf.sh prod cluster init && ./tf.sh prod cluster apply
```

**Lock test.** Terminal A: `./tf.sh dev cluster apply -var workers=1` and leave it at the prompt. Terminal B:

```bash
./tf.sh dev cluster plan
# Error: Error acquiring the state lock
# ... Lock Info: ID: 4f1c... Path: tfstate/dev/cluster.tfstate Operation: OperationTypeApply ...
aws --endpoint-url $S3_ENDPOINT s3 ls s3://tfstate/dev/
# cluster.tfstate  cluster.tfstate.tflock
```

**Stale lock.** Terminal B: `pkill -9 terraform`. Terminal A dies without releasing the lock. Now:

```bash
./tf.sh dev cluster plan                       # still "Error acquiring the state lock"
./tf.sh dev cluster force-unlock <LOCK_ID>     # only after confirming nobody else is running!
./tf.sh dev cluster plan                       # works; "No changes."
```

`force-unlock` deletes the `.tflock` object. In a team, check CI and colleagues first: force-unlocking a lock that a running apply holds can corrupt state. If your store does not support conditional writes, the second run would **not** be blocked; that is why this test is part of the acceptance criteria.
:::

### Clean up

Keep both clusters running for Milestone 2.

## Milestone 2: Platform stack — namespaces, Gateway API, Traefik

:::meta
difficulty: medium
time: 60 min
:::

Goal: a `platform` module that installs namespaces, the Gateway API CRDs and Traefik as a Gateway API controller, and a `platform` stack that configures the kubernetes and helm providers from the cluster stack's remote state.

### Requirements

1. `modules/platform`: inputs `namespaces` (set of strings), `gateway_api_version` (default a current release), `traefik_chart_version` (pinned), `traefik_replicas`, `gateway_node_port` (default 30080). Decode the upstream CRD YAML **without** a provider function (so the module stays easy to unit test with mocks): split on document separators and `yamldecode` each part, skipping empty ones. Outputs `gateway_name`, `gateway_namespace`, `namespaces`.
2. `stacks/platform`: reads `<env>/cluster.tfstate` with `terraform_remote_state` (backend `s3`, same settings as the backend files), configures both providers (helm v3 syntax), creates namespace `shipit`, outputs gateway name/namespace and the app namespace.
3. dev: 1 Traefik replica; prod: 2.
4. A fresh `plan` of the platform stack works as soon as the cluster stack is applied.

### Verify

```bash
for e in dev prod; do
  kubectl --kubeconfig ~/.kube/kind-shipit-$e get gatewayclass,gateway -A
  kubectl --kubeconfig ~/.kube/kind-shipit-$e -n traefik get deploy traefik
done
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080   # 404 from Traefik (no routes yet)
curl -s -o /dev/null -w '%{http_code}\n' localhost:8081   # 404
```

The Gateway shows `PROGRAMMED True`; prod's Traefik deployment shows `2/2`.

:::hint
- `terraform_remote_state` takes the same arguments as the backend inside `config`; build a `locals` map with the common ones and `merge` the `key`.
- Decoding: `[for raw in split("\n---\n", body) : try(yamldecode(raw), null)]`, then filter out `null`. The first chunk of the upstream file is only a licence comment.
- Remember to strip `status` from each manifest before passing it to `kubernetes_manifest`.
:::

:::solution
`modules/platform/main.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

resource "kubernetes_namespace_v1" "this" {
  for_each = var.namespaces
  metadata {
    name   = each.key
    labels = { "app.kubernetes.io/managed-by" = "terraform" }
  }
}

data "http" "gateway_api" {
  url = "https://github.com/kubernetes-sigs/gateway-api/releases/download/${var.gateway_api_version}/standard-install.yaml"
}

locals {
  gateway_api_raw  = [for raw in split("\n---\n", data.http.gateway_api.response_body) : try(yamldecode(raw), null)]
  gateway_api_docs = [for doc in local.gateway_api_raw : doc if doc != null]
}

resource "kubernetes_manifest" "gateway_api" {
  for_each = { for m in local.gateway_api_docs : "${m.kind}/${m.metadata.name}" => m }
  manifest = { for k, v in each.value : k => v if k != "status" }
}

resource "helm_release" "traefik" {
  name             = "traefik"
  namespace        = "traefik"
  create_namespace = true
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = var.traefik_chart_version

  values = [yamlencode({
    deployment = { replicas = var.traefik_replicas }
    providers  = { kubernetesGateway = { enabled = true } }
    gateway    = { listeners = { web = { namespacePolicy = { from = "All" } } } }
    service    = { spec = { type = "NodePort" } }
    ports      = { web = { nodePort = var.gateway_node_port } }
  })]

  wait       = true
  timeout    = 300
  depends_on = [kubernetes_manifest.gateway_api]
}
```

`modules/platform/variables.tf`:

```hcl
variable "namespaces" {
  type        = set(string)
  description = "Application namespaces to create (do not include 'traefik')"
  validation {
    condition     = !contains(var.namespaces, "traefik")
    error_message = "The traefik namespace is managed by the Traefik release."
  }
}

variable "gateway_api_version" {
  type        = string
  description = "Gateway API release tag, e.g. v1.6.2"
  default     = "v1.6.2"
  validation {
    condition     = can(regex("^v\\d+\\.\\d+\\.\\d+$", var.gateway_api_version))
    error_message = "Use a release tag like v1.6.2."
  }
}

variable "traefik_chart_version" {
  type        = string
  description = "Pinned Traefik Helm chart version"
  default     = "41.5.0"
}

variable "traefik_replicas" {
  type        = number
  description = "Traefik pod replicas"
  default     = 1
  validation {
    condition     = var.traefik_replicas >= 1 && var.traefik_replicas <= 3
    error_message = "traefik_replicas must be 1-3."
  }
}

variable "gateway_node_port" {
  type        = number
  description = "NodePort for Traefik's web entrypoint; must match the kind port mapping"
  default     = 30080
}
```

`modules/platform/outputs.tf`:

```hcl
output "gateway_name" {
  value = "traefik-gateway"
}

output "gateway_namespace" {
  value = helm_release.traefik.namespace
}

output "namespaces" {
  value = [for ns in kubernetes_namespace_v1.this : ns.metadata[0].name]
}
```

`stacks/platform/main.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  backend "s3" {}
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

variable "environment" {
  type        = string
  description = "dev or prod"
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "traefik_replicas" {
  type        = number
  description = "Traefik replicas for this environment"
  default     = 1
}

variable "state_bucket" {
  type        = string
  description = "Bucket holding all stack states"
  default     = "tfstate"
}

variable "state_endpoint" {
  type        = string
  description = "S3-compatible endpoint of the state store"
  default     = "http://localhost:9000"
}

locals {
  state_config = {
    bucket                      = var.state_bucket
    region                      = "us-east-1"
    endpoints                   = { s3 = var.state_endpoint }
    use_path_style              = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_s3_checksum            = true
  }
}

data "terraform_remote_state" "cluster" {
  backend = "s3"
  config  = merge(local.state_config, { key = "${var.environment}/cluster.tfstate" })
}

locals {
  k8s = data.terraform_remote_state.cluster.outputs
}

provider "kubernetes" {
  host                   = local.k8s.endpoint
  cluster_ca_certificate = local.k8s.cluster_ca_certificate
  client_certificate     = local.k8s.client_certificate
  client_key             = local.k8s.client_key
}

provider "helm" {
  kubernetes = {
    host                   = local.k8s.endpoint
    cluster_ca_certificate = local.k8s.cluster_ca_certificate
    client_certificate     = local.k8s.client_certificate
    client_key             = local.k8s.client_key
  }
}

module "platform" {
  source           = "../../modules/platform"
  namespaces       = ["shipit"]
  traefik_replicas = var.traefik_replicas
}

output "gateway_name" {
  value = module.platform.gateway_name
}

output "gateway_namespace" {
  value = module.platform.gateway_namespace
}

output "app_namespace" {
  value = "shipit"
}
```

`envs/dev/platform.tfvars`: `environment = "dev"` and `traefik_replicas = 1`. `envs/prod/platform.tfvars`: `environment = "prod"` and `traefik_replicas = 2`.

```bash
./tf.sh dev platform init  && ./tf.sh dev platform apply
./tf.sh prod platform init && ./tf.sh prod platform apply
```

Why `yamldecode` instead of `provider::kubernetes::manifest_decode_multi`: it uses only built-in functions, so the module's unit tests (Milestone 4) can feed it a small fixture through `override_data` and run against mocked providers without depending on provider-function support.
:::

### Clean up

Keep everything for Milestone 3.

## Milestone 3: Ship the app — image, Helm chart, app stack

:::meta
difficulty: hard
time: 90 min
:::

Goal: build `shipit-api`, load it into both clusters, write a small Helm chart (API, Postgres, Redis, HTTPRoute), and deploy it with an `app` module and stack. Acceptance criteria 5–7 must pass.

### Requirements

1. `app/shipit-api`: Node.js 22 + TypeScript (run with Node's built-in type stripping, no build step), endpoints `/healthz`, `/readyz`, `GET/POST /items`, Redis cache with 30 s TTL and an `x-cache` header, config from `PORT`, `DATABASE_URL`, `REDIS_URL`.
2. Image `shipit-api:0.1.0` loaded into both kind clusters (no registry).
3. `charts/shipit`: API Deployment + Service with readiness `/readyz` and liveness `/healthz`; a Secret with `DATABASE_URL`; Postgres with emptyDir or PVC depending on `postgres.persistence`; Redis; an `HTTPRoute` attached to the gateway from values.
4. `modules/app`: inputs `environment`, `namespace`, `chart_path`, `image_repository` (default `shipit-api`), `image_tag` (validated: not `latest`), `replicas`, `postgres_persistence`, `gateway_name`, `gateway_namespace`. Generates the Postgres password with `random_password` and passes it via `set_sensitive` so it never appears in `values`.
5. `stacks/app`: reads cluster and platform remote state; dev 1 replica without persistence, prod 2 replicas with persistence. Output `url`.

### Verify

```bash
curl -s localhost:8080/healthz; echo
curl -s localhost:8080/readyz; echo
curl -s -X POST localhost:8080/items -H 'content-type: application/json' -d '{"name":"first"}'; echo
curl -si localhost:8080/items | grep -i x-cache    # miss
curl -si localhost:8080/items | grep -i x-cache    # hit
kubectl --kubeconfig ~/.kube/kind-shipit-prod -n shipit get deploy
# persistence check (prod keeps data, dev loses it)
for e in dev prod; do
  kubectl --kubeconfig ~/.kube/kind-shipit-$e -n shipit delete pod -l app=shipit-postgres
done
```

Wait at least 30 seconds (so the Redis cache expires) and until the Postgres pods are ready again, then `GET /items` on both ports: prod still lists its items; dev returns `[]`. Note that dev's API pod may restart once, because the database it was connected to disappeared.

:::hint
- Type stripping only removes annotations: avoid `enum`, `namespace` and constructor parameter properties.
- If `kind load docker-image` fails with a digest error (common with Docker Desktop's containerd image store), use `docker save shipit-api:0.1.0 -o /tmp/shipit.tar && kind load image-archive /tmp/shipit.tar --name shipit-dev`.
- `imagePullPolicy: IfNotPresent` plus a non-`latest` tag makes Kubernetes use the loaded image.
- The helm provider does not notice template changes in a local chart unless something in the release inputs changes. Bump `version` in `Chart.yaml` whenever you edit templates.
:::

:::solution
`app/shipit-api/package.json`:

```json
{
  "name": "shipit-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "express": "^5.1.0",
    "pg": "^8.13.0",
    "redis": "^4.7.0"
  }
}
```

`app/shipit-api/src/server.ts`:

```typescript
import express, { type Request, type Response } from "express";
import pg from "pg";
import { createClient } from "redis";

const port = Number(process.env.PORT ?? 3000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err: Error) => console.error("redis error:", err.message));

await redis.connect();
await pool.query(
  "CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())"
);

const app = express();
app.use(express.json());

app.get("/healthz", (_req: Request, res: Response) => {
  res.send("ok");
});

app.get("/readyz", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.send("ready");
  } catch {
    res.status(503).send("not ready");
  }
});

app.get("/items", async (_req: Request, res: Response) => {
  const cached = await redis.get("items");
  if (cached) {
    res.set("x-cache", "hit").json(JSON.parse(cached));
    return;
  }
  const { rows } = await pool.query("SELECT id, name, created_at FROM items ORDER BY id");
  await redis.set("items", JSON.stringify(rows), { EX: 30 });
  res.set("x-cache", "miss").json(rows);
});

app.post("/items", async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const { rows } = await pool.query(
    "INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at",
    [name]
  );
  await redis.del("items");
  res.status(201).json(rows[0]);
});

app.listen(port, () => console.log(`shipit-api listening on ${port}`));
```

`app/shipit-api/Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
```

(In production, commit a `package-lock.json` and use `npm ci`.)

```bash
docker build -t shipit-api:0.1.0 app/shipit-api
kind load docker-image shipit-api:0.1.0 --name shipit-dev
kind load docker-image shipit-api:0.1.0 --name shipit-prod
```

`charts/shipit/Chart.yaml`:

```yaml
apiVersion: v2
name: shipit
description: shipit-api with in-cluster Postgres and Redis (local environments only)
type: application
version: 0.1.0
appVersion: "0.1.0"
```

`charts/shipit/values.yaml`:

```yaml
replicaCount: 1
environment: dev
image:
  repository: shipit-api
  tag: "0.1.0"
  pullPolicy: IfNotPresent
gateway:
  name: traefik-gateway
  namespace: traefik
postgres:
  enabled: true
  image: postgres:17-alpine
  password: change-me   # overridden by Terraform via set_sensitive
  persistence: false
  size: 1Gi
redis:
  enabled: true
  image: redis:8-alpine
resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    memory: 256Mi
```

`charts/shipit/templates/api.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Release.Name }}-db
type: Opaque
stringData:
  POSTGRES_PASSWORD: {{ .Values.postgres.password | quote }}
  DATABASE_URL: "postgres://shipit:{{ .Values.postgres.password }}@{{ .Release.Name }}-postgres:5432/shipit"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-api
  labels:
    app: {{ .Release.Name }}-api
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}-api
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-api
    spec:
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 3000
          env:
            - name: PORT
              value: "3000"
            - name: APP_ENV
              value: {{ .Values.environment | quote }}
            - name: REDIS_URL
              value: "redis://{{ .Release.Name }}-redis:6379"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ .Release.Name }}-db
                  key: DATABASE_URL
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 10
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-api
spec:
  selector:
    app: {{ .Release.Name }}-api
  ports:
    - port: 80
      targetPort: http
```

`charts/shipit/templates/deps.yaml`:

```yaml
{{- if .Values.postgres.enabled }}
{{- if .Values.postgres.persistence }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ .Release.Name }}-postgres
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: {{ .Values.postgres.size }}
---
{{- end }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-postgres
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: {{ .Release.Name }}-postgres
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-postgres
    spec:
      containers:
        - name: postgres
          image: {{ .Values.postgres.image }}
          env:
            - name: POSTGRES_USER
              value: shipit
            - name: POSTGRES_DB
              value: shipit
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Release.Name }}-db
                  key: POSTGRES_PASSWORD
          ports:
            - containerPort: 5432
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "shipit"]
            periodSeconds: 5
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: data
          {{- if .Values.postgres.persistence }}
          persistentVolumeClaim:
            claimName: {{ .Release.Name }}-postgres
          {{- else }}
          emptyDir: {}
          {{- end }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-postgres
spec:
  selector:
    app: {{ .Release.Name }}-postgres
  ports:
    - port: 5432
{{- end }}
{{- if .Values.redis.enabled }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Release.Name }}-redis
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}-redis
    spec:
      containers:
        - name: redis
          image: {{ .Values.redis.image }}
          ports:
            - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-redis
spec:
  selector:
    app: {{ .Release.Name }}-redis
  ports:
    - port: 6379
{{- end }}
```

`charts/shipit/templates/httproute.yaml`:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ .Release.Name }}-api
spec:
  parentRefs:
    - name: {{ .Values.gateway.name }}
      namespace: {{ .Values.gateway.namespace }}
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: {{ .Release.Name }}-api
          port: 80
```

Check the chart before Terraform touches it: `helm lint charts/shipit && helm template t charts/shipit | grep '^kind:'`.

`modules/app/main.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

resource "random_password" "postgres" {
  length  = 24
  special = false
}

locals {
  values = {
    replicaCount = var.replicas
    environment  = var.environment
    image = {
      repository = var.image_repository
      tag        = var.image_tag
      pullPolicy = "IfNotPresent"
    }
    gateway = {
      name      = var.gateway_name
      namespace = var.gateway_namespace
    }
    postgres = {
      enabled     = true
      persistence = var.postgres_persistence
    }
    redis = { enabled = true }
  }
}

resource "helm_release" "shipit" {
  name      = "shipit"
  namespace = var.namespace
  chart     = var.chart_path

  values = [yamlencode(local.values)]

  set_sensitive = [
    { name = "postgres.password", value = random_password.postgres.result },
  ]

  wait    = true
  timeout = 300
}
```

`modules/app/variables.tf`:

```hcl
variable "environment" {
  type        = string
  description = "dev or prod"
}

variable "namespace" {
  type        = string
  description = "Existing namespace to install into (created by the platform stack)"
}

variable "chart_path" {
  type        = string
  description = "Path to the shipit Helm chart"
}

variable "image_repository" {
  type        = string
  description = "Image repository (a local name when loaded into kind)"
  default     = "shipit-api"
}

variable "image_tag" {
  type        = string
  description = "Immutable image tag"
  validation {
    condition     = var.image_tag != "latest" && length(var.image_tag) > 0
    error_message = "Use an explicit, immutable tag, not 'latest'."
  }
}

variable "replicas" {
  type        = number
  description = "API replicas"
  default     = 1
  validation {
    condition     = var.replicas >= 1 && var.replicas <= 5
    error_message = "replicas must be 1-5."
  }
}

variable "postgres_persistence" {
  type        = bool
  description = "Use a PVC for Postgres (true) or an emptyDir (false)"
  default     = false
}

variable "gateway_name" {
  type        = string
  description = "Gateway the HTTPRoute attaches to"
}

variable "gateway_namespace" {
  type        = string
  description = "Namespace of that Gateway"
}
```

`modules/app/outputs.tf`:

```hcl
output "release_name" {
  value = helm_release.shipit.name
}

output "release_status" {
  value = helm_release.shipit.status
}
```

`stacks/app/main.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  backend "s3" {}
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

variable "environment" {
  type        = string
  description = "dev or prod"
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "image_tag" {
  type        = string
  description = "shipit-api image tag"
}

variable "replicas" {
  type        = number
  description = "API replicas"
  default     = 1
}

variable "postgres_persistence" {
  type        = bool
  description = "Persist Postgres data"
  default     = false
}

variable "state_bucket" {
  type        = string
  description = "Bucket holding all stack states"
  default     = "tfstate"
}

variable "state_endpoint" {
  type        = string
  description = "S3-compatible endpoint of the state store"
  default     = "http://localhost:9000"
}

locals {
  state_config = {
    bucket                      = var.state_bucket
    region                      = "us-east-1"
    endpoints                   = { s3 = var.state_endpoint }
    use_path_style              = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_s3_checksum            = true
  }
}

data "terraform_remote_state" "cluster" {
  backend = "s3"
  config  = merge(local.state_config, { key = "${var.environment}/cluster.tfstate" })
}

data "terraform_remote_state" "platform" {
  backend = "s3"
  config  = merge(local.state_config, { key = "${var.environment}/platform.tfstate" })
}

locals {
  k8s      = data.terraform_remote_state.cluster.outputs
  platform = data.terraform_remote_state.platform.outputs
}

provider "helm" {
  kubernetes = {
    host                   = local.k8s.endpoint
    cluster_ca_certificate = local.k8s.cluster_ca_certificate
    client_certificate     = local.k8s.client_certificate
    client_key             = local.k8s.client_key
  }
}

module "app" {
  source               = "../../modules/app"
  environment          = var.environment
  namespace            = local.platform.app_namespace
  chart_path           = "../../charts/shipit"
  image_tag            = var.image_tag
  replicas             = var.replicas
  postgres_persistence = var.postgres_persistence
  gateway_name         = local.platform.gateway_name
  gateway_namespace    = local.platform.gateway_namespace
}

output "url" {
  value = local.k8s.http_url
}
```

`envs/dev/app.tfvars`:

```hcl
environment          = "dev"
image_tag            = "0.1.0"
replicas             = 1
postgres_persistence = false
```

`envs/prod/app.tfvars`:

```hcl
environment          = "prod"
image_tag            = "0.1.0"
replicas             = 2
postgres_persistence = true
```

```bash
./tf.sh dev app init  && ./tf.sh dev app apply
./tf.sh prod app init && ./tf.sh prod app apply
./tf.sh prod app output url      # http://localhost:8081
```

The API pods may restart once or twice while Postgres starts (the app exits if it cannot connect at startup), then become ready. `helm_release` waits up to 5 minutes for that.
:::

### Clean up

Keep everything; Milestone 4 adds tests and CI around it.

## Milestone 4: Quality gate — tests, pre-commit and CI

:::meta
difficulty: hard
time: 90 min
:::

Goal: unit tests for all three modules that run without any cluster, the same checks as pre-commit hooks, and a GitHub Actions workflow that blocks bad pull requests.

### Requirements

1. `modules/kind-cluster/tests/unit.tftest.hcl` with `mock_provider "kind"`: default is a single node; `workers = 2` gives three nodes with roles in the right order; the host port lands in the port mapping; `http_host_port = 80` is rejected.
2. `modules/platform/tests/unit.tftest.hcl` with mocked `kubernetes`, `helm` and `http` providers and an `override_data` for `data.http.gateway_api` returning a small two-document YAML fixture (one doc with a `status` field): namespaces are created, both docs become `kubernetes_manifest` instances, `status` is stripped, and Traefik values contain the replica count and NodePort.
3. `modules/app/tests/unit.tftest.hcl` with mocked `helm` and `random`: dev and prod values are rendered correctly, the password is **not** in `values`, and `image_tag = "latest"` is rejected.
4. `.tflint.hcl` and `.pre-commit-config.yaml` (fmt, validate, tflint, trivy); `pre-commit run --all-files` passes.
5. Lock files in every stack and module directory contain `darwin_arm64` and `linux_amd64` hashes.
6. `.github/workflows/ci.yml`: on pull requests and pushes to `main`, runs fmt check, `validate` for every module and stack (without backends), TFLint, Trivy (HIGH/CRITICAL fail), `helm lint charts/shipit`, and `terraform test` in every module.
7. A `README.md` that satisfies acceptance criterion 17.

### Verify

```bash
for m in modules/*; do (cd $m && terraform init -backend=false -input=false >/dev/null && terraform test); done
pre-commit run --all-files
```

All tests pass with Docker stopped (prove it: quit Docker, run the tests, start Docker again). On GitHub, a PR that breaks formatting fails the `quality` job.

:::hint
- Blocks inside `kind_config` are lists in the plan: `kind_cluster.this.kind_config[0].node[1].role`.
- In tests, read rendered Helm values with `yamldecode(helm_release.traefik.values[0])`.
- To check a key is absent: `!can(yamldecode(helm_release.shipit.values[0]).postgres.password)`.
- `terraform init` inside a module downloads its providers even though tests use mocks: the mock still needs the provider's schema.
:::

:::solution
`modules/kind-cluster/tests/unit.tftest.hcl`:

```hcl
mock_provider "kind" {}

variables {
  name           = "unit"
  http_host_port = 18080
}

run "single_node_by_default" {
  command = plan

  assert {
    condition     = length(kind_cluster.this.kind_config[0].node) == 1
    error_message = "Expected only the control-plane node by default"
  }
}

run "adds_workers_after_control_plane" {
  command = plan

  variables {
    workers = 2
  }

  assert {
    condition     = length(kind_cluster.this.kind_config[0].node) == 3
    error_message = "Expected 1 control-plane + 2 workers"
  }

  assert {
    condition     = kind_cluster.this.kind_config[0].node[0].role == "control-plane" && kind_cluster.this.kind_config[0].node[2].role == "worker"
    error_message = "Control plane must come first, workers after"
  }
}

run "maps_host_port" {
  command = plan

  assert {
    condition     = kind_cluster.this.kind_config[0].node[0].extra_port_mappings[0].host_port == 18080
    error_message = "http_host_port must be mapped on the control-plane node"
  }

  assert {
    condition     = output.http_url == "http://localhost:18080"
    error_message = "http_url output is wrong"
  }
}

run "rejects_privileged_port" {
  command = plan

  variables {
    http_host_port = 80
  }

  expect_failures = [var.http_host_port]
}
```

`modules/platform/tests/unit.tftest.hcl`:

```hcl
mock_provider "kubernetes" {}
mock_provider "helm" {}
mock_provider "http" {}

override_data {
  target = data.http.gateway_api
  values = {
    response_body = <<-EOT
      # licence header, like the upstream file
      ---
      apiVersion: apiextensions.k8s.io/v1
      kind: CustomResourceDefinition
      metadata:
        name: gateways.gateway.networking.k8s.io
      spec:
        group: gateway.networking.k8s.io
      ---
      apiVersion: apiextensions.k8s.io/v1
      kind: CustomResourceDefinition
      metadata:
        name: httproutes.gateway.networking.k8s.io
      spec:
        group: gateway.networking.k8s.io
      status:
        acceptedNames:
          kind: ""
    EOT
  }
}

variables {
  namespaces = ["shipit", "monitoring"]
}

run "creates_namespaces" {
  command = plan

  assert {
    condition     = length(kubernetes_namespace_v1.this) == 2
    error_message = "Expected two namespaces"
  }
}

run "decodes_crds_and_strips_status" {
  command = plan

  assert {
    condition     = length(kubernetes_manifest.gateway_api) == 2
    error_message = "Expected two manifests from the fixture"
  }

  assert {
    condition     = !contains(keys(kubernetes_manifest.gateway_api["CustomResourceDefinition/httproutes.gateway.networking.k8s.io"].manifest), "status")
    error_message = "status must be stripped"
  }
}

run "traefik_values" {
  command = plan

  variables {
    traefik_replicas = 2
  }

  assert {
    condition     = yamldecode(helm_release.traefik.values[0]).deployment.replicas == 2
    error_message = "Replica count not passed to Traefik"
  }

  assert {
    condition     = yamldecode(helm_release.traefik.values[0]).ports.web.nodePort == 30080
    error_message = "NodePort must match the kind port mapping"
  }
}

run "rejects_traefik_namespace" {
  command = plan

  variables {
    namespaces = ["traefik"]
  }

  expect_failures = [var.namespaces]
}
```

`modules/app/tests/unit.tftest.hcl`:

```hcl
mock_provider "helm" {}
mock_provider "random" {}

variables {
  environment       = "dev"
  namespace         = "shipit"
  chart_path        = "../../charts/shipit"
  image_tag         = "0.1.0"
  gateway_name      = "traefik-gateway"
  gateway_namespace = "traefik"
}

run "dev_defaults" {
  command = plan

  assert {
    condition     = yamldecode(helm_release.shipit.values[0]).replicaCount == 1
    error_message = "dev should run one replica"
  }

  assert {
    condition     = yamldecode(helm_release.shipit.values[0]).postgres.persistence == false
    error_message = "dev should not persist Postgres"
  }
}

run "prod_settings" {
  command = plan

  variables {
    environment          = "prod"
    replicas             = 2
    postgres_persistence = true
  }

  assert {
    condition     = yamldecode(helm_release.shipit.values[0]).replicaCount == 2
    error_message = "prod should run two replicas"
  }

  assert {
    condition     = yamldecode(helm_release.shipit.values[0]).postgres.persistence
    error_message = "prod must persist Postgres"
  }
}

run "password_not_in_values" {
  command = plan

  assert {
    condition     = !can(yamldecode(helm_release.shipit.values[0]).postgres.password)
    error_message = "The password must only be passed via set_sensitive"
  }
}

run "rejects_latest" {
  command = plan

  variables {
    image_tag = "latest"
  }

  expect_failures = [var.image_tag]
}
```

`.tflint.hcl`:

```hcl
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
```

`.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/antonbabenko/pre-commit-terraform
    rev: v1.108.1   # pre-commit autoupdate
    hooks:
      - id: terraform_fmt
      - id: terraform_validate
        args:
          - --hook-config=--retry-once-with-cleanup=true
          - --tf-init-args=-backend=false
      - id: terraform_tflint
        args:
          - --args=--config=__GIT_WORKING_DIR__/.tflint.hcl
      - id: terraform_trivy
        args:
          - --args=--severity=HIGH,CRITICAL
```

Lock files for both platforms:

```bash
for d in modules/* stacks/*; do
  (cd $d && terraform init -backend=false -input=false >/dev/null && \
   terraform providers lock -platform=darwin_arm64 -platform=linux_amd64)
done
git add **/.terraform.lock.hcl
```

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false
      - run: terraform fmt -check -recursive
      - name: validate all modules and stacks
        run: |
          for d in modules/* stacks/*; do
            echo "::group::$d"
            (cd "$d" && terraform init -backend=false -input=false && terraform validate)
            echo "::endgroup::"
          done
      - uses: terraform-linters/setup-tflint@v4
      - run: tflint --init && tflint --recursive --config="$GITHUB_WORKSPACE/.tflint.hcl"
        env:
          GITHUB_TOKEN: ${{ github.token }}
      - name: trivy
        run: |
          curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin
          trivy config --severity HIGH,CRITICAL --exit-code 1 .
      - uses: azure/setup-helm@v4
      - run: helm lint charts/shipit

  test:
    needs: quality
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false
      - name: terraform test
        run: |
          for m in modules/*; do
            echo "::group::$m"
            (cd "$m" && terraform init -backend=false -input=false && terraform test)
            echo "::endgroup::"
          done
```

Trivy will likely report findings in the chart (for example containers without `securityContext` or read-only root filesystems). Fix the HIGH ones in the chart (add `securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false }` to the API container) or suppress with a documented reason; this is a realistic conversation to have in a PR.

Push with `gh repo create platform-capstone --private --source=. --push`, then enable branch protection on `main` requiring `quality` and `test`. Check action major versions on their releases pages when you do this.
:::

### Clean up

Nothing new to destroy. Commit everything.

## Milestone 5: Stretch goal (optional, costs money) — shipit on AWS with guard rails

:::meta
difficulty: hard
time: 2–3 hours
:::

Goal: run `shipit-api` on AWS (VPC + ECS Fargate) as a new stack in the same repository, with guard rails that make accidental spending hard. Expect roughly $0.02–0.03 per hour while it runs (Fargate task, public IPv4, CloudWatch Logs); destroy the same day.

### Requirements

1. New stack `stacks/aws-app` in a **separate terminal without `env.sh`** (`export AWS_PROFILE=learn-admin`, `aws sso login`). Its state goes in a real S3 bucket with `use_lockfile = true` (as in the state module), or local state if you destroy within the session.
2. Networking with `terraform-aws-modules/vpc/aws` (pinned major), two AZs, public and private subnets, **no NAT gateway**.
3. Private ECR repository; push `shipit-api:0.1.0` built for `linux/arm64`.
4. ECS Fargate service (ARM64, 0.25 vCPU / 0.5 GB) in public subnets with `assign_public_ip = true`, a security group allowing only your IP on port 3000, `wait_for_steady_state = true`. For this stretch, `/healthz` is enough: run the API without Postgres/Redis by adding a `DEMO_MODE` env var that skips connecting (your choice how), or point it at RDS/ElastiCache if you want to go further (more cost).
5. Guard rails:
   - a required variable `i_accept_aws_costs` whose validation fails unless it is `true`;
   - `default_tags` including `Project`, `Owner`, `ManagedBy` and `ExpiresOn` (a date you pass in);
   - a `check` block that warns if your budget from the AWS module (`learning-monthly`) does not exist;
   - `desired_count` validated to at most 2;
   - an output reminding you to destroy.

### Verify

- `terraform plan` without `-var i_accept_aws_costs=true` fails with your message.
- `curl http://<task-ip>:3000/healthz` returns `ok`.
- `terraform destroy` leaves nothing tagged `Project = shipit-capstone` in Tag Editor.

:::hint
Start from the AWS module's Lab 6 solution (VPC module + ECR + Fargate). The `aws_budgets_budget` data source can look up a budget by name inside a `check` block's scoped `data` block; if the lookup fails, the check produces a warning, not an error.
:::

:::solution
Use the AWS module's Lab 6 `main.tf` as the base (rename resources to `shipit-capstone-*`, port 3000, image tag variable). Add these guard rails:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

variable "i_accept_aws_costs" {
  type        = bool
  description = "Must be true. This stack creates billable resources (~$0.02-0.03/hour)."
  default     = false
  validation {
    condition     = var.i_accept_aws_costs
    error_message = "This stack costs money. Re-run with -var i_accept_aws_costs=true and destroy it today."
  }
}

variable "expires_on" {
  type        = string
  description = "Date (YYYY-MM-DD) by which this stack must be destroyed"
  validation {
    condition     = can(regex("^\\d{4}-\\d{2}-\\d{2}$", var.expires_on))
    error_message = "Use YYYY-MM-DD."
  }
}

variable "desired_count" {
  type        = number
  description = "Fargate tasks"
  default     = 1
  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 2
    error_message = "At most 2 tasks in this lab."
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "shipit-capstone"
      Owner     = "roma"
      ManagedBy = "terraform"
      ExpiresOn = var.expires_on
    }
  }
}

check "budget_guard_exists" {
  data "aws_budgets_budget" "guard" {
    name = "learning-monthly"
  }

  assert {
    condition     = data.aws_budgets_budget.guard.name == "learning-monthly"
    error_message = "No 'learning-monthly' budget found. Create it (AWS module, Lab 1) before running paid labs."
  }
}

output "reminder" {
  value = "Billable resources are running. Destroy today: terraform destroy -var i_accept_aws_costs=true -var expires_on=${var.expires_on}"
}
```

In the ECS service, use `desired_count = var.desired_count`. For `DEMO_MODE`, the smallest change to `server.ts` is to wrap the startup connections:

```typescript
const demo = process.env.DEMO_MODE === "true";
if (!demo) {
  await redis.connect();
  await pool.query("CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())");
}
```

and set `environment = [{ name = "PORT", value = "3000" }, { name = "DEMO_MODE", value = "true" }]` in the container definition. Build `shipit-api:0.1.1` for `linux/arm64`, push to ECR, apply:

```bash
terraform apply -var i_accept_aws_costs=true -var expires_on=$(date +%F)
```

Write one paragraph in the README comparing this with the local platform: which stack boundaries and module interfaces carried over unchanged, and what you would change for production (private subnets with VPC endpoints or NAT, an ALB with HTTPS, RDS and ElastiCache, OIDC-based CI applies, Argo CD or ECS deployments driven by CI for the app layer).
:::

### Clean up

```bash
terraform destroy -var i_accept_aws_costs=true -var expires_on=$(date +%F)
```

Then, in the local terminal, run the full teardown from the top of this page when you are finished with the capstone.
