Interview questions on Terraform and infrastructure as code, from junior to senior. Try answering out loud before opening the model answer. Good answers name the mechanism, give a concrete example, and mention the trade-off.

## Fundamentals

### What is infrastructure as code, and why is Terraform declarative?

:::details Model answer
Infrastructure as code means describing infrastructure in version-controlled files and creating it through tooling instead of by hand. You get review, history, repeatability (dev and prod built the same way) and automation.

Terraform is **declarative**: you describe the desired end state ("a bucket with versioning on"), and Terraform computes the steps by comparing desired state (code), recorded state (state file) and real state (refresh). Imperative tools (scripts, Ansible tasks to a degree) describe steps; running them twice can do different things. Declarative configs are idempotent: applying the same code twice changes nothing the second time.
:::

### Walk me through `init`, `plan` and `apply`.

:::details Model answer
- `init` prepares the working directory: downloads providers and modules into `.terraform/`, writes or verifies `.terraform.lock.hcl`, and configures the backend (where state lives).
- `plan` refreshes state from the real world, compares it with the configuration, and shows the actions: create `+`, destroy `-`, update `~`, replace `-/+`. With `-out` it saves the plan.
- `apply` executes a plan (a new one, after confirmation, or a saved one), walking the dependency graph in parallel, and writes the new state.

In CI I run `fmt -check`, `validate`, `plan -out` on PRs and apply the reviewed plan or re-plan on merge.
:::

### What is a provider, and how does Terraform talk to it?

:::details Model answer
A provider is a plugin that maps Terraform resources to an API (AWS, Kubernetes, Docker, GitHub...). Terraform core handles the language, graph and state; providers are separate binaries that core runs as subprocesses and talks to over gRPC. Each provider has a source address (`hashicorp/aws`), a version constraint, and a configuration (region, credentials). The lock file pins the exact versions and hashes so everyone gets the same binary.
:::

### What is the difference between a resource and a data source?

:::details Model answer
A `resource` is managed: Terraform creates, updates and destroys it, and records it in state. A `data` source only **reads** existing information (the latest AMI, the current account ID, a VPC created by another team) and never changes anything. A common junior mistake is expecting a data source to "adopt" an existing object; to manage something that already exists you import it.
:::

### Explain `count` vs `for_each`. When do you choose each?

:::details Model answer
Both create multiple instances. `count` addresses instances by index (`aws_subnet.this[0]`); `for_each` by key from a map or set (`aws_subnet.this["eu-central-1a"]`).

With `count`, removing an item from the middle of a list shifts all later indexes, so Terraform plans to destroy and recreate those resources. `for_each` keys are stable, so only the removed item is destroyed. I use `for_each` for collections of distinct things, and `count` mainly for "zero or one" toggles: `count = var.enable_nat ? 1 : 0`.
:::

### What do `~`, `-/+` and `(known after apply)` mean in a plan?

:::details Model answer
`~` is an in-place update. `-/+` is a replacement: the provider cannot update that attribute, so Terraform destroys and recreates the resource; the plan marks the attribute with `# forces replacement`. For stateful resources (databases, volumes) that is a red flag in review. `(known after apply)` marks computed values (IDs, IPs) that only exist once the resource is created; anything depending on them is also unknown during plan.
:::

## State

### What is Terraform state and why does it exist?

:::details Model answer
State is Terraform's record of which real objects correspond to which resource addresses in your code, plus their last-known attributes. It exists because the mapping cannot be reliably derived from the cloud alone (names aren't unique, many resources don't support tags), and because it makes plans fast and enables dependency ordering on destroy.

Consequences: state is critical (lose it and Terraform no longer knows what it manages) and sensitive (it contains attribute values in plain text, including secrets). It belongs in a remote, encrypted, versioned, access-controlled backend with locking.
:::

### How do you store and lock state on AWS today?

:::details Model answer
An S3 backend with a dedicated bucket: versioning on (to recover from bad writes), encryption (SSE-KMS or SSE-S3), public access blocked, and a bucket policy limiting access to the CI roles and a few admins. Since Terraform 1.10, `use_lockfile = true` gives native locking: Terraform writes a `<key>.tflock` object using S3 conditional writes. The older DynamoDB table locking is deprecated. Keys are organised per environment and component: `prod/network.tfstate`, `prod/services.tfstate`. The state bucket itself is bootstrapped separately (a small stack with local state, or created once by hand) because it cannot depend on itself.
:::

### A colleague's apply crashed and now everyone gets "Error acquiring the state lock". What do you do?

