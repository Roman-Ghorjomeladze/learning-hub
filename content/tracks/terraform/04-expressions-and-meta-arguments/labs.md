All labs run locally and free with the Docker, local, tls, http and random providers. You need Terraform 1.10+ and a running Docker engine. `jq` and `curl` help.

```bash
mkdir -p ~/tf-labs/m04 && cd ~/tf-labs/m04
```

:::mac Bind mounts
Labs 3 and 5 bind-mount generated files from `~/tf-labs` into containers. Docker Desktop and OrbStack share your home directory by default. With Colima, your home directory is mounted by default too; if you changed that, add the path to Colima's mounts.
:::

## Lab 1: Expression workout in the console

:::meta
difficulty: easy
time: 25 min
:::

Goal: get fluent with for expressions, splats and the key functions before using them in resources.

### Steps

```bash
mkdir -p ~/tf-labs/m04/lab1 && cd ~/tf-labs/m04/lab1
cat > main.tf <<'EOF'
variable "services" {
  default = {
    api    = { image = "shipit-api:1.4", ports = [3000, 9229], public = true }
    worker = { image = "shipit-api:1.4", ports = [], public = false }
    web    = { image = "nginx:1.30-alpine", ports = [80], public = true }
  }
}

variable "settings" {
  default = {
    tls = { enabled = true }
  }
}

locals {
  envs = ["dev", "prod"]
}
EOF
terraform init >/dev/null && terraform console
```

Solve each task with a single expression. Write your answer, then check it:

1. A list of service names.
2. A map of service name to image, only for public services.
3. A map of image to the list of services using it.
4. A flat list of strings `"api:3000"`, `"api:9229"`, `"web:80"`.
5. Every combination of environment and service name as `"dev-api"`, `"dev-web"`, ...
6. The `/24` subnet number 3 inside `10.20.0.0/16`.
7. `var.settings.tls.port` with a fallback of `443` (the attribute doesn't exist).
8. The JSON string for `{ services = <list from task 1>, count = <number of services> }`.
9. Use `coalesce` to pick the first non-empty value among `""`, `(var.settings.tls.enabled ? "tls" : "")` and `"plain"`.

### Verify

Your expressions return exactly the expected values in the solution.

:::hint
- Task 3 needs the grouping `...` suffix.
- Task 4 needs a nested `for` and `flatten`.
- Task 5: `setproduct(local.envs, keys(var.services))` gives pairs; then format them.
- Task 7: `try()`.
:::

:::solution
```text
1. > keys(var.services)
   ["api", "web", "worker"]

2. > { for name, s in var.services : name => s.image if s.public }
   { "api" = "shipit-api:1.4", "web" = "nginx:1.30-alpine" }

3. > { for name, s in var.services : s.image => name... }
   { "nginx:1.30-alpine" = ["web"], "shipit-api:1.4" = ["api", "worker"] }

4. > flatten([for name, s in var.services : [for p in s.ports : "${name}:${p}"]])
   ["api:3000", "api:9229", "web:80"]

5. > [for pair in setproduct(local.envs, keys(var.services)) : join("-", pair)]
   ["dev-api", "dev-web", "dev-worker", "prod-api", "prod-web", "prod-worker"]

6. > cidrsubnet("10.20.0.0/16", 8, 3)
   "10.20.3.0/24"

7. > try(var.settings.tls.port, 443)
   443

8. > jsonencode({ services = keys(var.services), count = length(var.services) })
   "{\"count\":3,\"services\":[\"api\",\"web\",\"worker\"]}"

9. > coalesce("", var.settings.tls.enabled ? "tls" : "", "plain")
   "tls"
```

Note in 8 that `jsonencode` sorts object keys, and in 4 that `worker` contributes nothing because its port list is empty.
:::

### Clean up

```bash
cd ~/tf-labs/m04 && rm -rf lab1
```

## Lab 2: count's index-shift problem, then for_each with moved

:::meta
difficulty: medium
time: 30 min
:::

Goal: see the index-shift problem destroy the wrong containers, then refactor to `for_each` without recreating anything.

### Steps

1. Create three "sites" with `count`:

```bash
mkdir -p ~/tf-labs/m04/lab2 && cd ~/tf-labs/m04/lab2
cat > main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

variable "sites" {
  type    = list(string)
  default = ["blog", "shop", "docs"]
}

resource "docker_image" "echo" {
  name         = "hashicorp/http-echo:latest"
  keep_locally = true
}

resource "docker_container" "site" {
  count   = length(var.sites)
  name    = "site-${var.sites[count.index]}"
  image   = docker_image.echo.image_id
  command = ["-text=${var.sites[count.index]}"]
}

output "sites" {
  value = docker_container.site[*].name
}
EOF
terraform init && terraform apply -auto-approve
terraform state list
```

2. Remove `"shop"` from the default list and run `terraform plan`. Count the replacements. **Don't apply.** Put `"shop"` back.

3. Refactor to `for_each`: change `count` to `for_each = toset(var.sites)`, use `each.key` in `name` and `command`, and fix the output. Run `terraform plan` and read what it wants to do.

4. Add `moved` blocks so the plan shows only moves, then apply.

5. Now remove `"shop"` again and plan. Apply.

### Verify

- Step 2 plan: `site[1]` replaced (shop -> docs) and `site[2]` destroyed: `Plan: 1 to add, 0 to change, 2 to destroy.`
- Step 3 plan without `moved`: 3 to add, 3 to destroy.
- Step 4 plan: three `has moved to` lines and `0 to add, 0 to change, 0 to destroy`.
- Step 5 plan: only `docker_container.site["shop"]` destroyed.

:::hint
The output for a `for_each` resource can't use `[*]` directly because the resource is a map. Use `[for c in docker_container.site : c.name]` or `values(docker_container.site)[*].name`.
:::

:::solution
```hcl
resource "docker_container" "site" {
  for_each = toset(var.sites)
  name     = "site-${each.key}"
  image    = docker_image.echo.image_id
  command  = ["-text=${each.key}"]
}

moved {
  from = docker_container.site[0]
  to   = docker_container.site["blog"]
}

moved {
  from = docker_container.site[1]
  to   = docker_container.site["shop"]
}

moved {
  from = docker_container.site[2]
  to   = docker_container.site["docs"]
}

output "sites" {
  value = [for c in docker_container.site : c.name]
}
```

With `count`, identity is the **position**, so removing an element shifts later ones and Terraform "renames" (replaces) them. With `for_each`, identity is the **key**, so removing `shop` touches only `site["shop"]`.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 3: A templated load balancer with dynamic blocks and replace_triggered_by

:::meta
difficulty: medium
time: 40 min
:::

Goal: run N backends from a map, generate an nginx config with `templatefile`, publish ports with a `dynamic` block, and restart the proxy automatically when the config changes.

### Steps

1. Create the template and config:

```bash
mkdir -p ~/tf-labs/m04/lab3 && cd ~/tf-labs/m04/lab3

cat > nginx.conf.tftpl <<'EOF'
upstream backends {
%{ for host in backends ~}
    server ${host}:80;
%{ endfor ~}
}

server {
    listen 80;
    location / {
        proxy_pass http://backends;
    }
    location = /lb-health {
        return 200 "ok: ${length(backends)} backends\n";
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
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}

variable "backends" {
  type = map(object({
    weight = optional(number, 1)
  }))
  default = {
    blue  = {}
    green = {}
  }
}

variable "published_ports" {
  type    = map(number) # container port => host port
  default = { "80" = 8094 }
}

resource "docker_network" "lb" {
  name = "tf-lb"
}

resource "docker_image" "whoami" {
  name         = "traefik/whoami:latest"
  keep_locally = true
}

resource "docker_image" "nginx" {
  name         = "nginx:1.30-alpine"
  keep_locally = true
}

resource "docker_container" "backend" {
  for_each = var.backends
  name     = "lb-backend-${each.key}"
  image    = docker_image.whoami.image_id
  env      = ["WHOAMI_NAME=${each.key}"]

  networks_advanced {
    name = docker_network.lb.id
  }
}

resource "local_file" "nginx_conf" {
  filename = "${path.module}/generated/default.conf"
  content = templatefile("${path.module}/nginx.conf.tftpl", {
    backends = [for b in docker_container.backend : b.name]
  })
}

resource "docker_container" "proxy" {
  name  = "lb-proxy"
  image = docker_image.nginx.image_id

  networks_advanced {
    name = docker_network.lb.id
  }

  volumes {
    host_path      = abspath(local_file.nginx_conf.filename)
    container_path = "/etc/nginx/conf.d/default.conf"
    read_only      = true
  }

  dynamic "ports" {
    for_each = var.published_ports
    content {
      internal = tonumber(ports.key)
      external = ports.value
    }
  }

  lifecycle {
    replace_triggered_by = [local_file.nginx_conf]
  }
}

output "url" {
  value = "http://localhost:${var.published_ports["80"]}"
}
EOF
terraform init && terraform apply -auto-approve
cat generated/default.conf
```

2. Test round-robin:

```bash
curl -s localhost:8094/lb-health
for i in 1 2 3 4; do curl -s localhost:8094 | grep -E '^Name'; done
```

3. Add a third backend `red = {}` to the default map. Plan: what is created, what is replaced, and why is the proxy replaced? Apply and test again.

4. Publish an extra port: add `"8080" = 8095` to `published_ports`. Plan and apply (nginx doesn't listen on 8080 in the container, so it won't answer, but notice the second `ports` block).

5. Comment out the `lifecycle` block, add a fourth backend, apply, and test. Does nginx route to it? Why not? Restore the lifecycle block and apply again.

### Verify

- `curl localhost:8094/lb-health` reports the right number of backends.
- Repeated `curl` requests alternate `Name: blue`, `Name: green` (and `red` after step 3).
- Step 5 without `replace_triggered_by`: the config file changes but nginx keeps serving the old upstream list.

:::hint
- `templatefile` variables: everything the template uses must be passed in the map; the template can't see `var.` or `local.`.
- In step 5, the bind-mounted file was replaced (new inode) by `local_file`, but the running container still sees the old file, and nginx only reads config at start or reload. Something must trigger a restart.
:::

:::solution
- Step 3: `docker_container.backend["red"]` is created; `local_file.nginx_conf` is replaced (its content changed, and local_file content forces replacement); `docker_container.proxy` is replaced because `replace_triggered_by` points at `local_file.nginx_conf`. Plan: `3 to add, 0 to change, 2 to destroy`.
- Step 4: the dynamic block now renders two `ports` blocks; changing ports forces the proxy to be replaced.
- Step 5: without `replace_triggered_by`, the proxy's own arguments didn't change (`host_path` is the same string), so Terraform leaves it alone and nginx never sees the new config. With it, any change to the rendered config replaces the proxy. In production you'd achieve the same by baking config into an image tag or using a config checksum annotation in Kubernetes.

Rendered `generated/default.conf` with three backends:

```text
upstream backends {
    server lb-backend-blue:80;
    server lb-backend-green:80;
    server lb-backend-red:80;
}
...
```
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 4: Break & fix: lifecycle and for_each gone wrong

:::meta
difficulty: hard
time: 35 min
:::

Goal: diagnose four realistic mistakes with meta-arguments.

### Steps

```bash
mkdir -p ~/tf-labs/m04/lab4 && cd ~/tf-labs/m04/lab4
cat > main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "redis_tag" {
  type    = string
  default = "8-alpine"
}

resource "docker_volume" "data" {
  name = "shipit-redis-data-${var.environment}"
  lifecycle {
    prevent_destroy = true
  }
}

resource "docker_image" "redis" {
  name         = "redis:${var.redis_tag}"
  keep_locally = true
}

resource "docker_container" "redis" {
  name  = "shipit-redis-${var.environment}"
  image = docker_image.redis.image_id

  volumes {
    volume_name    = docker_volume.data.name
    container_path = "/data"
  }

  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = var.environment == "prod"
      error_message = "Redis in prod must use a pinned major version tag."
    }
  }
}

resource "random_pet" "worker" {
  count = 2
}

resource "docker_container" "worker" {
  for_each = toset(random_pet.worker[*].id)
  name     = "worker-${each.key}"
  image    = docker_image.redis.image_id
  command  = ["redis-server", "--port", "6380"]
}
EOF
terraform init
terraform plan
```

Fix the problems so that:

1. `terraform apply` succeeds on a fresh setup for `dev`.
2. Changing `redis_tag` to `7-alpine` and applying succeeds (container replaced, data volume kept).
3. The precondition expresses what its error message says: **in prod**, the tag must start with a digit (no `latest`, no `alpine` alone). In dev anything goes.
4. Workers are created reliably with names you choose (e.g. `worker-a`, `worker-b`).
5. `prevent_destroy` still protects the volume. Explain how you'd tear down this dev environment completely.

### Verify

```bash
terraform apply -auto-approve
terraform apply -auto-approve -var redis_tag=7-alpine
terraform plan -var environment=prod -var redis_tag=latest   # precondition error
docker ps --filter name=shipit-redis --filter name=worker
```

:::hint
1. Read the `for_each` error: what must be known at plan time?
2. The precondition condition is inverted relative to its message. Think "if prod then the tag must match a regex".
3. When `redis_tag` changes, the container is replaced with `create_before_destroy = true`. What does Docker say about the name?
4. `prevent_destroy` blocks any plan that destroys the volume, including `terraform destroy`.
:::

:::solution
**Bug 1: `for_each` with unknown keys.** `random_pet.worker[*].id` is only known after apply: `Error: Invalid for_each argument ... The "for_each" set includes values derived from resource attributes that cannot be determined until apply`. Use static keys:

```hcl
resource "docker_container" "worker" {
  for_each = toset(["a", "b"])
  name     = "worker-${each.key}"
  image    = docker_image.redis.image_id
  command  = ["redis-server", "--port", "6380"]
}
```

(and delete `random_pet.worker`). If you really want random names, use them as *values* inside a map with static keys, never as keys.

**Bug 2: precondition logic.** The condition `var.environment == "prod"` fails in dev and has nothing to do with the tag. Express "not prod, or a pinned tag":

```hcl
precondition {
  condition     = var.environment != "prod" || can(regex("^[0-9]", var.redis_tag))
  error_message = "Redis in prod must use a pinned major version tag."
}
```

**Bug 3: create_before_destroy with a fixed name.** Changing the tag replaces the container; with `create_before_destroy` Terraform tries to create a second `shipit-redis-dev` while the first exists: `Conflict. The container name "/shipit-redis-dev" is already in use`. Remove `create_before_destroy` (a single Redis container can't have two copies sharing a name and volume anyway), or make the name unique per replacement. Removing it is right here.

**Bug 4: tearing down with prevent_destroy.** `terraform destroy` fails with `Instance cannot be destroyed ... lifecycle.prevent_destroy`. That's the feature working. To tear down a dev environment deliberately: change `prevent_destroy` to `false` (or make it conditional through a separate resource for prod), apply, then destroy. Note that `prevent_destroy` can't reference variables; it must be a literal, so teams often keep it `true` in prod-only stacks.

Clean, working `docker_container.redis`:

```hcl
resource "docker_container" "redis" {
  name  = "shipit-redis-${var.environment}"
  image = docker_image.redis.image_id

  volumes {
    volume_name    = docker_volume.data.name
    container_path = "/data"
  }

  lifecycle {
    precondition {
      condition     = var.environment != "prod" || can(regex("^[0-9]", var.redis_tag))
      error_message = "Redis in prod must use a pinned major version tag."
    }
  }
}
```
:::

### Clean up

```bash
sed -i '' 's/prevent_destroy = true/prevent_destroy = false/' main.tf
terraform apply -auto-approve && terraform destroy -auto-approve
```

## Lab 5: HTTPS with the tls provider, a check block and a provider alias

:::meta
difficulty: medium
time: 35 min
:::

Goal: generate a self-signed certificate with Terraform, serve HTTPS from nginx, verify it with a `check` block, and practise provider aliases.

### Steps

1. Create the files:

```bash
mkdir -p ~/tf-labs/m04/lab5 && cd ~/tf-labs/m04/lab5

cat > tls.conf.tftpl <<'EOF'
server {
    listen 443 ssl;
    server_name ${server_name};
    ssl_certificate     /etc/nginx/tls/tls.crt;
    ssl_certificate_key /etc/nginx/tls/tls.key;
    location / {
        return 200 "hello over TLS from ${server_name}\n";
    }
}
EOF

cat > main.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    docker = { source = "kreuzwerker/docker", version = "~> 4.6" }
    local  = { source = "hashicorp/local", version = "~> 2.9" }
    tls    = { source = "hashicorp/tls", version = "~> 4.4" }
    http   = { source = "hashicorp/http", version = "~> 3.6" }
  }
}

provider "docker" {}

locals {
  server_name = "localhost"
  https_port  = 8443
}

resource "tls_private_key" "this" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "this" {
  private_key_pem       = tls_private_key.this.private_key_pem
  validity_period_hours = 24
  early_renewal_hours   = 6
  dns_names             = [local.server_name]
  allowed_uses          = ["digital_signature", "key_encipherment", "server_auth"]

  subject {
    common_name  = local.server_name
    organization = "shipit labs"
  }
}

resource "local_file" "cert" {
  filename = "${path.module}/generated/tls.crt"
  content  = tls_self_signed_cert.this.cert_pem
}

resource "local_sensitive_file" "key" {
  filename        = "${path.module}/generated/tls.key"
  content         = tls_private_key.this.private_key_pem
  file_permission = "0600"
}

resource "local_file" "nginx_conf" {
  filename = "${path.module}/generated/tls.conf"
  content  = templatefile("${path.module}/tls.conf.tftpl", { server_name = local.server_name })
}

resource "docker_image" "nginx" {
  name         = "nginx:1.30-alpine"
  keep_locally = true
}

resource "docker_container" "https" {
  name  = "tf-https"
  image = docker_image.nginx.image_id

  ports {
    internal = 443
    external = local.https_port
  }

  volumes {
    host_path      = abspath(dirname(local_file.cert.filename))
    container_path = "/etc/nginx/tls"
    read_only      = true
  }

  volumes {
    host_path      = abspath(local_file.nginx_conf.filename)
    container_path = "/etc/nginx/conf.d/default.conf"
    read_only      = true
  }

  lifecycle {
    replace_triggered_by = [local_file.cert, local_sensitive_file.key, local_file.nginx_conf]
  }
}

check "https_endpoint" {
  data "http" "home" {
    url         = "https://${local.server_name}:${local.https_port}/"
    ca_cert_pem = tls_self_signed_cert.this.cert_pem
  }

  assert {
    condition     = data.http.home.status_code == 200
    error_message = "HTTPS endpoint returned ${data.http.home.status_code}."
  }
}

output "cert_expires" {
  value = tls_self_signed_cert.this.validity_end_time
}
EOF
terraform init
```

2. Run `terraform apply`. Note any warning from the check block during the **plan** phase of the first apply (the container doesn't exist yet). Then run `terraform plan` again.

3. Test with curl using the generated CA:

```bash
curl --cacert generated/tls.crt https://localhost:8443/
openssl x509 -in generated/tls.crt -noout -subject -enddate
```

4. Break the check: `docker stop tf-https`, run `terraform plan`. Is it an error or a warning? Run `terraform apply -auto-approve` and see the container come back.

5. Provider alias practice: add a second Docker provider configuration with `alias = "secondary"` (same local engine; in real life this would be another host or context) and a `docker_image` for `busybox:1.37` that uses it via `provider = docker.secondary`. Plan and apply. Check `terraform state show docker_image.busybox` and `terraform providers`.

### Verify

- `curl --cacert ...` prints `hello over TLS from localhost` without `-k`.
- With the container stopped, `terraform plan` shows a **warning** `Check block assertion failed` (or a data source error inside the check) and still completes.
- `terraform state show docker_image.busybox` shows `provider = provider["registry.terraform.io/kreuzwerker/docker"].secondary`.

:::hint
If the plan in step 2 warns that the check failed, that's expected: during the first plan the HTTPS endpoint doesn't exist yet. Checks run again after apply, so the apply output should end without the warning.

If `docker logs tf-https` shows nginx can't read `tls.key` (some file-sharing setups map permissions differently), set `file_permission = "0644"` on the key for this lab only.

For step 5: `provider "docker" { alias = "secondary" }` and inside the resource `provider = docker.secondary` (no quotes).
:::

:::solution
Step 4: check failures are **warnings**; the run continues. That's the difference from pre/postconditions, which would fail the run. Apply then recreates/starts the container (the provider sees it's not running; `must_run` defaults to true).

Step 5 additions:

```hcl
provider "docker" {
  alias = "secondary"
  # host = "ssh://deploy@build-01.internal:22"   # what you'd set for a real second engine
}

resource "docker_image" "busybox" {
  provider     = docker.secondary
  name         = "busybox:1.37"
  keep_locally = true
}
```

`terraform state show` shows `provider = provider["registry.terraform.io/kreuzwerker/docker"].secondary` for that resource. If you later remove the aliased provider block while the resource is still in state, Terraform can't plan its destruction: providers must stay configured until the resources using them are gone.

Security note: the private key is in state (`tls_private_key` is a managed resource). For real certificates use a CA service (ACM, cert-manager, Let's Encrypt), and keep private keys out of Terraform state where you can.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 6: Challenge: environments x services matrix

:::meta
difficulty: hard
time: 45 min
:::

Goal: drive a whole local "platform" from two small inputs using `setproduct`, `flatten`, `cidrsubnet`, `for_each` and conditionals.

### Requirements

Inputs (use these defaults):

```hcl
variable "environments" {
  default = ["dev", "staging"]
}

variable "services" {
  default = {
    api = { text = "shipit api", port_base = 9100 }
    web = { text = "shipit web", port_base = 9200 }
  }
}
```

Build:

1. One Docker network per environment named `mx-<env>`, each with its own `/24` subnet carved from `172.28.0.0/16` with `cidrsubnet` (dev = netnum 1, staging = netnum 2; derive it from the list index).
2. One `hashicorp/http-echo` container per (environment, service) pair, named `mx-<env>-<service>`, attached to its environment's network, replying with `"<text> (<env>)"`.
3. Host ports: `port_base + index of the environment` (dev api = 9100, staging api = 9101, dev web = 9200, staging web = 9201).
4. Use `for_each` with keys like `"dev-api"`. No `count` anywhere.
5. Staging containers get `restart = "unless-stopped"`, dev gets `"no"` (a conditional).
6. An output `urls`: a map from key to URL, and an output `by_env`: a map from env to the list of container names in that env.
7. Adding `"prod"` to `environments` must only **add** resources, never replace existing ones. Prove it with a plan.

### Verify

```bash
terraform apply -auto-approve
terraform output urls
curl -s localhost:9101     # shipit api (staging)
docker network inspect mx-staging -f '{{(index .IPAM.Config 0).Subnet}}'   # 172.28.2.0/24
terraform plan -var 'environments=["dev","staging","prod"]'   # only additions
```

:::hint
Build a local list of objects with `flatten` over environments (with index) and services, then convert it to a map keyed by `"${env}-${svc}"`. Docker networks take `ipam_config { subnet = ... }`. Use `index(var.environments, env)` or iterate with `for i, env in var.environments`.
:::

:::solution
```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

variable "environments" {
  type    = list(string)
  default = ["dev", "staging"]
}

variable "services" {
  type = map(object({ text = string, port_base = number }))
  default = {
    api = { text = "shipit api", port_base = 9100 }
    web = { text = "shipit web", port_base = 9200 }
  }
}

locals {
  envs = { for i, env in var.environments : env => i }   # { dev = 0, staging = 1 }

  instances = {
    for pair in setproduct(var.environments, keys(var.services)) :
    "${pair[0]}-${pair[1]}" => {
      env     = pair[0]
      service = pair[1]
      text    = "${var.services[pair[1]].text} (${pair[0]})"
      port    = var.services[pair[1]].port_base + local.envs[pair[0]]
    }
  }
}

resource "docker_network" "env" {
  for_each = local.envs
  name     = "mx-${each.key}"

  ipam_config {
    subnet = cidrsubnet("172.28.0.0/16", 8, each.value + 1)
  }
}

resource "docker_image" "echo" {
  name         = "hashicorp/http-echo:latest"
  keep_locally = true
}

resource "docker_container" "svc" {
  for_each = local.instances

  name    = "mx-${each.key}"
  image   = docker_image.echo.image_id
  command = ["-text=${each.value.text}"]
  restart = each.value.env == "staging" ? "unless-stopped" : "no"

  ports {
    internal = 5678
    external = each.value.port
  }

  networks_advanced {
    name = docker_network.env[each.value.env].id
  }
}

output "urls" {
  value = { for k, inst in local.instances : k => "http://localhost:${inst.port}" }
}

output "by_env" {
  value = {
    for k, c in docker_container.svc : local.instances[k].env => c.name...
  }
}
```

Why adding `prod` only adds: keys are names (`"prod-api"`, network `"prod"`), and existing envs keep their index because `prod` is appended at the end. If you inserted `prod` at the **beginning** of the list, the indices (and therefore the subnets and ports) of dev and staging would shift and force replacements: the index-shift problem in disguise. A more robust design stores the netnum and port offset explicitly per environment in a map.
:::

### Clean up

```bash
terraform destroy -auto-approve
```
