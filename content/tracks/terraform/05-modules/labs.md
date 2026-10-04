In these labs you build one reusable module, `web-app` (network attachment + container + optional volume), and use it in several ways. Everything runs locally and free. You need Terraform 1.10+, a running Docker engine, `git`, and optionally `terraform-docs` (`brew install terraform-docs`).

The module lives in a shared folder that the labs reference:

```text
~/tf-labs/m05/
  modules/web-app/     <- built in Lab 1, reused later
  lab1/ lab2/ ...      <- root modules
```

```bash
mkdir -p ~/tf-labs/m05/modules/web-app && cd ~/tf-labs/m05
```

## Lab 1: Write the web-app module and call it twice

:::meta
difficulty: easy
time: 30 min
:::

Goal: write a small, well-typed module and instantiate it twice from a root module.

### Steps

1. Create the module files:

```bash
cd ~/tf-labs/m05/modules/web-app

cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = ">= 4.0" # minimum only: the root module pins the exact range
    }
  }
}
EOF

cat > variables.tf <<'EOF'
variable "name" {
  type        = string
  description = "Container name; also used as the DNS alias on the network."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,40}$", var.name))
    error_message = "name must be lowercase letters, digits and dashes (2-41 chars)."
  }
}

variable "image" {
  type        = string
  description = "Image reference including tag, e.g. nginx:1.30-alpine."
}

variable "internal_port" {
  type        = number
  description = "Port the app listens on inside the container."
}

variable "external_port" {
  type        = number
  description = "Host port to publish. null means the app is only reachable on the network."
  default     = null
}

variable "network_name" {
  type        = string
  description = "Name of an existing Docker network to attach to. The caller creates it."
}

variable "env" {
  type        = map(string)
  description = "Environment variables for the container."
  default     = {}
  nullable    = false
}

variable "command" {
  type        = list(string)
  description = "Override the image's default command. null keeps the image default."
  default     = null
}

variable "volume" {
  type = object({
    container_path = string
    name           = optional(string)
  })
  description = "Optional named volume to create and mount. name defaults to \"<name>-data\". null means no volume."
  default     = null
}

variable "labels" {
  type        = map(string)
  description = "Extra container labels."
  default     = {}
  nullable    = false
}
EOF

cat > main.tf <<'EOF'
locals {
  labels = merge(var.labels, {
    "managed-by" = "terraform"
    "app"        = var.name
  })
}

resource "docker_image" "this" {
  name         = var.image
  keep_locally = true
}

resource "docker_volume" "this" {
  count = var.volume == null ? 0 : 1
  name  = coalesce(var.volume.name, "${var.name}-data")
}

resource "docker_container" "this" {
  name    = var.name
  image   = docker_image.this.image_id
  env     = [for k, v in var.env : "${k}=${v}"]
  command = var.command

  networks_advanced {
    name    = var.network_name
    aliases = [var.name]
  }

  dynamic "ports" {
    for_each = var.external_port == null ? [] : [var.external_port]
    content {
      internal = var.internal_port
      external = ports.value
    }
  }

  dynamic "volumes" {
    for_each = docker_volume.this
    content {
      volume_name    = volumes.value.name
      container_path = var.volume.container_path
    }
  }

  dynamic "labels" {
    for_each = local.labels
    content {
      label = labels.key
      value = labels.value
    }
  }
}
EOF

cat > outputs.tf <<'EOF'
output "container_name" {
  description = "Name of the container."
  value       = docker_container.this.name
}

output "url" {
  description = "URL on the host, or null when no port is published."
  value       = var.external_port == null ? null : "http://localhost:${var.external_port}"
}

output "internal_url" {
  description = "URL for other containers on the same network."
  value       = "http://${var.name}:${var.internal_port}"
}

output "volume_name" {
  description = "Name of the created volume, or null."
  value       = one(docker_volume.this[*].name)
}
EOF
```

2. Create a root module that calls it twice:

```bash
mkdir -p ~/tf-labs/m05/lab1 && cd ~/tf-labs/m05/lab1

cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

provider "docker" {}
EOF

cat > main.tf <<'EOF'
resource "docker_network" "apps" {
  name = "m05-apps"
}

module "whoami" {
  source = "../modules/web-app"

  name          = "whoami"
  image         = "traefik/whoami:latest"
  internal_port = 80
  external_port = 8201
  network_name  = docker_network.apps.name
  env           = { WHOAMI_NAME = "lab1" }
}

module "echo" {
  source = "../modules/web-app"

  name          = "echo"
  image         = "hashicorp/http-echo:latest"
  internal_port = 5678
  network_name  = docker_network.apps.name
  command       = ["-text=hello from the echo module"]
}

output "whoami_url"    { value = module.whoami.url }
output "echo_internal" { value = module.echo.internal_url }
output "echo_url"      { value = module.echo.url }
EOF

terraform init
terraform apply
```

