A dense reference for daily Terraform work. Commands assume Terraform 1.10+ (some features note their minimum version).

## Core workflow

| Command | What it does |
| --- | --- |
| `terraform init` | Download providers/modules, configure backend, write `.terraform.lock.hcl` |
| `terraform init -upgrade` | Upgrade providers/modules within version constraints |
| `terraform init -reconfigure` | Re-init backend ignoring the saved config (no state migration) |
| `terraform init -migrate-state` | Move state to a new/changed backend |
| `terraform init -backend=false` | Init without a backend (for validate/test in CI) |
| `terraform init -backend-config=dev.s3.tfbackend` | Partial backend config from a file |
| `terraform fmt -recursive` / `-check` | Format files / fail if unformatted (exit 3) |
| `terraform validate` | Check syntax, types and references (no API calls) |
| `terraform plan` | Show proposed changes |
| `terraform plan -out=tfplan` | Save a plan to apply exactly later |
| `terraform apply tfplan` | Apply a saved plan (fails if state changed since) |
| `terraform apply -auto-approve` | Apply without prompt (CI only) |
| `terraform destroy` | Destroy everything in this state |
| `terraform plan -destroy` | Preview a destroy |
| `terraform output [-raw\|-json] [name]` | Read outputs |
| `terraform console` | Evaluate expressions against current state |
| `terraform graph \| dot -Tsvg > g.svg` | Dependency graph |
| `terraform providers` | Providers required by config and state |
| `terraform providers lock -platform=darwin_arm64 -platform=linux_amd64` | Record hashes for several platforms |
| `terraform version` | CLI and provider versions |

## Useful plan/apply flags

| Flag | Use |
| --- | --- |
| `-var 'name=value'` / `-var-file=prod.tfvars` | Set variables (`*.auto.tfvars` and `terraform.tfvars` load automatically) |
| `-target=ADDRESS` | Limit to one resource (emergencies and bootstraps only) |
| `-replace=ADDRESS` | Force recreation of one resource (replaces `taint`) |
| `-refresh-only` | Update state to match reality without changing infrastructure |
| `-refresh=false` | Skip refresh (faster, riskier) |
| `-detailed-exitcode` | Exit 0 = no changes, 1 = error, 2 = changes (drift checks) |
| `-lock-timeout=5m` | Wait for a held lock instead of failing |
| `-lock=false` | Disable locking (avoid) |
| `-parallelism=N` | Concurrent operations (default 10) |
| `-generate-config-out=gen.tf` | With `import` blocks: draft resource config |
| `-input=false -no-color` | Non-interactive CI output |
| `TF_LOG=DEBUG terraform plan` | Debug logs (`TF_LOG_PATH` to write a file) |

## Plan symbols

| Symbol | Meaning |
| --- | --- |
| `+` | create |
| `-` | destroy |
| `~` | update in place |
| `-/+` | destroy then create (replacement) |
| `+/-` | create then destroy (`create_before_destroy`) |
| `<=` | read (data source) |
| `# forces replacement` | the attribute that causes `-/+` |
| `(known after apply)` | computed value, unknown at plan time |

## State operations

| Command | Use |
| --- | --- |
| `terraform state list` | List addresses in state |
| `terraform state show ADDRESS` | Show one resource's attributes |
| `terraform state mv SRC DST` | Rename/move an address (prefer `moved` blocks) |
| `terraform state rm ADDRESS` | Forget a resource without destroying it (prefer `removed` blocks) |
| `terraform state pull > backup.tfstate` | Download current state |
| `terraform state push file.tfstate` | Overwrite remote state (dangerous) |
| `terraform force-unlock LOCK_ID` | Remove a stale lock after confirming nothing is running |
| `terraform import ADDRESS ID` | CLI import (prefer `import` blocks) |
| `terraform workspace list\|new\|select\|show\|delete` | CLI workspaces |

Refactoring blocks (reviewable, part of plan/apply):

