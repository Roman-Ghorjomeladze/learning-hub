These labs build a small infrastructure repository step by step. Everything runs locally with the Docker provider or with mocked AWS, so it is free. Only the optional part of the last lab touches AWS (free resources: an OIDC provider and IAM roles).

**Prerequisites**

```bash
brew install tflint trivy checkov pre-commit conftest jq gh
terraform version    # 1.10+ (mocks need 1.7+)
docker info >/dev/null && echo docker ok
```

Repository layout you will end up with:

```text
~/tf-labs/infra-repo/
  .pre-commit-config.yaml
  .tflint.hcl
  modules/
    web/                 # Docker nginx service (Labs 1, 4)
      tests/
    s3-bucket/           # hardened bucket module (Labs 2, 3, 5)
      tests/
  envs/
    dev/  prod/          # thin root modules (Lab 1)
  ws/                    # workspace variant (Lab 1)
  policy/                # Rego rules (Lab 6)
  .github/workflows/     # CI (Lab 6)
```

## Lab 1: Environments — directories vs workspaces

:::meta
difficulty: easy
time: 30 min
:::

Goal: deploy the same module as `dev` and `prod` from separate directories, then do the same with CLI workspaces, and feel the difference. Finish with a drift check.

### Steps

1. Create the module:

```bash
mkdir -p ~/tf-labs/infra-repo/{modules/web,envs/dev,envs/prod,ws} && cd ~/tf-labs/infra-repo
git init -q
```

`modules/web/main.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment must be dev, test or prod."
  }
}

variable "host_port" {
  type        = number
  description = "First host port; replicas use consecutive ports"
}

variable "replicas" {
  type    = number
  default = 1
}

resource "docker_image" "nginx" {
  name         = "nginx:stable-alpine"
  keep_locally = true
}

resource "docker_container" "web" {
  count = var.replicas
  name  = "web-${var.environment}-${count.index}"
  image = docker_image.nginx.image_id

  ports {
    internal = 80
    external = var.host_port + count.index
  }

  labels {
    label = "environment"
    value = var.environment
  }
}

output "urls" {
  value = [for c in docker_container.web : "http://localhost:${c.ports[0].external}"]
}

output "host_port" {
  value = var.host_port
}
```

2. Thin root modules. `envs/dev/main.tf`:

```hcl
module "web" {
  source      = "../../modules/web"
  environment = "dev"
  host_port   = 8081
  replicas    = 1
}

output "urls" {
  value = module.web.urls
}
```

`envs/prod/main.tf` is the same with `environment = "prod"`, `host_port = 8091`, `replicas = 2`.

3. Apply both:

```bash
(cd envs/dev && terraform init -input=false && terraform apply -auto-approve)
(cd envs/prod && terraform init -input=false && terraform apply -auto-approve)
docker ps --filter label=environment --format '{{.Names}}\t{{.Ports}}'
```

4. Now the workspace variant. `ws/main.tf`:

```hcl
locals {
  settings = {
    dev  = { host_port = 8181, replicas = 1 }
    prod = { host_port = 8191, replicas = 2 }
  }
  env = terraform.workspace
}

module "web" {
  source      = "../modules/web"
  environment = local.env
  host_port   = local.settings[local.env].host_port
  replicas    = local.settings[local.env].replicas
}
```

```bash
cd ws
terraform init -input=false
terraform workspace new dev  && terraform apply -auto-approve
terraform workspace new prod && terraform apply -auto-approve
terraform workspace list
ls terraform.tfstate.d/
```

5. Try the classic mistake: `terraform workspace select default && terraform plan`. Read the error.

6. Drift check. In `envs/dev`:

```bash
cd ~/tf-labs/infra-repo/envs/dev
terraform plan -detailed-exitcode; echo "exit=$?"
docker rm -f web-dev-0
terraform plan -detailed-exitcode; echo "exit=$?"
terraform apply -auto-approve
```

### Verify