3. Explore:

```bash
terraform state list
curl -s "$(terraform output -raw whoami_url)" | head -5
# echo isn't published; reach it from inside the network:
docker run --rm --network m05-apps curlimages/curl -s "$(terraform output -raw echo_internal)"
ls .terraform/modules && cat .terraform/modules/modules.json | jq .
```

4. Try `terraform plan` after setting `name = "Echo"` on the second module. Revert.

### Verify

- `terraform state list` shows addresses like `module.whoami.docker_container.this` and `module.echo.docker_image.this`.
- whoami answers on `localhost:8201`; echo answers only from inside the network; `echo_url` is `null`.
- Step 4 fails with the module's validation message.

:::hint
If `init` says it can't find the module, check the relative path: it's resolved from the root module's directory (`lab1/`), so `../modules/web-app`.
:::

:::solution
Expected `terraform state list`:

```text
docker_network.apps
module.echo.docker_container.this
module.echo.docker_image.this
module.whoami.docker_container.this
module.whoami.docker_image.this
```

No `docker_volume` entries because neither call set `volume` (count = 0). `modules.json` lists each module key with `"Source": "../modules/web-app"` and `"Dir": "../modules/web-app"`: local modules aren't copied, which is why edits to the module take effect without re-running `init`.

Note how validation inside the module protects every caller: the root module didn't need to know the naming rule.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 2: for_each over modules, optional volumes and aggregated outputs

:::meta
difficulty: medium
time: 30 min
:::

Goal: drive many module instances from one map, enable the optional volume for one of them, and prove the data survives container replacement.

### Steps

1. Create the root module:

```bash
mkdir -p ~/tf-labs/m05/lab2 && cd ~/tf-labs/m05/lab2
cp ../lab1/versions.tf .

cat > main.tf <<'EOF'
variable "apps" {
  type = map(object({
    image         = string
    internal_port = number
    external_port = optional(number)
    env           = optional(map(string), {})
    command       = optional(list(string))
    volume_path   = optional(string)
  }))
}

resource "docker_network" "apps" {
  name = "m05-lab2"
}

module "app" {
  source   = "../modules/web-app"
  for_each = var.apps

  name          = each.key
  image         = each.value.image
  internal_port = each.value.internal_port
  external_port = each.value.external_port
  env           = each.value.env
  command       = each.value.command
  network_name  = docker_network.apps.name
  volume        = each.value.volume_path == null ? null : { container_path = each.value.volume_path }
  labels        = { stack = "lab2" }
}

output "urls" {
  value = { for k, m in module.app : k => m.url if m.url != null }
}

output "volumes" {
  value = { for k, m in module.app : k => m.volume_name if m.volume_name != null }
}
EOF

cat > terraform.tfvars <<'EOF'
apps = {
  whoami = {
    image         = "traefik/whoami:latest"
    internal_port = 80
    external_port = 8202
  }
  site = {
    image         = "nginx:1.30-alpine"
    internal_port = 80
    external_port = 8203
    volume_path   = "/usr/share/nginx/html"
  }
  echo = {
    image         = "hashicorp/http-echo:latest"
    internal_port = 5678
    command       = ["-text=internal only"]
  }
}
EOF

terraform init && terraform apply -auto-approve
terraform output
```

2. Write content into the volume and check it's served:

```bash
docker exec site sh -c 'echo "<h1>persisted by a volume</h1>" > /usr/share/nginx/html/index.html'
curl -s localhost:8203
```

3. Change the `site` image to `nginx:1.31-alpine` in `terraform.tfvars`. Plan (what's replaced? what's not?), apply, and `curl` again.

4. Add a fourth app `whoami2` (copy whoami, port 8204). Plan: confirm nothing existing changes.

### Verify

- `terraform output urls` contains whoami, site and (after step 4) whoami2, but not echo.
- After step 3 the container is replaced but `curl localhost:8203` still shows `persisted by a volume`.
- Step 4's plan only adds `module.app["whoami2"].*` resources.

