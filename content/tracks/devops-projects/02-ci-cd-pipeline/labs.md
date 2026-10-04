These labs extend the `shipit` repository from Project 1. You need it on GitHub (public is simplest: free environment approvals, free arm64 runners, anonymous pulls), with the Milestone 1 to 8 code committed, and the GHCR package `shipit-api` set to public.

```bash
brew install gh actionlint act pinact   # pinact is optional (Lab 3)
cd ~/code/shipit && git status          # clean, on main, pushed
gh auth status
mkdir -p .github/workflows
```

Lint every workflow before you push; it saves many red runs:

```bash
actionlint
```

:::tip Work through pull requests
From Lab 1 on, make every change on a branch and open a PR (`gh pr create --fill`). You will see the PR-only behaviour (no pushes, no deploys) and, after enabling branch protection, the required checks.
:::

## Lab 1: Pull-request checks for the app

:::meta
difficulty: easy
time: 30 min
:::

Goal: every PR that touches `app/` is linted, type-checked and tested in under two minutes, and merging requires a green check.

### Steps

1. Create `.github/workflows/app.yml` with only the first job for now:

```yaml
name: app

on:
  pull_request:
    paths:
      - "app/**"
      - ".github/workflows/app.yml"
  push:
    branches: [main]
    tags: ["v*.*.*"]
    paths:
      - "app/**"
      - ".github/workflows/app.yml"
  workflow_dispatch:

concurrency:
  group: app-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

jobs:
  check:
    name: lint & test
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: app
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: app/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
```

2. Push it on a branch together with a trivial app change (so the path filter matches), and open a PR:

```bash
git switch -c ci/app-checks
echo "// ci" >> app/src/config.ts
actionlint && git add . && git commit -m "ci: app checks" && git push -u origin HEAD
gh pr create --fill
gh pr checks --watch
```

3. Protect `main`: Settings → Rules → Rulesets → New branch ruleset, target the default branch, enable "Require a pull request before merging" and "Require status checks to pass", and add the check **lint & test**. (Classic branch protection rules work too.)

4. Prove the gate works: push a commit to the PR that breaks a test (for example change the expected status in the `/healthz` test to 201), watch the check fail and the merge button get blocked, then revert it.

### Verify

- The PR shows a **lint & test** check that passes in roughly a minute; the second run is faster because the npm cache is restored (`Cache restored from key: ...` in the setup-node step).
- A PR that changes only `README.md` does not run the workflow at all.
- With the failing test, the PR cannot be merged.

:::hint
If the job fails at `setup-node` with "Dependencies lock file is not found", `cache-dependency-path` does not point at `app/package-lock.json` or the lock file is not committed. If the workflow does not start, check the path filter: the workflow file itself is in the list, so editing it always triggers a run.
:::

:::solution
The YAML in step 1 is the complete solution. Points to be able to explain:

- `paths` filters keep unrelated PRs fast and cheap. They apply to branch pushes and PRs; tag pushes ignore them.
- `cancel-in-progress` only for PRs: pushing three commits quickly to a PR cancels the two stale runs, but a run on `main` (which will deploy in Lab 5) is never cancelled halfway.
- Top-level `permissions: contents: read` overrides whatever default the repository or organisation grants the `GITHUB_TOKEN`. Jobs widen it only when needed.
- `npm ci` (not `npm install`) installs exactly what the lock file says and fails if `package.json` and the lock file disagree.
- The required check is referenced by the job's `name`, so do not rename it casually.

Merge the PR (remove the `// ci` line first if you like).
:::

### Clean up

Nothing to clean up. Keep the ruleset; later labs rely on PRs.

## Lab 2: Build, scan and push a multi-arch image to GHCR

:::meta
difficulty: medium
time: 45 min
:::

Goal: on every merge to `main`, build the image once for amd64 and arm64, gate on a Trivy scan, push with `sha-` (and on tags, semver) tags, attach SBOM and provenance, and record the digest.

### Steps

1. Replace `.github/workflows/app.yml` with the full workflow below. It contains the `check` job from Lab 1, the new `image` job, and the two GitOps jobs used in Labs 5 and 6. `deploy-dev` would fail on `main` until the dev values file exists, so **comment out `deploy-dev` and `deploy-prod` for now**; you re-enable them in Lab 5.

`.github/workflows/app.yml`