- The directory layout creates three containers (`web-dev-0`, `web-prod-0`, `web-prod-1`). The first workspace apply then fails. Explain why before reading the solution.
- The first drift check exits `0`, the second `2`.
- In `ws`, `terraform.tfstate.d/dev` and `terraform.tfstate.d/prod` hold separate states.

:::hint
Container names are built from `environment`, so the workspace `dev` tries to create `web-dev-0`, which the directory-based dev already owns. Docker refuses duplicate names. In real life this is two states fighting over one resource. Destroy one layout before applying the other, or add a prefix variable.
:::

:::solution
`envs/prod/main.tf`:

```hcl
module "web" {
  source      = "../../modules/web"
  environment = "prod"
  host_port   = 8091
  replicas    = 2
}

output "urls" {
  value = module.web.urls
}
```

Expected behaviour:

- The workspace apply fails with `Conflict. The container name "/web-dev-0" is already in use`. Destroy `envs/dev` and `envs/prod` first (`terraform destroy -auto-approve` in each), then the workspace applies succeed. Two states claiming the same real resource is exactly what separate environment layouts must prevent; in AWS you would see "already exists" errors or, worse, two configurations silently fighting.
- In the `default` workspace, `local.settings["default"]` does not exist: `Invalid index ... The given key does not identify an element in this collection value`. With workspaces, nothing in the directory tells you which environment you are about to change.
- `-detailed-exitcode` returns `2` after `docker rm -f`, because the plan wants to create the container again. A scheduled CI job uses exactly this exit code to flag drift.
:::

### Clean up

```bash
cd ~/tf-labs/infra-repo/ws
terraform workspace select prod && terraform destroy -auto-approve
terraform workspace select dev && terraform destroy -auto-approve
terraform workspace select default
terraform workspace delete prod && terraform workspace delete dev
(cd ../envs/dev && terraform destroy -auto-approve)
(cd ../envs/prod && terraform destroy -auto-approve)
```

## Lab 2: Lint and scan a module, then automate it with pre-commit

:::meta
difficulty: easy
time: 30 min
:::

Goal: run `fmt`, `validate`, TFLint, Trivy and Checkov against a deliberately flawed AWS module (no AWS account needed), fix the findings, and wire everything into pre-commit.

### Steps

1. Create `modules/s3-bucket/main.tf` exactly as below. The odd formatting is intentional.

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

resource "aws_s3_bucket" "this" {
  bucket_prefix = "${var.name_prefix}-${var.environment}-"
    force_destroy = true
}

resource "aws_security_group" "admin" {
  name = "admin"
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.admin.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_instance" "bastion" {
  ami           = "ami-12345678"
  instance_type = "t9.micro"
}
```

2. Root `.tflint.hcl`:

```hcl
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.49.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
```

3. Run the checks, cheapest first:

```bash
cd ~/tf-labs/infra-repo
terraform fmt -check -recursive; echo "fmt exit=$?"
(cd modules/s3-bucket && terraform init -backend=false -input=false >/dev/null && terraform validate)
tflint --init
tflint --chdir=modules/s3-bucket --config=$PWD/.tflint.hcl
trivy config modules/s3-bucket
checkov -d modules/s3-bucket --compact --quiet
```

4. Fix the module: run `terraform fmt -recursive`, remove the bastion and security group (they do not belong in a bucket module), and add the hardening resources from the AWS module (public access block, ownership controls, encryption, versioning, lifecycle). Re-run until TFLint is clean and Trivy shows no HIGH/CRITICAL findings.

5. Add `.pre-commit-config.yaml` at the repo root:

```yaml
repos:
  - repo: https://github.com/antonbabenko/pre-commit-terraform
    rev: v1.108.1
    hooks:
      - id: terraform_fmt
      - id: terraform_validate
      - id: terraform_tflint
        args:
          - --args=--config=__GIT_WORKING_DIR__/.tflint.hcl
      - id: terraform_trivy
        args:
          - --args=--severity=HIGH,CRITICAL
