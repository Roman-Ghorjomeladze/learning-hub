An image is the unit you build, scan, ship and deploy. Getting it right affects build speed (seconds vs minutes in CI), security (what's inside), and reliability (whether "the same image" really is the same). This module covers how images are identified and moved around, then the Dockerfile language and build cache in depth, and ends with a first working image for `shipit-api`. Module 04 turns that image into a production-grade one.

## What an image is (quick recap)

From module 01: an image is an **OCI manifest** pointing to a **config** (default command, env, user, working directory, exposed ports, labels, history) and an ordered list of **read-only layers**, all addressed by SHA-256 digests. Multi-platform images add an **index** that maps platforms (linux/amd64, linux/arm64) to manifests.

A Dockerfile is a recipe: each filesystem-changing instruction (`RUN`, `COPY`, `ADD`) produces a layer; other instructions (`ENV`, `CMD`, `EXPOSE`, `USER`, `LABEL`...) only change the config.

## Image references: registry, repository, tag, digest

```text
 ghcr.io / roma-g / shipit-api : 1.4.2 @ sha256:9f86d081884c7d65...
 └─ registry ┘└ namespace ┘└ repo ┘ └ tag ┘ └──────── digest ────────┘
```

| Part | Default if omitted | Notes |
| --- | --- | --- |
| Registry | `docker.io` (Docker Hub) | Any hostname with a dot or port: `ghcr.io`, `123456789012.dkr.ecr.eu-central-1.amazonaws.com`, `localhost:5001` |
| Namespace | `library` on Docker Hub (official images) | Your user or organisation |
| Repository | — | The image name |
| Tag | `latest` | **Mutable** pointer, set by whoever pushes |
| Digest | — | **Immutable** content hash of the manifest or index |

So `nginx` means `docker.io/library/nginx:latest`, and `node:22-alpine` means `docker.io/library/node:22-alpine`.

**Tags move; digests don't.** `node:22-alpine` today and in three weeks are different images (new Node patch, new Alpine fixes). A digest identifies exactly one artifact forever — if a byte changed, the digest would change.

```bash
docker pull node:22-alpine
docker image inspect node:22-alpine --format '{{json .RepoDigests}}'
# ["node@sha256:6e80991f69cc7722c561e5d14d5e72ab47c0d6b6cfb3ae50fb9cf9a7b30fdf97"]
docker pull node@sha256:6e80991f...       # always exactly this content
docker run --rm node:22-alpine@sha256:6e80991f... node --version   # tag is ignored when a digest is present
```

:::info "latest" is just a tag name
`latest` has no special meaning beyond being the default when you omit a tag. It isn't necessarily the newest build, and it changes whenever someone pushes it. Never deploy `latest` — module 04 covers a proper tagging strategy (semver + git SHA, deploy by digest).
:::

## Registries: Docker Hub, GHCR, ECR

A registry stores manifests and blobs and implements the OCI distribution API. Common choices:

| Registry | Address | Login |
| --- | --- | --- |
| Docker Hub | `docker.io` (default) | `docker login` (use a personal access token, not your password) |
| GitHub Container Registry | `ghcr.io/<owner>/<image>` | `echo "$GITHUB_TOKEN" \| docker login ghcr.io -u <user> --password-stdin` (classic PAT with `write:packages`, or `GITHUB_TOKEN` in Actions) |
| Amazon ECR | `<account>.dkr.ecr.<region>.amazonaws.com/<repo>` | `aws ecr get-login-password --region eu-central-1 \| docker login --username AWS --password-stdin <account>.dkr.ecr.eu-central-1.amazonaws.com` (token valid 12 h) |
| Local registry | `localhost:5001/<image>` | none (`docker run -d -p 5001:5000 registry:3`) |

```bash
docker login ghcr.io -u roma-g --password-stdin < ~/.secrets/ghcr-token
docker tag shipit-api:dev ghcr.io/roma-g/shipit-api:1.0.0   # a new name for the same image ID
docker push ghcr.io/roma-g/shipit-api:1.0.0
docker pull ghcr.io/roma-g/shipit-api:1.0.0
docker logout ghcr.io
```

- `docker tag` copies nothing; it adds a reference to the same image.
- Pushing uploads only the layers the registry doesn't already have ("Layer already exists").
- ECR repositories must exist before you push (`aws ecr create-repository --repository-name shipit-api`); GHCR and Docker Hub create them on first push.
- Credentials are stored by a credential helper (`osxkeychain` on macOS — see `credsStore` in `~/.docker/config.json`), not in plain text, when a helper is configured.

:::warning Docker Hub rate limits
Docker Hub limits pulls for anonymous and free users (per IP for anonymous pulls). CI runners behind a shared IP hit this quickly and fail with `toomanyrequests`. Always `docker login` in CI, use a pull-through cache or mirror (ECR pull-through cache, Harbor), or copy base images into your own registry.
:::

## The build: context, builder and Dockerfile

```text
   docker build -t shipit-api:dev .
                                  │
                                  └── build CONTEXT: this directory (minus .dockerignore)
   ┌────────────┐   sends context + Dockerfile    ┌──────────────────────────┐
   │ docker CLI │ ──────────────────────────────► │ BuildKit (in dockerd or  │
   │ (buildx)   │ ◄────────────────────────────── │ a buildx builder)        │
   └────────────┘   progress, then image          │ executes steps, caches   │
                                                  └──────────────────────────┘
```

- The **build context** is the set of files the builder can `COPY`. `COPY` can never reach outside it (`COPY ../secrets` fails).
- BuildKit (the default builder) transfers context files lazily and incrementally, but a huge context (a `node_modules` folder, `.git`, build output, test fixtures) still slows builds and risks leaking files into images.
- `docker build` is an alias for `docker buildx build`. `-f path/to/Dockerfile` selects a different Dockerfile; `--progress=plain` shows full step output; `--no-cache` ignores the cache; `--pull` re-checks base images.

### .dockerignore

Placed at the context root, it uses glob patterns similar to `.gitignore`:

```text
# .dockerignore for a Node/TypeScript service
node_modules
npm-debug.log*
dist
coverage
.git
.github
.vscode
.env
.env.*
!.env.example
Dockerfile*
compose*.yaml
*.md
```

:::try See what your context contains
BuildKit reports the context size on every build. Compare a folder with and without a big ignored directory:

```bash
mkdir -p /tmp/ctx-demo/node_modules && cd /tmp/ctx-demo
head -c 52428800 /dev/zero > node_modules/big.bin          # 50 MB of fake dependencies
printf 'FROM alpine:3.22\nCOPY . /ctx\nRUN du -sh /ctx\n' > Dockerfile
docker build --no-cache --progress=plain . 2>&1 | grep -E 'transferring context|/ctx'
echo node_modules > .dockerignore
docker build --no-cache --progress=plain . 2>&1 | grep -E 'transferring context|/ctx'
cd ~ && rm -rf /tmp/ctx-demo
```

The first build transfers ~50 MB and copies it into the image; the second transfers a few bytes.
:::

Two reasons it matters beyond speed:

1. **Correctness**: copying your Mac's `node_modules` into a Linux image brings macOS/arm64 native binaries (bcrypt, sharp, esbuild) that crash or misbehave in the container. Dependencies must be installed *inside* the build.
2. **Security**: `.env` files, cloud credentials and `.git` history end up in a layer forever — anyone who pulls the image can extract them.

## Dockerfile instructions

Start every Dockerfile with a syntax directive. It pins the Dockerfile frontend, so you get current features (heredocs, `--mount`, `--chmod`) regardless of the engine version:

```dockerfile
# syntax=docker/dockerfile:1
```

| Instruction | Purpose | Notes |
| --- | --- | --- |
| `FROM image [AS name]` | Base image; starts a build stage | Pin a specific tag (`node:22.11-bookworm-slim`) or digest. `FROM scratch` = empty |
| `RUN cmd` | Execute a command at build time → new layer | Combine related commands; clean up in the same `RUN` |
| `COPY src dest` | Copy files from the context (or `--from=stage`) | `--chown=node:node`, `--chmod=755`, `--link` |
| `ADD src dest` | Like COPY, plus remote URLs, git repos and auto-extraction of local tar archives | Prefer `COPY` unless you need these features; use `--checksum` for URLs |
| `WORKDIR /app` | Set (and create) the working directory | Use absolute paths; never `RUN cd ...` |
| `ENV KEY=value` | Env var at build time **and** runtime | Persists in the image config |
| `ARG NAME=default` | Build-time variable (`--build-arg NAME=x`) | Not in the runtime env, but visible in `docker history` |
| `USER node` | User (and group) for subsequent `RUN`, `CMD`, `ENTRYPOINT` | Run apps as non-root (module 04) |
| `EXPOSE 3000` | Document the port | Doesn't publish |
| `CMD ["node", "dist/index.js"]` | Default command / default args | Overridden by `docker run image <args>` |
| `ENTRYPOINT ["tini", "--"]` | The executable that always runs | Overridden only with `--entrypoint` |
| `LABEL key=value` | Metadata | OCI labels in module 04 |
| `VOLUME /data` | Declare a mount point; creates an anonymous volume per container | Mostly avoid in app images — it surprises users and hides data |
| `HEALTHCHECK CMD ...` | Container health probe | Module 04 |
| `SHELL ["/bin/bash", "-o", "pipefail", "-c"]` | Change the shell used by shell-form instructions | Useful for `pipefail` |
| `STOPSIGNAL SIGQUIT` | Signal sent by `docker stop` | nginx uses `SIGQUIT` for graceful shutdown |
| `ONBUILD ...` | Trigger instructions in images built *FROM* this one | Rare; confusing, avoid |

### RUN: combine, clean up in the same layer

```dockerfile
# Bad: three layers, the apt lists stay in layer 1 forever, and the update result is cached separately
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*

# Good: one layer, no stale cache, nothing left behind
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
```

A cached `RUN apt-get update` on its own line is reused for months; a later `apt-get install` change would then use stale package lists. Keep update and install in the same instruction.

BuildKit supports **heredocs** for readable multi-line scripts:

```dockerfile
RUN <<EOF
set -eux
apt-get update
apt-get install -y --no-install-recommends curl
rm -rf /var/lib/apt/lists/*
EOF
```

### COPY vs ADD

Use `COPY` by default. `ADD` silently extracts local tarballs and fetches URLs, which is surprising and, for URLs, unverified unless you add `--checksum=sha256:...`. Use `ADD` deliberately when you want those behaviours, e.g. `ADD --checksum=sha256:... https://example.com/tool.tar.gz /tmp/`.

## Shell form vs exec form

| | Exec form (JSON array) | Shell form |
| --- | --- | --- |
| Syntax | `CMD ["node", "dist/index.js"]` | `CMD node dist/index.js` |
| Runs as | `node dist/index.js` directly — node is PID 1 | `/bin/sh -c "node dist/index.js"` — the shell may be PID 1 |
| Signals | Delivered to your process | May stop at the shell (module 02) |
| Variable expansion | None (`$PORT` stays literal) | Shell expands `$PORT` |
| Needs a shell in the image | No (works with distroless/scratch) | Yes |

Rule: **exec form for `CMD` and `ENTRYPOINT`**; shell form is fine (and normal) for `RUN`. Exec form must use double quotes — `CMD ['node', 'x.js']` (single quotes) is not valid JSON and silently becomes shell form.

## CMD vs ENTRYPOINT

The final command is **ENTRYPOINT + CMD**. `docker run image args...` replaces CMD; `--entrypoint` replaces ENTRYPOINT.

| Dockerfile | `docker run img` | `docker run img --version` |
| --- | --- | --- |
| `CMD ["node", "server.js"]` | `node server.js` | `--version` (fails: not a command) |
| `ENTRYPOINT ["node"]` + `CMD ["server.js"]` | `node server.js` | `node --version` |
| `ENTRYPOINT ["tini", "--"]` + `CMD ["node", "server.js"]` | `tini -- node server.js` | `tini -- --version` |
| `ENTRYPOINT ["docker-entrypoint.sh"]` + `CMD ["node"]` | the script runs, usually ending with `exec "$@"` | script with `--version` |

Patterns:

- **App images**: `CMD ["node", "dist/index.js"]` (optionally with `ENTRYPOINT ["tini", "--"]`). Easy to override for one-off tasks: `docker run shipit-api node dist/migrate.js`.
- **Tool images** (behave like a binary): `ENTRYPOINT ["jq"]`, `CMD ["--help"]`. Users pass arguments: `docker run tool .items`.
- **Entrypoint scripts** for setup logic (wait for DB, render config): always end with `exec "$@"` so the CMD replaces the shell as PID 1.

```bash
#!/bin/sh
# docker-entrypoint.sh
set -e
if [ "$RUN_MIGRATIONS" = "true" ]; then
  node dist/migrate.js
fi
exec "$@"
```

:::try Predict the command
For each image, predict what runs, then check with `docker inspect -f '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' <image>`:

```bash
docker pull nginx:alpine && docker pull postgres:17-alpine && docker pull node:22-alpine
for i in nginx:alpine postgres:17-alpine node:22-alpine; do
  echo "$i: $(docker inspect -f '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' $i)"
done
```

All three official images use an entrypoint script plus a CMD. `docker run node:22-alpine -v` works — why? (Hint: read the script with `docker run --rm --entrypoint cat node:22-alpine /usr/local/bin/docker-entrypoint.sh`.)
:::

## ARG vs ENV

```dockerfile
ARG NODE_VERSION=22              # before FROM: only usable in FROM lines
FROM node:${NODE_VERSION}-bookworm-slim

ARG APP_VERSION=dev              # after FROM: available to following instructions in this stage
ENV NODE_ENV=production          # baked into the image, visible at runtime
LABEL org.opencontainers.image.version=$APP_VERSION
RUN echo "building $APP_VERSION"
```

```bash
docker build --build-arg NODE_VERSION=24 --build-arg APP_VERSION=1.4.2 -t shipit-api:1.4.2 .
```

| | `ARG` | `ENV` |
| --- | --- | --- |
| Set with | `--build-arg` (or default) | Dockerfile (override at runtime with `-e`) |
| Available during build | Yes (after declaration, within the stage) | Yes |
| Available at runtime | No | Yes |
| Visible in image metadata | In `docker history` for `RUN` lines that use it | In the image config |
| Scope | Ends at the end of the stage; an `ARG` before `FROM` must be re-declared inside a stage to use it there | Inherited by later stages built `FROM` this stage |

:::warning Never pass secrets with ARG or ENV
`--build-arg NPM_TOKEN=...` ends up in `docker history` and the image metadata; `ENV` is visible to anyone who runs `docker inspect`. Use BuildKit secret mounts (`RUN --mount=type=secret,...`) for build-time secrets — module 04.
:::

## Layers and the build cache

BuildKit reuses a cached result for an instruction when its **cache key** matches a previous build. Roughly:

- The key includes the **parent layer** and the **instruction text** (including build args it uses).
- For `COPY`/`ADD`, the key also includes a **checksum of the copied files' contents and metadata** (not modification times).
- `RUN` is **not** re-executed just because the outside world changed: `RUN apt-get update` or `RUN curl .../latest` stays cached until something earlier changes.
- **Once one step misses the cache, every later step in that stage rebuilds.**

So order instructions from **least to most frequently changing**:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
WORKDIR /app

# 1. Dependency manifests change rarely → this layer and `npm ci` stay cached
COPY package.json package-lock.json ./
RUN npm ci

# 2. Source changes on every commit → only these steps re-run
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

CMD ["node", "dist/index.js"]
```

If you write `COPY . .` before `npm ci`, any source change invalidates the copy, so `npm ci` reinstalls every dependency on every build — the single most common slow-Dockerfile mistake in Node projects.

:::deep How BuildKit actually builds
BuildKit converts the Dockerfile into a **directed acyclic graph** of low-level build operations (LLB). Benefits you can exploit:

- **Parallelism**: independent stages in a multi-stage build run concurrently, and stages not needed for the target are skipped entirely.
- **Content-based cache**: for `COPY`, the cache key is a checksum of the file contents, so `touch`ing a file or a fresh `git clone` (new mtimes) doesn't bust the cache, but changing one byte does.
- **Lazy context transfer**: only files referenced by `COPY`/`ADD` are sent, and only the changed ones on later builds. `.dockerignore` still matters because of pattern-matched copies like `COPY . .`.
- **Cache export/import**: the cache can live outside the builder — `--cache-to type=registry,ref=ghcr.io/roma-g/shipit-api:buildcache,mode=max` and `--cache-from` the same ref, or `type=gha` in GitHub Actions — so ephemeral CI runners still get cache hits.
- **Cache mounts** (`RUN --mount=type=cache,target=/root/.npm`) persist a directory across builds *without* putting it in a layer — module 04.

`docker buildx du` shows cache usage; `docker builder prune` clears it.
:::

## Inspecting images

```bash
docker image ls                                 # local images and sizes
docker history shipit-api:dev                   # layers, the instruction that created each, sizes
docker history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' shipit-api:dev
docker image inspect shipit-api:dev --format '{{json .Config}}' | jq
docker image inspect shipit-api:dev --format '{{.Architecture}} {{.Size}}'
dive shipit-api:dev                             # interactive layer explorer
```

**dive** shows each layer's file tree, highlights added/modified/removed files, and computes an "efficiency" score and wasted space (files duplicated or deleted in later layers). Use `dive --ci shipit-api:dev` in pipelines to fail builds below an efficiency threshold. In dive's UI, Tab switches panes, and Ctrl-U/Ctrl-A toggle showing only unmodified/added files.

## docker init

`docker init` asks a few questions (language, version, package manager, start command, port) and generates a solid starting point: `Dockerfile`, `compose.yaml`, `.dockerignore` and `README.Docker.md`.

```bash
cd ~/code/shipit-api
docker init
# ? What application platform does your project use? Node
# ? What version of Node do you want to use? 22
# ? Which package manager do you want to use? npm
# ? Do you want to run "npm run build" before starting your server? Yes
# ? What directory is your build output to? dist
# ? What command do you want to use to start the app? node dist/index.js
# ? What port does your server listen on? 3000
```

The generated Dockerfile already uses multi-stage builds, cache mounts and a non-root user. Treat it as a reviewed template, not magic: read every line and adjust (it won't know about your Postgres/Redis, health endpoints or monorepo layout).

## shipit-api: a first Dockerfile

The app (full code in Lab 2) is a small Express + TypeScript service. A straightforward single-stage Dockerfile:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first for cache reuse
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
```

It works and builds fast incrementally, but it's not production-ready: it ships the TypeScript compiler and all devDependencies, runs as root, has no health check, and the base image is referenced only by a mutable tag. Module 04 fixes each of those with a multi-stage build.

:::tip Why `npm ci` and not `npm install`
`npm ci` installs exactly what `package-lock.json` specifies, fails if `package.json` and the lockfile disagree, and deletes any existing `node_modules` first. Builds become reproducible. That's also why the lockfile must be committed and copied into the image.
:::

:::mac Images built on Apple Silicon are arm64
`docker build` on an M-series Mac produces a `linux/arm64` image by default. Push that to an amd64 server or cluster node and it fails with `exec format error`. For now, check with `docker image inspect -f '{{.Architecture}}' shipit-api:dev`; module 04 builds one tag for both architectures with `buildx --platform linux/amd64,linux/arm64`.
:::

## Pitfalls

- **`COPY . .` before installing dependencies** → no cache reuse, slow builds.
- **No `.dockerignore`** → host `node_modules` (wrong platform binaries), `.env` and `.git` in the image.
- **Mutable base tags** (`node:latest`, `node:22`) → builds change under you. Pin at least the minor version and variant; pin digests for reproducibility (module 04).
- **Deleting files in a later layer** → doesn't reduce size (module 01). Clean up in the same `RUN`.
- **Shell-form `CMD`** → signal problems; single-quoted JSON → silently shell form.
- **Secrets in `ARG`/`ENV`/`COPY`** → permanently in the image.
- **`apt-get update` in its own `RUN`** → stale package lists from cache.
- **`RUN cd /app && ...` instead of `WORKDIR`** → the `cd` doesn't persist to the next instruction.

## Summary

- Image references: `registry/namespace/repo:tag@digest`; tags are mutable, digests immutable.
- `docker tag` + `docker push` publish to Docker Hub, GHCR, ECR or a local registry; log in with tokens via `--password-stdin`.
- The build context is everything the builder can `COPY`; `.dockerignore` keeps it small and safe.
- Exec form for `CMD`/`ENTRYPOINT`; ENTRYPOINT + CMD = final command; entrypoint scripts end in `exec "$@"`.
- `ARG` is build-time only, `ENV` persists to runtime; neither is for secrets.
- Order Dockerfiles from stable to volatile: copy `package*.json`, `npm ci`, then copy source and build.
- `docker history`, `docker image inspect` and `dive` show what's inside; `docker init` bootstraps sensible files.