```yaml
name: app

on:
  pull_request:
    paths:
      - "app/**"
      - ".github/workflows/app.yml"
  push:
    branches: [main]
    tags: ["v*.*.*"]          # path filters are not evaluated for tag pushes
    paths:
      - "app/**"
      - ".github/workflows/app.yml"
  workflow_dispatch:

# One run per ref; cancel superseded PR runs, never cancel main/tag runs mid-deploy.
concurrency:
  group: app-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

jobs:
  check:
    name: lint & test
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: app
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: app/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test

  image:
    name: build, scan, push
    needs: check
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write         # push to GHCR with GITHUB_TOKEN
      id-token: write         # OIDC token for the provenance attestation
      attestations: write
    outputs:
      tag: ${{ steps.vars.outputs.tag }}
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v5

      - name: Compute names
        id: vars
        env:
          OWNER: ${{ github.repository_owner }}
        run: |
          echo "IMAGE=ghcr.io/${OWNER,,}/shipit-api" >> "$GITHUB_ENV"   # registry paths must be lowercase
          echo "tag=sha-${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3

      - name: Image metadata (tags and OCI labels)
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE }}
          tags: |
            type=sha,format=short,prefix=sha-
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=ref,event=pr
            type=raw,value=main,enable={{is_default_branch}}

      # 1) Build ONE platform into the local Docker engine so we can scan before anything is pushed.
      - name: Build for scanning (linux/amd64, local)
        uses: docker/build-push-action@v6
        with:
          context: app
          platforms: linux/amd64
          load: true
          tags: shipit-api:ci
          cache-from: type=gha,scope=shipit-api
          cache-to: type=gha,mode=max,scope=shipit-api

      # 2) Gate: fail on fixable HIGH/CRITICAL vulnerabilities.
      #    Pin third-party actions to a full commit SHA in real repos (see Lab 3).
      - name: Trivy scan (gate)
        uses: aquasecurity/trivy-action@0.35.0
        with:
          image-ref: shipit-api:ci
          format: table
          exit-code: "1"
          ignore-unfixed: true
          severity: CRITICAL,HIGH
          vuln-type: os,library

      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # 3) Build all platforms and push, with SBOM and provenance attestations.
      #    The amd64 layers come straight from the cache populated in step 1.
      - name: Build and push (multi-arch)
        id: push
        if: github.event_name != 'pull_request'
        uses: docker/build-push-action@v6
        with:
          context: app
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=shipit-api
          cache-to: type=gha,mode=max,scope=shipit-api
          provenance: mode=max
          sbom: true

      - name: GitHub build provenance attestation
        if: github.event_name != 'pull_request'
        uses: actions/attest-build-provenance@v2
        with:
          subject-name: ${{ env.IMAGE }}
          subject-digest: ${{ steps.push.outputs.digest }}
          push-to-registry: true

      - name: Summary
        if: github.event_name != 'pull_request'
        env:
          TAGS: ${{ steps.meta.outputs.tags }}
          DIGEST: ${{ steps.push.outputs.digest }}
        run: |
          {
            echo "### Image pushed"
            echo "Digest: \`${DIGEST}\`"
            echo
            while read -r t; do echo "- \`${t}\`"; done <<< "${TAGS}"
          } >> "$GITHUB_STEP_SUMMARY"

  # GitOps: CI never talks to the cluster. It commits the new image to Git; Argo CD pulls it.
  deploy-dev:
    name: promote to dev (GitOps)
    needs: image
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: dev
    permissions:
      contents: write
    concurrency:
      group: gitops-dev
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v5
        with:
          ref: main
      - name: Bump image in deploy/envs/dev/values.yaml
        env:
          TAG: ${{ needs.image.outputs.tag }}
          DIGEST: ${{ needs.image.outputs.digest }}
        run: |
          yq -i '.image.tag = strenv(TAG) | .image.digest = strenv(DIGEST)' deploy/envs/dev/values.yaml
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add deploy/envs/dev/values.yaml
          if git diff --cached --quiet; then echo "dev already runs ${TAG}"; exit 0; fi
          git commit -m "deploy(dev): shipit-api ${TAG}"
          git pull --rebase origin main
          git push origin HEAD:main

  deploy-prod:
    name: promote to production (GitOps, approval required)
    needs: image
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    environment: production      # required reviewers are configured on this environment
    permissions:
      contents: write
    concurrency:
      group: gitops-production
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v5
        with:
          ref: main
      - name: Bump image in deploy/envs/prod/values.yaml
        env:
          DIGEST: ${{ needs.image.outputs.digest }}
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          export VERSION
          yq -i '.image.tag = strenv(VERSION) | .image.digest = strenv(DIGEST)' deploy/envs/prod/values.yaml
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add deploy/envs/prod/values.yaml
          if git diff --cached --quiet; then echo "production already runs ${VERSION}"; exit 0; fi
          git commit -m "deploy(prod): shipit-api ${VERSION}"
          git pull --rebase origin main
          git push origin HEAD:main
```

2. Allow the workflow to push to the existing package: GitHub → your profile → Packages → `shipit-api` → Package settings → **Manage Actions access** → Add repository `shipit` with role **Write**. (Packages first created by a workflow are linked automatically; yours was created from your laptop in Project 1.)

3. Open a PR, check that the PR run builds and scans but does **not** push, and merge it.

4. Inspect what was published:

```bash
OWNER=$(gh api user --jq .login | tr '[:upper:]' '[:lower:]')
SHA=$(git rev-parse --short=7 origin/main)
docker buildx imagetools inspect ghcr.io/$OWNER/shipit-api:sha-$SHA
docker buildx imagetools inspect ghcr.io/$OWNER/shipit-api:sha-$SHA --format '{{ json .Provenance.SLSA.invocation.configSource }}'
docker buildx imagetools inspect ghcr.io/$OWNER/shipit-api:sha-$SHA --format '{{ json .SBOM.SPDX.packages }}' | head -c 600; echo
gh attestation verify oci://ghcr.io/$OWNER/shipit-api:sha-$SHA --owner $OWNER
```

### Verify

- The PR run shows `build, scan, push` green, with the push steps **skipped**.
- The `main` run's summary shows the pushed digest and tags `sha-<7>` and `main`.
- `imagetools inspect` lists `linux/amd64` and `linux/arm64`; the provenance output names your repository and workflow; the SBOM lists packages such as `express` and `pg`.
- `gh attestation verify` ends with `✓ Verification succeeded!`.
- Re-run the workflow (`gh run rerun <id>`): the multi-arch build log is dominated by `CACHED` steps.

:::hint
`denied: permission_denied: write_package`: step 2 is missing, or the job lacks `packages: write`. `invalid reference format: repository name must be lowercase`: you hard-coded the owner instead of using the lowercasing step. If the Trivy step fails on the very first run, read its table: a fixable HIGH/CRITICAL in the base image is the gate doing its job. Rebuild later (Debian publishes fixes quickly) or handle it as in Lab 3.
:::