```

```bash
pre-commit autoupdate
pre-commit install
pre-commit run --all-files
```

### Verify

- Before fixing: `fmt` exits `3`, `validate` **passes** (it cannot know `t9.micro` is invalid), TFLint reports `aws_instance_invalid_type`, Trivy reports the open SSH ingress and missing bucket protections, Checkov fails several `CKV_AWS_*` checks.
- After fixing: `pre-commit run --all-files` passes, and `git commit` runs the hooks automatically.

:::hint
TFLint plugins are downloaded by `tflint --init` from GitHub. If you hit GitHub rate limits, set `GITHUB_TOKEN` (for example `export GITHUB_TOKEN=$(gh auth token)`). Some Checkov checks (cross-region replication, event notifications, access logging) are reasonable to skip for this module with a documented `#checkov:skip=...` comment.
:::

:::solution
Fixed `modules/s3-bucket/main.tf` (also used in Lab 3):

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "name_prefix" {
  type        = string
  description = "Prefix for the bucket name"
}

variable "environment" {
  type        = string
  description = "dev, test or prod"
  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment must be dev, test or prod."
  }
}

variable "noncurrent_days" {
  type    = number
  default = 30
}

locals {
  is_prod = var.environment == "prod"
}

resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_144:cross-region replication not required for this module
  #checkov:skip=CKV2_AWS_62:event notifications not required
  #checkov:skip=CKV_AWS_18:access logging handled centrally
  bucket_prefix = "${var.name_prefix}-${var.environment}-"
  force_destroy = !local.is_prod
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    id     = "cleanup"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

output "bucket_name" {
  value = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.this.arn
}
```

Typical findings before the fix (wording and check IDs vary by tool version):

```text
Error: "t9.micro" is an invalid value as instance_type (aws_instance_invalid_type)
CRITICAL: Security group rule allows unrestricted ingress from any IP address.  (AWS-0107)
HIGH: No public access block so not blocking public acls                       (AWS-0086)
HIGH: Bucket does not have encryption enabled                                   (AWS-0088)
```

Trivy may still report LOW/MEDIUM items (for example, a customer-managed KMS key instead of the AWS-managed one, or logging); decide per finding whether to fix or suppress with a reason.
:::

### Clean up

Nothing to destroy. Commit your work: `git add -A && git commit -m "lint-clean s3 module"` (the hooks run).

## Lab 3: Unit tests with `mock_provider`

:::meta
difficulty: medium
time: 30 min
:::

Goal: test the S3 module's logic (secure defaults, prod rules, input validation) in seconds, with no AWS credentials.

### Steps

1. Make sure no AWS credentials are active, to prove the tests do not need them:

```bash
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

2. Create `modules/s3-bucket/tests/unit.tftest.hcl` with the three runs from the lesson (`secure_by_default`, `prod_cannot_force_destroy`, `rejects_unknown_environment`), and add a fourth:

```hcl
run "lifecycle_uses_variable" {
  command = apply

  variables {
    noncurrent_days = 7
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.this.rule[0].noncurrent_version_expiration[0].noncurrent_days == 7
    error_message = "noncurrent_days must flow into the lifecycle rule"
  }
}
```

3. Run:

```bash
cd ~/tf-labs/infra-repo/modules/s3-bucket
terraform init -backend=false -input=false
terraform test
```

4. Prove the tests catch regressions: change `block_public_policy = true` to `false` and `force_destroy = !local.is_prod` to `force_destroy = true`, run `terraform test`, read the failures, then revert.

5. Write one more test on your own: in `dev`, `force_destroy` must be `true`.

### Verify

```text
tests/unit.tftest.hcl... in progress
  run "secure_by_default"... pass
  run "prod_cannot_force_destroy"... pass
  run "rejects_unknown_environment"... pass
  run "lifecycle_uses_variable"... pass
  run "dev_allows_force_destroy"... pass
tests/unit.tftest.hcl... tearing down
tests/unit.tftest.hcl... pass

Success! 5 passed, 0 failed.
```