```hcl
moved {
  from = aws_s3_bucket.logs
  to   = aws_s3_bucket.access_logs
}

moved {
  from = aws_instance.web          # count/for_each and modules work too
  to   = module.web.aws_instance.this
}

import {
  to = aws_s3_bucket.assets
  id = "roma-assets-bucket"
}

import {                            # import many with for_each (1.7+)
  for_each = var.existing_buckets
  to       = aws_s3_bucket.imported[each.key]
  id       = each.value
}

removed {
  from = aws_s3_bucket.legacy
  lifecycle {
    destroy = false                 # stop managing, keep the real bucket (1.7+)
  }
}
```

## Backends

S3 (native locking, Terraform 1.10+; DynamoDB locking deprecated):

```hcl
terraform {
  backend "s3" {
    bucket       = "roma-tfstate-123456789012"
    key          = "prod/network.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

Partial config (values per environment in a file):

```hcl
# backend.tf
terraform {
  backend "s3" {}
}
```

```hcl
# envs/dev.s3.tfbackend   ->  terraform init -backend-config=envs/dev.s3.tfbackend
bucket       = "roma-tfstate-123456789012"
key          = "dev/network.tfstate"
region       = "eu-central-1"
use_lockfile = true
```

S3-compatible store (MinIO, SeaweedFS, LocalStack):

```hcl
endpoints                   = { s3 = "http://localhost:9000" }
use_path_style              = true
skip_credentials_validation = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_s3_checksum            = true
```

Reading another stack's outputs:

```hcl
data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "roma-tfstate-123456789012"
    key    = "prod/network.tfstate"
    region = "eu-central-1"
  }
}
# data.terraform_remote_state.network.outputs.vpc_id
```

Other: `backend "local" { path = "..." }`, HCP Terraform via `cloud { organization = "..." workspaces { name = "..." } }`.

## Terraform block and versions

```hcl
terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"     # >= 6.0, < 7.0
    }
  }
}
```

| Constraint | Allows |
| --- | --- |
| `= 1.2.3` | exactly 1.2.3 |
| `>= 1.2, < 2.0` | range |
| `~> 1.2` | >= 1.2, < 2.0 |
| `~> 1.2.3` | >= 1.2.3, < 1.3.0 |
| `!= 1.2.4` | exclude a version |

Commit `.terraform.lock.hcl`; never commit `.terraform/` or `*.tfstate`.

## Variables, outputs, locals

```hcl
variable "environment" {
  type        = string
  description = "dev or prod"
  default     = "dev"
  nullable    = false
  sensitive   = false
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "services" {
  type = map(object({
    image    = string
    replicas = optional(number, 1)   # optional attribute with default
    ports    = optional(list(number), [])
  }))
}

locals {
  name_prefix = "shipit-${var.environment}"
  common_tags = { Project = "shipit", Environment = var.environment }
}

output "bucket_arn" {
  value       = aws_s3_bucket.this.arn
  description = "ARN of the bucket"
  sensitive   = false
}
```

Variable precedence (lowest → highest): defaults, `TF_VAR_name` env vars, `terraform.tfvars`, `*.auto.tfvars` (alphabetical), `-var` / `-var-file` (in order given).

Types: `string`, `number`, `bool`, `list(T)`, `set(T)`, `map(T)`, `object({...})`, `tuple([...])`, `any`.

## Expressions

```hcl
# conditional
instance_type = var.environment == "prod" ? "m7g.large" : "t4g.small"

# for expressions
upper_names = [for n in var.names : upper(n)]
by_name     = { for s in var.services : s.name => s }
only_public = [for s in aws_subnet.all : s.id if s.map_public_ip_on_launch]
grouped     = { for s in var.servers : s.az => s.name... }   # group into lists

# splat
ids = aws_instance.web[*].id

# string templates and heredocs
greeting = "Hello, ${var.name}!"
script   = <<-EOT
  #!/bin/bash
  echo "env=${var.environment}"
EOT

# dynamic blocks
dynamic "ingress" {
  for_each = var.ports
  content {
    from_port = ingress.value
    to_port   = ingress.value
    protocol  = "tcp"
  }
}

# references:
#   var.x  local.x  module.m.output  data.aws_vpc.main.id  each.key  each.value
#   count.index  path.module  path.root  terraform.workspace  self (conditions/provisioners)
```

## Meta-arguments

```hcl
resource "aws_subnet" "public" {
  for_each = { a = 0, b = 1 }                 # map or set(string); stable keys
  # count  = 2                                 # by index; avoid for lists that change
  provider   = aws.use1                        # alias selection
  depends_on = [aws_internet_gateway.main]     # hidden dependencies only

  lifecycle {
    create_before_destroy = true
    prevent_destroy       = true
    ignore_changes        = [tags["LastDeployed"]]
    replace_triggered_by  = [terraform_data.version]
    precondition {
      condition     = var.cidr != ""
      error_message = "cidr is required"
    }
    postcondition {
      condition     = self.cidr_block != null
      error_message = "subnet has no CIDR"
    }
  }
}

module "vpc" {
  source    = "terraform-aws-modules/vpc/aws"
  version   = "~> 6.0"
  for_each  = toset(["dev", "prod"])     # count/for_each/depends_on work on modules
  providers = { aws = aws.use1 }
}
```

`check` block (non-blocking assertion, warns on plan/apply):

```hcl
check "api_health" {
  data "http" "health" {
    url = "https://api.example.com/healthz"
  }
  assert {
    condition     = data.http.health.status_code == 200
    error_message = "API is not healthy"
  }
}
```

## Common functions

| Category | Functions |
| --- | --- |
| Strings | `format("%s-%03d", a, n)`, `join(",", l)`, `split(",", s)`, `replace(s, "a", "b")`, `lower`, `upper`, `trimspace`, `trimprefix`, `trimsuffix`, `substr`, `regex`, `regexall`, `startswith`, `endswith`, `strcontains` |
| Collections | `length`, `element`, `index`, `contains`, `concat`, `flatten`, `distinct`, `compact`, `slice`, `sort`, `reverse`, `keys`, `values`, `lookup(map, k, default)`, `merge`, `zipmap`, `setunion`, `setintersection`, `setsubtract`, `one`, `range`, `coalesce`, `coalescelist`, `chunklist`, `transpose` |
| Type conversion | `tostring`, `tonumber`, `tobool`, `tolist`, `toset`, `tomap`, `try(expr, fallback)`, `can(expr)`, `type` (console only) |
| Encoding | `jsonencode`, `jsondecode`, `yamlencode`, `yamldecode`, `base64encode`, `base64decode`, `urlencode`, `csvdecode` |
| Files | `file`, `fileexists`, `fileset(path, "*.yaml")`, `templatefile("t.tftpl", {...})`, `filebase64`, `abspath`, `pathexpand`, `dirname`, `basename` |
| Network | `cidrsubnet("10.0.0.0/16", 8, 1)` → `10.0.1.0/24`, `cidrsubnets("10.0.0.0/16", 4, 4, 8)`, `cidrhost(prefix, n)`, `cidrnetmask` |
| Hash/crypto | `md5`, `sha256`, `filesha256`, `uuid` (changes every run), `bcrypt` |
| Date/time | `timestamp()` (changes every run), `plantimestamp()`, `timeadd`, `formatdate` |
| Sensitivity | `sensitive(v)`, `nonsensitive(v)`, `issensitive(v)` |
| Provider-defined (1.8+) | `provider::kubernetes::manifest_decode_multi(yaml)`, `provider::aws::arn_parse(arn)` |

## Providers

```hcl
provider "aws" {
  region = "eu-central-1"
  default_tags {
    tags = { ManagedBy = "terraform", Project = "shipit" }
  }
}

provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}