:::solution
Expected `main` run summary:

```text
### Image pushed
Digest: `sha256:3b1f...`
ghcr.io/<you>/shipit-api:sha-1a2b3c4
ghcr.io/<you>/shipit-api:main
```

How the job is put together, step by step:

1. **Compute names**: lowercases the owner and derives the `sha-` tag. Exported as a job output so later jobs can use it.
2. **QEMU + buildx**: QEMU registers emulators for arm64; buildx creates a `docker-container` builder that supports multi-platform builds and cache export.
3. **metadata-action**: produces `sha-1a2b3c4` always, `1.4.0`/`1.4` only on `v1.4.0` tags, `pr-12` on PRs (never pushed), `main` on the default branch, and OCI labels.
4. **Build for scanning**: single platform, `load: true` into the runner's Docker engine. Writes the layer cache (`cache-to: type=gha,mode=max`; `mode=max` also caches intermediate stages such as `build` and `prod-deps`).
5. **Trivy gate**: `exit-code: "1"` turns findings into a failed step; `ignore-unfixed: true` avoids blocking on vulnerabilities with no available fix, which you cannot act on.
6. **Login, build and push**: skipped on PRs. Rebuilds both platforms using the cache, pushes, and attaches SBOM and SLSA provenance as attestation manifests inside the image index (those are the `unknown/unknown` entries in `imagetools inspect`).
7. **GitHub attestation**: signs a provenance statement for the pushed digest with the workflow's OIDC identity and stores it in GitHub and in the registry. `gh attestation verify` checks the signature and that it came from your repository.

Why the digest matters: the GitOps jobs write it to the values file, and the chart renders `repository@digest`. Tags are for people; digests are what the cluster runs.
:::

### Clean up

Nothing to clean. Old `sha-` tags accumulate in GHCR; a scheduled cleanup workflow (for example with `actions/delete-package-versions`) is a good later addition, keeping anything referenced by an environment.

## Lab 3: Break and fix the supply-chain gate

:::meta
difficulty: medium
time: 40 min
:::

Goal: watch the Trivy gate stop a vulnerable dependency from being published, fix it properly, then close the other supply-chain hole: mutable action tags.

### Steps

1. On a branch, add an old version of a popular library as if a teammate needed one helper function:

```bash
git switch -c feat/needs-lodash
cd app && npm install --save-exact lodash@4.17.15 && cd ..
git add app/package.json app/package-lock.json
git commit -m "feat: add lodash" && git push -u origin HEAD
gh pr create --fill
gh pr checks --watch
```

2. Open the failed **build, scan, push** job and read the Trivy table. Answer: which package, which CVEs, which severity, which installed version, which fixed version, and is the vulnerable code even used by shipit-api?

3. Fix it the right way (see the solution for the decision). Push and confirm the gate turns green.

4. Pin every action to a full commit SHA. Either use `pinact`:

```bash
pinact run            # rewrites uses: owner/repo@vX to uses: owner/repo@<sha> # vX
git diff .github/workflows
```

or do it by hand with the GitHub API (macOS `sed`):

```bash
for ref in $(grep -rhoE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[A-Za-z0-9_.-]+$' .github/workflows | awk '{print $2}' | sort -u); do
  action=${ref%@*}; version=${ref#*@}
  repo=$(echo "$action" | cut -d/ -f1-2)
  sha=$(gh api "repos/$repo/commits/$version" --jq .sha)
  echo "$ref -> $sha"
  sed -i '' "s|uses: ${ref}\$|uses: ${action}@${sha} # ${version}|" .github/workflows/*.yml
done
```

5. Add Dependabot so pinned SHAs (and npm, Docker base image, Terraform providers) get update PRs:

`.github/dependabot.yml`

```yaml
version: 2
updates:
  - package-ecosystem: github-actions   # also keeps SHA-pinned actions up to date
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: npm
    directory: /app
    schedule:
      interval: weekly
  - package-ecosystem: docker
    directory: /app
    schedule:
      interval: weekly
  - package-ecosystem: terraform
    directory: /infra
    schedule:
      interval: weekly
```

### Verify

- The PR with `lodash@4.17.15` is red at **Trivy scan (gate)** and nothing was pushed to GHCR for it.
- After the fix, the PR is green.
- `grep -rn "uses:" .github/workflows` shows only 40-character SHAs followed by `# vX` comments.
- Insights → Dependency graph → Dependabot lists the four ecosystems.

:::hint
The Trivy table has columns Library, Vulnerability, Severity, Status, Installed Version, Fixed Version. For the fix, there are three possible responses to a finding: upgrade, remove, or accept with a recorded justification. Which one is right when a dependency was added for one small helper?
:::

:::solution
Trivy reports, in the `node-pkg` section for `app/node_modules`, `lodash 4.17.15` with (among others) **CVE-2020-8203** (prototype pollution in `zipObjectDeep`, HIGH, fixed in 4.17.19) and **CVE-2021-23337** (command injection via `template`, HIGH, fixed in 4.17.21).

Decision ladder, best first:

1. **Remove** the dependency if one helper is all you need; modern JavaScript covers most lodash use cases (`structuredClone`, `Object.groupBy`, optional chaining). `npm uninstall lodash`.
2. **Upgrade** to a fixed version: `npm install --save-exact lodash@4.17.21` (or newer).
3. **Accept** only with a recorded, expiring justification, when there is no fix and the vulnerable code path is provably unreachable. Trivy reads a `.trivyignore` (or `.trivyignore.yaml`) from the working directory:

```yaml
# .trivyignore.yaml
vulnerabilities:
  - id: CVE-2021-23337
    statement: "template() is never called with user input; tracked in ISSUE-123"
    expired_at: 2026-12-31
```

Ignoring a finding because "it is only a test" or "the gate is annoying" is how gates become theatre.

Why pin to SHAs: in March 2026 the tags of `aquasecurity/trivy-action` itself were force-pushed to malicious code. A workflow using `@0.33.0` silently ran the attacker's version with the job's token and secrets; a workflow pinned to a SHA kept running the audited code. Pinning plus Dependabot gives you immutability and still lets updates flow, as reviewable PRs. Official `actions/*` and verified publishers are lower risk, but pinning everything is simpler than deciding case by case.

Defence in depth you already have: the `image` job's token can write packages but not code (`contents: read`), and PR runs from forks cannot push at all.
:::

### Clean up

Close or merge the lodash PR after the fix, and merge the pinning PR.

## Lab 4: Validate the charts and Terraform, then deploy end to end in CI

:::meta
difficulty: hard
time: 50 min
:::

Goal: a second workflow that lints and schema-validates both charts, packages the app chart to GHCR, checks Terraform (fmt, validate, test), and on every relevant PR creates a kind cluster in the runner, plans, applies, smoke-tests and destroys it.

### Steps

1. Create the dev environment values file (used here for linting and in Lab 5 by Argo CD). Replace `your-github-user` with your lowercase GitHub user:

`deploy/envs/dev/values.yaml`

```yaml
# dev environment, delivered by Argo CD. CI (app.yml -> deploy-dev) rewrites image.tag/digest.
replicaCount: 2

image:
  repository: ghcr.io/your-github-user/shipit-api
  tag: "0.1.0"        # first real value: the image you pushed in Project 1
  digest: ""
  pullPolicy: IfNotPresent

httpRoute:
  hostnames:
    - shipit.local

autoscaling:
  enabled: false

networkPolicy:
  enabled: true
```

2. Make sure `infra/tests/plan.tftest.hcl` exists (from Project 1); if not, add it:

`infra/tests/plan.tftest.hcl`

```hcl
# Runs without Docker or a cluster: every provider is mocked and only `plan` is executed.
mock_provider "kind" {}
mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "random" {}

run "terraform_mode_deploys_app_with_helm" {
  command = plan

  variables {
    deploy_mode = "terraform"
  }

  assert {
    condition     = length(helm_release.shipit_api) == 1
    error_message = "terraform mode must create the shipit-api helm_release"
  }

  assert {
    condition     = length(helm_release.argocd) == 0
    error_message = "terraform mode must not install Argo CD"
  }

  assert {
    condition     = kubernetes_namespace_v1.shipit.metadata[0].labels["pod-security.kubernetes.io/enforce"] == "baseline"
    error_message = "shipit namespace must enforce the baseline Pod Security Standard"
  }
}

run "argocd_mode_hands_the_app_to_argocd" {
  command = plan

  variables {
    deploy_mode     = "argocd"
    gitops_repo_url = "https://github.com/example/shipit.git"
  }

  assert {
    condition     = length(helm_release.shipit_api) == 0 && length(helm_release.argocd) == 1
    error_message = "argocd mode must install Argo CD and skip the Terraform-managed app release"
  }
}

run "rejects_unknown_deploy_mode" {
  command = plan

  variables {
    deploy_mode = "flux"
  }

  expect_failures = [var.deploy_mode]
}
```

Run it locally first: `terraform -chdir=infra init && terraform -chdir=infra test`.

3. Create `.github/workflows/platform.yml`:

`.github/workflows/platform.yml`

