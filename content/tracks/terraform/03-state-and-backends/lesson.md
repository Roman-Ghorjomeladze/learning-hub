## Why Terraform needs state

Terraform's job is to make real infrastructure match your configuration. To do that it must answer, for each `resource` block: **which real object is this?**

Your config says `resource "docker_container" "web"`. Docker knows a container with ID `3f1c9a...`. Nothing in Docker (or AWS) says "this container is `docker_container.web` from Roma's repo". The **state** is that mapping:

```text
   configuration                 state (terraform.tfstate)               real world
   -------------                 -------------------------               ----------
   docker_container.web   <-->   docker_container.web                <-->  container 3f1c9a...
                                   id = "3f1c9a..."
                                   name = "tf-web", image = "sha256:.."
                                   ports = [{ internal=80, external=8080 }]
   docker_image.nginx     <-->   docker_image.nginx                  <-->  image sha256:aa11...
```

State exists for four reasons:

1. **Mapping** config to real objects (by ID). Without it, Terraform could only guess by name, and many APIs don't have unique names.
2. **Metadata**, notably the dependency order of existing resources. If you delete both a container and its network from config, Terraform needs state to know to delete the container first.
3. **Performance.** For large configs, state is a cache of attributes; `-refresh=false` can skip re-reading thousands of objects.
4. **Detecting deletions.** If a resource block disappears from config, state is the only record that something must be destroyed.

:::info Why CloudFormation has no state file
CloudFormation and Pulumi still have state; it's just held by the service (the "stack"). Terraform makes state an explicit artifact that you store and protect yourself, or delegate to a backend like S3 or HCP Terraform.
:::

## What's inside a state file

State is JSON. Look but don't edit by hand:

```json
{
  "version": 4,
  "terraform_version": "1.16.5",
  "serial": 7,
  "lineage": "6f0b1c1e-8a52-2f8e-9c6d-5b2f7d1e0a44",
  "outputs": {
    "url": { "value": "http://localhost:8080", "type": "string" }
  },
  "resources": [
    {
      "mode": "managed",
      "type": "docker_container",
      "name": "web",
      "provider": "provider[\"registry.terraform.io/kreuzwerker/docker\"]",
      "instances": [
        {
          "schema_version": 2,
          "attributes": {
            "id": "3f1c9a...",
            "name": "tf-web",
            "image": "sha256:aa11...",
            "env": ["POSTGRES_PASSWORD=hunter2"]
          },
          "sensitive_attributes": [],
          "dependencies": ["docker_image.nginx"]
        }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `serial` | Increments on every state write. Used to detect stale copies. |
| `lineage` | UUID assigned when the state was first created. Two files with different lineages are unrelated; Terraform refuses to push one over the other. |
| `resources[].mode` | `managed` (resource) or `data` (data source). |
| `instances` | One per instance: several with `count`/`for_each`, each with `index_key`. |
| `attributes` | Everything the provider returned, **including secrets in plain text**. |
| `dependencies` | Recorded edges, used to destroy in the right order. |

:::warning State contains secrets
Database passwords, private keys from `tls_private_key`, `random_password` results, environment variables with tokens: all are stored in state in plain text, even if marked `sensitive`. Rules:

- Never commit state to Git.
- Store it in a backend with **encryption at rest** and **tight access control** (only CI and a few admins can read the production state).
- Turn on **versioning** for the bucket so you can recover.
- Prefer designs where secrets never enter state: let AWS generate and manage a database password (`manage_master_user_password` on RDS), read secrets at runtime in the app, or use ephemeral values and write-only arguments where providers support them.
:::

## Refresh and drift

**Drift** is any difference between the real world and state, caused by changes outside Terraform: a hotfix in the console, an autoscaler, `docker update` by hand.

During every `plan` (and `apply`), Terraform first **refreshes**: it asks providers to read each object in state and updates its in-memory view. Then it diffs config against that refreshed view.

```text
  config  ---- desired ----+
                           |  diff  --> plan
  real world --refresh--> state'