:::details Model answer
Read the lock info (who, when, which operation). Confirm that no Terraform process is still running against that state: check CI runs and ask the person. Only then run `terraform force-unlock <LOCK_ID>`. Then run a plan to see whether the crashed apply left partial changes (some resources created but not recorded is possible; refresh and the plan will show it). I would not use `-lock=false`; concurrent writes can corrupt state. If state is damaged, S3 versioning lets you restore the previous version.
:::

### How do you rename a resource or move it into a module without destroying it?

:::details Model answer
With a `moved` block:

```hcl
moved {
  from = aws_s3_bucket.logs
  to   = module.logging.aws_s3_bucket.this
}
```

The plan then shows a move instead of destroy and create. Unlike `terraform state mv`, it is in code, reviewed in the PR, and applies to every environment and every teammate's state automatically. I keep refactors in their own PR so the expected plan is "0 to add, 0 to change, 0 to destroy".
:::

### How do you bring existing, hand-made infrastructure under Terraform?

:::details Model answer
Write `import` blocks (Terraform 1.5+) with the target address and the provider-specific ID, optionally run `terraform plan -generate-config-out=generated.tf` to draft the resource code, then clean the generated code, plan until it shows only the import and no changes, and apply. For many objects, `import` supports `for_each` (1.7+). The opposite operation, stopping management without destroying, is a `removed` block with `lifecycle { destroy = false }`.
:::

### What is drift and how do you handle it?

:::details Model answer
Drift is when real infrastructure differs from what state/code describe: a console hotfix, another tool, an autoscaler. Terraform sees it on refresh during plan. I detect it with scheduled `terraform plan -detailed-exitcode` (exit 2 = changes) per stack, and alert on it.

Resolution depends on who is right: revert by applying; adopt by changing code; for fields legitimately owned elsewhere (ASG desired count, HPA replicas) use `lifecycle { ignore_changes = [...] }`; to only refresh state without changing infra, `apply -refresh-only`. Long term, reduce drift by removing console write access for humans.
:::

## Language and modules

### What makes a good Terraform module?

:::details Model answer
A clear, small interface: typed variables with descriptions, `validation` for constrained values, sensible defaults, and outputs that consumers need (IDs, ARNs, endpoints). It declares `required_providers` but does not configure providers (callers pass them in). It does one job at the right level of abstraction ("a service with its IAM role and log group", not "one resource wrapper" and not "the whole company"). It is versioned with Git tags or a registry, documented (terraform-docs), and tested (`terraform test`). Breaking changes bump the major version and ship `moved` blocks where possible.
:::

### When would you use a community module like terraform-aws-modules/vpc instead of writing your own?

:::details Model answer
For well-understood building blocks (VPC, EKS, RDS) the community modules are battle-tested and save weeks, so I usually use them, pinned to a major version, often wrapped in a thin internal module that sets company defaults. I read the plan the first time because they create many resources conditionally, and I read changelogs on major upgrades because inputs get renamed (EKS v21 renamed `cluster_name` to `name`). I write my own when requirements are narrow, when I want to understand every resource, or when the module's flexibility makes plans hard to review.
:::

### Explain `lifecycle` options and when you've used them.

:::details Model answer
- `create_before_destroy`: create the replacement first to avoid downtime (needs unique names, e.g. `name_prefix`).
- `prevent_destroy`: plan fails if the resource would be destroyed; I put it on databases and state buckets.
- `ignore_changes`: ignore drift on fields managed elsewhere (desired count, tags added by other systems).
- `replace_triggered_by`: force replacement when another resource or value changes.
- `precondition`/`postcondition`: assert assumptions (the AMI is arm64; the subnet belongs to the VPC) with a clear error message.
:::

### How do you handle secrets in Terraform?

:::details Model answer
Never in code or committed tfvars. Inputs come from a secrets manager or CI secret store, marked `sensitive = true` so they are redacted in output. I remember that state still stores them in plain text, so state access is restricted and encrypted. Better still, avoid passing secrets through Terraform at all: let AWS generate and rotate them (RDS `manage_master_user_password` with Secrets Manager), use write-only arguments (`*_wo`, Terraform 1.11+) and ephemeral values where providers support them, and in Kubernetes use External Secrets rather than Helm values.
:::

## Workflow and teams

### How do you structure Terraform for dev, staging and prod?

:::details Model answer
Shared modules plus a thin root module per environment (and per component), each with its own backend key, often its own AWS account:

```text
modules/network  modules/service
envs/dev/network  envs/dev/services  envs/prod/network  envs/prod/services
```

