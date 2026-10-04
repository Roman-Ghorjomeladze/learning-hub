## What a module is

Every directory of `.tf` files is a **module**. You've been writing modules all along: the directory where you run `terraform` is the **root module**. A **child module** is any module called from another module with a `module` block.

```text
shipit-infra/                         <- root module (you run terraform here)
  main.tf          module "api" { source = "./modules/web-app" ... }
  versions.tf
  modules/
    web-app/                          <- child module
      main.tf      resource "docker_container" "this" { ... }
      variables.tf
      outputs.tf
      versions.tf
```

Think of modules as **functions** (module 02's analogy, now literal):

```text
          module "api" {                         modules/web-app
            source = "./modules/web-app"          +--------------------------+
            name   = "api"          ---------->   | variable "name"          |
            image  = "traefik/whoami:latest"      | variable "image"         |
          }                                       |                          |
                                                  | resource docker_container|
          module.api.url  <---------------------- | output "url"             |
                                                  +--------------------------+
```

- **Inputs** are the child's `variable` blocks, set as arguments in the `module` block.
- **Outputs** are the child's `output` blocks, read by the caller as `module.<name>.<output>`.
- Everything else inside is **private**. The caller can't reference `module.api.docker_container.this`; if it needs a value, the module must output it.
- Resources inside get addresses like `module.api.docker_container.this`, visible in plans and state.

Why use modules:

1. **Reuse**: the same "web app" or "VPC" pattern for many services and environments.
2. **Encapsulation**: hide 15 resources behind 5 well-named inputs.
3. **Consistency**: every team's bucket gets encryption, versioning and tags because the module enforces it.
4. **Separation of concerns**: a platform team owns the module, product teams call it.

## Calling a module

```hcl
module "api" {
  source = "./modules/web-app"

  # inputs (the child's variables)
  name           = "shipit-api"
  image          = "traefik/whoami:latest"
  internal_port  = 80
  external_port  = 8101
  network_name   = docker_network.shipit.name
  env            = { LOG_LEVEL = "info" }
}

output "api_url" {
  value = module.api.url
}
```

Meta-arguments available on `module` blocks: `source`, `version`, `count`, `for_each`, `depends_on` and `providers`. Not `lifecycle`.

After adding a module block or changing its `source`/`version`, run `terraform init` (or `terraform get`). Terraform copies or downloads modules into `.terraform/modules/` and records them in `.terraform/modules/modules.json`. Local path modules are referenced in place, so edits to them take effect immediately without re-init.

## Module structure conventions

The standard layout for a reusable module:

```text
terraform-docker-web-app/        # repo name convention for registries: terraform-<PROVIDER>-<NAME>
  main.tf          # resources (split into network.tf, volume.tf... when it grows)
  variables.tf     # inputs, each with type and description
  outputs.tf       # outputs, each with description
  versions.tf      # terraform { required_version, required_providers } with MINIMUM versions
  README.md        # what it does, usage example, inputs/outputs table (generated)
  LICENSE
  examples/
    basic/main.tf  # a runnable example that calls the module
    with-volume/main.tf
  modules/         # optional nested submodules
  tests/           # terraform test files (*.tftest.hcl), covered in a later module
```

Rules of thumb:

- **No `provider` blocks in reusable modules.** The caller configures providers. A module with its own provider block can't be used with `count`, `for_each` or `depends_on`, and can't be removed cleanly from a config.
- **`versions.tf` uses minimums**, not pins: `version = ">= 4.0"` for providers. The root module pins exact ranges (`~> 4.6`). A child that pins `= 4.6.0` forces every caller onto that exact version.
- **Every variable has a `type` and `description`**; every output has a `description`.
- **Name the main resource `this`** (or `main`) when there's one obvious primary resource: `docker_container.this`, `aws_s3_bucket.this`. It reads well as `module.api.docker_container.this`.
- **Expose outputs generously** for attributes callers might need (IDs, names, URLs). Adding an output later is easy, but a missing output blocks callers until you release.

## Designing inputs and outputs

A module's variables and outputs are its **public API**. Design them like you'd design a NestJS service's DTOs.

```hcl
# modules/web-app/variables.tf
variable "name" {
  type        = string
  description = "Container name; also used as the network alias."
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

variable "network_name" {
  type        = string
  description = "Existing Docker network to attach to (created by the caller)."
}

variable "external_port" {
  type        = number
  description = "Host port to publish. null = don't publish."
  default     = null
}

variable "env" {
  type        = map(string)
  description = "Environment variables for the container."
  default     = {}
  nullable    = false
}

variable "volume" {
  type = object({
    container_path = string
    name           = optional(string)   # default: "<name>-data"
  })
  description = "Optional named volume to create and mount. null = no volume."
  default     = null
}
```

Good practices:

- **Sensible defaults** for everything that has one; required inputs only for what the module can't guess.
- **Use objects for groups of related settings** (`volume`, `healthcheck`) with `optional()` attributes, and `null` to mean "feature off".
- **Validate** at the module boundary so callers get clear errors.
- **Don't pass through every provider argument.** A module that exposes all 60 arguments of `docker_container` adds nothing over the resource itself.

```hcl
# modules/web-app/outputs.tf
output "container_name" {
  description = "Name of the container."
  value       = docker_container.this.name
}

output "url" {
  description = "URL on the host, or null if no port is published."
  value       = var.external_port == null ? null : "http://localhost:${var.external_port}"
}

output "volume_name" {
  description = "Name of the created volume, or null."
  value       = one(docker_volume.this[*].name)
}
```

## Module sources

| Source | Example | Versioning |
| --- | --- | --- |
| Local path | `source = "./modules/web-app"` or `"../shared/web-app"` | Same repo, no version; changes apply immediately |
| Terraform Registry | `source = "terraform-aws-modules/vpc/aws"` + `version = "~> 6.0"` | `version` constraint (registry and private registries only) |
| Private registry (HCP Terraform) | `source = "app.terraform.io/acme/web-app/docker"` + `version` | `version` constraint |
| GitHub | `source = "github.com/acme/terraform-docker-web-app?ref=v1.2.0"` | `ref` = tag, branch or commit SHA |
| Generic Git | `source = "git::https://git.example.com/infra/modules.git//web-app?ref=v1.2.0"` | `ref` |
| Git over SSH | `source = "git::ssh://git@github.com/acme/modules.git//web-app?ref=v1.2.0"` | `ref` |
| S3 / GCS / HTTP archive | `source = "s3::https://s3.eu-central-1.amazonaws.com/acme-modules/web-app-1.2.0.zip"` | File name |

- The **double slash** `//` separates the repository from a **subdirectory** inside it: `modules.git//web-app`.
- `version` only works for registry sources. For Git, pin with `?ref=`. Prefer a **tag** (`v1.2.0`) or a **commit SHA**; never a branch like `main` for anything that matters, because the code can change under you without any diff in your repo.
- The dependency lock file **does not** record module versions. Pinning in `source`/`version` is your only protection.
- `terraform init -upgrade` re-resolves registry module versions within constraints.
- Since Terraform 1.15 a module's `source` and `version` may reference variables declared with `const = true`; before that they had to be literal strings.

:::warning Treat third-party modules like dependencies, not magic
A public module runs with your credentials and can create anything. Before using one:

- Check the **source code** (registry pages link to GitHub), the maintainer, recent releases, open issues and downloads.
- **Pin an exact version** or a tight range, and upgrade deliberately, reading the changelog.
- Prefer well-known collections (e.g. `terraform-aws-modules/*` for AWS) or your organisation's own modules.
- Watch the **plan** on upgrades: modules sometimes rename resources (hopefully with `moved` blocks).
- Avoid modules that wrap a single resource with no added opinion; use the resource directly.
:::

## Composition: small modules, flat trees

The most common module mistake is the "god module": one `platform` module with 80 variables and `create_vpc`, `create_db`, `create_cache` booleans everywhere. Prefer **small, focused modules composed in the root module**:

```text
   root module (composition)
   ├── module "network"   -> outputs network_id
   ├── module "postgres"  (network_id = module.network.id)   -> outputs host, port
   ├── module "redis"     (network_id = module.network.id)   -> outputs url
   └── module "api"       (network_id, database_url = module.postgres..., redis_url = module.redis.url)
```

Principles from HashiCorp's composition guide that work well in practice:

- **Keep the tree flat**: the root calls child modules; child modules rarely call other modules. Deep nesting makes it hard to see what's created and to pass values through.
- **Dependency inversion**: a module **receives** what it depends on (a network ID, a subnet list, a KMS key ARN) instead of creating or looking it up itself. Then the same module works with a network created here, by another team, or by hand.
- **Let the caller decide whether to create**: instead of `create_network = true` inside the app module, the root creates the network (or reads it with a data source) and passes it in.
- **Abstract on domain concepts, not providers**: "web app", "service queue", "static site", not "docker container with optional things".
- **Don't abstract too early.** Copy a pattern twice; on the third use, extract a module. A premature module freezes the wrong interface.

:::info Data-only modules
A module can contain only `data` blocks and outputs, for example "find the shared VPC and its private subnets for environment X". Callers get a stable interface while the lookup logic can change in one place.
:::

## for_each and count on modules

Module blocks support `count` and `for_each` (since 0.13), which is how you stamp out the same pattern many times:

```hcl
variable "apps" {
  type = map(object({
    image         = string
    internal_port = number
    external_port = number
    env           = optional(map(string), {})
  }))
}

module "app" {
  source   = "./modules/web-app"
  for_each = var.apps

  name          = each.key
  image         = each.value.image
  internal_port = each.value.internal_port
  external_port = each.value.external_port
  env           = each.value.env
  network_name  = docker_network.shipit.name
}

output "urls" {
  value = { for k, m in module.app : k => m.url }
}
```

Addresses become `module.app["api"].docker_container.this`. Everything from module 04 applies: prefer `for_each` with stable keys over `count`, keys must be known at plan time, and use `moved` blocks to refactor (`from = module.api`, `to = module.app["api"]`).

`depends_on` on a module makes **every** resource and data source in it wait for the dependency. It's occasionally needed, but it often makes data sources inside the module read at apply time and turns many values into `(known after apply)`. Prefer passing an output of the dependency as an input.

## Passing providers to modules

By default a child module **inherits the default (unaliased) provider configurations** of its parent. Nothing to do:

```hcl
provider "docker" {}         # root config

module "api" {
  source = "./modules/web-app"   # uses the root's default docker provider
  # ...
}
```

To use an **aliased** configuration, pass it explicitly:

```hcl
provider "aws" {
  region = "eu-central-1"
}

provider "aws" {
  alias  = "dr"
  region = "eu-west-1"
}

module "backup_bucket" {
  source    = "./modules/bucket"
  providers = {
    aws = aws.dr            # inside the module, the default "aws" is the DR region
  }
}
```

When a module itself needs **several** configurations of one provider (e.g. a replicated bucket in two regions), it declares the names it expects with `configuration_aliases`, and the caller must pass all of them:

```hcl
# modules/replicated-bucket/versions.tf
terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 6.0"
      configuration_aliases = [aws.primary, aws.replica]
    }
  }
}

# inside the module
resource "aws_s3_bucket" "primary" {
  provider = aws.primary
  bucket   = "${var.name}-primary"
}

resource "aws_s3_bucket" "replica" {
  provider = aws.replica
  bucket   = "${var.name}-replica"
}
```

```hcl
# root module
module "assets" {
  source = "./modules/replicated-bucket"
  name   = "shipit-assets"
  providers = {
    aws.primary = aws
    aws.replica = aws.dr
  }
}
```

:::deep Why provider blocks inside modules are a trap
In old Terraform, modules often contained `provider "aws" { region = var.region }`. Problems:

1. **Removal**: if you delete the module call, Terraform needs the provider configuration to destroy the module's resources, but the provider block was inside the module you just deleted. You get "provider configuration not present" and must restore it to proceed.
2. **Meta-arguments**: modules with provider blocks can't use `count`, `for_each` or `depends_on`, because each instance would need its own provider instance, which Terraform doesn't support that way.
3. **Credentials**: the module now decides how to authenticate, which is the root's job.

So: providers are configured only in root modules; child modules declare `required_providers` (with `configuration_aliases` if needed) and receive configurations.
:::

## Refactoring resources into a module

You have a flat config with `docker_container.api` already deployed and you extract a module. Without help, Terraform sees `docker_container.api` removed and `module.api.docker_container.this` added: **destroy + create**. A `moved` block fixes it:

```hcl
module "api" {
  source = "./modules/web-app"
  # ...
}

moved {
  from = docker_container.api
  to   = module.api.docker_container.this
}
```

The plan shows `has moved to` and no changes, as long as the module produces exactly the same arguments as the old resource. If the plan shows a replacement, compare attributes: a different `name`, extra `labels` or a different `env` order (sets aside) will force replacement.

## Versioning and publishing modules

For modules shared across repos:

- Put each module in its own repo (`terraform-docker-web-app`) **or** a monorepo of modules with tags per module (`web-app/v1.2.0`), consumed with `//subdir?ref=`.
- **Tag releases with semantic versioning**: `v1.2.0`. Major = breaking change in inputs/outputs or behaviour (e.g. a resource rename without `moved`, a removed variable); minor = new optional input or output; patch = fixes.
- Keep a **CHANGELOG** and **examples** that are tested.
- The **public registry** publishes GitHub repos named `terraform-<PROVIDER>-<NAME>` with semver tags. HCP Terraform and other platforms offer **private registries** so your organisation can use `version` constraints for internal modules too.
- Use `moved` blocks in the module when you rename internals, so callers upgrading don't lose resources. Keep them across versions.

## Documenting modules with terraform-docs

`terraform-docs` reads variables and outputs (with their descriptions and types) and generates the README tables, so docs never drift from code:

```bash
brew install terraform-docs
terraform-docs markdown table --output-file README.md --output-mode inject ./modules/web-app
```

In `inject` mode it replaces the content between these markers in the README, leaving the rest of your hand-written text alone:

```text
<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
```

Teams run it in a pre-commit hook or CI so a PR that changes inputs also updates the docs.

:::try Read a real module
Open the GitHub repo of a popular registry module, for example `terraform-aws-modules/terraform-aws-s3-bucket`. Look at `variables.tf` (how many inputs?), `versions.tf` (minimum versions), `examples/`, and search for `moved` blocks. Ask yourself which parts you'd keep if you wrote a smaller module for your team.
:::

:::try Count the API surface
For the `web-app` module you'll build in the labs, list every input and output before writing any resources. Could a new teammate use it from the README alone? Which inputs could you remove by choosing a sensible default?
:::

## Pitfalls and best practices

- **No provider blocks in child modules.** Use `required_providers` and `configuration_aliases`.
- **Minimum versions in modules, pinned ranges in roots.**
- **Pin module versions** (`version` or `?ref=` tag/SHA); never track a branch.
- **Small modules, flat composition, dependency inversion.** Pass IDs in; output IDs out.
- **Avoid boolean flag soup** (`create_x`, `enable_y`, `use_z`) that turns one module into many hidden ones.
- **Output what callers need**, with descriptions; never force callers to reach into module internals (they can't anyway).
- **Refactor with `moved`** when extracting or renaming, and keep those blocks in shared modules.
- **`for_each` on modules** with stable keys; avoid `depends_on` on modules unless necessary.
- **Generate docs** with terraform-docs and keep runnable `examples/`.

## Summary

- Every directory is a module; the one you run in is the root; others are children called with `module` blocks.
- Inputs are variables, outputs are the only way out; internals are private.
- Standard layout: `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`, `README.md`, `examples/`.
- Sources: local path, registry (+`version`), Git (`//subdir?ref=tag`), archives. Lock files don't pin modules.
- Compose small modules in the root; inject dependencies; don't abstract too early.
- Children inherit default providers; pass aliases with `providers = {}` and declare them with `configuration_aliases`.
- `for_each` on modules stamps out patterns; `moved` blocks move existing resources into modules safely.