```

When drift appears in a plan you have two choices:

| Choice | How | When |
| --- | --- | --- |
| **Revert** the manual change | Just `terraform apply`; Terraform puts things back as the config says | The manual change was a mistake or a temporary hack |
| **Accept** the manual change | Update the config to match, then run `terraform apply -refresh-only` (or simply a normal apply once config matches) | The manual change was right and should be permanent |

`terraform plan -refresh-only` shows only what changed in the real world, without proposing any changes to infrastructure. `terraform apply -refresh-only` writes those observed values into state. It replaced the old `terraform refresh` command, which did the same without asking for confirmation.

```bash
terraform plan -refresh-only     # "Objects have changed outside of Terraform" ...
terraform apply -refresh-only    # accept the observed values into state
```

:::warning -refresh-only does not change your config
After accepting drift into state, if your `.tf` files still say the old value, the **next normal plan** will propose changing it back. Always update the code too, or you've just postponed the revert.
:::

`-refresh=false` does the opposite: skip refresh and trust state. It speeds up plans on huge configs but hides drift; use it rarely and knowingly.

## Backends: where state lives

A **backend** determines where state is stored and whether it can be locked.

- **local** (default): `terraform.tfstate` in the working directory, plus `terraform.tfstate.backup` (the previous version). Fine for learning and personal experiments. Terrible for teams: no sharing, no locking, lost with your laptop.
- **Remote backends**: `s3`, `gcs`, `azurerm`, `pg` (Postgres), `kubernetes`, `http`, `consul`, and the `cloud` block for HCP Terraform. The team shares one state, and the backend provides locking.

### S3 backend (the AWS default)

```hcl
terraform {
  backend "s3" {
    bucket       = "acme-terraform-state"
    key          = "shipit/prod/network/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true            # SSE for the state and lock objects
    kms_key_id   = "arn:aws:kms:eu-central-1:111122223333:key/..." # optional: SSE-KMS with your key
    use_lockfile = true            # native S3 locking
  }
}
```

- **`use_lockfile = true`** enables **S3-native locking**: Terraform creates a `<key>.tflock` object next to the state using an S3 conditional write (`If-None-Match`), which fails if the lock object already exists. It was introduced as experimental in Terraform 1.10, became generally available in 1.11, and is now the recommended approach.
- **`dynamodb_table`** (the old way, a DynamoDB table holding lock items) is **deprecated** and will be removed in a future version. When migrating, you can set both `use_lockfile = true` and `dynamodb_table` for a transition period, then drop DynamoDB.
- The bucket itself is **not** created by the backend. You create it once (by hand, a small bootstrap Terraform config with local state, or CloudFormation), with **versioning on**, **public access blocked**, **encryption** on and a restrictive bucket policy.
- The IAM principal needs `s3:ListBucket` on the bucket, `s3:GetObject`/`s3:PutObject` on the state key, and `s3:GetObject`/`s3:PutObject`/`s3:DeleteObject` on the `.tflock` key.

:::tip One state per component and environment
Use the key to separate states: `shipit/<env>/<component>/terraform.tfstate`, e.g. `shipit/prod/network`, `shipit/prod/database`, `shipit/prod/app`. Small states mean faster plans, smaller blast radius and fewer people blocked by a lock.
:::

### Partial configuration

Backend blocks **cannot use variables** (the backend must be known before variables are evaluated). To avoid hard-coding per-environment values, leave them out and pass them at init:

```hcl
# backend.tf
terraform {
  backend "s3" {}
}
```

```hcl
# env/prod.s3.tfbackend
bucket       = "acme-terraform-state"
key          = "shipit/prod/app/terraform.tfstate"
region       = "eu-central-1"
encrypt      = true
use_lockfile = true
```

```bash
terraform init -backend-config=env/prod.s3.tfbackend
```

### Changing or migrating backends

When you add or change a backend block, `terraform init` notices and asks what to do:

```bash
terraform init -migrate-state   # copy existing state into the new backend
terraform init -reconfigure     # use the new backend config, ignore existing state (no copy)
```

Use `-migrate-state` when moving from local to S3. Use `-reconfigure` when you just switched which environment's backend config you're pointing at and don't want anything copied.

### HCP Terraform

HCP Terraform (formerly Terraform Cloud) is HashiCorp's managed service. Instead of a `backend` block you use a `cloud` block:

```hcl
terraform {
  cloud {
    organization = "acme"
    workspaces {
      name = "shipit-prod-app"
    }
  }
}
```

It stores and locks state, keeps state history, runs plans/applies remotely, integrates with VCS for PR plans, and adds policy checks (Sentinel/OPA), private registry and RBAC. There's a free tier with limits; paid tiers are priced per managed resource. Alternatives with similar features: Spacelift, env0, Scalr, Atlantis (self-hosted, open source) and plain CI pipelines with an S3 backend.

:::deep Workspaces: CLI workspaces vs HCP workspaces
`terraform workspace new staging` creates another **named state** for the same configuration and backend. With S3 the non-default workspace states live under `env:/<workspace>/<key>`, and `terraform.workspace` is available in expressions.

CLI workspaces look like an easy way to do dev/staging/prod, but most teams avoid them for environments: every environment shares the same code and backend credentials, it's easy to apply in the wrong workspace (the current workspace is invisible in the code), and environments can't differ structurally. Separate directories (or separate `.tfbackend` files) per environment are more explicit. Workspaces are fine for short-lived copies, such as one stack per feature branch.

HCP Terraform "workspaces" are a different concept: each one is a separate state with its own variables, permissions and run history, closer to "one root module instance".
:::

## State locking

Two people running `apply` on the same state at once would corrupt it: both read serial 7, both write serial 8 with different content. Backends that support **locking** prevent this. Terraform acquires the lock before any operation that might write state (`plan`, `apply`, `destroy`, `state mv`, `import`, `console`...) and releases it afterwards.

```text
Error: Error acquiring the state lock