Environments differ in tfvars values, not in code. Separate states mean a dev mistake cannot touch prod, plans stay small, and permissions can differ (prod applies only from CI). CLI workspaces are fine for short-lived identical copies (per-branch previews), but for long-lived environments the hidden "current workspace" and shared backend config are footguns. Terragrunt is an option when boilerplate across dozens of components becomes painful.
:::

### Workspaces vs directories: what are the trade-offs?

:::details Model answer
Workspaces: one config and backend config, several states; minimal duplication, but the active environment is invisible in the path, all envs share backend settings (hard to put prod in another account), and structural differences turn into conditionals on `terraform.workspace`. Directories: explicit and flexible (different backends, accounts, extra components per env), at the cost of some boilerplate. I default to directories for long-lived environments and use workspaces for ephemeral copies. Note that HCP Terraform "workspaces" are a different concept, closer to directories.
:::

### Describe a good CI/CD pipeline for Terraform.

:::details Model answer
On pull request: `fmt -check`, `validate`, TFLint, Trivy/Checkov, `terraform test`, then `plan` per affected stack, posted as a PR comment, plus optional policy checks (Conftest/Sentinel) and cost estimates (Infracost). Humans review code and plan. On merge: apply, behind a protected environment with required reviewers for prod, with concurrency limits per state. Authentication through OIDC to short-lived cloud roles: a read-only plan role for PRs and an apply role trusted only for the protected environment. To apply exactly what was reviewed, apply the saved plan artifact or require up-to-date branches; tools like Atlantis or HCP Terraform add PR-level locking.
:::

### How does GitHub Actions authenticate to AWS without access keys?

:::details Model answer
The workflow requests an OIDC token from GitHub (`permissions: id-token: write`). AWS trusts GitHub's OIDC provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`) and lets the token assume an IAM role whose trust policy checks the `sub` claim, for example `repo:org/infra:environment:production` or `repo:org/infra:pull_request`. `aws-actions/configure-aws-credentials` exchanges the token for temporary credentials. No secret is stored; credentials expire within an hour; and the trust policy limits which repo, branch or environment can use which role. Avoid wildcards like `repo:org/*`.
:::

### How do you test Terraform code?

:::details Model answer
Layers, cheapest first: `fmt` and `validate`; linting (TFLint) and misconfiguration scanning (Trivy, Checkov); variable validations and pre/postconditions inside the code; `terraform test` unit tests with `mock_provider` and overrides (no credentials, seconds); a few integration tests that apply real resources in a sandbox account and destroy them (`terraform test` with real providers, or Terratest in Go); policy as code on every plan; and `check` blocks for ongoing health. Mocks prove module logic, not that the cloud accepts the config, so integration tests still matter for shared modules.
:::

### What is policy as code and where does it fit?

:::details Model answer
Machine-checked rules evaluated against every plan, owned by platform or security teams: "no public S3 buckets", "only approved instance types", "all resources tagged with CostCenter", "no 0.0.0.0/0 on port 22". Implementations: OPA/Rego via Conftest on `terraform show -json` output (open source, any CI), Sentinel or OPA in HCP Terraform/Enterprise with enforcement levels, or custom checks in Trivy/Checkov. Module tests prove a module does what its author intended; policies enforce organisation rules regardless of who wrote the code.
:::

### How do you upgrade providers and Terraform safely?

:::details Model answer
Pin `required_version` and providers with `~>`, commit the lock file with hashes for every platform (`terraform providers lock -platform=darwin_arm64 -platform=linux_amd64`). Let Dependabot/Renovate open upgrade PRs; read changelogs and upgrade guides for majors (AWS v5 → v6, helm provider v2 → v3 changed blocks to attributes). Run tests and plans in dev first, roll through environments one stack at a time, and expect "no changes" plans unless the upgrade intentionally changes behaviour. For the CLI, keep everyone and CI on the same version (`.terraform-version`, tfenv/mise), because newer CLIs can write state older ones refuse to read.
:::

## Senior and architecture

### How do you limit blast radius in a large Terraform estate?

:::details Model answer
Split state by environment, account and component (network, data, compute, IAM), so each plan touches a small, well-understood set of resources and each pipeline has only the permissions it needs. Use separate AWS accounts per environment (AWS Organizations), `prevent_destroy` and cloud deletion protection on stateful resources, read-only defaults for humans with an audited break-glass role, code owners on prod paths, and small PRs. Pass data between stacks via outputs/data sources rather than one giant state. Watch for the opposite failure too: hundreds of tiny states with tangled remote-state dependencies; group by lifecycle and ownership.
:::