:::hint
If you see `No valid credential sources found`, the `mock_provider "aws" {}` line is missing or misspelled: Terraform is configuring the real provider. Blocks inside `aws_s3_bucket_lifecycle_configuration` are lists in the state, hence `rule[0]`.
:::

:::solution
Complete `tests/unit.tftest.hcl`:

```hcl
mock_provider "aws" {}

variables {
  name_prefix = "shipit-assets"
  environment = "dev"
}

run "secure_by_default" {
  command = apply

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

  expect_failures = [var.environment]
}

run "lifecycle_uses_variable" {
  command = apply

  variables {
    noncurrent_days = 7
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.this.rule[0].noncurrent_version_expiration[0].noncurrent_days == 7
    error_message = "noncurrent_days must flow into the lifecycle rule"
  }
}

run "dev_allows_force_destroy" {
  command = plan

  assert {
    condition     = aws_s3_bucket.this.force_destroy
    error_message = "dev buckets should be force-destroyable"
  }
}
```

With the regression from step 4, the output shows:

```text
  run "secure_by_default"... fail
Error: Test assertion failed
  on tests/unit.tftest.hcl line 13, in run "secure_by_default":
  13:     condition     = aws_s3_bucket_public_access_block.this.block_public_policy
Public bucket policies must be blocked
```
:::

### Clean up

Nothing to destroy: mocks create nothing.

## Lab 4: An integration test with real resources

:::meta
difficulty: medium
time: 25 min
:::

Goal: test the `web` module end to end: apply it for real (Docker), check it answers HTTP 200 using a helper module, and let `terraform test` destroy everything.

### Steps

1. Helper module `modules/web/tests/http-check/main.tf`:

```hcl
terraform {
  required_providers {
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

variable "url" {
  type = string
}

data "http" "this" {
  url = var.url
  retry {
    attempts     = 10
    min_delay_ms = 500
  }
}

output "status_code" {
  value = data.http.this.status_code
}
```

2. Test file `modules/web/tests/integration.tftest.hcl`:

```hcl
run "deploy" {
  command = apply

  variables {
    environment = "test"
    host_port   = 18080
    replicas    = 2
  }

  assert {
    condition     = length(output.urls) == 2
    error_message = "Expected two URLs for two replicas"
  }
}

run "first_replica_responds" {
  command = apply

  module {
    source = "./tests/http-check"
  }

  variables {
    url = run.deploy.urls[0]
  }

  assert {
    condition     = output.status_code == 200
    error_message = "First replica did not return HTTP 200"
  }
}
```

3. Run it and watch Docker in a second terminal:

```bash
cd ~/tf-labs/infra-repo/modules/web
terraform init -input=false
terraform test
# second terminal: watch docker ps --filter label=environment=test
```

4. Add a third run that checks the second replica (`run.deploy.urls[1]`).

### Verify

- `Success! 3 passed, 0 failed.`
- During the run, `web-test-0` and `web-test-1` exist; afterwards `docker ps -a --filter label=environment=test` is empty.

:::hint
`terraform init` in the module root also installs the providers needed by test helper modules. If you get `Module not installed` for `./tests/http-check`, run `terraform init` again after creating the helper.
:::

:::solution
Third run:

```hcl
run "second_replica_responds" {
  command = apply

  module {
    source = "./tests/http-check"
  }

  variables {
    url = run.deploy.urls[1]
  }

  assert {
    condition     = output.status_code == 200
    error_message = "Second replica did not return HTTP 200"
  }
}
```

The order matters: runs execute top to bottom, and the teardown destroys state in reverse order at the end of the file. The helper module has no resources (only a data source), so destroying it is a no-op; the `deploy` run's containers are removed last.
:::

### Clean up

`terraform test` cleaned up. If a run was interrupted with Ctrl-C twice, remove leftovers with `docker rm -f web-test-0 web-test-1`.

## Lab 5: Break and fix — the PR that "passes validate"