```yaml
name: platform

on:
  pull_request:
    paths:
      - "infra/**"
      - "deploy/charts/**"
      - "deploy/envs/local/**"
      - "app/**"
      - "scripts/**"
      - "Makefile"
      - ".github/workflows/platform.yml"
  push:
    branches: [main]
    paths:
      - "infra/**"
      - "deploy/charts/**"
      - ".github/workflows/platform.yml"
  workflow_dispatch:

concurrency:
  group: platform-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  helm:
    name: helm lint, validate, package
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write          # push the packaged chart to GHCR (main only)
    steps:
      - uses: actions/checkout@v5
      - uses: azure/setup-helm@v4

      - name: Lint
        run: |
          helm lint deploy/charts/shipit-data
          helm lint deploy/charts/shipit-api -f deploy/envs/local/values.yaml
          helm lint deploy/charts/shipit-api -f deploy/envs/dev/values.yaml

      - name: Render every optional template and validate against schemas
        run: |
          helm template shipit-api deploy/charts/shipit-api -f deploy/envs/dev/values.yaml \
            --set autoscaling.enabled=true --set networkPolicy.enabled=true > rendered.yaml
          helm template shipit-data deploy/charts/shipit-data >> rendered.yaml
          docker run --rm -v "$PWD:/work" ghcr.io/yannh/kubeconform:v0.6.7 \
            -strict -summary \
            -schema-location default \
            -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
            /work/rendered.yaml

      - name: Package
        run: helm package deploy/charts/shipit-api --destination dist

      - name: Push chart to GHCR as an OCI artifact
        if: github.event_name == 'push'
        env:
          OWNER: ${{ github.repository_owner }}
          TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ACTOR: ${{ github.actor }}
        run: |
          echo "$TOKEN" | helm registry login ghcr.io -u "$ACTOR" --password-stdin
          helm push dist/shipit-api-*.tgz "oci://ghcr.io/${OWNER,,}/charts"

  terraform:
    name: terraform fmt, validate, test
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false
      - run: terraform fmt -check -recursive -diff
      - run: terraform init -input=false
      - run: terraform validate
      - run: terraform test          # mock providers: no Docker, no cluster

  e2e:
    name: plan, apply on kind, smoke test, destroy
    needs: [helm, terraform]
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      KUBECONFIG: ${{ github.workspace }}/infra/.kube/config
      TF_IN_AUTOMATION: "1"
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false
      - uses: azure/setup-helm@v4
      - uses: helm/kind-action@v1
        with:
          install_only: true

      - name: Create the cluster only (bootstrap)
        run: |
          terraform -chdir=infra init -input=false
          terraform -chdir=infra apply -input=false -auto-approve -target=kind_cluster.this

      - name: Build the image and load it into kind
        run: |
          docker build -t shipit-api:dev app
          kind load docker-image shipit-api:dev --name shipit

      - name: Terraform plan (full)
        run: |
          set -o pipefail
          terraform -chdir=infra plan -input=false -no-color -out=tfplan \
            -var image_repository=shipit-api -var image_tag=dev | tee plan.txt
          {
            echo "### Terraform plan"
            echo
            grep -E '^(Plan:|No changes)' plan.txt | sed 's/^/    /' || true
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Terraform apply
        run: terraform -chdir=infra apply -input=false tfplan

      - name: Smoke test through the Gateway
        run: ./scripts/smoke.sh

      - name: Dump cluster state on failure
        if: failure()
        run: |
          kubectl get pods -A -o wide || true
          kubectl get events -A --sort-by=.lastTimestamp | tail -50 || true
          kubectl describe pods -n shipit || true
          kubectl logs -n shipit -l app.kubernetes.io/name=shipit-api --tail=100 || true

      - name: Upload plan
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: terraform-plan
          path: plan.txt
          if-no-files-found: ignore

      - name: Destroy
        if: always()
        run: terraform -chdir=infra destroy -input=false -auto-approve -var image_repository=shipit-api -var image_tag=dev || kind delete cluster --name shipit
```

4. Pin the new actions (Lab 3, step 4), lint, push on a branch, open a PR and watch all three jobs.

```bash
actionlint && git add . && git commit -m "ci: platform checks and kind e2e" && git push -u origin HEAD
gh pr create --fill && gh pr checks --watch
```

5. Break it on purpose to see each gate catch something different, one at a time, then revert:
   - Mis-indent a line in an `.tf` file → `terraform fmt -check` fails with a diff.
   - Rename `minAvailable` to `minAvailble` in `pdb.yaml` → kubeconform fails with `additional properties 'minAvailble' not allowed` (helm lint does not catch it).
   - Change the HTTPRoute hostname in `deploy/envs/local/values.yaml` to `wrong.local` → the e2e smoke test fails and the failure dump shows the route and pods are healthy (the test calls `shipit.local`).

### Verify

- Three jobs green on the PR: **helm lint, validate, package**, **terraform fmt, validate, test**, **plan, apply on kind, smoke test, destroy**.
- The e2e run summary shows a `Plan: N to add, 0 to change, 0 to destroy.` line, and the `terraform-plan` artifact contains the full plan.
- After merging to `main`, the helm job pushes the chart: `helm show chart oci://ghcr.io/<you>/charts/shipit-api --version 0.1.0` prints the Chart.yaml.
- Each deliberate break in step 5 fails exactly the job you expected.

:::hint
If the e2e job fails at `kind load` with "no nodes found for cluster", the cluster name differs (the Terraform default is `shipit`). If the smoke test times out, look at the failure dump: `ImagePullBackOff` means the image was not loaded; `0/1 Ready` means look at the app logs. If `terraform test` fails on `kubernetes_namespace_v1.shipit.metadata[0].labels`, check the label key spelling in `platform.tf`. If kubeconform cannot download the CRD schema, confirm the datreeio CRDs-catalog URL template is quoted exactly as shown.
:::

:::solution
The workflow in step 3 is the solution. What each layer catches, and why you need all of them:

| Check | Catches | Misses |
| --- | --- | --- |
| `helm lint` | Template syntax, missing Chart.yaml fields, values typos that break rendering | Invalid Kubernetes fields |
| `kubeconform -strict` | Unknown or mistyped fields, wrong types, invalid CRD objects (with the CRD schema source) | Runtime behaviour, cross-object references |
| `terraform fmt/validate` | Formatting, syntax, type and reference errors | Logic errors, provider-side failures |
| `terraform test` (mocks) | Conditional logic, validations, expected attributes | Real provider behaviour |
| e2e on kind | Everything working together: ordering, CRDs, image, probes, routing | Cloud-specific behaviour (load balancers, IAM, storage classes) |

Design notes:

- `-target=kind_cluster.this` before the plan mirrors `make up`: a meaningful plan of the in-cluster resources needs the cluster to exist (the kubernetes and helm providers are configured from it). In production, separate states remove this bootstrap step.
- `if: always()` on destroy guarantees cleanup even when the smoke test fails, with `kind delete cluster` as a fallback if Terraform itself is broken. Runners are ephemeral anyway, but the habit matters for self-hosted runners and real clouds, where a forgotten environment costs money.
- `TF_IN_AUTOMATION=1` slightly adjusts Terraform output for non-interactive use, and `terraform_wrapper: false` prevents the setup action's wrapper from mangling stdout when you pipe it.
- The e2e job builds the image locally rather than pulling from GHCR, so it also works for PRs from forks, which have no registry credentials.
- Charts pushed as OCI artifacts are immutable by convention: bump `version` in Chart.yaml whenever templates change. A good extension is a check that fails the PR if `deploy/charts/shipit-api/templates/**` changed without a version bump.
:::

