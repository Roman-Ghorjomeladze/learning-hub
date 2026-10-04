This capstone pulls the whole Terraform track together into one project you could show in an interview: a small but realistic "platform" built **entirely from code**, with two environments, remote state, reusable modules, tests and CI. It runs on your Mac for free. An optional stretch goal takes the same ideas to AWS with cost guard rails.

This page is the brief: what to build, how it fits together, how to know you are done, and how to grade yourself. The labs are the milestones, each with a full reference solution. Try each milestone yourself first; open the solution when you are stuck or to compare.

## The brief

You are the first platform engineer at a small company. The product team has `shipit-api` (Node.js + TypeScript, PostgreSQL, Redis, port 3000, `/healthz`, `/readyz`, `/items`). They want:

- a **dev** and a **prod** environment that are built the same way and differ only in size and settings;
- everything reproducible from an empty laptop with a handful of commands, and destroyable just as easily;
- changes reviewed through pull requests with automated checks;
- a path to the cloud later, without rewriting everything.

Your constraints: Terraform only for infrastructure (no click-ops, no hand-run `kubectl apply` for platform pieces), no paid services, state not kept on a laptop disk in `terraform.tfstate` files, and no secrets committed to Git.

## Architecture

```text
                    ┌───────────────────────────── your Mac ─────────────────────────────┐
                    │                                                                     │
  curl :8080 ───────┼──▶ kind "shipit-dev"  (1 node)          curl :8081 ──▶ kind "shipit-prod" (1 cp + 1 worker)
                    │      NodePort 30080                                     NodePort 30080
                    │        │                                                   │
                    │      Traefik (Gateway API controller, helm)              Traefik x2
                    │        │ Gateway "traefik-gateway"                         │
                    │      HTTPRoute (from the shipit chart)                  HTTPRoute
                    │        │                                                   │
                    │      shipit-api x1 ─▶ postgres (emptyDir), redis       shipit-api x2 ─▶ postgres (PVC), redis
                    │                                                                     │
                    │   S3-compatible state store (container, :9000)                      │
                    │     bucket "tfstate":  dev/cluster.tfstate  dev/platform.tfstate  dev/app.tfstate
                    │                        prod/cluster.tfstate prod/platform.tfstate prod/app.tfstate
                    └─────────────────────────────────────────────────────────────────────┘
```

### Stacks and data flow

Three stacks, applied in order, each with its own state per environment. This is the layered model from the Kubernetes module, and it is what keeps every `plan` working from an empty state (no two-phase problem).

```text
 stacks/cluster   ──outputs: endpoint, CA, client cert/key, http_url──▶  stacks/platform
   module kind-cluster                                                    module platform
                                                                            namespaces, Gateway API CRDs, Traefik
                                                    outputs: gateway name/namespace, app namespace
                                                                                 │
 stacks/cluster ──────────────── outputs ─────────────────────────────▶  stacks/app ◀─┘
                                                                           module app
                                                                             helm_release: charts/shipit
```

Stacks read each other's outputs with `terraform_remote_state` from the same S3-compatible bucket.

### Repository layout

```text
platform-capstone/
  bootstrap/compose.yaml        # the state store itself (bootstrapped outside Terraform)
  env.sh                        # exports state-store credentials for your shell (not committed)
  tf.sh                         # wrapper: ./tf.sh <env> <stack> <init|plan|apply|destroy|...>
  modules/
    kind-cluster/               # kind_cluster with port mapping and N workers
    platform/                   # namespaces, Gateway API CRDs, Traefik
    app/                        # helm_release of the shipit chart
    */tests/*.tftest.hcl        # unit tests with mocks
  stacks/
    cluster/  platform/  app/   # thin root modules: backend "s3" {}, providers, one module call
  envs/
    dev/   cluster.tfvars  platform.tfvars  app.tfvars  cluster.s3.tfbackend  platform.s3.tfbackend  app.s3.tfbackend
    prod/  (same files, different values)
  charts/shipit/                # Helm chart: api, postgres, redis, HTTPRoute
  app/shipit-api/               # Node.js 22 + TypeScript source and Dockerfile
  .github/workflows/ci.yml
  .pre-commit-config.yaml  .tflint.hcl  .gitignore
```

### Key design decisions (and why)

