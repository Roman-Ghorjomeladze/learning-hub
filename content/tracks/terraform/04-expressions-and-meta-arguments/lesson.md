## Why this module matters

Modules 01–03 gave you static resources: one block, one object. Real configurations are **data-driven**: "one container per service in this map", "a port block for each exposed port", "replace the proxy when its config file changes", "refuse to destroy the database". That's what expressions and meta-arguments are for.

The mental model: HCL is **not a programming language**. There are no loops with side effects, no mutable variables, no statements. Everything is an **expression** that evaluates to a value, and meta-arguments (`count`, `for_each`, `lifecycle`, `depends_on`, `provider`) tell Terraform how to turn a block into zero or more managed objects. If you think "functional TypeScript with `map`/`filter`/`reduce` and only `const`", you'll feel at home.

## Strings, templates and heredocs

```hcl
locals {
  env  = "dev"
  name = "shipit-${local.env}-api"                    # interpolation
  msg  = "Port is ${var.port}, debug=${var.debug}"     # numbers/bools convert to strings

  # Directives: %{ if }, %{ for } inside strings
  greeting = "Hello, %{ if var.user != "" }${var.user}%{ else }stranger%{ endif }!"

  # Heredoc; <<- strips the common leading indentation
  nginx_snippet = <<-EOT
    server {
      listen 80;
      server_name ${local.name}.local;
    }
  EOT

  # A for directive in a heredoc, with ~ to trim the newline after the directive
  hosts = <<-EOT
    %{~ for name, port in var.services ~}
    ${name} -> ${port}
    %{~ endfor ~}
  EOT
}
```

- `${ ... }` interpolates an expression. `%{ ... }` is a directive (`if`/`else`/`endif`, `for`/`endfor`).
- `~` next to a directive or interpolation strips whitespace (including newlines) on that side.
- To write a literal `${` (for example in a shell script), escape it as `$${`. A literal `%{` is `%%{`.
- For anything longer than a few lines, put the template in a file and use `templatefile()` (below).

## Operators and conditionals

```hcl
locals {
  is_prod   = var.environment == "prod"
  replicas  = local.is_prod ? 3 : 1                      # condition ? true_val : false_val
  log_level = var.debug ? "debug" : "info"
  port_ok   = var.port >= 1024 && var.port <= 65535      # && || !
  half      = var.memory_mb / 2                           # + - * / %
}
```

Both branches of a conditional must have **compatible types**. `var.x ? "a" : 1` is converted to strings; `var.x ? ["a"] : {}` is an error. A common trick for optional resources is a conditional `count` (below).

## for expressions

`for` expressions transform collections, like `Array.prototype.map/filter` or a Python comprehension. Brackets decide the result type:

```hcl
variable "services" {
  type = map(object({ image = string, port = number, public = bool }))
  default = {
    api    = { image = "shipit-api:1.4", port = 3000, public = true }
    worker = { image = "shipit-api:1.4", port = 0, public = false }
    web    = { image = "nginx:1.30-alpine", port = 8080, public = true }
  }
}

locals {
  # [ ... ] produces a list (or tuple)
  names = [for name, s in var.services : name]                       # ["api", "web", "worker"]
  upper = [for n in local.names : upper(n)]

  # { ... } produces an object/map: key => value
  ports = { for name, s in var.services : name => s.port }           # { api = 3000, ... }

  # filter with if
  public = { for name, s in var.services : name => s if s.public }   # api and web only

  # group values with ... (multiple values per key become a list)
  by_image = { for name, s in var.services : s.image => name... }
  # { "nginx:1.30-alpine" = ["web"], "shipit-api:1.4" = ["api", "worker"] }
}
```

- Iterating a **list**: `for v in list` or `for i, v in list` (index, value).
- Iterating a **map/object**: `for k, v in map`. Maps iterate in **lexical key order**.
- Iterating a **set**: `for v in set`.
- In `{ }` form, duplicate keys are an error unless you use the grouping `...` suffix.

:::try for expressions in the console
In an empty folder, put the `services` variable above in `main.tf`, run `terraform console`, and evaluate `local`-style expressions directly, e.g. `{ for n, s in var.services : n => s.port if s.port > 0 }` and `[for n, s in var.services : "${n}:${s.port}"]`. Then try making two items produce the same key without `...` and read the error.
:::