:::meta
difficulty: medium
time: 25 min
:::

Goal: a colleague's PR changes the S3 module. `terraform validate` passes, but the tests fail. Find and fix three bugs using only the tool output.

### Steps

1. Apply the colleague's changes to `modules/s3-bucket/main.tf`:

```diff
   validation {
-    condition     = contains(["dev", "test", "prod"], var.environment)
+    condition     = !contains(["dev", "test", "prod"], var.environment)
     error_message = "environment must be dev, test or prod."
   }
 ...
+variable "versioning" {
+  type    = bool
+  default = true
+}
 ...
   versioning_configuration {
-    status = "Enabled"
+    status = var.versioning ? "Suspended" : "Enabled"
   }
 ...
 resource "aws_s3_bucket_public_access_block" "this" {
   bucket                  = aws_s3_bucket.this.id
-  block_public_acls       = true
+  block_public_acls       = var.environment == "prod"
```

2. Run, in order, and read every message:

```bash
cd ~/tf-labs/infra-repo/modules/s3-bucket
terraform validate
terraform test
trivy config . --severity HIGH,CRITICAL
```

3. Fix the module until all three commands are clean. Then add a test that would have caught the `block_public_acls` change.

### Verify

`terraform validate` passes before **and** after; `terraform test` reports all runs passing (including your new one) only after your fixes; Trivy has no HIGH findings.

:::hint
- A failing `expect_failures` run that says the validation *did not* fail, plus valid inputs being rejected, points at a logic inversion.
- Read the versioning conditional out loud: "if versioning is wanted, suspend it".
- `block_public_acls` now depends on the environment. Static scanners cannot always resolve variables without defaults, so do not rely on Trivy alone here; a test pins the behaviour.
:::

:::solution
Symptoms:

```text
run "secure_by_default"... fail
Error: Invalid value for variable
  ... environment must be dev, test or prod.        <- valid "dev" rejected: inverted condition

run "rejects_unknown_environment"... fail
Error: Missing expected failure                        <- "qa-old" accepted
```

After fixing the validation, `secure_by_default` fails on `versioning_configuration[0].status == "Enabled"` (it is `Suspended`). Trivy may or may not flag the public access block: `var.environment` has no default, so a static scanner cannot always evaluate the condition. That is exactly why the new test below matters.

Fixes:

```hcl
  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment must be dev, test or prod."
  }

  versioning_configuration {
    status = var.versioning ? "Enabled" : "Suspended"
  }

  block_public_acls = true
```

New test:

```hcl
run "public_acls_blocked_in_every_env" {
  command = plan

  variables {
    environment = "dev"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.this.block_public_acls
    error_message = "Public ACLs must be blocked in every environment"
  }
}
```

Takeaway: `validate` only checks that the configuration is well-formed. Logic, security and intent need tests and scanners, and CI must run all of them.
:::

### Clean up

Nothing to destroy. Commit the fixed module and tests.

## Lab 6: Challenge — a CI pipeline on GitHub Actions (with optional OIDC to AWS)

:::meta
difficulty: hard
time: 60–90 min
:::

Goal: push `infra-repo` to GitHub and build a pipeline that enforces everything from this module on every pull request.

### Requirements

1. A private GitHub repository `infra-repo` (create it with `gh repo create infra-repo --private --source=. --push`).
2. Workflow `.github/workflows/terraform-ci.yml` triggered on `pull_request` and on `push` to `main`, with minimal `permissions`.
3. Jobs (fail fast, cheapest first):
   - **quality**: `terraform fmt -check -recursive`, `terraform validate` for both modules, TFLint, Trivy (HIGH/CRITICAL fail the build).
   - **test**: `terraform test` in `modules/s3-bucket` (mocked) and `modules/web` (Docker is available on `ubuntu-latest` runners).
   - **policy**: a Conftest policy that **denies any Docker container whose external port is below 1024**. Generate plan JSON with `terraform plan -out` + `terraform show -json` in `envs/dev` on the runner (Docker is available there) and run `conftest test` against it.
