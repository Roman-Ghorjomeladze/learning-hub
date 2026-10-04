## The mental model: a module is a function

A Terraform module (including your root module) behaves like a function in TypeScript:

```text
             +----------------------------------+
 variables   |  module                          |   outputs
 ----------> |   locals    (private constants)  | ----------->
 (params)    |   resources (side effects)       |   (return values)
             |   data      (reads)              |
             +----------------------------------+
```

| Terraform | TypeScript analogy |
| --- | --- |
| `variable "port" { type = number }` | a typed function parameter `port: number` |
| `default = 3000` | a default parameter value |
| `validation { ... }` | a runtime guard (`zod` schema, `class-validator`) |
| `locals { ... }` | `const` declared inside the function |
| `output "url" { ... }` | the return value |
| `data "..." "..." {}` | a read-only query (a `SELECT`) |

Inputs make one configuration usable for dev, staging and production. Outputs let you hand values to people, scripts, CI and other modules. Locals keep the middle readable.

## Input variables

```hcl
variable "app_name" {
  type        = string
  description = "Base name used for all containers, e.g. shipit."
  default     = "shipit"
}

variable "api_port" {
  type        = number
  description = "Host port that exposes the API."
  # no default: the caller MUST provide it
}
```

Refer to a variable with `var.<name>`: `name = "${var.app_name}-api"`.

- **`description`** is documentation for whoever uses the module. Write it from their point of view; tools like `terraform-docs` turn it into a README.
- A variable **without `default` is required**. In an interactive shell Terraform prompts for it; in CI (`-input=false`) a missing value is an error, which is what you want.
- Variables are **set once per run** and are constant during it. You can't assign to them.

### Types

Always declare a `type`. It catches mistakes at plan time and documents intent.

```hcl
# Primitive types
variable "image_tag"   { type = string }
variable "replicas"    { type = number }
variable "debug"       { type = bool }

# Collection types: every element has the SAME type
variable "allowed_ips" { type = list(string) } # ordered, duplicates allowed
variable "tags"        { type = set(string) }  # unordered, unique
variable "labels"      { type = map(string) }  # string keys -> same-typed values

# Structural types: elements can have DIFFERENT types
variable "db" {
  type = object({
    image   = string
    port    = number
    persist = bool
  })
}

variable "pair" {
  type = tuple([string, number]) # fixed length, positional types
}

# Collections of structures are where Terraform shines
variable "services" {
  type = map(object({
    image = string
    port  = number
  }))
}
```

| Type | Example value | Notes |
| --- | --- | --- |
| `string` | `"nginx:1.30-alpine"` | |
| `number` | `8080`, `0.5` | One numeric type for ints and floats |
| `bool` | `true` | |
| `list(T)` | `["a", "b"]` | Indexed `var.x[0]`; order matters |
| `set(T)` | `["a", "b"]` | No index; duplicates removed; order not guaranteed |
| `map(T)` | `{ team = "platform" }` | Keys are always strings |
| `object({...})` | `{ image = "x", port = 1 }` | Fixed attribute names, each with a type |
| `tuple([...])` | `["x", 1]` | Fixed length, positional types |
| `any` | anything | Terraform infers a type; avoid in modules unless you really need it |

:::info Automatic conversion
Terraform converts between compatible types when it can: `"8080"` becomes `8080` for a `number`, `true` becomes `"true"` for a `string`, a list becomes a set. Conversion that loses information (`"abc"` to `number`) is an error. This is why `internal = "5678"` silently works; still write the right type.
:::

### Optional object attributes

For objects with many settings, you don't want callers to pass every attribute. `optional(type, default)` (stable since Terraform 1.3) makes an attribute optional and can give it a default:

```hcl
variable "postgres" {
  type = object({
    image    = optional(string, "postgres:18-alpine")
    port     = optional(number, 5432)
    db_name  = string                 # still required
    max_conn = optional(number)       # optional, null when omitted
    labels   = optional(map(string), {})
  })
}
```

Caller:

```hcl
postgres = {
  db_name = "shipit"
  port    = 55432
}
# Terraform sees:
# { image = "postgres:18-alpine", port = 55432, db_name = "shipit", max_conn = null, labels = {} }
```

Defaults apply even inside nested collections, for example in each element of a `map(object({...}))`. This is the cleanest way to design module inputs, much better than a dozen flat variables.

### Validation

Types check shape; `validation` checks meaning. Each variable can have several `validation` blocks:

```hcl
variable "environment" {
  type        = string
  description = "Deployment environment."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "api_port" {
  type = number

  validation {
    condition     = var.api_port >= 1024 && var.api_port <= 65535
    error_message = "api_port must be between 1024 and 65535 (unprivileged ports only)."
  }
}

variable "image" {
  type = string

  validation {
    condition     = !endswith(var.image, ":latest") && strcontains(var.image, ":")
    error_message = "Pin an explicit image tag; ':latest' and untagged images are not allowed."
  }
}
```

- `condition` must evaluate to `true` for valid values. Use functions like `contains`, `can(regex(...))`, `length`, `alltrue`, `startswith`.
- `error_message` should be a full sentence that tells the user how to fix it.
- Since Terraform **1.9**, a validation condition may reference **other variables** (and locals and data sources), not only the variable being validated. Before 1.9 it could only reference itself.

```hcl
variable "min_replicas" { type = number }
variable "max_replicas" {
  type = number
  validation {
    condition     = var.max_replicas >= var.min_replicas
    error_message = "max_replicas must be >= min_replicas."
  }
}
```

:::tip Use `can()` for regex validation
`regex()` throws an error when there is no match. Wrap it: `condition = can(regex("^[a-z][a-z0-9-]{2,30}$", var.app_name))`. `can()` returns `true` if the expression evaluates without error.
:::

### sensitive, nullable, ephemeral, deprecated, const

```hcl
variable "db_password" {
  type      = string
  sensitive = true   # redacted in plan/apply output
  nullable  = false  # passing null is an error (instead of meaning "use default")
}
```

- **`sensitive = true`** hides the value in CLI output (`(sensitive value)`). Anything derived from it is also marked sensitive. It is **still stored in plain text in the state file**. Sensitive is about not printing, not about encryption. Module 03 covers protecting state.
- **`nullable`** (default `true`): when a caller passes `null`, a nullable variable takes `null`; with `nullable = false` and a default, passing `null` gives you the default instead, and with no default it's an error. In reusable modules, `nullable = false` removes a whole class of "attempt to use null" bugs.
- **`ephemeral = true`** (Terraform 1.10+): the value is available during the run but is **never written to state or plan files**. Only usable in places that accept ephemeral values (provider configuration, other ephemeral variables/outputs, write-only resource arguments). Good for short-lived tokens. You'll meet it again with secrets in the AWS modules.
- **`deprecated = "message"`** (1.15+) warns callers who still set a variable you plan to remove.
- **`const = true`** (1.15+) lets a variable be used where Terraform needs the value while loading config, notably a module's `source` and `version`.

:::warning sensitive is not secret storage
Marking a variable `sensitive` prevents accidental printing in logs and PR comments. The value is still readable by anyone who can read the state, and `terraform output -raw db_password` prints it. Treat state as a secret, and prefer fetching secrets at runtime (AWS Secrets Manager, Vault) or using ephemeral values where providers support them.
:::

## Ways to set variables and precedence

You can provide values in six ways. When the same variable is set in several places, the one **higher** in this list wins:

```text
 highest  1. -var 'x=..' and -var-file=foo.tfvars on the CLI (later flags win over earlier ones)
          2. *.auto.tfvars / *.auto.tfvars.json files (lexical order, later files win)
          3. terraform.tfvars.json
          4. terraform.tfvars
          5. TF_VAR_<name> environment variables
 lowest   6. default in the variable block
```

Examples:

```bash
# terraform.tfvars (loaded automatically)
app_name = "shipit"
api_port = 3000
labels   = { team = "platform", owner = "roma" }

# prod.tfvars (only loaded when asked)
terraform plan -var-file=prod.tfvars

# a single value
terraform plan -var='api_port=3001'

# complex values on the CLI need HCL syntax inside quotes
terraform plan -var='labels={team="platform",tier="api"}'

# environment variables: handy in CI and for secrets
export TF_VAR_db_password='s3cr3t'
terraform plan
```

Typical team convention:

- `terraform.tfvars` for **shared non-secret defaults** of this root module (committed), or one `env/<name>.tfvars` per environment passed with `-var-file` (committed).
- **Secrets** via `TF_VAR_*` from the CI secret store or a secrets manager, never committed.
- `*.auto.tfvars` for machine-generated values (some CI tools write them).