### Clean up

Nothing persists: the runner and its kind cluster are gone after each run.

## Lab 5: GitOps delivery to dev with Argo CD

:::meta
difficulty: hard
time: 60 min
:::

Goal: merges to `main` deploy to the dev environment without CI touching the cluster. CI commits the new digest to `deploy/envs/dev/values.yaml`; Argo CD in your kind cluster syncs it. Rollback is `git revert`.

### Steps

1. Change the Argo CD bootstrap chart from Project 1 so the image version comes **only** from Git. Replace `deploy/argocd-bootstrap/templates/application.yaml` and `values.yaml`:

`deploy/argocd-bootstrap/templates/application.yaml`

```yaml
{{- range $env, $cfg := .Values.environments }}
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shipit-api-{{ $env }}
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ required "repoURL is required" $.Values.repoURL | quote }}
    targetRevision: {{ $.Values.revision | quote }}
    path: deploy/charts/shipit-api
    helm:
      releaseName: shipit-api
      valueFiles:
        - ../../envs/{{ $env }}/values.yaml   # the ONLY place the image version lives
  destination:
    server: https://kubernetes.default.svc
    namespace: {{ $cfg.namespace }}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
{{- end }}
```

`deploy/argocd-bootstrap/values.yaml`

```yaml
repoURL: ""
revision: main
environments:
  dev:
    namespace: shipit
```

2. In `infra/argocd.tf`, replace the `helm_release.argocd_bootstrap` resource with this version (it no longer passes an image, and it takes a map of environments):

`infra/argocd.tf`

```hcl
variable "argocd_environments" {
  description = "Environments Argo CD deploys: env name => target namespace. Values come from deploy/envs/<env>/values.yaml."
  type = map(object({
    namespace = string
  }))
  default = {
    dev = { namespace = "shipit" }
  }
}

resource "helm_release" "argocd_bootstrap" {
  count = var.deploy_mode == "argocd" ? 1 : 0

  name      = "argocd-bootstrap"
  namespace = "argocd"
  chart     = abspath("${path.module}/../deploy/argocd-bootstrap")

  values = [yamlencode({
    repoURL      = var.gitops_repo_url
    revision     = var.gitops_revision
    environments = var.argocd_environments
  })]

  lifecycle {
    precondition {
      condition     = var.gitops_repo_url != ""
      error_message = "Set gitops_repo_url when deploy_mode = \"argocd\"."
    }
  }

  depends_on = [helm_release.argocd, helm_release.shipit_data]
}
```

Bump `version` in `deploy/argocd-bootstrap/Chart.yaml` to `0.2.0`.

3. Uncomment the `deploy-dev` and `deploy-prod` jobs in `.github/workflows/app.yml`. Create the `dev` environment in GitHub: Settings → Environments → New environment `dev` → Deployment branches and tags: **Selected branches** → `main`. If your `main` ruleset requires PRs, add **GitHub Actions** (the `github-actions` app) to the ruleset's bypass list so the bot can push the values bump.

4. Commit and push everything (Argo CD reads from GitHub, not from your laptop), then recreate the environment in Argo CD mode, pulling images from GHCR:

```bash
git add . && git commit -m "deploy: gitops dev environment" && git push   # via PR if main is protected
make recreate DEPLOY_MODE=argocd LOCAL_IMAGE=0 GH_USER=<you> TAG=0.1.0
kubectl get applications -n argocd
kubectl get deploy shipit-api -n shipit -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

5. Ship a change. Edit the `/healthz` handler in `app/src/app.ts` to return `{ status: "ok", service: "shipit-api" }`, open a PR, merge it, and follow the chain:

```bash
gh run watch                                          # app workflow on main
git pull && git log --oneline -3 -- deploy/envs/dev/values.yaml
kubectl get applications -n argocd -w                 # OutOfSync -> Synced (polls about every 3 minutes)
kubectl rollout status deploy/shipit-api -n shipit
curl -s -H 'Host: shipit.local' localhost:8080/healthz
```

6. Roll back with Git only:

```bash
git revert --no-edit $(git log -1 --format=%H -- deploy/envs/dev/values.yaml)
git push                                              # via PR if needed
# after Argo CD syncs:
curl -s -H 'Host: shipit.local' localhost:8080/healthz   # {"status":"ok"} again
```

### Verify

- The `promote to dev (GitOps)` job appears under the `dev` environment (repo home page → Deployments) and its commit `deploy(dev): shipit-api sha-xxxxxxx` is on `main`.
- The Deployment's image is `ghcr.io/<you>/shipit-api@sha256:...` matching the digest in the values file and in the run summary.
- `/healthz` shows the new field after the sync, and the old response after the revert, with no CI run involved in the rollback.
- `kubectl get applications -n argocd` shows `shipit-api-dev   Synced   Healthy`.

:::hint
Waiting for Argo CD: it polls Git about every 3 minutes by default. Click **Refresh** in the UI (`kubectl port-forward -n argocd svc/argocd-server 8081:80`) or annotate the app: `kubectl annotate application shipit-api-dev -n argocd argocd.argoproj.io/refresh=normal --overwrite`. If the bump job fails with `remote: Permission to ... denied` or `protected branch`, the job lacks `contents: write` or the ruleset has no bypass for GitHub Actions. If pods show `ImagePullBackOff`, the GHCR package is private.
:::

:::solution
The full flow:

```text
 merge PR ─► app.yml on main: check ─► image (push sha-1a2b3c4, digest D)
          ─► deploy-dev: yq sets image.tag=sha-1a2b3c4, image.digest=D ─► commit to main
 Argo CD (poll) ─► Git revision changed ─► renders chart with envs/dev/values.yaml
          ─► Deployment template changed (image@D) ─► rolling update (maxUnavailable 0)