### Where would you draw the line between Terraform and Kubernetes GitOps tools?

:::details Model answer
Terraform owns slow-changing infrastructure: VPC, the cluster (EKS), node groups, IAM roles for workloads (IRSA/Pod Identity), DNS, databases, and a minimal bootstrap of the platform, typically the gateway controller and Argo CD itself plus a root Application. Argo CD (or Flux) owns application delivery and often the faster-moving add-ons: continuous reconciliation, self-healing, PR-equals-deploy, no cluster credentials in CI. The rule is that one tool owns each object. I also never create a cluster and configure the kubernetes/helm providers from it in the same state (the two-phase problem): cluster, platform and apps are separate stacks.
:::

### Explain the "two-phase" or provider-dependency problem with Kubernetes and Terraform.

:::details Model answer
Terraform configures providers before planning resources. If the kubernetes or helm provider takes its host and credentials from a cluster resource in the same configuration, those values are unknown on the first plan, so resources that need the API at plan time (`kubernetes_manifest`, data sources) fail, and later cluster replacements leave the providers pointing at the old cluster during plan. The same happens with CRDs and custom resources in one stack. The fix is separate stacks applied in order (cluster → platform with CRDs → workloads), reading outputs via remote state or data sources. `-target` is a one-off workaround, not a workflow.
:::

### Your team wants Terraform to deploy application releases ten times a day. What do you advise?

:::details Model answer
I'd separate concerns. Terraform is designed for reviewed, relatively infrequent changes, and every apply refreshes and locks the whole state, so frequent releases make plans noisy and create lock contention and risk to unrelated infrastructure. For Kubernetes, use GitOps (Argo CD) with image tag bumps via PR or automated image updaters. For ECS, let CI register task definitions and update services (or use CodeDeploy), with Terraform managing the service but ignoring the task definition revision (`ignore_changes = [task_definition]`) or reading the image tag from a parameter. Terraform still owns the service's infrastructure: IAM, networking, load balancer, scaling policies.
:::

### How would you design the bootstrap of a new AWS environment from zero?

:::details Model answer
1. Account vending: create the account under AWS Organizations (Control Tower/Account Factory or Terraform), apply SCPs and a budget with alerts.
2. Bootstrap stack with local state (kept briefly) or run once from an admin session: state bucket with versioning, encryption, public access block and a restrictive policy; GitHub OIDC provider; plan/apply IAM roles. Then migrate this stack's own state into the bucket (`init -migrate-state`).
3. Network stack: VPC, subnets, endpoints/NAT, DNS.
4. Shared services: KMS keys, logging, ECR.
5. Platform: EKS or ECS cluster; then add-ons (gateway controller, Argo CD).
6. Data: RDS/ElastiCache with deletion protection.
7. Apps: via GitOps or service pipelines.

Each layer is its own state, applied by CI in order, all from code, with tests and policy checks in PRs. This is the same shape as a local kind-based platform: only the providers change.
:::

### What are the risks of `terraform_remote_state`, and what alternatives exist?

:::details Model answer
`terraform_remote_state` requires read access to the producer's **entire** state, which may contain secrets, and it couples consumers to the producer's backend layout and output names. Alternatives: publish values to SSM Parameter Store or Secrets Manager from the producer and read them with data sources; look up resources directly with data sources and naming/tagging conventions (`data "aws_vpc" "main" { tags = { Name = "prod" } }`); or, in HCP Terraform, use the `tfe_outputs` data source with scoped access. Whatever you use, treat outputs as a contract and version changes to them.
:::

### Terraform vs OpenTofu vs Pulumi vs CloudFormation/CDK: how do you choose?

:::details Model answer
- **Terraform**: largest provider ecosystem, multi-cloud and SaaS, HCL, mature tooling; BSL licence since 2023, with HCP Terraform as the commercial platform.
- **OpenTofu**: Linux Foundation fork of Terraform under MPL, compatible for most configs, adds features like state encryption; a good choice when licensing matters.
- **Pulumi**: real programming languages (TypeScript, Python, Go), strong for teams who want loops, abstractions and tests in a general-purpose language; state managed by Pulumi Cloud or self-hosted backends.
- **CloudFormation/CDK**: AWS-native, no state file to manage, deep AWS integration, but AWS-only and slower to support some features; CDK gives TypeScript on top of CloudFormation.

As a TypeScript engineer I'd be comfortable with CDK or Pulumi, but for a multi-provider platform (AWS + Kubernetes + GitHub + Cloudflare) with a hiring market that knows HCL, Terraform/OpenTofu is usually the pragmatic default.
:::
