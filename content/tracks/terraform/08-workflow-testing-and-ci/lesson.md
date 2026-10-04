Writing HCL that works on your laptop is the easy half of Terraform. The hard half is running it as a team: several environments, many people changing things, reviews, CI, secrets, upgrades, and the occasional "who changed this in the console?". This module is about that workflow. It is also where senior interviews spend most of their time, because these choices decide whether infrastructure changes are boring (good) or scary (bad).

## Laying out multiple environments

You want `dev` and `prod` (maybe `staging`) built from the same code, with different sizes and settings, and with **separate state** so a mistake in dev cannot touch prod. There are two common layouts.

### Option A: a directory per environment (recommended default)

```text
infra/
  modules/
    network/            # reusable building blocks (module 05)
    service/
  envs/
    dev/
      main.tf           # module "network" { source = "../../modules/network" ... }
      backend.tf        # key = "dev/network.tfstate"
      terraform.tfvars  # instance sizes, counts, feature flags for dev
    prod/
      main.tf
      backend.tf        # key = "prod/network.tfstate", maybe a different account
      terraform.tfvars
```

Each environment is its own root module with its own backend configuration and its own state. `cd envs/prod && terraform plan` is unambiguous: the directory **is** the environment.

### Option B: CLI workspaces

```bash
terraform workspace new dev
terraform workspace new prod
terraform workspace select prod
terraform apply -var-file=prod.tfvars
```

One directory, one backend configuration; each workspace gets a separate state (`env:/prod/<key>` in S3). Code can branch on `terraform.workspace`:

```hcl
locals {
  instance_count = terraform.workspace == "prod" ? 3 : 1
}
```

### Trade-offs

| | Directories | Workspaces |
| --- | --- | --- |
| Which env am I in? | Obvious from the path | Hidden state (`terraform workspace show`); easy to apply to the wrong one |
| Different backends / AWS accounts | Natural (each env has its own backend + provider config) | Hard: all workspaces share one backend config |
| Envs that differ structurally | Easy (prod has extra modules) | Becomes `count = terraform.workspace == "prod" ? 1 : 0` everywhere |
| Duplication | Some boilerplate per env | Minimal |
| Good for | Long-lived environments (dev/staging/prod) | Short-lived copies of the same thing (feature branches, per-developer sandboxes, test runs) |

:::info HCP Terraform workspaces are different
In HCP Terraform (formerly Terraform Cloud), a "workspace" is a separate unit with its own state, variables, permissions and run history, usually one per environment per component. It is closer to the directory model than to CLI workspaces. Do not confuse the two in interviews.
:::

### Splitting by component as well as environment

Production setups split state along **two** axes: environment and component.

```text
envs/prod/network/      -> state: prod/network.tfstate     (changes rarely)
envs/prod/data/         -> state: prod/data.tfstate        (RDS, ElastiCache; protected)
envs/prod/services/     -> state: prod/services.tfstate    (ECS services; changes often)
```

Smaller states mean faster plans, smaller blast radius, finer permissions (the services pipeline cannot delete the database), and fewer lock conflicts. Components share data through outputs read with `terraform_remote_state` or, better, through data sources and naming conventions (`data "aws_vpc" "main" { tags = { Name = "prod" } }`), which avoids giving consumers read access to the producer's whole state.

## DRY: modules first, Terragrunt if needed

Per-environment directories duplicate some boilerplate: the `terraform` block, backend, provider, and module calls. Modules (module 05) remove the real duplication; the remaining per-env files should be thin: a module call and variables.