:::hint
Docker copies the image's files into an **empty** named volume the first time it's mounted, so the nginx default page appears in the new volume before you overwrite `index.html`.
:::

:::solution
Step 3's plan replaces `module.app["site"].docker_image.this` and `module.app["site"].docker_container.this`, while `module.app["site"].docker_volume.this[0]` is untouched because none of its arguments changed. The new container mounts the same volume, so your file survives. This is the Terraform version of what you learned about volumes in the Docker track: containers are disposable, volumes hold state.

Address format for for_each modules: `module.app["site"].docker_volume.this[0]` combines the module key and the resource's `count` index.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 3: Refactor flat resources into the module without downtime

:::meta
difficulty: medium
time: 30 min
:::

Goal: move existing, running resources into a module using `moved` blocks so that nothing is recreated.

### Steps

1. Deploy a "legacy" flat configuration:

```bash
mkdir -p ~/tf-labs/m05/lab3 && cd ~/tf-labs/m05/lab3
cp ../lab1/versions.tf .

cat > main.tf <<'EOF'
resource "docker_network" "apps" {
  name = "m05-lab3"
}

resource "docker_image" "api" {
  name         = "traefik/whoami:latest"
  keep_locally = true
}

resource "docker_container" "api" {
  name  = "legacy-api"
  image = docker_image.api.image_id
  env   = ["WHOAMI_NAME=legacy"]

  networks_advanced {
    name    = docker_network.apps.name
    aliases = ["legacy-api"]
  }

  ports {
    internal = 80
    external = 8205
  }

  labels {
    label = "app"
    value = "legacy-api"
  }

  labels {
    label = "managed-by"
    value = "terraform"
  }
}
EOF
terraform init && terraform apply -auto-approve
docker inspect -f '{{.Id}}' legacy-api | cut -c1-12
```

2. Replace the two resource blocks (`docker_image.api`, `docker_container.api`) with a call to `../modules/web-app` named `api` that produces the **same** container. Run `terraform init` and `terraform plan`. Read it.

3. Add `moved` blocks until the plan shows no changes. Apply. Check the container ID is unchanged.

### Verify

- Before `moved`: the plan destroys and recreates the container and image.
- After `moved`: `Plan: 0 to add, 0 to change, 0 to destroy.` with two `has moved to` lines, and the container ID didn't change.

:::hint
Both resources need a `moved` block. If the plan still shows a replacement after the moves, compare the arguments the module generates with the old ones: name, env, network alias, ports and labels must all match.
:::

:::solution
```hcl
resource "docker_network" "apps" {
  name = "m05-lab3"
}

module "api" {
  source = "../modules/web-app"

  name          = "legacy-api"
  image         = "traefik/whoami:latest"
  internal_port = 80
  external_port = 8205
  network_name  = docker_network.apps.name
  env           = { WHOAMI_NAME = "legacy" }
}

moved {
  from = docker_image.api
  to   = module.api.docker_image.this
}

moved {
  from = docker_container.api
  to   = module.api.docker_container.this
}
```

This works because the module happens to add the same two labels (`app`, `managed-by`) and the same alias that the legacy config had. In real refactors, you either make the module flexible enough to reproduce the old arguments, or accept an in-place update (`~`) where the provider allows it. A replacement (`-/+`) during a "pure refactor" means something doesn't match yet.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 4: Git sources, tags and upgrading a module version

:::meta
difficulty: medium
time: 35 min
:::

Goal: consume the module from a Git repository pinned to a tag, release a breaking v2, and upgrade deliberately.

### Steps

1. Turn a copy of the module into a Git repo with a `v1.0.0` tag:

```bash
mkdir -p ~/tf-labs/m05/git && cd ~/tf-labs/m05/git
rm -rf terraform-docker-web-app && mkdir terraform-docker-web-app && cd terraform-docker-web-app
cp ../../modules/web-app/*.tf .
echo "# terraform-docker-web-app" > README.md
git init -q -b main && git add . && git commit -qm "v1.0.0" && git tag v1.0.0
git log --oneline --decorate
```

2. Consume it from a root module:

```bash
mkdir -p ~/tf-labs/m05/lab4 && cd ~/tf-labs/m05/lab4
cp ../lab1/versions.tf .
cat > main.tf <<EOF
resource "docker_network" "apps" {
  name = "m05-lab4"
}

module "web" {
  source = "git::file://$HOME/tf-labs/m05/git/terraform-docker-web-app?ref=v1.0.0"

  name          = "versioned-web"
  image         = "traefik/whoami:latest"
  internal_port = 80
  external_port = 8206
  network_name  = docker_network.apps.name
}

output "url" { value = module.web.url }
EOF
cat main.tf | grep source
terraform init && terraform apply -auto-approve
ls .terraform/modules/web
```

