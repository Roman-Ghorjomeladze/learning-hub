The `shipit-api:dev` image from module 03 works, but it ships the TypeScript compiler and every devDependency, runs as root, references a moving base tag, only exists for one CPU architecture and says nothing about where it came from. In an interview — and in a security review — those are the first things people look at. This module fixes each one and explains the trade-offs, so you can defend every line of a production Dockerfile.

## What "production-grade" means for an image

| Property | Why it matters | Technique |
| --- | --- | --- |
| Small | Faster pulls, faster scaling, less attack surface | Multi-stage builds, minimal base, prod-only deps |
| Minimal attack surface | Fewer packages = fewer CVEs and fewer tools for an attacker | Slim/distroless/hardened bases, no shells/compilers in runtime |
| Least privilege | Container escapes and app exploits are less damaging | Non-root `USER`, read-only files, no extra capabilities |
| Reproducible | Same inputs → same image; safe rollbacks | Pinned digests, lockfiles, `npm ci` |
| Correct shutdown and health | Zero-downtime deploys | Exec-form CMD, init process, SIGTERM handling, health checks |
| Multi-platform | Runs on Apple Silicon laptops, Graviton and x86 nodes | `buildx --platform linux/amd64,linux/arm64` |
| Traceable | Know what's inside and where it came from | OCI labels, SBOM, provenance, semver + SHA tags |
| Fast to build | Developer and CI productivity | Layer ordering, cache mounts, remote cache |

## Multi-stage builds

A multi-stage Dockerfile has several `FROM` instructions. Each starts a **stage** with its own filesystem; later stages copy only what they need from earlier ones with `COPY --from=<stage>`. The final stage is the image; everything else is discarded (but cached).

```text
 ┌───────────── build-base (node:22 slim) ─────────────┐
 │                                                       │
 ├─► deps:      package*.json → npm ci (all deps)        │
 │     └─► build:  tsconfig + src → npm run build → dist/│
 │                                                       │
 └─► prod-deps: package*.json → npm ci --omit=dev        │
                                                         │
 runtime (node:22 slim or distroless) ◄── COPY dist ─────┘
                                      ◄── COPY node_modules (prod only)
```

The production Dockerfile for `shipit-api`:

```dockerfile
# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
# In real projects pin the digest too, e.g.
# ARG BASE_IMAGE=node:22-bookworm-slim@sha256:<digest>

############################
# Build stages
############################
FROM node:${NODE_VERSION}-bookworm-slim AS build-base
WORKDIR /app

FROM build-base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build-base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

############################
# Runtime stage
############################
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Files stay owned by root: the app can read but not modify its own code
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The official node images ship a 'node' user with UID/GID 1000
USER 1000:1000
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
```

Why each choice:

- **Two dependency installs.** `deps` has everything needed to compile; `prod-deps` has only runtime dependencies. The runtime image never contains `typescript` or `@types/*`.
- **Stages run in parallel.** BuildKit builds `build` and `prod-deps` concurrently and skips stages the target doesn't need.
- **`--target`** builds an intermediate stage, e.g. `docker build --target build -t shipit-api:build .` for running tests in CI with dev dependencies available.
- **`tini`** as ENTRYPOINT forwards signals and reaps zombies — Kubernetes has no `--init` flag, so it belongs in the image. The app still handles SIGTERM itself for draining.
- **Root-owned files + non-root user.** If the app is compromised, the attacker can't rewrite its code or install tools.
- **Numeric `USER 1000:1000`.** Kubernetes' `runAsNonRoot: true` can only verify a *numeric* UID; with `USER node` the kubelet refuses to start the pod ("image has non-numeric user").

:::try Build a single stage
With the Dockerfile above in `~/hub-labs/shipit-api` (Lab 1 creates it), build only the compile stage and look inside:

```bash
docker build --target build -t shipit-api:build-stage .
docker run --rm shipit-api:build-stage ls node_modules/.bin | grep tsc
docker run --rm shipit-api:build-stage ls dist
```

The final image built without `--target` contains `dist` but no `tsc`.
:::

## Choosing a base image