```

Why each piece is there:

- **The Application no longer receives the image from Terraform.** If both Terraform (`valuesObject`) and Git defined the image, you would have two sources of truth, and the higher-precedence one (Terraform) would silently win. Now Git is the only place a version is decided, which is the GitOps contract.
- **Renaming the Application** to `shipit-api-dev` deletes the old one; its finalizer removes the old resources and the new one recreates them. A short interruption is fine locally; in production you would migrate with `argocd app set` or by adopting resources with the same names.
- **`environment: dev`** gives you a deployment history per environment and a place to add protection rules later, even though the job does not touch the cluster.
- **`concurrency: gitops-dev` and `git pull --rebase`** avoid two merges fighting over the same file.
- **`git revert` as rollback**: no rebuild, no pipeline, an audit trail, and the same mechanism for every environment. `argocd app rollback` also exists, but it disables auto-sync until Git catches up, so prefer Git.
- **Push vs pull in one sentence**: the cluster's credentials never left the cluster, and the cluster's API server never had to be reachable from GitHub.
:::

### Clean up

Leave it running for Lab 6, or `make down DEPLOY_MODE=argocd GH_USER=<you>`.

## Lab 6 (challenge): Production promotion with approvals and an OIDC design

:::meta
difficulty: hard
time: 75 min
:::

Goal: a production environment in the same kind cluster that only changes when a semver tag is pushed **and** a reviewer approves, plus a written OIDC trust policy for a future cloud plan job. Requirements only.

### Requirements

1. Terraform creates an isolated `shipit-prod` namespace (Pod Security `restricted` **enforced**), its own database Secret and its own `shipit-data` release, behind a variable `enable_prod` (default `false`).
2. Argo CD gets a second Application, `shipit-api-prod`, reading `deploy/envs/prod/values.yaml`, hostname `shipit-prod.local`, autoscaling on, NetworkPolicy on.
3. GitHub environment `production`: you as required reviewer, deployment limited to tags matching `v*`.
4. `git tag v0.2.0 && git push origin v0.2.0` produces images `0.2.0`, `0.2` and `sha-…`, then pauses at `deploy-prod` until approved. After approval, the prod values file gets `tag: "0.2.0"` and the digest, and Argo CD rolls out prod. Dev is unaffected by the tag.
5. Write (do not apply) an AWS IAM role trust policy for a hypothetical `shipit-ci-plan` role that only pull-request workflows of your repo can assume, and the workflow snippet that would use it.

### Verify

- `curl -s -H 'Host: shipit-prod.local' localhost:8080/readyz` returns ready after the first sync.
- The tag run shows **Waiting** at `promote to production` with a "Review deployments" button; nothing changes in `shipit-prod` until you approve.
- After approval: `kubectl get deploy shipit-api -n shipit-prod -o jsonpath='{..image}'` shows the new digest; `kubectl get hpa -n shipit-prod` exists.
- `kubectl label --dry-run=server --overwrite ns shipit-prod pod-security.kubernetes.io/enforce=restricted` reports no violations for existing pods.

:::hint
Reuse Project 1's patterns: `count = var.enable_prod ? 1 : 0` on each prod resource, the same data chart with a different namespace, and `argocd_environments = { dev = {...}, prod = { namespace = "shipit-prod" } }` in `terraform.tfvars`. The `deploy-prod` job from Lab 2 already exists; it just needs the environment and the values file. For the trust policy, the claims you need are `aud` and `sub`; look at what `sub` looks like for a `pull_request` event.
:::

:::solution
**Terraform** (`infra/prod.tf`):

`infra/prod.tf`

```hcl
# A second, isolated environment in the same kind cluster: its own namespace, secret and data stores.
variable "enable_prod" {
  description = "Create the shipit-prod namespace, secret and data stores."
  type        = bool
  default     = false
}

resource "kubernetes_namespace_v1" "shipit_prod" {
  count = var.enable_prod ? 1 : 0
  metadata {
    name = "shipit-prod"
    labels = {
      "pod-security.kubernetes.io/enforce" = "restricted"
    }
  }
}

resource "random_password" "postgres_prod" {
  count   = var.enable_prod ? 1 : 0
  length  = 24
  special = false
}

resource "kubernetes_secret_v1" "shipit_db_prod" {
  count = var.enable_prod ? 1 : 0
  metadata {
    name      = "shipit-db"
    namespace = kubernetes_namespace_v1.shipit_prod[0].metadata[0].name
  }
  data = {
    POSTGRES_PASSWORD = random_password.postgres_prod[0].result
    DATABASE_URL      = "postgres://shipit:${random_password.postgres_prod[0].result}@postgres:5432/shipit"
  }
}

resource "helm_release" "shipit_data_prod" {
  count     = var.enable_prod ? 1 : 0
  name      = "shipit-data"
  namespace = kubernetes_namespace_v1.shipit_prod[0].metadata[0].name
  chart     = "${local.charts_dir}/shipit-data"
  wait      = true
  timeout   = 300

  depends_on = [kubernetes_secret_v1.shipit_db_prod]
}
```

**`infra/terraform.tfvars`** additions:

```hcl
enable_prod = true
argocd_environments = {
  dev  = { namespace = "shipit" }
  prod = { namespace = "shipit-prod" }
}
```

**Values** (`deploy/envs/prod/values.yaml`):

`deploy/envs/prod/values.yaml`

```yaml
# production environment, delivered by Argo CD. Only the approved deploy-prod job rewrites image.*.
replicaCount: 2