Error message: operation error S3: PutObject, https response error StatusCode: 412,
  ... PreconditionFailed
Lock Info:
  ID:        5d6c3c55-0b0a-7d4e-2b8a-8f3c1b2a9e10
  Path:      acme-terraform-state/shipit/prod/app/terraform.tfstate
  Operation: OperationTypeApply
  Who:       roma@MacBook-Pro.local
  Version:   1.16.5
  Created:   2026-10-03 09:12:44 UTC
```

- If someone else really is running, **wait**. `-lock-timeout=5m` makes Terraform retry for a while instead of failing immediately (useful in CI).
- If the process that held the lock **crashed** (laptop closed mid-apply, CI job killed), the lock stays. After confirming nobody is running, release it with the ID from the message:

```bash
terraform force-unlock 5d6c3c55-0b0a-7d4e-2b8a-8f3c1b2a9e10
```

:::warning Never use -lock=false to "get past" a lock
`-lock=false` disables locking for that run. If another apply really is in progress you can corrupt state. Investigate who holds the lock first.
:::

## The state commands

| Command | What it does |
| --- | --- |
| `terraform state list` | All resource addresses in state (filter: `terraform state list module.app`) |
| `terraform state show ADDR` | All attributes of one resource |
| `terraform state mv SRC DST` | Change the address of an object in state (rename, move into a module) without touching infrastructure |
| `terraform state rm ADDR` | Forget an object: remove it from state, **leave it running** |
| `terraform state pull` | Print the current remote state as JSON (good for backups: `terraform state pull > backup.tfstate`) |
| `terraform state push FILE` | Overwrite remote state with a local file (checks lineage/serial; `-force` skips the checks; dangerous) |
| `terraform force-unlock ID` | Remove a stale lock |

All of them create a backup of the previous state when using the local backend. With a remote backend, bucket versioning is your backup.

## Config-driven refactoring: moved, import, removed

Since Terraform 1.1–1.7, the recommended way to change state is **in code**, using blocks that are reviewed in a PR and applied by the normal plan/apply flow. The imperative `state mv`, `state rm` and `terraform import` commands still exist and are fine for one-off local fixes, but they bypass review and are easy to get wrong across environments.

### moved: renaming without destroying

If you rename `docker_container.web` to `docker_container.frontend`, Terraform sees one resource removed and one added, and plans **destroy + create**. A `moved` block tells it they're the same object:

```hcl
resource "docker_container" "frontend" {  # was "web"
  name  = "tf-web"
  image = docker_image.nginx.image_id
}

