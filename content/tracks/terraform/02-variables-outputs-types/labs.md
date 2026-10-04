All labs run locally and free. You need Terraform 1.10+ and a running Docker engine (see module 01 labs for socket notes on Colima). Lab 2's precedence results are the same on any Terraform 1.x.

```bash
mkdir -p ~/tf-labs/m02 && cd ~/tf-labs/m02
```

Optional but useful: `brew install jq`.

## Lab 1: Types and terraform console

:::meta
difficulty: easy
time: 20 min
:::

Goal: get a feel for Terraform's type system without creating anything.

### Steps

1. Create a provider-less config:

```bash
mkdir -p ~/tf-labs/m02/lab1 && cd ~/tf-labs/m02/lab1
cat > variables.tf <<'EOF'
variable "app_name" {
  type    = string
  default = "shipit"
}

variable "allowed_ips" {
  type    = list(string)
  default = ["10.0.0.1", "10.0.0.2", "10.0.0.1"]
}

variable "services" {
  type = map(object({
    image    = string
    port     = number
    replicas = optional(number, 1)
    env      = optional(map(string), {})
  }))
  default = {
    api = { image = "shipit-api:1.0", port = 3000, env = { LOG_LEVEL = "info" } }
    web = { image = "nginx:1.30-alpine", port = 8080, replicas = 2 }
  }
}
EOF

cat > main.tf <<'EOF'
locals {
  unique_ips    = toset(var.allowed_ips)
  service_names = keys(var.services)
  total_replicas = sum([for s in var.services : s.replicas])
}

output "summary" {
  value = {
    names          = local.service_names
    unique_ips     = local.unique_ips
    total_replicas = local.total_replicas
  }
}
EOF
terraform init
```

2. Open the console and evaluate these, predicting each result first:

```text
terraform console
> var.services.web.env
> var.services["api"].replicas
> type(var.services)
> length(var.allowed_ips)
> length(local.unique_ips)
> local.unique_ips[0]
> tolist(local.unique_ips)[0]
> [for name, s in var.services : "${name}=${s.image}"]
> { for name, s in var.services : name => s.port }
> exit
```

3. Run `terraform apply -auto-approve` and check the output. Then run `terraform output -json summary | jq .`.

### Verify

- `var.services.web.env` is `{}` and `var.services["api"].replicas` is `1` (defaults from `optional`).
- `length(local.unique_ips)` is `2`.
- `local.unique_ips[0]` fails: sets have no index. `tolist(...)` fixes it.
- The output shows `total_replicas = 3`.

:::hint
If `type(var.services)` prints something long, read it carefully: it shows the fully resolved object type including optional attributes with defaults applied.
:::

:::solution
Expected console results:

```text
> var.services.web.env
tomap({})
> var.services["api"].replicas
1
> type(var.services)
map(
    object({
        env: map(string),
        image: string,
        port: number,
        replicas: number,
    }),
)
> length(var.allowed_ips)
3
> length(local.unique_ips)
2
> local.unique_ips[0]
Error: Invalid index ... This value does not have any indices.
> tolist(local.unique_ips)[0]
"10.0.0.1"
> [for name, s in var.services : "${name}=${s.image}"]
["api=shipit-api:1.0", "web=nginx:1.30-alpine"]
> { for name, s in var.services : name => s.port }
{ "api" = 3000, "web" = 8080 }
```

Map iteration is always in lexical key order, which is why `api` comes before `web`. Set ordering for strings is also lexical, but don't rely on order for sets in general.
:::

### Clean up

```bash
rm -rf ~/tf-labs/m02/lab1
```

## Lab 2: Variable precedence experiment

:::meta
difficulty: easy
time: 15 min
:::

Goal: prove the precedence order to yourself so you never have to guess during an incident.

### Steps

```bash
mkdir -p ~/tf-labs/m02/lab2 && cd ~/tf-labs/m02/lab2
cat > main.tf <<'EOF'
variable "color" {
  type    = string
  default = "red (default)"
}

output "color" {
  value = var.color
}
EOF
terraform init
```

Run each step and **write your prediction before pressing enter**:

```bash
# 1. default only
terraform apply -auto-approve | tail -1

# 2. environment variable
export TF_VAR_color="blue (TF_VAR)"
terraform apply -auto-approve | tail -1

# 3. terraform.tfvars
echo 'color = "green (terraform.tfvars)"' > terraform.tfvars
terraform apply -auto-approve | tail -1

# 4. two auto.tfvars files
echo 'color = "yellow (a.auto.tfvars)"' > a.auto.tfvars
echo 'color = "orange (b.auto.tfvars)"' > b.auto.tfvars
terraform apply -auto-approve | tail -1

# 5. -var-file and -var together (order matters)
echo 'color = "pink (custom.tfvars)"' > custom.tfvars
terraform apply -auto-approve -var='color=purple (-var)' -var-file=custom.tfvars | tail -1
terraform apply -auto-approve -var-file=custom.tfvars -var='color=purple (-var)' | tail -1
```

### Verify

Your results match: default, TF_VAR, terraform.tfvars, b.auto.tfvars, then whichever of `-var`/`-var-file` came **last** on the command line.

:::hint
Auto tfvars files are loaded in lexical (alphabetical) order, and a later file overrides an earlier one. CLI flags are processed left to right.
:::

:::solution
```text
1. color = "red (default)"
2. color = "blue (TF_VAR)"
3. color = "green (terraform.tfvars)"
4. color = "orange (b.auto.tfvars)"
5a. color = "pink (custom.tfvars)"     # -var-file came last
5b. color = "purple (-var)"            # -var came last
```

This is a real debugging scenario: someone left an `old.auto.tfvars` in the folder or exported a `TF_VAR_` in their shell profile, and "the tfvars file is being ignored".
:::

### Clean up

```bash
unset TF_VAR_color
cd ~/tf-labs/m02 && rm -rf lab2
```

## Lab 3: A parameterised Postgres container with validation and sensitive outputs

:::meta
difficulty: medium
time: 30 min
:::

Goal: build a small, well-typed configuration that runs Postgres for the shipit API with a generated password.

### Steps

1. Create the files:

```bash
mkdir -p ~/tf-labs/m02/lab3 && cd ~/tf-labs/m02/lab3

cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
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

provider "docker" {}
EOF

cat > variables.tf <<'EOF'
variable "environment" {
  type        = string
  description = "Environment name; becomes part of container names."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "postgres" {
  description = "Postgres container settings."
  type = object({
    image   = optional(string, "postgres:18-alpine")
    port    = optional(number, 55432)
    db_name = optional(string, "shipit")
    user    = optional(string, "shipit")
  })
  default = {}

  validation {
    condition     = var.postgres.port >= 1024 && var.postgres.port <= 65535
    error_message = "postgres.port must be between 1024 and 65535."
  }

  validation {
    condition     = can(regex(":[0-9]+", var.postgres.image))
    error_message = "postgres.image must be pinned to a numeric major version tag, e.g. postgres:18-alpine."
  }
}

variable "labels" {
  type     = map(string)
  default  = {}
  nullable = false
}
EOF

cat > main.tf <<'EOF'
locals {
  name = "shipit-${var.environment}-postgres"
  labels = merge(var.labels, {
    managed_by  = "terraform"
    environment = var.environment
  })
}

resource "random_password" "db" {
  length  = 24
  special = false
}

resource "docker_image" "postgres" {
  name         = var.postgres.image
  keep_locally = true
}

resource "docker_container" "postgres" {
  name  = local.name
  image = docker_image.postgres.image_id

  env = [
    "POSTGRES_DB=${var.postgres.db_name}",
    "POSTGRES_USER=${var.postgres.user}",
    "POSTGRES_PASSWORD=${random_password.db.result}",
  ]

  ports {
    internal = 5432
    external = var.postgres.port
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
  value = docker_container.postgres.name
}

output "database_url" {
  description = "Connection string for shipit-api's DATABASE_URL."
  value       = "postgresql://${var.postgres.user}:${random_password.db.result}@localhost:${var.postgres.port}/${var.postgres.db_name}"
  sensitive   = true
}
EOF

cat > terraform.tfvars <<'EOF'
environment = "dev"
labels = {
  team = "platform"
}
EOF
```