## Splat expressions

A splat is shorthand for a simple `for` that picks one attribute from every element of a **list**:

```hcl
locals {
  web_names = docker_container.web[*].name   # same as [for c in docker_container.web : c.name]
  emails    = var.users[*].email
}
```

- Splats work on lists (resources with `count`). For `for_each` resources, which are **maps**, use `values(docker_container.web)[*].name` or a `for` expression.
- Applied to a single non-list value, `[*]` wraps it in a one-element list (or an empty list if it's `null`). Handy for optional nested blocks with `dynamic`.

## The built-in functions you'll actually use

You can't define your own functions in HCL (providers can ship some, called as `provider::name::fn()`), but the built-ins cover most needs. Try any of these in `terraform console`.

| Function | Example | Result / use |
| --- | --- | --- |
| `try(a, b, ...)` | `try(var.cfg.tls.port, 443)` | First expression that evaluates without error. Great for optional deep attributes |
| `can(expr)` | `can(regex("^v[0-9]+", var.tag))` | `true` if expr evaluates without error. Mostly in validations |
| `lookup(map, key, default)` | `lookup(var.sizes, var.env, "small")` | Map value or default. With objects, prefer `try(var.x[key], default)` |
| `merge(m1, m2, ...)` | `merge(local.default_labels, var.labels)` | Shallow merge; later maps win |
| `coalesce(a, b, ...)` | `coalesce(var.name, "shipit")` | First non-null, non-empty-string argument |
| `flatten(list)` | `flatten([["a"], ["b", "c"]])` | `["a", "b", "c"]`. Key tool for nested loops |
| `setproduct(a, b)` | `setproduct(["dev","prod"], ["api","web"])` | All combinations: `[["dev","api"], ["dev","web"], ...]` |
| `cidrsubnet(prefix, newbits, netnum)` | `cidrsubnet("10.0.0.0/16", 8, 2)` | `"10.0.2.0/24"`. Subnet math for VPCs and Docker networks |
| `jsonencode(v)` / `jsondecode(s)` | `jsonencode({ a = 1 })` | `{"a":1}`. IAM policies, app configs, API responses |
| `yamlencode(v)` / `yamldecode(s)` | `yamldecode(file("values.yaml"))` | YAML in and out |
| `templatefile(path, vars)` | `templatefile("${path.module}/nginx.conf.tftpl", { upstreams = local.upstreams })` | Render a template file |
| `file(path)` | `file("${path.module}/init.sql")` | Read a file as a string (at plan time, from disk) |
| `keys` / `values` / `zipmap` | `zipmap(["a","b"], [1,2])` | `{ a = 1, b = 2 }` |
| `contains` / `distinct` / `concat` / `sort` | `contains(["dev","prod"], var.env)` | List helpers |
| `join` / `split` / `replace` / `format` | `format("%s-%03d", "web", 7)` | `"web-007"` |
| `one(list)` | `one(data.x.y[*].id)` | The single element, `null` for empty, error for more than one |
| `toset` / `tolist` / `tomap` | `toset(var.names)` | Type conversions, especially for `for_each` |

`path.module` is the directory of the current module; always use it for files that ship with a module, since a relative path would resolve against wherever Terraform is run. `path.root` is the root module's directory and `path.cwd` the working directory.

:::deep flatten + for: the nested loop pattern
`for_each` needs a flat map, but data is often nested: "for each service, for each port". Flatten it into a list of objects, then key it:

```hcl
variable "services" {
  default = {
    api = { ports = [3000, 9229] }
    web = { ports = [80, 443] }
  }
}

locals {
  service_ports = flatten([
    for svc, cfg in var.services : [
      for port in cfg.ports : {
        key     = "${svc}-${port}"
        service = svc
        port    = port
      }
    ]
  ])
  # [{key="api-3000",...}, {key="api-9229",...}, {key="web-80",...}, {key="web-443",...}]

  service_ports_map = { for sp in local.service_ports : sp.key => sp }
}

# for_each = local.service_ports_map  -> one instance per (service, port), with stable keys
```

`setproduct` is the same idea when you want every combination of two independent lists (environments x services, AZs x tiers).
:::

## count: N copies

```hcl
resource "docker_container" "worker" {
  count = 3
  name  = "shipit-worker-${count.index}"   # 0, 1, 2
  image = docker_image.api.image_id
}

# Conditional resource: 0 or 1
resource "docker_container" "debug_ui" {
  count = var.enable_debug_ui ? 1 : 0
  name  = "debug-ui"
  image = docker_image.ui.image_id
}

output "debug_ui_name" {
  value = one(docker_container.debug_ui[*].name)  # null when disabled
}
```

- Instances are addressed by index: `docker_container.worker[0]`. The resource as a whole is a **list**.
- `count` must be known at plan time. You can't use `count = length(some_resource.ids)` if those IDs are only known after apply.

### The index-shift problem

`count` over a **list of distinct things** is a trap:

```hcl
variable "sites" { default = ["blog", "shop", "docs"] }

resource "docker_container" "site" {
  count = length(var.sites)
  name  = "site-${var.sites[count.index]}"
  # ...
}
```

State: `site[0]=blog`, `site[1]=shop`, `site[2]=docs`. Now remove `"shop"`:

```text
 before:  [0]=blog  [1]=shop  [2]=docs
 after:   [0]=blog  [1]=docs
          -> site[1] changes name shop -> docs   (forces replacement: destroy shop, recreate as docs)
          -> site[2] is destroyed                (destroys the real docs container)
```

Terraform tracks instances by **index**, so removing an element shifts everything after it. Plan: 1 to add, 2 to destroy, for a change that should have destroyed one thing. With databases or load balancers this means outages and data loss.

## for_each: one instance per key

```hcl
resource "docker_container" "site" {
  for_each = toset(["blog", "shop", "docs"])
  name     = "site-${each.key}"
  # ...
}

resource "docker_container" "svc" {
  for_each = var.services                # map(object)
  name     = "shipit-${each.key}"
  image    = each.value.image
}
```

- Instances are addressed by key: `docker_container.site["shop"]`. The resource as a whole is a **map**.
- Removing `"shop"` destroys exactly `site["shop"]`. Nothing else moves.
- `each.key` and `each.value` (for sets, both are the element).
- `for_each` accepts a **map** or a **set of strings**. A list must be converted (`toset(var.names)`); a list of objects must be turned into a map with a `for` expression.
- Keys must be known at plan time, and should be **stable, meaningful identifiers** (names), never values computed by a provider.

| Use `count` when | Use `for_each` when |
| --- | --- |
| Turning one resource on or off (`count = var.enabled ? 1 : 0`) | Creating one instance per named thing (services, users, buckets) |
| Truly identical, interchangeable copies where identity doesn't matter | Instances differ in configuration |
| | You will ever add or remove items from the middle |

:::tip Migrating from count to for_each without destroying
Use `moved` blocks (module 03), one per instance:

```hcl
moved {
  from = docker_container.site[0]
  to   = docker_container.site["blog"]
}
moved {
  from = docker_container.site[2]
  to   = docker_container.site["docs"]
}
```
:::

## dynamic blocks

Some arguments are **nested blocks**, not attributes: `ports { }`, `labels { }`, `volumes { }` in `docker_container`, `ingress { }` in an AWS security group. You can't put a `for` expression in a block, so HCL provides `dynamic`:

```hcl
variable "published_ports" {
  type    = list(object({ internal = number, external = number }))
  default = [{ internal = 80, external = 8080 }, { internal = 443, external = 8443 }]
}

resource "docker_container" "proxy" {
  name  = "shipit-proxy"
  image = docker_image.nginx.image_id

  dynamic "ports" {
    for_each = var.published_ports
    content {
      internal = ports.value.internal
      external = ports.value.external
    }
  }

  dynamic "labels" {
    for_each = merge(var.labels, { managed_by = "terraform" })
    iterator = label            # optional: rename the iterator (default is the block name)
    content {
      label = label.key
      value = label.value
    }
  }

  # Optional single block: 0 or 1 based on whether the variable is set
  dynamic "healthcheck" {
    for_each = var.healthcheck_cmd == null ? [] : [var.healthcheck_cmd]
    content {
      test     = ["CMD-SHELL", healthcheck.value]
      interval = "10s"
    }
  }
}
```

:::warning Don't hide everything behind dynamic
`dynamic` is for blocks whose number genuinely varies with input. Wrapping every block in `dynamic` "for flexibility" makes code unreadable and plans hard to review. If a block always appears once, write it out.
:::

## depends_on: hidden dependencies only

Terraform infers order from references. `depends_on` adds an edge when there's a dependency Terraform **can't see**:

```hcl
resource "docker_container" "migrate" {
  name    = "shipit-migrate"
  image   = docker_image.api.image_id
  command = ["npm", "run", "migrate"]
  # Uses DATABASE_URL pointing at "shipit-postgres" by hostname: a string, not a reference
  env = ["DATABASE_URL=postgresql://shipit@shipit-postgres:5432/shipit"]

  depends_on = [docker_container.postgres]
}
```

- `depends_on` takes a list of **whole resources or modules**, not attributes.
- Prefer real references (`docker_container.postgres.name` in the URL would have created the edge). Overusing `depends_on`, especially on modules or data sources, makes more values "known after apply" and causes noisy plans.
- `depends_on` only orders **Terraform operations**. It doesn't wait for Postgres to be *ready*; that's what healthchecks and app retries are for.

## lifecycle

```hcl
resource "docker_container" "api" {
  name  = "shipit-api"
  image = docker_image.api.image_id

  lifecycle {
    create_before_destroy = true
    prevent_destroy       = false
    ignore_changes        = [labels]
    replace_triggered_by  = [terraform_data.api_config]

    precondition {
      condition     = var.environment != "prod" || var.replicas >= 2
      error_message = "prod needs at least 2 replicas."
    }

    postcondition {
      condition     = length(self.network_data) > 0
      error_message = "The API container is not attached to any network."
    }
  }
}
```

### create_before_destroy

By default a replacement is **destroy, then create** (`-/+`). With `create_before_destroy = true`, Terraform creates the new object first, switches references, then destroys the old one (`+/-`), which avoids downtime for things like load balancer target groups, launch templates and certificates.

:::warning Unique names break create_before_destroy
If the resource has a **unique name** that doesn't change (a container named `shipit-api`, an S3 bucket name, a security group name), the new object can't be created while the old one still holds the name: "Conflict. The container name is already in use". Fixes: let the name vary (`name_prefix` in AWS, a random suffix, a hash of the config in the name) or don't use create_before_destroy for that resource. Also note the setting propagates: a resource's dependencies get create_before_destroy behaviour too.
:::

### prevent_destroy

```hcl
resource "docker_volume" "pgdata" {
  name = "shipit-pgdata"
  lifecycle {
    prevent_destroy = true
  }
}
```

Any plan that would destroy this resource **fails with an error**. Use it on databases, state buckets, KMS keys and volumes holding data. Limitations: it only protects while the block is in the config (if someone deletes the whole resource block, the protection goes with it), and it makes `terraform destroy` of the stack fail, which is intended.

### ignore_changes

```hcl
lifecycle {
  ignore_changes = [labels, env]   # or `all`
}
```

Terraform won't plan updates for these attributes when they differ from config. Use it when something else legitimately manages a value: an autoscaler changing desired count, a CI pipeline updating an image tag, tags added by an external compliance tool. Don't use it to silence drift you don't understand.

### replace_triggered_by

Replaces the resource when **another** resource (or one of its attributes) changes, even though nothing in its own arguments changed:

```hcl
resource "local_file" "nginx_conf" {
  filename = "${path.module}/generated/nginx.conf"
  content  = templatefile("${path.module}/nginx.conf.tftpl", { upstreams = local.upstreams })
}

resource "docker_container" "proxy" {
  # ... mounts the file via a bind mount ...
  lifecycle {
    replace_triggered_by = [local_file.nginx_conf]   # restart the proxy when its config changes
  }
}
```

`replace_triggered_by` only accepts references to **managed resources** (or their attributes). To trigger on a variable or local, wrap it in `terraform_data`:

```hcl
resource "terraform_data" "api_version" {
  input = var.api_version   # changing the input replaces terraform_data, which triggers the container
}
```

`terraform_data` (built in since 1.4, no provider needed) replaces the older `null_resource` from the `hashicorp/null` provider. It holds a value (`input`/`output`), can be replaced via `triggers_replace`, and is a home for provisioners.

### Preconditions and postconditions

- **`precondition`** is checked **before** the resource is planned/applied. Use it for assumptions about inputs or other resources ("the selected image must be arm64-compatible", "prod needs 2 replicas").
- **`postcondition`** is checked **after** the provider returns the planned/applied object, and can use `self` (the resource's own attributes). Use it for guarantees ("the container ended up on the expected network").
- Both **fail the run** with your error message. They also work on data sources and outputs.

Compared with variable `validation`: validation checks one input in isolation (now also with references to other variables); pre/postconditions can check anything in scope, at the place where the assumption matters.

## check blocks: continuous validation

A `check` block (1.5+) asserts something about the infrastructure as a whole, and **only warns** when it fails. The run continues. It can contain a **scoped data source** that is read on every plan/apply:

```hcl
check "api_health" {
  data "http" "healthz" {
    url = "http://localhost:${docker_container.api.ports[0].external}/healthz"
  }

  assert {
    condition     = data.http.healthz.status_code == 200
    error_message = "shipit-api /healthz returned ${data.http.healthz.status_code}."
  }
}
```

Use checks for things you want to **know** about but shouldn't block deployment: a health endpoint, a certificate's expiry date, a DNS record resolving. HCP Terraform can run them on a schedule (health assessments); locally they run on every plan and apply.

| Mechanism | Where | On failure | Typical use |
| --- | --- | --- | --- |
| `validation` | variable | Error | Bad input |
| `precondition` | resource/data/output | Error | Assumption before acting |
| `postcondition` | resource/data/output | Error | Guarantee after acting (`self`) |
| `check` | top level | Warning | Ongoing health of the whole system |

:::try Break a postcondition on purpose
In any lab with a container, add to its lifecycle: `postcondition { condition = self.name == "nope"  error_message = "name check failed" }`. Run `terraform plan`. When is it evaluated, at plan or apply? (It's evaluated as soon as the attribute is known: at plan for a name you set, after apply for computed values.)
:::

## Provider aliases

One provider block is the **default configuration** for that provider. Add more configurations with `alias`, and select them per resource with the `provider` meta-argument:

```hcl
provider "aws" {
  region = "eu-central-1"                 # default
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"                    # CloudFront certificates must live here
}

resource "aws_acm_certificate" "cdn" {
  provider    = aws.us_east_1
  domain_name = "shipit.example.com"
  # ...
}
```

The same works for Docker: two engines (your Mac and a remote build host over SSH) or two contexts:

```hcl
provider "docker" {}                                  # local engine

provider "docker" {
  alias = "buildhost"
  host  = "ssh://deploy@build-01.internal:22"
}

resource "docker_image" "api_on_buildhost" {
  provider = docker.buildhost
  name     = "nginx:1.30-alpine"
}
```

Typical uses: multiple AWS regions (DR replicas, global services), multiple accounts (assume-role into a shared networking account), several Kubernetes clusters. Passing aliased providers into child modules uses `providers = { ... }` and `configuration_aliases`, covered in module 05.

## Pitfalls and best practices

- **Default to `for_each` with meaningful keys**; use `count` for on/off switches.
- **Keys and counts must be known at plan time.** Build them from variables and locals, not from provider-computed attributes.
- **Keep expressions readable.** Move complex logic into well-named locals; a 6-line nested `for` inside a resource argument is a code smell.
- **Use `try()` for optional data**, not long chains of conditionals.
- **Prefer references over `depends_on`.**
- **`create_before_destroy` + fixed unique names = conflict.**
- **`prevent_destroy` on anything holding data**, and still keep backups.
- **`ignore_changes` with a comment** explaining who else manages that attribute.
- **Use `check` blocks for health, conditions for correctness.**

## Summary

- Templates (`${}` and `%{}`), heredocs, conditionals, `for` (list `[]` or map `{}`, with `if` filters and `...` grouping) and splats (`[*]`, lists only) are the core of the expression language.
- Key functions: `try`, `can`, `lookup`, `merge`, `coalesce`, `flatten`, `setproduct`, `cidrsubnet`, `jsonencode`, `templatefile`, `file`.
- `count` indexes by position (index-shift problem); `for_each` keys by name and is the safe default. Migrate with `moved`.
- `dynamic` generates repeated nested blocks; use it only when the number varies.
- `lifecycle`: `create_before_destroy`, `prevent_destroy`, `ignore_changes`, `replace_triggered_by`, plus pre/postconditions. `terraform_data` bridges variables into `replace_triggered_by`.
- `check` blocks warn about ongoing health; provider `alias` + `provider =` targets multiple regions, accounts or hosts.