[Terragrunt](https://terragrunt.gruntwork.io/) is a wrapper that generates that boilerplate. A typical `terragrunt.hcl` in `envs/prod/network/`:

```hcl
include "root" {
  path = find_in_parent_folders("root.hcl")   # shared remote_state and provider generation
}

terraform {
  source = "../../../modules//network"
}

inputs = {
  cidr     = "10.10.0.0/16"
  az_count = 3
}
```

The root file generates `backend.tf` with a key derived from the folder path, and `terragrunt run --all plan` (older versions: `run-all plan`) runs every component in dependency order. Terragrunt shines in large estates with dozens of components and accounts. For a handful of environments, plain Terraform with thin root modules is simpler and has fewer moving parts. Know what it is; reach for it when duplication actually hurts.

:::info OpenTofu
OpenTofu is the open-source (MPL) fork of Terraform under the Linux Foundation. The workflow in this module applies to both. OpenTofu adds features like client-side state encryption; HCP Terraform features like Sentinel are Terraform-only. Tools like Terragrunt, TFLint, Trivy and pre-commit-terraform support both.
:::

## Code quality: format, validate, lint, scan

Run these, cheapest first, locally and in CI:

| Tool | Command | Catches |
| --- | --- | --- |
| `terraform fmt` | `terraform fmt -check -recursive` | Formatting differences (CI fails instead of rewriting) |
| `terraform validate` | `terraform init -backend=false && terraform validate` | Syntax, unknown arguments, type errors, missing variables in references |
| [TFLint](https://github.com/terraform-linters/tflint) | `tflint --init && tflint --recursive` | Invalid instance types, deprecated syntax, unused declarations, naming conventions |
| [Trivy](https://trivy.dev/) | `trivy config .` | Security misconfigurations: public buckets, open security groups, missing encryption |
| [Checkov](https://www.checkov.io/) | `checkov -d .` | Similar to Trivy with a different, larger policy set; also scans plan JSON |

`validate` knows the provider schema but not AWS: `instance_type = "t9.huge"` passes validation and fails at apply. TFLint's AWS ruleset knows valid instance types:

```hcl
# .tflint.hcl
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.49.0"   # check github.com/terraform-linters/tflint-ruleset-aws/releases
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
```

Trivy took over tfsec's Terraform checks (tfsec is no longer developed separately). A finding looks like this (check ID formats vary between Trivy versions):

```text
s3.tf (terraform)
HIGH: No public access block so not blocking public acls
════════════════════════════════════════
 AWS-0086  aws_s3_bucket.logs
```

Suppress a finding you have consciously accepted with a comment and a reason: `#trivy:ignore:<check ID>` on the line above the resource (use the ID Trivy prints), or `#checkov:skip=CKV_AWS_18:access logging handled centrally` inside the resource block. Unexplained suppressions are a code-review red flag.

### pre-commit hooks

[pre-commit](https://pre-commit.com/) runs checks on `git commit`, so problems never reach a PR:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/antonbabenko/pre-commit-terraform
    rev: v1.108.1   # run `pre-commit autoupdate` to move to the latest tag
    hooks:
      - id: terraform_fmt
      - id: terraform_validate
      - id: terraform_tflint
      - id: terraform_trivy
      - id: terraform_docs   # optional: keeps module READMEs' inputs/outputs tables current
```

```bash
brew install pre-commit tflint trivy terraform-docs
pre-commit install            # installs the git hook
pre-commit run --all-files    # run everything once
```

Hooks are a convenience for developers; CI must run the same checks because hooks can be skipped (`git commit --no-verify`).

## Testing with `terraform test`

Since Terraform 1.6, `terraform test` runs `.tftest.hcl` files (in the module root or a `tests/` directory). Each file contains `run` blocks executed in order. Each run does a `plan` or an `apply` and checks `assert` conditions. Resources created by `apply` runs are destroyed automatically at the end of the file, in reverse order.

```text
modules/s3-bucket/
  main.tf  variables.tf  outputs.tf
  tests/
    unit.tftest.hcl          # mock_provider: no cloud, runs in seconds
    integration.tftest.hcl   # real provider: creates and destroys real resources
```

### Unit tests with mocks (Terraform 1.7+)

`mock_provider` replaces a real provider with one that returns fake values for computed attributes and never calls an API. No credentials, no cost, seconds to run.

```hcl
# tests/unit.tftest.hcl
mock_provider "aws" {}

variables {
  name_prefix = "shipit-assets"
  environment = "dev"
}

run "secure_by_default" {
  command = apply   # "apply" against a mock creates nothing real

  assert {
    condition     = aws_s3_bucket_public_access_block.this.block_public_policy
    error_message = "Public bucket policies must be blocked"
  }

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "Versioning must be enabled"
  }
}

run "prod_cannot_force_destroy" {
  command = plan

  variables {
    environment = "prod"
  }

  assert {
    condition     = aws_s3_bucket.this.force_destroy == false
    error_message = "force_destroy must be false in prod"
  }
}

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "qa-old"
  }

  expect_failures = [var.environment]   # the validation block must fail
}
```

Useful extras:

- `mock_resource "aws_s3_bucket" { defaults = { arn = "arn:aws:s3:::fixed" } }` inside `mock_provider` when an attribute needs a realistic shape (for example something you parse with `split`).
- `override_resource`, `override_data` and `override_module` replace single objects, even with a real provider.
- `run.<name>.<output>` reads outputs of an earlier run, so you can chain runs.
- `module { source = "./tests/setup" }` in a run block executes a helper module (create prerequisites, or make an HTTP check against what you deployed).

:::warning Mocks test your logic, not AWS
A mocked test proves your conditionals, `for_each` keys, validations and outputs are right. It cannot prove AWS accepts the configuration (invalid policy JSON, wrong region for a resource, IAM eventual consistency). Keep a few integration tests that really apply, in a sandbox account, ideally on a schedule or before releasing a module version.
:::

### Integration tests

Without a mock, `command = apply` creates real resources. A common pattern is a deploy run followed by a verification run using a tiny helper module:

```hcl
# tests/integration.tftest.hcl
run "deploy" {
  command = apply
  variables {
    environment = "test"
    host_port   = 18080
  }
}

run "responds_over_http" {
  command = apply
  module {
    source = "./tests/http-check"   # contains: data "http" "this" { url = var.url, retry { attempts = 5 } }
  }
  variables {
    url = "http://localhost:${run.deploy.host_port}"
  }
  assert {
    condition     = data.http.this.status_code == 200
    error_message = "Expected HTTP 200"
  }
}
```

`terraform test` runs every test file; `terraform test -filter=tests/unit.tftest.hcl` runs one, and `-verbose` prints plans and state.

:::deep Which validation tool for which job?
- `variable` **validation** blocks: reject bad inputs early (`environment` in an allowed list, CIDR is valid via `can(cidrhost(var.cidr, 0))`).
- **Preconditions/postconditions** in `lifecycle`: assumptions about other objects (the AMI must be arm64; the subnet must be in the VPC).
- **`check` blocks**: non-blocking health assertions evaluated on every plan/apply (an endpoint returns 200); they warn instead of failing.
- **`terraform test`**: proves the module behaves as intended across scenarios, run in CI.
- **Policy as code**: organisation-wide rules applied to every plan, regardless of who wrote the module.

Tests and validations live with the module author; policies live with the platform/security team.
:::

## CI/CD with GitHub Actions

The standard flow:

```text
 feature branch ──PR──▶ CI: fmt -check, validate, tflint, trivy, terraform test
                        CI: terraform plan  ──▶ plan posted as PR comment
                        humans review code AND plan
                 merge ▶ CI (main): terraform apply  (environment "production" with required reviewers)
```

### Keyless AWS access with OIDC

GitHub Actions can request a short-lived OIDC token that AWS trusts. You create an IAM OIDC identity provider and a role whose trust policy only allows **your repo**, and optionally only certain branches or environments. No AWS keys are stored in GitHub.

```hcl
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "gha_plan_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:roma-g/shipit-infra:pull_request"]
    }
  }
}