| Decision | Why | Trade-off you accept |
| --- | --- | --- |
| Separate stacks for cluster, platform and app | Plans always work from scratch; small blast radius; mirrors cloud setups (EKS stack vs add-ons vs apps) | Three applies instead of one; outputs passed via remote state |
| One directory per stack, per-env `*.tfvars` + `*.s3.tfbackend` | Envs differ only in values; no copy-paste of stack code | Must never mix dev backend with prod vars: the `tf.sh` wrapper pairs them and uses a separate `TF_DATA_DIR` per env |
| S3 backend against a local S3-compatible store | Same backend type you will use on AWS, with real locking (`use_lockfile`) | One more container to run; it must exist before any `init` |
| The state store is bootstrapped with Docker Compose, not Terraform | Chicken-and-egg: the store holding state cannot depend on that state | One manual step, documented |
| Gateway API + Traefik instead of Ingress | Ingress-NGINX is retired; Gateway API is the current standard | CRDs must be installed separately and first |
| App deployed with a Helm chart via `helm_release` | Chart is reusable by Argo CD later; HTTPRoute inside the chart avoids plan-time CRD lookups | Terraform sees release inputs, not every object inside it |
| Postgres and Redis inside the chart | Free and self-contained for local environments | Not production-grade; on AWS you would use RDS and ElastiCache |

:::warning About MinIO in 2026
The classic local S3-compatible store for this setup was **MinIO**. MinIO stopped publishing community images in October 2025, archived the community repository in April 2026, and removed its images from Docker Hub in September 2026. The labs therefore use **Silo** (`pgsty/silo`), a maintained fork that keeps MinIO's commands, environment variables and `mc` client, exactly as in the state & backends module. Any S3-compatible server that supports conditional writes works with the same backend settings (SeaweedFS and Garage are alternatives); verify locking with the test in Milestone 1.
:::

:::info The cloud equivalent
Swap kind for EKS (`terraform-aws-modules/eks`), the local bucket for a real S3 bucket with versioning and encryption, Traefik's NodePort for an AWS load balancer, in-chart Postgres/Redis for RDS/ElastiCache, and `tf.sh` for a CI pipeline with OIDC roles. The stack boundaries, module interfaces and tests stay the same. That is the point of the exercise.
:::

## Milestones

| # | Milestone | You will have |
| --- | --- | --- |
| 0 | Bootstrap | Repo skeleton, state store running, `tfstate` bucket with versioning, `tf.sh` wrapper |
| 1 | Cluster stack | `kind-cluster` module; dev and prod clusters; state in the bucket; locking verified (and a stale lock fixed) |
| 2 | Platform stack | Namespaces, Gateway API CRDs, Traefik per environment |
| 3 | App stack | shipit image built and loaded, Helm chart, `app` module; `curl` works on :8080 (dev) and :8081 (prod) |
| 4 | Quality gate | Unit tests for all three modules, pre-commit, CI workflow |
| 5 | Stretch (optional, paid) | AWS: VPC + ECS Fargate for shipit-api with cost guard rails |

Plan on a few evenings. Milestones 0–3 are the core; 4 makes it professional; 5 is optional.

## Acceptance criteria

The capstone is done when **all** of these are true. Each has a command you can run.

**Reproducibility**

1. From a fresh clone (with the state store running and `env.sh` sourced), these commands build dev end to end with no manual edits and no `-target`:

```bash
./tf.sh dev cluster init  && ./tf.sh dev cluster apply
./tf.sh dev platform init && ./tf.sh dev platform apply
./tf.sh dev app init      && ./tf.sh dev app apply
```

2. The same with `prod` builds prod; both environments run at the same time.
3. Running `plan` on any stack right after `apply` shows **No changes**.
4. Destroying in reverse order (`app`, `platform`, `cluster`) removes everything; `kind get clusters` is empty afterwards.

**Functionality**

5. `curl -s localhost:8080/healthz` returns `ok`; `curl -s localhost:8080/readyz` returns `ready`.
6. `curl -s -X POST localhost:8080/items -H 'content-type: application/json' -d '{"name":"first"}'` returns `201`, and `GET /items` lists it; a second `GET` within 30 seconds returns header `x-cache: hit`.
7. Prod runs 2 API replicas and 2 Traefik replicas; dev runs 1 of each. In prod, items survive deleting the Postgres pod (PVC); in dev they do not (emptyDir).

**State and structure**

8. No `terraform.tfstate` files exist in the repository folders; the bucket contains six state objects (three per environment).
9. Two concurrent `apply`/`plan` runs on the same stack and environment cannot both acquire the lock.
10. Stacks contain only providers, backend, variables, remote-state lookups, one or two module calls and outputs. All resources live in modules.
11. Every module input has a `type` and `description`; inputs with a limited range have `validation` blocks.
12. Provider and chart versions are pinned; `.terraform.lock.hcl` files are committed with hashes for `darwin_arm64` and `linux_amd64`.