:::warning Variable values on the CLI and in env end up in shell history and process lists
`-var='db_password=...'` lands in your shell history. Prefer `TF_VAR_db_password` set from a password manager (`export TF_VAR_db_password=$(op read ...)`) or a secrets manager data source.
:::

:::try Who wins?
In an empty folder, declare `variable "color" { default = "red" }` and `output "color" { value = var.color }`. Then run `terraform apply -auto-approve` with: `TF_VAR_color=blue`; plus a `terraform.tfvars` with `color = "green"`; plus `z.auto.tfvars` with `color = "yellow"`; plus `-var color=purple`. Predict each output first. (Lab 2 walks through this.)
:::

## Locals

`locals` names a value computed inside the module. It is **not** an input; callers can't set it.

```hcl
locals {
  name_prefix = "${var.app_name}-${var.environment}"

  common_labels = merge(var.labels, {
    managed_by  = "terraform"
    environment = var.environment
  })

  is_prod = var.environment == "prod"
}

resource "docker_container" "api" {
  name    = "${local.name_prefix}-api"
  restart = local.is_prod ? "unless-stopped" : "no"
  # ...
}
```

Use locals to:

- **Avoid repetition** (naming conventions, common labels/tags).
- **Name a complex expression** so the resource block stays readable.
- **Hide implementation details** that shouldn't be configurable.

Don't overdo it: a local that just renames `var.x` adds a layer of indirection for nothing. And don't turn every local into a variable "just in case"; each variable is a public API you must support.

## Outputs

```hcl
output "api_url" {
  description = "URL of the API on the host."
  value       = "http://localhost:${docker_container.api.ports[0].external}"
}

output "postgres_url" {
  description = "Connection string for the app."
  value       = "postgresql://shipit:${random_password.db.result}@localhost:${var.db_port}/shipit"
  sensitive   = true
}
```

- After `apply`, outputs are printed and stored in state. Read them with `terraform output`, `terraform output api_url`, `terraform output -raw api_url` (no quotes, good for scripts) or `terraform output -json` (for `jq`).
- If an output's value is derived from something sensitive, Terraform **refuses** to plan unless you mark the output `sensitive = true` (error: `Output refers to sensitive values`). That's a safety net, not a nuisance.
- `terraform output -raw postgres_url` **does print** a sensitive output. Sensitive only hides it in the general listing.
- In child modules (module 05), outputs are the only way the parent can read values from inside.
- `depends_on` in an output is rarely needed. It makes the output wait for resources it doesn't reference, for example when the output is a URL that only works after some other resource has been configured.
- Outputs can also have a `precondition` block, and since 1.15 an explicit `type`.

```bash
# use outputs in scripts
curl "$(terraform output -raw api_url)/healthz"
psql "$(terraform output -raw postgres_url)" -c 'select 1'
terraform output -json | jq -r '.api_url.value'
```

## Data sources

A **resource** creates and manages an object. A **data source** only **reads** something that already exists (or computes something), and gives you its attributes:

```hcl
# Look up the current digest of a tag in the registry (no pull)
data "docker_registry_image" "nginx" {
  name = "nginx:1.30-alpine"
}

resource "docker_image" "nginx" {
  name          = data.docker_registry_image.nginx.name
  pull_triggers = [data.docker_registry_image.nginx.sha256_digest] # re-pull when the tag moves
  keep_locally  = true
}

# Read an existing network created outside Terraform
data "docker_network" "bridge" {
  name = "bridge"
}

# Read a file from disk
data "local_file" "motd" {
  filename = "${path.module}/motd.txt"
}

# Call an HTTP endpoint (hashicorp/http provider)
data "http" "tf_version" {
  url = "https://checkpoint-api.hashicorp.com/v1/check/terraform"
  request_headers = {
    Accept = "application/json"
  }
}

locals {
  latest_terraform = jsondecode(data.http.tf_version.response_body).current_version
}
```

- Reference with `data.<type>.<name>.<attribute>`.
- Data sources are read during **plan** (so their values show up in the plan), unless their arguments depend on something that is only known after apply; then the read is deferred and shown as `<= read (data resources)`.
- In AWS work you'll use them constantly: `aws_caller_identity`, `aws_availability_zones`, `aws_ami`, looking up a VPC created by another team, reading a secret from Secrets Manager.
- If the thing doesn't exist, the data source **fails the plan**. That's often what you want: fail early.

:::deep Data sources vs terraform_remote_state vs variables
Three ways to get information from "outside" into a configuration:

- **Variables**: the caller passes it. Simple and explicit, but someone has to know the value.
- **Data sources**: look it up from the real API by name or tag (`data "aws_vpc" "main" { tags = { Name = "main" } }`). Loose coupling: the other team can change how the VPC is built as long as the tag stays.
- **`terraform_remote_state`**: read another configuration's outputs directly from its state file. Convenient, but it couples you to their state layout and requires read access to their entire state (which may contain secrets). Prefer data sources or a published value (SSM Parameter Store, outputs passed by CI) when you can.
:::

## terraform console

`terraform console` is a REPL that evaluates expressions with your configuration's variables, locals and state in scope. Use it to try functions and check what a complex expression produces before you put it in code.

```text
$ terraform console
> var.services
{
  "api" = { "image" = "shipit-api:1.0", "port" = 3000 }
  "web" = { "image" = "nginx:1.30-alpine", "port" = 8080 }
}
> keys(var.services)
["api", "web"]
> upper(var.app_name)
"SHIPIT"
> [for k, s in var.services : "${k}:${s.port}"]
["api:3000", "web:8080"]
> type(var.services)
map(object({image: string, port: number}))
> local.common_labels
{ "environment" = "dev", "managed_by" = "terraform", "team" = "platform" }
> exit
```

- It works without applying anything: variables and locals evaluate from config; resource attributes come from state (or are unknown).
- `terraform console -plan` evaluates against the planned values, so you can inspect `(known after apply)` things that are known at plan time.
- Pipe expressions for scripting: `echo 'cidrsubnet("10.0.0.0/16", 8, 2)' | terraform console`.
- `type(...)` is a console-only function that shows the type of an expression. Very handy when debugging type errors.

:::try Five-minute console session
In any folder (no providers needed), create `main.tf` with `locals { ports = { api = 3000, web = 8080 } }` and run `terraform console`. Try `local.ports`, `values(local.ports)`, `max(values(local.ports)...)`, `lookup(local.ports, "db", 5432)` and `type(local.ports)`. Note how `...` expands a list into function arguments.
:::

## Putting it together

A small parameterised example for a Postgres container:

```hcl
variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "postgres" {
  type = object({
    image   = optional(string, "postgres:18-alpine")
    port    = optional(number, 5432)
    db_name = optional(string, "shipit")
  })
  default = {}
}

resource "random_password" "db" {
  length  = 24
  special = false
}

locals {
  name = "shipit-${var.environment}-postgres"
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
    "POSTGRES_USER=shipit",
    "POSTGRES_PASSWORD=${random_password.db.result}",
  ]
  ports {
    internal = 5432
    external = var.postgres.port
  }
}

output "database_url" {
  value     = "postgresql://shipit:${random_password.db.result}@localhost:${var.postgres.port}/${var.postgres.db_name}"
  sensitive = true
}
```

Note `default = {}` on the object: since every attribute is optional, an empty object is a valid value and the defaults fill in.

## Pitfalls and best practices

- **Type everything.** `type = any` in a module pushes errors from plan time to "the provider rejected something deep inside".
- **Prefer one well-typed object over many flat variables** when settings belong together.
- **Validate at the edge.** Catch bad input in `validation` with a helpful message instead of letting the provider fail with an obscure API error.
- **Don't put secrets in `.tfvars` files that get committed.** Use env vars, a secrets manager data source, or ephemeral values.
- **`sensitive` hides output, not state.** Protect the state.
- **Name outputs for consumers**, not after implementation details (`api_url`, not `docker_container_api_ports_0_external`).
- **Remember precedence** when debugging "why is this value wrong": an old `*.auto.tfvars` file in the folder or a forgotten `TF_VAR_` export beats `terraform.tfvars`.
- **Run `terraform console`** whenever an expression surprises you.

## Summary

- Variables are typed inputs; use `object` with `optional(type, default)` for structured settings.
- `validation` guards meaning; conditions can reference other variables since 1.9.
- `sensitive` redacts output but values still live in state; `ephemeral` keeps values out of state entirely where supported.
- Precedence (high to low): CLI `-var`/`-var-file` > `*.auto.tfvars` > `terraform.tfvars.json` > `terraform.tfvars` > `TF_VAR_` > `default`.
- Locals name internal values; outputs return values to people, scripts and parent modules.
- Data sources read existing things; `terraform console` lets you try expressions safely.