resource "aws_iam_role" "gha_plan" {
  name               = "gha-terraform-plan"
  assume_role_policy = data.aws_iam_policy_document.gha_plan_trust.json
}

resource "aws_iam_role_policy_attachment" "gha_plan_readonly" {
  role       = aws_iam_role.gha_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
# plus an inline policy allowing read/write on the state bucket key (plan needs the lock file)
```

The `sub` claim encodes where the workflow runs: `repo:ORG/REPO:pull_request`, `repo:ORG/REPO:ref:refs/heads/main`, or, when the job uses a GitHub **environment**, `repo:ORG/REPO:environment:production`. Use a **read-only plan role** for PRs and a separate **apply role** that only the `production` environment (protected by required reviewers) can assume. Never use `repo:ORG/*` wildcards that let any repository in the org assume a powerful role.

:::warning Pull requests from forks
Workflows triggered by PRs from forks do not get OIDC tokens or secrets with the `pull_request` event, which is a security feature. Do not "fix" it with `pull_request_target` plus checking out the fork's code: that runs untrusted code with your credentials.
:::

### The workflow

```yaml
# .github/workflows/terraform.yml
name: terraform

on:
  pull_request:
    paths: ["infra/**"]
  push:
    branches: [main]
    paths: ["infra/**"]

permissions:
  contents: read
  id-token: write       # required for OIDC
  pull-requests: write  # to comment the plan

env:
  TF_IN_AUTOMATION: "true"
  AWS_REGION: eu-central-1

jobs:
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra/envs/prod
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: "1.16.x"   # same version your team uses locally
          terraform_wrapper: false
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-terraform-plan
          aws-region: ${{ env.AWS_REGION }}
      - run: terraform fmt -check -recursive ../..
      - run: terraform init -input=false
      - run: terraform validate
      - run: terraform plan -input=false -no-color -lock-timeout=5m -out=tfplan
      - run: terraform show -no-color tfplan > plan.txt
      - name: Comment plan on PR
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          {
            echo "### Terraform plan: prod"
            echo '```'
            head -c 60000 plan.txt
            echo '```'
          } > comment.md
          gh pr comment ${{ github.event.pull_request.number }} --body-file comment.md --edit-last \
            || gh pr comment ${{ github.event.pull_request.number }} --body-file comment.md

  apply:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    environment: production   # required reviewers + the apply role's trust policy
    concurrency: terraform-prod
    defaults:
      run:
        working-directory: infra/envs/prod
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: "1.16.x"
          terraform_wrapper: false
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-terraform-apply
          aws-region: ${{ env.AWS_REGION }}
      - run: terraform init -input=false
      - run: terraform apply -input=false -auto-approve -lock-timeout=5m
```

Action major versions move; check each action's releases page and pin to a major (or, stricter, a commit SHA). `terraform_wrapper: false` keeps real exit codes and raw output, which matters for `-detailed-exitcode` and for piping `terraform output`.

:::tip Apply exactly what was reviewed
The simple workflow above re-plans on `main`. If something changed between the PR plan and the merge (another merged PR, drift), the apply could differ from what reviewers saw. Stricter options: upload `tfplan` as an artifact and apply that saved plan (it refuses to apply if state changed underneath), require branches to be up to date before merging, or use a tool built for this (Atlantis, HCP Terraform, Spacelift, env0) that locks and applies per PR.
:::

## Policy as code

Code review relies on humans noticing a public bucket in a 400-line plan. Policy as code makes rules machine-checked on every plan.

- **OPA / Conftest**: write rules in Rego, evaluate them against `terraform show -json tfplan`. Open source; works with any CI.
- **Sentinel**: HashiCorp's policy language in HCP Terraform / Terraform Enterprise, with enforcement levels (advisory, soft-mandatory, hard-mandatory). HCP Terraform can also run OPA policies.
- **Trivy / Checkov** with custom checks cover the same ground for many teams.

A Conftest rule that rejects security groups open to the world on SSH:

```text
# policy/terraform.rego
package main

import rego.v1

deny contains msg if {
  rc := input.resource_changes[_]
  rc.type == "aws_vpc_security_group_ingress_rule"
  rc.change.after.cidr_ipv4 == "0.0.0.0/0"
  rc.change.after.from_port <= 22
  rc.change.after.to_port >= 22
  msg := sprintf("%s opens SSH to the internet", [rc.address])
}
```

```bash
terraform plan -out tfplan && terraform show -json tfplan > plan.json
conftest test plan.json
```

## Drift detection

Drift is any difference between real infrastructure and state/code: a console hotfix, an autoscaler, another tool. Detect it on a schedule:

```bash
terraform plan -detailed-exitcode -input=false -lock=false
# exit 0 = no changes, 1 = error, 2 = changes present (drift or unapplied code)
```

A nightly GitHub Actions job with `on: schedule: - cron: "0 5 * * *"` can run this per component and open an issue when the exit code is 2. HCP Terraform has built-in drift detection.

When you find drift, decide which side is right:

| Situation | Action |
| --- | --- |
| Someone hot-fixed in the console, code is right | `terraform apply` to revert |
| The console change was correct | Update the code to match, then plan shows no changes |
| A field is legitimately managed elsewhere (ASG desired count, HPA replicas, tags added by AWS) | `lifecycle { ignore_changes = [...] }` |
| You just want state to reflect reality (no infra change) | `terraform apply -refresh-only` (review, then accept) |

## Team practices

- **Review the plan, not just the diff.** A one-line change of `name` on an RDS instance is a destroy-and-create. Reviewers look for `-/+`, `destroy`, and surprising counts.
- **Small blast radius.** Split state per environment and component; keep each plan short enough to read.
- **Nobody applies prod from a laptop.** CI applies; humans get read-only access by default, with an audited break-glass role for emergencies.
- **Protect critical resources.** `lifecycle { prevent_destroy = true }` on databases and state buckets; AWS deletion protection where it exists.
- **CODEOWNERS** on `infra/envs/prod/**` and on shared modules.
- **One change per PR.** Refactors with `moved` blocks go in a separate PR from functional changes, so the plan for the refactor shows zero changes.
- **Document modules** (`terraform-docs`), version them with Git tags, and consume them by tag (`?ref=v1.4.0`).

## Versioning providers and upgrading Terraform

- `required_version` pins Terraform; `required_providers` pins providers with `~>`. Commit `.terraform.lock.hcl`.
- **Lock file and platforms.** You run `darwin_arm64`, CI runs `linux_amd64`. Record hashes for both, or CI fails with "the cached package does not match any of the checksums":

```bash
terraform providers lock -platform=darwin_arm64 -platform=linux_amd64
```

- **Upgrade providers deliberately**: `terraform init -upgrade` updates within your constraints and rewrites the lock file; review the changelog, run tests and a plan in dev, then merge. Dependabot and Renovate can open these PRs for you (both support Terraform).
- **Major provider upgrades** (AWS 5 → 6, helm 2 → 3) have upgrade guides; expect syntax and behaviour changes. Upgrade one component at a time.
- **Terraform CLI upgrades**: read the changelog, upgrade dev first, keep every team member and CI on the same version (a `.terraform-version` file read by `tfenv`/`tfswitch`, or `mise`). A newer CLI can write state that older CLIs refuse to touch, so upgrade CI and laptops together.
- Recent language additions worth knowing: `import`/`moved`/`removed` blocks, `terraform test` with mocks, ephemeral values and write-only arguments (`*_wo`) that keep secrets out of state, and S3 native locking (`use_lockfile`).

:::try Check your own lock file
In any lab folder from earlier modules, open `.terraform.lock.hcl` and count the `h1:` hashes per provider. Then run `terraform providers lock -platform=darwin_arm64 -platform=linux_amd64` and look at the diff: new hashes appear for Linux. That is what CI needs.
:::

## Summary

- Directories per environment (and per component) are the default; CLI workspaces suit short-lived copies.
- Modules remove duplication; Terragrunt removes boilerplate across many components.
- Cheap checks first: `fmt`, `validate`, TFLint, Trivy/Checkov, run via pre-commit and again in CI.
- `terraform test` with `mock_provider` gives fast unit tests; keep a few real integration tests.
- CI plans on PRs, comments the plan, applies on merge behind a protected environment, using OIDC roles with tight `sub` conditions.
- Policy as code (Conftest/OPA, Sentinel) enforces organisation rules on every plan.
- Detect drift with `plan -detailed-exitcode`; resolve it deliberately.
- Pin versions, lock hashes for every platform, and upgrade on purpose.