provider "aws" {
  alias  = "prod"
  region = "eu-central-1"
  assume_role {
    role_arn = "arn:aws:iam::111111111111:role/terraform"
  }
}

# AWS provider v6: per-resource region
resource "aws_sns_topic" "alerts" {
  region = "us-east-1"
  name   = "billing-alerts"
}
```

Auth: `aws sso login --profile p && export AWS_PROFILE=p`. Never put keys in code.

Helm provider v3 syntax:

```hcl
provider "helm" {
  kubernetes = {
    config_path = "~/.kube/config"
  }
}

resource "helm_release" "traefik" {
  name       = "traefik"
  repository = "https://traefik.github.io/charts"
  chart      = "traefik"
  version    = "41.5.0"
  values     = [yamlencode({ deployment = { replicas = 2 } })]
  set        = [{ name = "service.spec.type", value = "NodePort" }]
}
```

## Modules

```hcl
module "network" {
  source = "./modules/network"                                   # local
  # source = "terraform-aws-modules/vpc/aws"  + version = "~> 6.0"  # registry
  # source = "git::https://github.com/org/modules.git//network?ref=v1.4.0"  # git tag
  cidr   = "10.0.0.0/16"
}
```

Structure: `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf` (`required_providers`, no `provider` blocks), `README.md`, `tests/`.

## Testing (`terraform test`, 1.6+; mocks 1.7+)

```hcl
# tests/unit.tftest.hcl
mock_provider "aws" {}