3. Release a **breaking** v2 in the module repo: rename the variable `external_port` to `host_port` (update `main.tf` and `outputs.tf` in the repo), commit, tag `v2.0.0`:

```bash
cd ~/tf-labs/m05/git/terraform-docker-web-app
sed -i '' 's/external_port/host_port/g' variables.tf main.tf outputs.tf
git commit -qam "BREAKING: rename external_port to host_port" && git tag v2.0.0
```

(On Linux use `sed -i` without `''`.)

4. Back in `lab4`, run `terraform plan`. Did anything change? Now change the `ref` to `v2.0.0` and run `terraform plan` without re-initialising. Then run `terraform init`, then `terraform plan` again. Fix the root module so the plan shows no changes and apply.

5. Make a change on the module's `main` branch without tagging (e.g. add a label), and think about what would happen to consumers using `?ref=main`.

### Verify

- Step 4: the first plan shows no changes (still on v1.0.0); after editing `ref`, Terraform asks you to run `init` ("Module source has changed"); after `init`, the plan fails with `Unsupported argument "external_port"` until you rename it to `host_port`. Then the plan shows no changes.

:::hint
`git::file://` plus an absolute path works for a local repository, just like `git::https://...` for a remote one. If your shell left `$HOME` unexpanded in `main.tf`, write the absolute path by hand (`/Users/<you>/tf-labs/...`).
:::

:::solution
Final module block:

```hcl
module "web" {
  source = "git::file:///Users/<you>/tf-labs/m05/git/terraform-docker-web-app?ref=v2.0.0"

  name          = "versioned-web"
  image         = "traefik/whoami:latest"
  internal_port = 80
  host_port     = 8206
  network_name  = docker_network.apps.name
}
```

Takeaways:

- Pinned refs make upgrades explicit: nothing changes for consumers until they edit `ref` and run `init`.
- A renamed input is a **breaking change** and deserves a major version. Here it didn't recreate anything because the generated container arguments were identical; renaming a *resource* inside the module without a `moved` block would have.
- Step 5: consumers on `?ref=main` would pick up the new label on their next `init`, and a plan would suddenly show changes nobody asked for. Pin tags or commit SHAs.
- The lock file doesn't record modules, so `ref`/`version` pins are your only guarantee.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 5: Break & fix: module wiring errors

:::meta
difficulty: medium
time: 30 min
:::

Goal: recognise the most common module errors from their messages.

### Steps

1. Create a deliberately broken child module and root:

```bash
mkdir -p ~/tf-labs/m05/lab5/modules/cache && cd ~/tf-labs/m05/lab5

cat > modules/cache/main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "= 4.0.0"
    }
  }
}

provider "docker" {
  host = "unix:///var/run/docker.sock"
}

variable "name" {
  type = string
}

variable "network_name" {
  type = string
}

resource "docker_image" "redis" {
  name         = "redis:8-alpine"
  keep_locally = true
}

resource "docker_container" "redis" {
  name  = var.name
  image = docker_image.redis.image_id
  networks_advanced {
    name = var.network_name
  }
}
EOF

cat > main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

resource "docker_network" "net" {
  name = "m05-lab5"
}

module "cache" {
  source   = "./modules/cache"
  for_each = toset(["sessions", "jobs"])

  name    = "cache-${each.key}"
  network = docker_network.net.name
}

output "cache_names" {
  value = [for k, m in module.cache : m.docker_container.redis.name]
}
EOF
terraform init
```

2. Make `terraform init`, `terraform validate` and `terraform apply` succeed. Expected result: two Redis containers `cache-sessions` and `cache-jobs`, and an output listing their names.

### Verify

```bash
terraform output cache_names
docker exec cache-jobs redis-cli ping    # PONG
```

:::hint
There are four problems. Read the errors in order:

1. Version constraints from root and child must overlap.
2. Which construct makes a module incompatible with `for_each`?
3. Argument names in a `module` block must match the child's variable names.
4. Can a caller reach inside a module to read a resource attribute?
:::