2. Apply and use the outputs:

```bash
terraform init
terraform apply
terraform output
terraform output -raw database_url; echo
docker exec "$(terraform output -raw container_name)" pg_isready -U shipit
```

3. Try invalid inputs and read the errors (don't apply, just plan):

```bash
terraform plan -var='environment=qa'
terraform plan -var='postgres={port=80}'
terraform plan -var='postgres={image="postgres:latest"}'
terraform plan -var='labels=null'
```

4. Remove `sensitive = true` from `database_url` and run `terraform plan`. Read the error, then put it back.

5. Look for the password in state: `grep -n POSTGRES_PASSWORD terraform.tfstate | head -2`.

### Verify

- `terraform output` shows `database_url = <sensitive>`, while `-raw` prints the full URL.
- `pg_isready` reports `accepting connections`.
- Each of the first three invalid plans fails with your custom error message. Note what happens with `labels=null` and compare with the solution.
- Step 4 fails with `Output refers to sensitive values`.
- Step 5 finds the password in plain text in state.

:::hint
The `dynamic "labels"` block turns a map into repeated nested `labels { }` blocks. You'll study `dynamic` in module 04; for now notice that it's needed because the provider models labels as blocks, not as a map argument.
:::

:::solution
Expected errors in step 3:

```text
Error: Invalid value for variable
  ... environment must be one of: dev, staging, prod.

Error: Invalid value for variable
  ... postgres.port must be between 1024 and 65535.

Error: Invalid value for variable
  ... postgres.image must be pinned to a numeric major version tag, e.g. postgres:18-alpine.
```

For `labels=null`: because `labels` has `nullable = false` **and** a default, Terraform uses the default `{}` instead of null, so the plan succeeds. Without a default it would be an error. With `nullable = true` (the default), `var.labels` would really be `null` inside the module, and every expression that expects a map (`keys(var.labels)`, `var.labels["team"]`, a `for_each`) would have to handle that case. `nullable = false` removes that class of bug.

Step 4 error:

```text
Error: Output refers to sensitive values
  To reduce the risk of accidentally exporting sensitive data that was intended to be only
  internal, Terraform requires that any root module output containing sensitive data be
  explicitly marked as sensitive, to confirm your intent.
```

`random_password.result` is sensitive by provider design, and sensitivity propagates through string interpolation.

Step 5 proves the key lesson: `sensitive` hides values in output only. The state stores the password in plain text, so state must be protected (module 03).
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 4: Break & fix: the variables that would not cooperate

:::meta
difficulty: medium
time: 25 min
:::

Goal: diagnose common variable and type errors. This config has **five** bugs. Fix them until `terraform plan` succeeds and shows the expected values.

### Steps

```bash
mkdir -p ~/tf-labs/m02/lab4 && cd ~/tf-labs/m02/lab4
cat > main.tf <<'EOF'
variable "app_name" {
  type    = string
  default = "Shipit API"

  validation {
    condition     = regex("^[a-z][a-z0-9-]+$", var.app_name)
    error_message = "app_name must be lowercase letters, digits and dashes."
  }
}

variable "ports" {
  type    = list(number)
  default = { api = 3000, web = 8080 }
}

variable "api_token" {
  type      = string
  sensitive = true
}

locals {
  api_port = var.ports.api
}

output "token_hint" {
  value = "token starts with ${substr(var.api_token, 0, 4)}"
}

output "api_port" {
  value = locals.api_port
}
EOF

cat > terraform.tfvars <<'EOF'
app_name = "shipit-api"
api_token = abcd1234efgh
EOF
terraform init
terraform plan -input=false
```

Expected end result: `terraform plan -input=false` (with the token supplied **without** putting it in a committed file) succeeds and shows `api_port = 3000`.

### Verify

```bash
TF_VAR_api_token=abcd1234efgh terraform plan -input=false
```

shows `+ api_port = 3000` and `+ token_hint = (sensitive value)`.

:::hint
Work through the errors in the order Terraform reports them. Clues: tfvars files are HCL (strings need quotes). Does `regex()` return a bool? Is `{ api = 3000 }` a list? What is the prefix for locals? And Terraform will not let a sensitive value leak into an output silently.
:::

:::solution
1. **tfvars syntax**: `api_token = abcd1234efgh` is parsed as a reference, not a string. Better still, remove the token from the file entirely and use `TF_VAR_api_token` so the secret is not committed.
2. **Type mismatch**: `ports` is declared `list(number)` but the default is an object with keys. Use `map(number)`.
3. **Validation must return bool**: `regex()` returns the match (or errors). Use `can(regex("^[a-z][a-z0-9-]+$", var.app_name))`. Note the *default* `"Shipit API"` would fail validation, but it's overridden by `terraform.tfvars`, and Terraform validates the final value. Fix the default to `"shipit-api"` anyway.
4. **`locals.api_port`** should be `local.api_port` (singular when referencing).
5. **Sensitive output**: `token_hint` derives from a sensitive variable, so it must be `sensitive = true` (or don't output it at all, which is better).

Fixed `main.tf`:

```hcl
variable "app_name" {
  type    = string
  default = "shipit-api"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+$", var.app_name))
    error_message = "app_name must be lowercase letters, digits and dashes."
  }
}

variable "ports" {
  type    = map(number)
  default = { api = 3000, web = 8080 }
}

variable "api_token" {
  type      = string
  sensitive = true
}

locals {
  api_port = var.ports.api
}

output "token_hint" {
  value     = "token starts with ${substr(var.api_token, 0, 4)}"
  sensitive = true
}

output "api_port" {
  value = local.api_port
}
```

Fixed `terraform.tfvars`:

```hcl
app_name = "shipit-api"
```
:::

### Clean up

```bash
cd ~/tf-labs/m02 && rm -rf lab4
```

## Lab 5: Data sources: digests, HTTP and files

:::meta
difficulty: medium
time: 25 min
:::

Goal: read information from the outside world and use it to drive resources.

### Steps

1. Create the config:

```bash
mkdir -p ~/tf-labs/m02/lab5 && cd ~/tf-labs/m02/lab5
echo "Welcome to shipit, managed by Terraform." > motd.txt

cat > main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.6"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}

data "docker_registry_image" "whoami" {
  name = "traefik/whoami:latest"
}

data "http" "tf_version" {
  url             = "https://checkpoint-api.hashicorp.com/v1/check/terraform"
  request_headers = { Accept = "application/json" }
}

data "local_file" "motd" {
  filename = "${path.module}/motd.txt"
}

data "docker_network" "bridge" {
  name = "bridge"
}

locals {
  latest_terraform = jsondecode(data.http.tf_version.response_body).current_version
}

resource "docker_image" "whoami" {
  name          = data.docker_registry_image.whoami.name
  pull_triggers = [data.docker_registry_image.whoami.sha256_digest]
  keep_locally  = true
}

resource "docker_container" "whoami" {
  name  = "tf-whoami"
  image = docker_image.whoami.image_id
  env   = ["MOTD=${trimspace(data.local_file.motd.content)}"]

  ports {
    internal = 80
    external = 8084
  }
}

output "whoami_digest"    { value = data.docker_registry_image.whoami.sha256_digest }
output "latest_terraform" { value = local.latest_terraform }
output "bridge_subnet"    { value = data.docker_network.bridge.ipam_config }
EOF
terraform init
terraform fmt
```

2. Run `terraform plan` and find where data source values appear. Apply.

3. Check `curl -s localhost:8084 | head -5` and `docker inspect tf-whoami --format '{{json .Config.Env}}'`.

4. Change `motd.txt` and run `terraform plan`. What happens to the container and why?

5. Compare `terraform version` with the `latest_terraform` output.

### Verify

- The plan already shows `whoami_digest` and `latest_terraform` values (read at plan time).
- After step 4 the container must be replaced (`env` forces replacement), even though you didn't touch any `.tf` file.

:::hint
Data sources are read before the resources that use them. To see exactly what a data source returned, run `terraform console` after apply and type `data.docker_network.bridge` or `data.http.tf_version.status_code`.
:::

:::solution
- Data sources without unknown inputs are read during plan, so their values appear in the plan output. If a data source depended on an attribute "known after apply", the plan would show `<= read (data resources)` and the value would appear only after apply.
- Changing `motd.txt` changes `data.local_file.motd.content`, which changes the container's `env`; `env` is ForceNew in the Docker provider, so the container is replaced. Data sources make configurations react to the outside world, which is powerful but means a plan can change without a code change.
- `pull_triggers` with the registry digest means: when someone pushes a new image under the same tag, the next plan re-pulls the image and replaces the container. This is a common pattern to deploy "the latest build of a moving tag" deliberately.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 6: Challenge: one config, three environments

:::meta
difficulty: hard
time: 40 min
:::

Goal: design inputs for a configuration that runs the same stack in dev, staging and prod on your machine, selected by a single variable.

### Requirements

1. A variable `environment` (validated: `dev`, `staging`, `prod`).
2. A variable `settings` of type `map(object(...))` keyed by environment, with attributes `web_port` (number, required), `image` (string, optional, default `nginx:1.30-alpine`) and `restart` (string, optional, default `"no"`). Provide values for all three environments in `terraform.tfvars`, with prod using `restart = "unless-stopped"`.
3. A **cross-variable validation** that fails with a clear message if `settings` has no entry for the chosen `environment`.
4. A validation that every `restart` value is one of `no`, `on-failure`, `always`, `unless-stopped`.
5. A local `current` holding the selected settings object; one `docker_container` named `shipit-<env>-web` using it.
6. Outputs: `url` and a non-sensitive `summary` object (env, image, restart).
7. Run it twice with different environments using `-var` and show that switching environment **replaces** the container (because the name changes). Then explain why that is a problem for real environments, and what you would do instead.

### Verify

```bash
terraform apply -auto-approve -var environment=dev && curl -sI localhost:$(terraform output -raw port) | head -1
terraform plan -var environment=qa        # validation error
terraform plan -var environment=prod      # container replaced, restart unless-stopped
```

:::hint
`alltrue([for s in values(var.settings) : contains([...], s.restart)])` validates every element. For requirement 3, put the validation on `environment` and reference `var.settings` (Terraform 1.9+).
:::

:::solution
`variables.tf`:

```hcl
variable "environment" {
  type = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }

  validation {
    condition     = contains(keys(var.settings), var.environment)
    error_message = "settings has no entry for the selected environment."
  }
}

variable "settings" {
  type = map(object({
    web_port = number
    image    = optional(string, "nginx:1.30-alpine")
    restart  = optional(string, "no")
  }))

  validation {
    condition = alltrue([
      for s in values(var.settings) : contains(["no", "on-failure", "always", "unless-stopped"], s.restart)
    ])
    error_message = "restart must be one of: no, on-failure, always, unless-stopped."
  }
}
```

`terraform.tfvars`:

```hcl
settings = {
  dev     = { web_port = 8101 }
  staging = { web_port = 8102 }
  prod    = { web_port = 8103, restart = "unless-stopped" }
}
```

`main.tf`:

```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

locals {
  current = var.settings[var.environment]
}

resource "docker_image" "web" {
  name         = local.current.image
  keep_locally = true
}

resource "docker_container" "web" {
  name    = "shipit-${var.environment}-web"
  image   = docker_image.web.image_id
  restart = local.current.restart

  ports {
    internal = 80
    external = local.current.web_port
  }
}

output "port" { value = local.current.web_port }
output "url"  { value = "http://localhost:${local.current.web_port}" }

output "summary" {
  value = {
    env     = var.environment
    image   = local.current.image
    restart = local.current.restart
  }
}
```

**Why switching environments with a variable is a problem:** there is only **one state file**. Applying with `environment=prod` replaces the dev container instead of adding a prod one. Real environments need separate state: separate root modules/directories per environment (most common), separate backends/keys, or Terraform workspaces (module 03). Variables choose *settings*, not *which state* you're working on.
:::

### Clean up

```bash
terraform destroy -auto-approve -var environment=prod
```