variables {
  environment = "dev"
}

run "secure_defaults" {
  command = plan            # or apply (default)
  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "versioning must be on"
  }
}

run "rejects_bad_env" {
  command         = plan
  variables { environment = "qa" }
  expect_failures = [var.environment]
}

run "check_endpoint" {
  module { source = "./tests/http-check" }      # helper module
  variables { url = run.deploy.url }            # outputs of an earlier run named "deploy"
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
```

`terraform test`, `terraform test -filter=tests/unit.tftest.hcl`, `terraform test -verbose`.

## Quality tooling

| Tool | Command |
| --- | --- |
| TFLint | `tflint --init && tflint --recursive` |
| Trivy | `trivy config .` (`--severity HIGH,CRITICAL --exit-code 1`) |
| Checkov | `checkov -d .` |
| terraform-docs | `terraform-docs markdown table . > README.md` |
| pre-commit | `pre-commit install && pre-commit run --all-files` |
| Conftest | `terraform show -json tfplan > plan.json && conftest test plan.json` |
| Infracost | `infracost breakdown --path .` (cost estimate per plan) |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TF_VAR_name` | Set input variable `name` |
| `TF_LOG`, `TF_LOG_PATH` | Logging level and file |
| `TF_DATA_DIR` | Location of `.terraform` (one per env when sharing a directory) |
| `TF_IN_AUTOMATION` | Less interactive wording in CI |
| `TF_CLI_ARGS_plan="-lock-timeout=5m"` | Default extra args per command |
| `TF_PLUGIN_CACHE_DIR` | Share downloaded providers across projects |
| `AWS_PROFILE`, `AWS_REGION` | AWS provider credentials/region |
| `KUBE_CONFIG_PATH` | kubeconfig for kubernetes/helm providers |

## Gotchas in one line each

- `count` on a changing list shifts indexes; use `for_each` with stable keys.
- `depends_on` only for hidden dependencies; references create edges automatically.
- Sensitive values are redacted in output but stored in plain text in state.
- Security groups lose AWS's default egress rule when created by Terraform.
- `aws_iam_policy_attachment` is exclusive; use `aws_iam_role_policy_attachment`.
- `kubernetes_manifest` needs the cluster and CRDs at plan time.
- Don't create a cluster and configure providers from it in the same state.
- `timestamp()` and `uuid()` change every run; use `plantimestamp()` or `terraform_data` if you need stability.
- A newer Terraform can upgrade state so older CLIs can't read it; upgrade CI and laptops together.