:::solution
1. **Conflicting version constraints**: the child pins `= 4.0.0`, the root wants `~> 4.6`, so `init` fails with `no available releases match the given constraints`. In a module, declare a minimum: `version = ">= 4.0"`.
2. **Provider block in a child module**: with `for_each` on the module, Terraform errors with `Module is incompatible with count, for_each, and depends_on ... contains provider configuration`. Delete the `provider` block from the child; it inherits the root's default docker provider. (Add `provider "docker" {}` in the root if you like being explicit.)
3. **Wrong argument name**: `network` isn't a variable of the module: `Unsupported argument ... An argument named "network" is not expected here`. Use `network_name`. Missing required variables produce `Missing required argument` similarly.
4. **Reaching into the module**: `m.docker_container.redis.name` fails with `Unsupported attribute ... This object does not have an attribute named "docker_container"`. Add an output to the child and use it.

Fixed child additions/changes:

```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = ">= 4.0"
    }
  }
}

# (provider block removed)

output "container_name" {
  description = "Name of the Redis container."
  value       = docker_container.redis.name
}
```

Fixed root:

```hcl
module "cache" {
  source   = "./modules/cache"
  for_each = toset(["sessions", "jobs"])

  name         = "cache-${each.key}"
  network_name = docker_network.net.name
}

output "cache_names" {
  value = [for k, m in module.cache : m.container_name]
}
```
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 6: Challenge: compose the shipit stack from small modules

:::meta
difficulty: hard
time: 60 min
:::

Goal: design and compose several focused modules in a root module, using dependency inversion, provider passing and generated docs.

### Requirements

In `~/tf-labs/m05/lab6`:

1. Write two new small modules next to `web-app`, under `lab6/modules/`:
   - **`postgres`**: inputs `name`, `network_name`, `db_name` (default `shipit`), `user` (default `shipit`), `image` (default `postgres:18-alpine`). Generates the password with `random_password` inside the module. Creates a named volume for data mounted at `/var/lib/postgresql` (Postgres 18 images keep data under that directory). Outputs `host` (the container name), `port` (5432) and a **sensitive** `database_url`.
   - **`redis`**: inputs `name`, `network_name`, `image` (default `redis:8-alpine`). Outputs `url` (`redis://<name>:6379`).
2. Neither module creates a network or has a `provider` block. Each has `versions.tf` with **minimum** provider versions, and descriptions on every variable and output.
3. In the root module: create one network `shipit-dev`, call `postgres`, `redis`, and `web-app` (from `../modules/web-app`) for an `api` placeholder using `traefik/whoami:latest` published on host port `8210`, passing `DATABASE_URL` and `REDIS_URL` env vars from the other modules' outputs. (whoami just echoes requests, but `docker inspect` will show the env wiring.)
4. Root outputs: `api_url` and a sensitive `database_url`.
5. **Provider passing**: add an aliased provider `docker.ops` in the root (same local engine) and deploy one extra `web-app` instance named `ops-dashboard` (whoami on port 8211) through it using the module's `providers` argument.
6. Generate a README for the `postgres` module with `terraform-docs` (if installed), injected between `BEGIN_TF_DOCS` markers.
7. `terraform fmt -recursive -check`, `terraform validate` and a no-changes second plan.

### Verify

```bash
terraform apply -auto-approve
curl -s localhost:8210 | head -3
docker inspect shipit-api -f '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'DATABASE_URL|REDIS_URL'
docker exec shipit-postgres pg_isready -U shipit
docker exec shipit-redis redis-cli ping
terraform state list | grep ops
terraform plan    # No changes
```

:::hint
- The module tree stays flat: root -> postgres, redis, web-app. The api doesn't call the postgres module; the root wires outputs to inputs.
- `DATABASE_URL` comes from a sensitive output, so the env map passed into `web-app` becomes sensitive too. That's fine; Terraform will redact it in plans.
- Provider passing: `providers = { docker = docker.ops }` on the module call.
:::

:::solution
`modules/postgres/versions.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    docker = { source = "kreuzwerker/docker", version = ">= 4.0" }
    random = { source = "hashicorp/random", version = ">= 3.0" }
  }
}
```

`modules/postgres/variables.tf`:

```hcl
variable "name" {
  type        = string
  description = "Container name; other containers reach Postgres at this hostname."
}

variable "network_name" {
  type        = string
  description = "Existing Docker network to attach to."
}

variable "db_name" {
  type        = string
  description = "Database to create on first start."
  default     = "shipit"
}

variable "user" {
  type        = string
  description = "Database user to create on first start."
  default     = "shipit"
}

variable "image" {
  type        = string
  description = "Postgres image with a pinned major version."
  default     = "postgres:18-alpine"
}
```