| Family | Example | Size (uncompressed, approx.) | Shell / package manager | libc | Notes |
| --- | --- | --- | --- | --- | --- |
| Full Debian | `node:22-bookworm` | ~1 GB | yes / apt | glibc | Includes compilers; good for build stages, too big for runtime |
| Slim Debian | `node:22-bookworm-slim` | ~200–250 MB | yes / apt | glibc | Safe default: compatible, debuggable, moderate CVE count |
| Alpine | `node:22-alpine` | ~150–170 MB | yes / apk | **musl** | Small; native modules need musl builds; Node's Alpine builds are "experimental" tier |
| Distroless | `gcr.io/distroless/nodejs22-debian12:nonroot` | ~150 MB | **no / no** | glibc | Only Node + runtime libs; `:debug` tags add busybox; runs as UID 65532 with `:nonroot` |
| Chainguard / Wolfi | `cgr.dev/chainguard/node` | small | no (`-dev` variants have a shell and apk) | glibc | Rebuilt daily, very low CVE counts; free tier offers only the `latest` tags |
| Docker Hardened Images | Docker's hardened `node` images | small | minimal | glibc / musl variants | Hardened, low-CVE images with SBOMs and provenance; made free and open source by Docker in December 2025 |
| scratch | `FROM scratch` | 0 | no | none | For static binaries (Go, Rust) — not for Node |

Sizes vary by version and architecture — measure with `docker image ls` (Lab 2 does a bake-off).

How to decide for a Node service:

1. **Start with `-slim`** (Debian, glibc). Everything works, you can `docker exec` into it, and CVE counts are reasonable if you rebuild regularly.
2. **Move to distroless, Chainguard or Docker Hardened Images** when you want minimal attack surface and your team is comfortable debugging without a shell (`kubectl debug` ephemeral containers, `nsenter`, `/proc/<pid>/root`).
3. **Use Alpine deliberately**, not by default: musl differs from glibc (DNS resolution behaviour, performance characteristics, native addons like `sharp`, `bcrypt`, Prisma engines need musl-specific binaries). The size win over slim is modest for Node, because the Node binary itself dominates.
4. **Match build and runtime libc.** Install `node_modules` on the same family you run on: building native modules on Debian and copying them to Alpine breaks with "Error relocating" / "not found" errors.

:::warning A smaller image is not automatically a safer one
CVE scanners count packages. A slim image you rebuild weekly is safer than a distroless image pinned for a year. Whatever base you choose, automate base updates (Renovate/Dependabot on the digest) and rebuild on a schedule.
:::

## Running as non-root

By default, containers run as root (UID 0). Without user namespaces, that's UID 0 on the host kernel — with fewer capabilities, but still root over every file the container can reach (module 01).

```dockerfile
# Official node images already contain user 'node' (1000:1000)
USER 1000:1000

# For other bases, create a system user:
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
USER 10001:10001
```

Consequences to plan for:

- **Writable paths**: a non-root process can't write to root-owned directories. Write to `/tmp` or a mounted volume; if the app needs a directory, create it and `chown` it in the Dockerfile (`RUN mkdir -p /app/uploads && chown 1000:1000 /app/uploads`) — or better, use an external store (S3).
- **Ports below 1024** need `CAP_NET_BIND_SERVICE`. Listen on 3000/8080 and map ports instead.
- **Verify** with `docker run --rm image id` and `docker inspect -f '{{.Config.User}}' image`.
- In Kubernetes, combine with `securityContext: { runAsNonRoot: true, runAsUser: 1000, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }` (the security module goes deeper).

:::try Who do popular images run as?
```bash
for i in node:22-bookworm-slim postgres:17-alpine redis:8-alpine nginx:alpine gcr.io/distroless/nodejs22-debian12:nonroot; do
  docker pull -q "$i" >/dev/null
  printf '%-48s User=%s\n' "$i" "$(docker inspect -f '{{.Config.User}}' "$i")"
done
```

Most official images have an empty `User` (root) — some, like postgres and redis, start as root and drop privileges in their entrypoint script; the node image ships a `node` user you must opt into. The distroless `:nonroot` variant is non-root by default.
:::

## BuildKit mounts: cache, secrets, SSH

`RUN --mount=...` attaches something to a single `RUN` step **without** adding it to a layer.

### Cache mounts

```dockerfile
RUN --mount=type=cache,target=/root/.npm \
    npm ci
```

npm's download cache persists across builds in the builder, so when `package-lock.json` changes, `npm ci` re-downloads only new packages instead of everything. Similar targets: `/var/cache/apt` + `/var/lib/apt/lists` (with `sharing=locked`), `/root/.cache/pip`, `/go/pkg/mod`. Cache mounts are local to the builder — on ephemeral CI runners, combine with layer cache export (`--cache-to type=gha` / `type=registry`).

### Secret mounts