**Quality**

13. `terraform test` passes in every module without network access to a cluster (mocks and overrides).
14. `terraform fmt -check -recursive`, `terraform validate`, TFLint and Trivy (HIGH/CRITICAL) pass locally via pre-commit and in CI.
15. CI runs on every pull request and blocks merging when any check fails.
16. No secrets in Git: the Postgres password is generated by Terraform and passed with `set_sensitive`; `env.sh` and `*.tfstate*` are git-ignored.

**Documentation**

17. A `README.md` explains prerequisites, the bootstrap step, the apply/destroy order, and one paragraph on how this design maps to AWS.

## Self-assessment rubric

Score each row 0–3. A total of 24+ out of 30 is a strong portfolio piece; below 15, revisit the relevant modules.

| Area | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| **Reproducibility** | Needs manual steps or `-target` | Works for dev only | Dev and prod from scratch | Plus clean destroy and zero-diff re-plan everywhere |
| **Stack design** | One big state | Stacks exist but share resources | Clean cluster/platform/app split | Plus clear outputs contract and documented ownership |
| **Modules** | Resources in root modules | Modules without types/descriptions | Typed, described, validated inputs | Plus sensible defaults, outputs and README per module |
| **State** | Local state | Remote state, no locking | Remote state with locking, per-env keys | Plus versioned bucket and verified lock behaviour |
| **Environments** | Copy-pasted code per env | Workspaces or ad-hoc flags | Per-env var sets and backends | Plus guard against mixing env backends and vars |
| **Kubernetes integration** | Breaks on fresh apply | Works with manual ordering | Works with proper stack order | Plus CRDs/charts pinned, Gateway API status healthy |
| **Application delivery** | App not deployed | Deployed, not reachable | Reachable, healthy probes | Plus prod/dev differences (replicas, persistence) |
| **Testing** | None | `validate` only | Unit tests for one module | Unit tests for all modules incl. validation failures and overrides |
| **CI & quality** | None | fmt/validate only | Lint, scan, tests in CI | Plus pre-commit, branch protection, pinned actions |
| **Security hygiene** | Secrets in Git or plan output | Secrets in tfvars | Generated secrets, `set_sensitive` | Plus documented state sensitivity and least-privilege notes |

## Tips before you start

- Work milestone by milestone and commit after each. Small, working steps beat a big-bang apply.
- Keep two terminals: one for Terraform, one for `kubectl get pods -A -w` or `docker ps`.
- Resource budget: two kind clusters with Traefik and the app need roughly 4 CPUs and 6–8 GB RAM for your Docker VM. If your Mac struggles, build prod with `workers = 0` or run only one environment at a time.
- When something fails, read the error, then ask "which stack owns this, and did the previous stack finish?" Most problems in this design are ordering problems.
- Destroy what you are not using. Local resources are free, but Docker VM memory is not infinite.

:::try Draw the dependency graph first
Before writing code, sketch on paper which outputs flow from `cluster` to `platform` and `app`, and which values differ between dev and prod. If you can fill a small table with the columns *value*, *owning stack*, *dev* and *prod* (host port, workers, Traefik replicas, API replicas, persistence), the rest is typing. Compare it with the reference after Milestone 3.
:::

:::deep How this maps to interview questions
Expect to be asked: "How do you structure Terraform for multiple environments?", "How do you manage state and locking?", "How would you deploy to Kubernetes with Terraform, and where would you stop?", "How do you test Terraform?", "How does CI authenticate to the cloud?". This project gives you a concrete answer to each, with trade-offs you have felt yourself: per-env var files vs directories, the two-phase problem, mocks vs integration tests, Helm release drift visibility, and the bootstrap problem of the state store. Mention what you would change for production (EKS, real S3 with KMS, OIDC, Argo CD for the app layer) to show you know where the local version stops.
:::

## Summary

- Build three stacks (cluster, platform, app) per environment, each with remote state in an S3-compatible bucket with lockfile locking.
- Put all resources in tested modules; keep root modules thin and environment differences in variable files.
- Deploy Traefik and the app with the helm provider in stacks that plan only after their dependencies exist.
- Prove quality with `terraform test`, linting, scanning and CI.
- Use the acceptance criteria as your checklist and the rubric to judge depth.