`modules/postgres/main.tf`:

```hcl
resource "random_password" "this" {
  length  = 24
  special = false
}

resource "docker_image" "this" {
  name         = var.image
  keep_locally = true
}

resource "docker_volume" "data" {
  name = "${var.name}-data"
}

resource "docker_container" "this" {
  name  = var.name
  image = docker_image.this.image_id
  env = [
    "POSTGRES_DB=${var.db_name}",
    "POSTGRES_USER=${var.user}",
    "POSTGRES_PASSWORD=${random_password.this.result}",
  ]

  networks_advanced {
    name    = var.network_name
    aliases = [var.name]
  }

  volumes {
    volume_name    = docker_volume.data.name
    container_path = "/var/lib/postgresql"
  }
}
```

`modules/postgres/outputs.tf`:

```hcl
output "host" {
  description = "Hostname of the database on the Docker network."
  value       = docker_container.this.name
}

output "port" {
  description = "Port Postgres listens on inside the network."
  value       = 5432
}

output "database_url" {
  description = "Connection string for applications on the same network."
  value       = "postgresql://${var.user}:${random_password.this.result}@${docker_container.this.name}:5432/${var.db_name}"
  sensitive   = true
}
```

`modules/redis/main.tf` (plus a `versions.tf` like the postgres one without `random`):

```hcl
variable "name" {
  type        = string
  description = "Container name; other containers reach Redis at this hostname."
}

variable "network_name" {
  type        = string
  description = "Existing Docker network to attach to."
}

variable "image" {
  type        = string
  description = "Redis image with a pinned major version."
  default     = "redis:8-alpine"
}

resource "docker_image" "this" {
  name         = var.image
  keep_locally = true
}

resource "docker_container" "this" {
  name  = var.name
  image = docker_image.this.image_id

  networks_advanced {
    name    = var.network_name
    aliases = [var.name]
  }
}

output "url" {
  description = "Redis URL for applications on the same network."
  value       = "redis://${docker_container.this.name}:6379"
}
```

Root `versions.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    docker = { source = "kreuzwerker/docker", version = "~> 4.6" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
}

provider "docker" {}

provider "docker" {
  alias = "ops"
  # in real life: another engine, e.g. host = "ssh://ops@ops-01.internal"
}
```

Root `main.tf`:

```hcl
resource "docker_network" "shipit" {
  name = "shipit-dev"
}

module "postgres" {
  source       = "./modules/postgres"
  name         = "shipit-postgres"
  network_name = docker_network.shipit.name
}

module "redis" {
  source       = "./modules/redis"
  name         = "shipit-redis"
  network_name = docker_network.shipit.name
}

module "api" {
  source        = "../modules/web-app"
  name          = "shipit-api"
  image         = "traefik/whoami:latest"
  internal_port = 80
  external_port = 8210
  network_name  = docker_network.shipit.name
  env = {
    DATABASE_URL = module.postgres.database_url
    REDIS_URL    = module.redis.url
  }
}

module "ops_dashboard" {
  source        = "../modules/web-app"
  providers     = { docker = docker.ops }
  name          = "ops-dashboard"
  image         = "traefik/whoami:latest"
  internal_port = 80
  external_port = 8211
  network_name  = docker_network.shipit.name
}

output "api_url" {
  value = module.api.url
}

output "database_url" {
  value     = module.postgres.database_url
  sensitive = true
}
```

Docs:

```bash
printf '# postgres module\n\nRuns PostgreSQL on an existing network.\n\n<!-- BEGIN_TF_DOCS -->\n<!-- END_TF_DOCS -->\n' > modules/postgres/README.md
terraform-docs markdown table --output-file README.md --output-mode inject ./modules/postgres
```

Design notes worth saying out loud in an interview:

- **Dependency inversion**: modules accept `network_name` instead of creating networks, so the same modules work with a network from another team or a data source.
- **Flat composition**: wiring happens in the root; modules don't know about each other.
- **Secrets**: the password is generated inside the module and only leaves as a sensitive output. It's still in state; in AWS you'd let RDS manage it in Secrets Manager instead.
- `ops_dashboard` and `api` use the same module code with different provider configurations, which is how you'd deploy to multiple regions, accounts or clusters.
:::

### Clean up

```bash
terraform destroy -auto-approve
docker volume ls --filter name=shipit   # the postgres volume is managed by Terraform and removed too
```