4. Branch protection on `main` requiring all three jobs.
5. Open a PR that sets `host_port = 80` in `envs/dev` and show that the policy job fails. Close it.
6. **Optional AWS part** (free resources only): in your `aws-guardrails` folder from the AWS module, create the GitHub OIDC provider and a role `gha-infra-plan` that only `repo:<you>/infra-repo:pull_request` can assume, with `ReadOnlyAccess`. Add a job that assumes it with `aws-actions/configure-aws-credentials` and runs `aws sts get-caller-identity`. No access keys anywhere.

### Verify

- The PR checks tab shows `quality`, `test` and `policy`; the `host_port = 80` PR is blocked by `policy`.
- (Optional) The OIDC job log shows `arn:aws:sts::<account>:assumed-role/gha-infra-plan/...`, and the repository has **no** AWS secrets configured.

:::hint
- `hashicorp/setup-terraform` with `terraform_wrapper: false`; TFLint has `terraform-linters/setup-tflint`; Trivy and Conftest can be installed with their install scripts or run as containers.
- In plan JSON, a container's ports are under `resource_changes[].change.after.ports[].external`.
- Remember `id-token: write` permission for OIDC, and that the `sub` claim for PR workflows is `repo:OWNER/REPO:pull_request`.
:::

:::solution
`policy/ports.rego`:

```text
package main

import rego.v1

deny contains msg if {
  rc := input.resource_changes[_]
  rc.type == "docker_container"
  some p in rc.change.after.ports
  p.external < 1024
  msg := sprintf("%s exposes privileged host port %d", [rc.address, p.external])
}
```

`.github/workflows/terraform-ci.yml`:

```yaml
name: terraform-ci

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
      - name: validate modules
        run: |
          for m in modules/s3-bucket modules/web; do
            (cd $m && terraform init -backend=false -input=false && terraform validate)
          done
      - uses: terraform-linters/setup-tflint@v4
      - run: tflint --init && tflint --recursive --config=$GITHUB_WORKSPACE/.tflint.hcl
        env:
          GITHUB_TOKEN: ${{ github.token }}
      - name: trivy
        run: |
          curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin
          trivy config --severity HIGH,CRITICAL --exit-code 1 modules

  test:
    needs: quality
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false
      - run: cd modules/s3-bucket && terraform init -backend=false -input=false && terraform test
      - run: cd modules/web && terraform init -input=false && terraform test

  policy:
    needs: quality
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false
      - name: plan to JSON
        working-directory: envs/dev
        run: |
          terraform init -input=false
          terraform plan -input=false -out=tfplan
          terraform show -json tfplan > plan.json
      - name: conftest
        run: |
          docker run --rm -v "$PWD":/project -w /project openpolicyagent/conftest \
            test envs/dev/plan.json --policy policy
```

Optional OIDC (add to `aws-guardrails/oidc.tf`, replace `<you>`):

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
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:<you>/infra-repo:pull_request"]
    }
  }
}

resource "aws_iam_role" "gha_infra_plan" {
  name               = "gha-infra-plan"
  assume_role_policy = data.aws_iam_policy_document.gha_plan_trust.json
}

resource "aws_iam_role_policy_attachment" "gha_infra_plan" {
  role       = aws_iam_role.gha_infra_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

output "gha_plan_role_arn" {
  value = aws_iam_role.gha_infra_plan.arn
}
```

Job to add to the workflow:

```yaml
  aws-identity:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::<account>:role/gha-infra-plan
          aws-region: eu-central-1
      - run: aws sts get-caller-identity
```

Pin action majors to what each action's releases page shows when you do this lab.
:::

### Clean up

- Delete the test PR branch. Keep or delete the repository (`gh repo delete infra-repo`).
- Optional AWS part: the OIDC provider and role are free; if you no longer need them, remove `oidc.tf` and run `terraform apply` in `aws-guardrails`.