moved {
  from = docker_container.web
  to   = docker_container.frontend
}
```

Plan now shows: `# docker_container.web has moved to docker_container.frontend` and `0 to add, 0 to change, 0 to destroy`.

`moved` works for: renaming resources, moving resources into or out of modules (`to = module.web.docker_container.this`), renaming modules, and switching to `count`/`for_each` (`from = docker_container.web`, `to = docker_container.web["frontend"]`).

Keep `moved` blocks in the code at least until every environment/state has applied them. In shared modules, keep them indefinitely: removing one is a breaking change for anyone still on an old version.

### import: adopting existing infrastructure

Real life: production was clicked together before IaC, or someone created a resource by hand during an incident. You want Terraform to manage it **without recreating it**.

```hcl
import {
  to = docker_container.legacy_redis
  id = "8d7e5c0f4b0a..."   # the provider-specific ID (container ID here; for AWS e.g. a bucket name or instance ID)
}

resource "docker_container" "legacy_redis" {
  name  = "legacy-redis"
  image = docker_image.redis.image_id
  # ... must match the real object
}
```

`terraform plan` shows `# docker_container.legacy_redis will be imported` and any differences between your config and the real object. `terraform apply` records it in state. After that, you can delete the `import` block (it's idempotent, so leaving it is harmless, but it's noise).

Writing the resource block by hand is the hard part. Terraform can draft it:

```bash
# with only the import block present (no resource block yet):
terraform plan -generate-config-out=generated.tf
```

This writes `generated.tf` with every attribute the provider reports. The feature is still labelled **experimental**, and the output is a starting point: it includes computed and default values you should delete, and sometimes conflicting attributes you must fix before the plan succeeds. Clean it up until the plan says `1 to import, 0 to add, 0 to change, 0 to destroy`.

Notes:

- How to find the import ID is documented at the bottom of each resource's page in the registry ("Import" section).
- Import blocks support `for_each` (1.7+) to import many similar objects, and work inside modules (1.16+). Recent providers also support importing by **identity** (an `identity = { ... }` object instead of `id`) where the provider defines one.
- The old CLI form is `terraform import docker_container.legacy_redis <id>`. It writes to state immediately without a plan, so prefer the block.

### removed: stop managing without destroying

Sometimes you want Terraform to **forget** a resource (it's being handed to another team's config, or should live outside IaC) but not delete it. Deleting the resource block would destroy it. Use `removed` (1.7+):

```hcl
removed {
  from = docker_container.legacy_redis

  lifecycle {
    destroy = false   # forget it, keep the real object
  }
}
```

Plan shows `# docker_container.legacy_redis will no longer be managed by Terraform`. With `destroy = true` the object is destroyed, which is equivalent to just deleting the block but more explicit. The CLI equivalent is `terraform state rm`.

Terraform 1.16 also accepts `destroy = false` inside a normal resource's `lifecycle` block, so that when Terraform would destroy that resource it removes it from state instead. It's new; check the `lifecycle` reference for your version before relying on it, and prefer the explicit `removed` block for one-off hand-overs.

## -replace: forcing recreation

Sometimes an object is broken in a way Terraform can't see (a container stuck in a bad state, a VM with a corrupted disk). Force a replacement:

```bash
terraform plan  -replace=docker_container.web
terraform apply -replace=docker_container.web
```

This replaced the old `terraform taint` command, which marked a resource in state for replacement on the next apply without showing you a plan. Terraform also marks a resource **tainted** automatically when its creation partially failed; the next apply replaces it.

## Recovering from mistakes