image:
  repository: ghcr.io/your-github-user/shipit-api
  tag: "0.1.0"
  digest: ""
  pullPolicy: IfNotPresent

httpRoute:
  hostnames:
    - shipit-prod.local

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 5

networkPolicy:
  enabled: true
```

**Run it**:

```bash
git add . && git commit -m "deploy: production environment" && git push     # via PR
make up DEPLOY_MODE=argocd LOCAL_IMAGE=0 GH_USER=<you> TAG=0.1.0
kubectl get applications -n argocd            # shipit-api-dev, shipit-api-prod
curl -s -H 'Host: shipit-prod.local' localhost:8080/readyz

# GitHub: Settings -> Environments -> New "production"
#   Required reviewers: you (untick "Prevent self-review" if you are the only person)
#   Deployment branches and tags: Selected -> add tag rule "v*"
git tag v0.2.0 && git push origin v0.2.0
gh run watch          # stops at "promote to production": Review deployments -> Approve
```

**OIDC trust policy** for `shipit-ci-plan` (account ID and owner are placeholders):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:roma/shipit:pull_request"
        }
      }
    }
  ]
}
```

Workflow snippet:

```yaml
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/shipit-ci-plan
          aws-region: eu-central-1
      - uses: hashicorp/setup-terraform@v3
      - run: terraform -chdir=infra init -input=false && terraform -chdir=infra plan -input=false -lock=false
```

Key points:

- **Same bytes in dev and prod.** The tag run builds from the tagged commit; if that commit was already built on `main`, the layers are cache hits and the digest is identical, so prod runs exactly what dev ran. Some teams go further and promote by re-tagging an existing digest (`docker buildx imagetools create -t ...:0.2.0 ...@sha256:...`) instead of building on tags at all.
- **The approval gates a Git commit, not a cluster command.** Auditors see who approved (GitHub), what changed (diff of `deploy/envs/prod/values.yaml`) and when it synced (Argo CD history).
- **`sub` is the security boundary** of OIDC. `StringEquals` on `repo:roma/shipit:pull_request` means only PR workflows of this repository get the plan role. The apply role would use `repo:roma/shipit:environment:production`, so it is only usable after an environment approval. Never trust only `aud` or use a wildcard like `repo:*`.
- **`-lock=false` in PR plans** is a common choice so that many concurrent PR plans do not block each other or a real apply; applies always lock.
- **Restricted PSS enforced** in prod proves the hardening from Project 1 is real; dev only warns, which keeps experimentation easy.
:::

### Clean up

```bash
make down DEPLOY_MODE=argocd GH_USER=<you>
```

## Lab 7 (optional): Run jobs locally with act

:::meta
difficulty: easy
time: 20 min
:::

Goal: iterate on workflow steps on your Mac without pushing, and learn where `act` stops being faithful.

### Steps

1. Configure act once:

```bash
cat > ~/.actrc <<'EOF'
--container-architecture=linux/amd64
-P ubuntu-latest=catthehacker/ubuntu:act-latest
EOF
cd ~/code/shipit
act -l
```

2. Run the cheap jobs:

```bash
act pull_request -j check
act pull_request -j terraform -W .github/workflows/platform.yml
```

3. Try the image job and observe what breaks:

```bash
act pull_request -j image -s GITHUB_TOKEN="$(gh auth token)"
```

4. Make the workflow act-aware: add `if: ${{ !env.ACT }}` to the steps that cannot work locally (the `type=gha` cache steps are the usual suspects), or move the cache options behind an expression, and rerun.

### Verify

- `check` passes locally with the same lint, typecheck and test output as on GitHub.
- `terraform` passes locally (fmt, validate, test).
- You can name at least three things that behave differently under act.

:::hint
act runs each job in a container from the `-P` image and mounts your Docker socket. Anything that talks to GitHub's own services (cache API, OIDC, attestations, environments) is either emulated partially or missing. First runs are slow because the runner image is large.
:::

:::solution
Typical observations:

- `check` and `terraform` work unchanged, which covers most "why does CI fail but my laptop doesn't" problems: they run in a clean Linux container with `npm ci`, like CI.
- The `image` job usually fails or degrades at the `type=gha` cache (no GitHub cache service token) and cannot do the attestation step (no OIDC token, no `id-token` permission). Environments and required reviewers do not exist locally; `if:` conditions referencing them still evaluate, but nothing pauses.
- Under `--container-architecture linux/amd64` on Apple Silicon, everything runs under emulation, so it is slower than GitHub; without the flag, some tools in the runner image may be missing for arm64.

A minimal act-aware change:

```yaml
      - name: Build for scanning (linux/amd64, local)
        uses: docker/build-push-action@v6
        with:
          context: app
          platforms: linux/amd64
          load: true
          tags: shipit-api:ci
          cache-from: ${{ !env.ACT && 'type=gha,scope=shipit-api' || '' }}
          cache-to: ${{ !env.ACT && 'type=gha,mode=max,scope=shipit-api' || '' }}
```

Use act for tight loops on shell logic and job wiring; trust only GitHub for the final answer.
:::

### Clean up

```bash
docker image ls | grep catthehacker    # remove the large runner image if you no longer need it
```