Private npm registry tokens are the classic Node case:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=cache,target=/root/.npm \
    npm ci
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t shipit-api:prod .
# or from an environment variable (CI):
docker build --secret id=npmrc,env=NPMRC_CONTENT -t shipit-api:prod .
```

The file exists only during that `RUN`, isn't part of any layer, doesn't appear in `docker history`, and doesn't affect the cache key. Compare with the anti-patterns: `ARG NPM_TOKEN` (recorded in history), `COPY .npmrc` then `RUN rm .npmrc` (still in the earlier layer).

### SSH mounts

To fetch private git dependencies with your SSH agent, without copying keys:

```dockerfile
RUN mkdir -p -m 0700 /root/.ssh && ssh-keyscan github.com >> /root/.ssh/known_hosts
RUN --mount=type=ssh git clone git@github.com:acme/private-lib.git /src/private-lib
```

```bash
ssh-add -l                      # make sure your agent has a key loaded
docker build --ssh default -t app .
```

## Multi-platform images with buildx

Your Mac is arm64; many production clusters are amd64, and AWS Graviton nodes are arm64 again. One tag should serve both:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/roma-g/shipit-api:1.1.0 \
  --push .
docker buildx imagetools inspect ghcr.io/roma-g/shipit-api:1.1.0
```

The result is an **image index** (manifest list) with one manifest per platform. Each client pulls the matching one.

How the non-native platform gets built:

1. **Emulation (QEMU via binfmt_misc)**: the builder runs amd64 `RUN` steps under emulation on your arm64 Mac. Docker Desktop and OrbStack set this up; elsewhere run `docker run --privileged --rm tonistiigi/binfmt --install all`. Works for anything, but emulated `npm ci` or compilation can be 5–20× slower.
2. **Cross-compilation**: run build steps natively on the build machine's platform and only produce target-specific output. BuildKit provides automatic args:

| Arg | Example |
| --- | --- |
| `BUILDPLATFORM` | `linux/arm64` (where the build runs) |
| `TARGETPLATFORM` | `linux/amd64` (what you're building for) |
| `TARGETOS`, `TARGETARCH`, `TARGETVARIANT` | `linux`, `amd64`, `` |

For TypeScript, compiling is platform-independent, so run that stage natively:

```dockerfile
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build-base
```

Dependencies with **native addons** (bcrypt, sharp, better-sqlite3) must be installed for the *target* platform, so keep `prod-deps` on the target platform (no `--platform` override). Pure-JS dependency trees can install on `$BUILDPLATFORM` too.

3. **Native builders**: a buildx builder with nodes of each architecture (e.g. an arm64 Mac plus a remote amd64 machine, or CI runners per arch) — fastest for heavy builds.

Builder requirements: the classic image store can't hold multi-platform images. With the **containerd image store** (default on Docker Desktop and new Docker Engine 29+ installs) the default builder can build and `--load` multi-platform images locally. Otherwise create a `docker-container` builder:

```bash
docker buildx create --name multiarch --driver docker-container --use
docker buildx ls
```

:::mac Testing the other architecture locally
`docker run --rm --platform linux/amd64 ghcr.io/roma-g/shipit-api:1.1.0 node -p process.arch` runs the amd64 variant under emulation and prints `x64`. It's a quick smoke test that the amd64 image starts — not a performance test.
:::

## Health checks

```dockerfile
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
```

- Docker runs the command inside the container; exit 0 = healthy, 1 = unhealthy. Status shows in `docker ps` (`healthy`, `unhealthy`, `starting`) and `docker inspect -f '{{json .State.Health}}'` (last results with output).
- **Don't depend on tools the image doesn't have.** `curl` isn't in slim or distroless images; Node 22's built-in `fetch` is. In distroless, use `/nodejs/bin/node` in the exec form.
- Compose uses health status for `depends_on: condition: service_healthy`; Docker Swarm replaces unhealthy tasks. Plain `docker run` only *reports* health — it doesn't restart unhealthy containers.
- **Kubernetes ignores `HEALTHCHECK`.** It uses liveness/readiness/startup probes defined in the pod spec (shipit's `/healthz` and `/readyz`). Keep the Dockerfile health check cheap and liveness-like.

## Labels, annotations and metadata

Use the standard OCI keys so registries and tools understand your images:

```dockerfile
ARG VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_DATE
LABEL org.opencontainers.image.title="shipit-api" \
      org.opencontainers.image.description="Items API for the shipit sample app" \
      org.opencontainers.image.source="https://github.com/roma-g/shipit" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="MIT"
```

```bash
docker build \
  --build-arg VERSION=1.1.0 \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t shipit-api:1.1.0 .
docker image inspect shipit-api:1.1.0 --format '{{json .Config.Labels}}' | jq
```

- GHCR uses `org.opencontainers.image.source` to link the package to its repository.
- **Labels** live in the image config; **annotations** live on manifests/indexes (`docker buildx build --annotation "index:org.opencontainers.image.description=..."`). Registries display annotations for multi-platform indexes, where there's no single config.
- Put labels that change per build (`revision`, `created`) at the **end** of the Dockerfile so they don't invalidate earlier cached layers.

## SBOM and provenance attestations

A **software bill of materials (SBOM)** lists every package in the image (OS packages and npm modules, with versions and licences). **Provenance** records how the image was built: source repo and commit, build arguments, builder, base images. Both are supply-chain requirements in many organisations (SLSA, executive orders, customer audits).

BuildKit generates them as **attestations** attached to the image index:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --sbom=true \
  --provenance=mode=max \
  -t ghcr.io/roma-g/shipit-api:1.1.0 --push .

# For a multi-platform image, .SBOM and .Provenance are maps keyed by platform
docker buildx imagetools inspect ghcr.io/roma-g/shipit-api:1.1.0 --format '{{ json .SBOM }}' | jq 'keys'
docker buildx imagetools inspect ghcr.io/roma-g/shipit-api:1.1.0 --format '{{ json .SBOM }}' \
  | jq -r '.["linux/arm64"].SPDX.packages[].name' | head -20
docker buildx imagetools inspect ghcr.io/roma-g/shipit-api:1.1.0 --format '{{ json .Provenance }}' \
  | jq '.["linux/arm64"].SLSA | keys'
```

- Minimal provenance (`mode=min`) is attached by default when pushing with buildx; `mode=max` adds build args and more detail (never put secrets in build args!).
- Attestations appear in the index as extra manifests with platform `unknown/unknown` — that's normal.
- Scanners consume them: `trivy image`, `docker scout cves`, `grype`. Signing images (cosign/Sigstore, Notation) is the next step, covered in the security module.

## Reproducibility

"Rebuild the same commit" should give you the same software:

- **Pin base images by digest** (`FROM node:22-bookworm-slim@sha256:...`) and let a bot open PRs for updates.
- **Lock dependencies** (`package-lock.json`) and install with `npm ci`.
- **Avoid unpinned downloads** (`curl .../latest/...`); use `ADD --checksum=sha256:...` or package-manager versions.
- **Don't bake build-time data** that changes every build into early layers (timestamps, random IDs).
- For bit-for-bit reproducible images, BuildKit honours `SOURCE_DATE_EPOCH` (e.g. `--build-arg SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` with the `rewrite-timestamp=true` output option) to normalise timestamps.

## Image size optimisation checklist

1. Multi-stage: compile in one stage, copy artefacts to a clean runtime stage.
2. `npm ci --omit=dev` for runtime dependencies; consider `npm prune --omit=dev` alternatives only if you can't reinstall.
3. Minimal base (slim → distroless/hardened).
4. Clean package manager caches in the same `RUN` (`rm -rf /var/lib/apt/lists/*`, `apk add --no-cache`), or use cache mounts.
5. `.dockerignore` everything that isn't needed.
6. Check with `dive` (wasted space) and `docker history`; don't chase the last megabyte at the expense of debuggability.

## Tagging strategy

| Tag | Example | Mutable? | Use |
| --- | --- | --- | --- |
| Full semver | `1.4.2` | Should be immutable | Releases; what humans refer to |
| Minor / major | `1.4`, `1` | Moves with patches | Consumers who want automatic patches |
| Git SHA | `sha-3f9c2ab` | Immutable | Trace any image back to a commit; every CI build |
| Branch | `main`, `pr-123` | Moves | Preview environments |
| `latest` | `latest` | Moves | Convenience only — never in deployments |
| Digest | `@sha256:...` | Immutable by definition | **What you actually deploy** |

Rules that save incidents:

- Every CI build pushes `sha-<short>`; releases add `X.Y.Z` (+ `X.Y`, `X`).
- Turn on **tag immutability** in the registry (ECR supports it per repository) so `1.4.2` can't be overwritten.
- Deploy by **digest** (or tag + digest: `ghcr.io/roma-g/shipit-api:1.4.2@sha256:...`). Kubernetes, ECS and Compose all accept it. Rollback = redeploy the previous digest.
- In GitHub Actions, `docker/metadata-action` generates these tags and OCI labels from git metadata.

## Linting and scanning

**hadolint** parses the Dockerfile and runs ShellCheck on `RUN` lines:

```bash
hadolint Dockerfile
docker run --rm -i hadolint/hadolint < Dockerfile     # no install needed
```

Common rules:

| Rule | Meaning |
| --- | --- |
| DL3006 / DL3007 | Always tag base images / don't use `latest` |
| DL3008 / DL3018 | Pin apt / apk package versions |
| DL3009 | Delete apt lists after installing |
| DL3015 | Use `--no-install-recommends` |
| DL3016 | Pin npm package versions in `npm install` |
| DL3020 | Use `COPY` instead of `ADD` for files |
| DL3025 | Use JSON (exec form) for `CMD`/`ENTRYPOINT` |
| DL3002 | Last `USER` should not be root |
| DL4006 | Set `SHELL ["/bin/bash", "-o", "pipefail", "-c"]` before `RUN` with pipes |
| SC2086 etc. | ShellCheck findings inside `RUN` |

Configure exceptions explicitly in `.hadolint.yaml` (e.g. ignoring DL3008 if you deliberately don't pin apt versions) and fail CI on warnings:

```yaml
# .hadolint.yaml
failure-threshold: warning
ignored:
  - DL3008   # apt versions not pinned: we rebuild weekly from a pinned base digest instead
trustedRegistries:
  - docker.io
  - gcr.io
  - ghcr.io
```

BuildKit also has built-in **build checks**: `docker build --check .` reports issues like `JSONArgsRecommended`, `FromAsCasing`, `UndefinedVar` without building.

**Scan the image**, not just the Dockerfile:

```bash
trivy image --severity HIGH,CRITICAL shipit-api:prod
trivy image --ignore-unfixed --exit-code 1 --severity CRITICAL shipit-api:prod   # CI gate
docker scout quickview shipit-api:prod                                            # Docker's scanner
```

:::deep Why distroless debugging is not as scary as it sounds
Without a shell, `docker exec -it app sh` fails. You still have options:

- **Debug variant**: `gcr.io/distroless/nodejs22-debian12:debug` adds busybox. Build a debug tag from the same Dockerfile with a build arg selecting the base, never ship it to prod.
- **Share namespaces with a tool container**: `docker run -it --rm --pid=container:app --network=container:app nicolaka/netshoot` — you see the app's processes and network with a full toolbox. `/proc/1/root` inside that container is the app's filesystem.
- **Kubernetes ephemeral containers**: `kubectl debug -it pod/app --image=busybox --target=app` injects a debugging container into a running pod.
- **Node's inspector**: start with `--inspect=0.0.0.0:9229` in a debug deployment, or send `SIGUSR1` to enable the inspector at runtime (`kill -USR1 1` from a namespace-sharing container), then port-forward 9229 and attach Chrome DevTools.
- **Heap snapshots**: `node --heapsnapshot-signal=SIGUSR2 dist/index.js`, trigger with `docker kill -s SIGUSR2 app`, then `docker cp app:/app/Heap...heapsnapshot .` — mind the writable path for non-root users (set `--diagnostic-dir=/tmp`).
:::

## Pitfalls

- **Copying `node_modules` from a stage with a different libc or architecture** (Debian → Alpine, arm64 → amd64) → native module crashes.
- **`USER node` instead of a numeric UID** → Kubernetes `runAsNonRoot` refuses to start the pod.
- **`HEALTHCHECK` that calls `curl` in an image without curl** → permanently `unhealthy`.
- **Changing labels early in the Dockerfile** (`ARG GIT_SHA` + `LABEL` at the top) → cache busted on every commit.
- **Emulated multi-arch builds of heavy native deps** → 30-minute CI builds; use cross-compilation or native builders.
- **Treating `--provenance=mode=max` as harmless** → it records build args; secrets in args leak.
- **Pinning digests and never updating** → stale, vulnerable images. Automate updates.

## Summary

- Multi-stage builds separate compile-time from runtime: `deps` → `build` → `prod-deps` → minimal `runtime`.
- Base image: slim by default; distroless/Chainguard/Docker Hardened Images for minimal surface; Alpine only with musl in mind.
- Run as a numeric non-root UID with root-owned, read-only app files; bake in `tini`.
- `RUN --mount=type=cache|secret|ssh` speeds builds and keeps credentials out of layers.
- `docker buildx build --platform linux/amd64,linux/arm64 --push` produces one index for both architectures; cross-compile platform-independent steps with `$BUILDPLATFORM`.
- Add `HEALTHCHECK` (Docker/Compose only), OCI labels, SBOM and provenance attestations.
- Tag with semver + git SHA, make release tags immutable, deploy by digest.
- Lint with hadolint and `docker build --check`; scan with Trivy or Docker Scout.