| Situation | Symptom | Fix |
| --- | --- | --- |
| Accidental `state rm` (or lost a resource from state) | Plan wants to **create** something that already exists; apply fails with "already exists"/name conflict | `import` block (or `terraform import`) to re-adopt it |
| Renamed a resource and applied without `moved` | Object was destroyed and recreated | Too late for that object; next time read the plan. For stateful things, restore from backup |
| Renamed but haven't applied yet | Plan shows destroy + create | Add a `moved` block |
| Stale lock after a crash | `Error acquiring the state lock` | Confirm nobody is running, then `terraform force-unlock <ID>` |
| Bad state written (wrong apply, bad `state push`) | Plan wants to destroy/recreate lots | Restore a previous version: local `terraform.tfstate.backup`, or the previous object version from the versioned bucket, then `terraform state push` |
| Someone edited state JSON by hand | Errors parsing state, odd plans | Restore from version history; never hand-edit |
| Drift from a hotfix | Plan wants to revert a manual change | Decide: revert (apply) or accept (update code + `apply -refresh-only`) |

:::tip Before any risky state operation
1. `terraform state pull > before-$(date +%s).tfstate` (an extra local backup, then keep it somewhere safe since it contains secrets).
2. Do the change via `moved`/`import`/`removed` in code where possible.
3. Run `terraform plan` and make sure it says what you expect, usually "0 to add, 0 to change, 0 to destroy" for pure refactors.
:::

## Practising remote state for free

Amazon S3 is cheap, but you don't need an AWS account to learn the S3 backend. Any **S3-compatible** server works for practice. The labs use **Silo**, a maintained community fork of MinIO (MinIO stopped publishing free community images in 2025, and `minio/minio` is no longer on Docker Hub). The backend needs a few extra settings to talk to a non-AWS endpoint:

```hcl
terraform {
  backend "s3" {
    bucket       = "tfstate"
    key          = "labs/m03/terraform.tfstate"
    region       = "us-east-1"          # any valid region string; MinIO-compatible servers ignore it
    use_lockfile = true

    endpoints = {
      s3 = "http://localhost:9000"
    }
    use_path_style              = true  # http://host/bucket/key instead of http://bucket.host/key
    skip_credentials_validation = true  # don't call AWS STS
    skip_requesting_account_id  = true  # don't call STS/IAM for the account ID
    skip_metadata_api_check     = true  # don't look for EC2 instance credentials
    skip_region_validation      = true
  }
}
```

Credentials come from the usual AWS sources; the simplest is `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` env vars.

:::info S3-compatible is "best effort"
HashiCorp only tests the S3 backend against Amazon S3. Most S3-compatible servers work, but features such as SSE (`encrypt = true` requires the server to have a KMS configured) or newer checksum headers can behave differently. If uploads fail with a checksum error, add `skip_s3_checksum = true`. In real AWS you would keep `encrypt = true` and never need the `skip_*` options.
:::

:::try Count your secrets
In any lab folder from module 02 that used `random_password`, run `terraform state pull | jq '.. | .result? // empty'`. Every string printed is a secret that anyone with read access to state can see.
:::

## Production checklist

- Remote backend with locking from day one (`use_lockfile = true` on S3; DynamoDB only for legacy setups).
- State bucket: versioning on, public access blocked, encryption (SSE-KMS for sensitive environments), access logging, a lifecycle rule for old versions, and a policy restricting who can read prod state.
- Separate state per environment and component; separate AWS accounts per environment where possible.
- Applies run from CI with a dedicated role; humans rarely need write access to prod state.
- Refactor with `moved`, adopt with `import` blocks, retire with `removed`, all reviewed in PRs.
- Detect drift on a schedule (`terraform plan -detailed-exitcode` returns 2 when there are changes) and alert.

## Summary

- State maps config addresses to real object IDs, records dependencies and holds attributes, including secrets in plain text.
- Refresh detects drift; revert it with apply or accept it with config changes plus `-refresh-only`.
- Use a remote backend with locking. S3: `use_lockfile = true` (native, 1.10+); DynamoDB locking is deprecated.
- Backend blocks can't use variables; use partial config (`-backend-config`) and `init -migrate-state`/`-reconfigure`.
- Change state through code: `moved` (rename), `import` (adopt, with `-generate-config-out` for a draft), `removed` (forget). Use `state` subcommands for one-off fixes.
- `-replace` forces recreation; `force-unlock` clears stale locks; versioned buckets plus `state push` recover bad state.
