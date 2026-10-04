These labs upgrade `shipit-api` step by step into a production image. You need the project from module 03 (`~/hub-labs/shipit-api` with `package.json`, `package-lock.json`, `tsconfig.json`, `src/index.ts` and `.dockerignore`). If you skipped it, do module 03 Lab 2 steps 1–3 first.

Tools used: `docker buildx`, `hadolint`, `trivy`, `dive`, `jq` (all installed in module 00).

```bash
cd ~/hub-labs/shipit-api
ls package.json package-lock.json tsconfig.json src/index.ts .dockerignore
```

## Lab 1: Multi-stage build for shipit-api

:::meta
difficulty: medium
time: 30 min
:::

Goal: replace the single-stage Dockerfile with a multi-stage, non-root, health-checked image and measure the difference.

### Steps

1. Keep the old Dockerfile for comparison and make sure the dev image exists:

```bash
mv Dockerfile Dockerfile.simple
docker build -q -t shipit-api:dev -f Dockerfile.simple .
```

2. Create the new `Dockerfile` — the production Dockerfile from the lesson:

```dockerfile
# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

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

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
```

3. Build and compare:

```bash
docker build -t shipit-api:prod .
docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' | grep shipit-api
```

4. Check what is (and isn't) inside:

```bash
docker run --rm shipit-api:prod id
docker run --rm shipit-api:prod ls node_modules | grep -cE '^(typescript|@types)$' || true
docker run --rm shipit-api:prod sh -c 'touch /app/dist/hacked 2>&1; ls -l /app'
docker inspect -f 'user={{.Config.User}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}' shipit-api:prod
```

5. Run it and watch the health status change:

```bash
docker run -d --name prod -p 127.0.0.1:3000:3000 shipit-api:prod
docker ps --filter name=prod --format '{{.Status}}'; sleep 20; docker ps --filter name=prod --format '{{.Status}}'
docker inspect -f '{{json .State.Health}}' prod | jq '{Status, FailingStreak, last: .Log[-1]}'
docker exec prod ps -o pid,user,args 2>/dev/null || docker top prod
time docker stop prod
```

### Verify

- `shipit-api:prod` is noticeably smaller than `shipit-api:dev` (typically 100+ MB less).
- `id` prints `uid=1000(node) gid=1000(node)`; the `grep -c` prints `0` (no TypeScript or `@types` in the runtime image).
- `touch /app/dist/hacked` fails with `Permission denied` — the app can't modify its own code.
- Status goes from `(health: starting)` to `(healthy)`; PID 1 is `tini`, with node as its child.
- `docker stop` takes well under a second.

:::hint
If the health check stays `starting` for long, remember `--start-period=10s` plus `--interval=15s`: the first check runs about 15 s after start. If `ps` isn't available, `docker top prod` shows processes from the host side.
:::

:::solution
```text
$ docker image ls ... | grep shipit-api
shipit-api:prod   ~235MB
shipit-api:dev    ~330MB

$ docker run --rm shipit-api:prod id
uid=1000(node) gid=1000(node) groups=1000(node)
$ docker run --rm shipit-api:prod sh -c 'touch /app/dist/hacked 2>&1; ls -l /app'
touch: cannot touch '/app/dist/hacked': Permission denied
drwxr-xr-x  3 root root 4096 ... dist
drwxr-xr-x 70 root root 4096 ... node_modules
-rw-r--r--  1 root root  402 ... package.json

$ docker inspect -f '{{json .State.Health}}' prod | jq '{Status, FailingStreak, last: .Log[-1]}'
{ "Status": "healthy", "FailingStreak": 0, "last": { "ExitCode": 0, "Output": "" } }

$ docker top prod
UID    PID    PPID   CMD
1000   61231  61209  /usr/bin/tini -- node dist/index.js
1000   61260  61231  node dist/index.js
```

Most of the savings come from dropping TypeScript, `@types/*` and other dev dependencies. The base image (slim Debian + Node ≈ 200 MB) now dominates — Lab 2 explores other bases.

Why the image still has `sh`: it's slim Debian. That's handy for debugging now, and a reason to consider distroless later.
:::

### Clean up

```bash
docker rm -f prod 2>/dev/null || true
```

## Lab 2: Base image bake-off

:::meta
difficulty: medium
time: 35 min
:::

Goal: build the same app on four bases and compare size, vulnerabilities, debuggability and startup.

### Steps

1. Create `Dockerfile.bases` with one target per base:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Alpine needs its own (musl) dependency install
FROM node:22-alpine AS prod-deps-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:22-bookworm-slim AS slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 1000:1000
CMD ["node", "dist/index.js"]

FROM node:22-alpine AS alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps-alpine /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 1000:1000
CMD ["node", "dist/index.js"]

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS distroless
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["dist/index.js"]

FROM cgr.dev/chainguard/node:latest AS chainguard
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["dist/index.js"]
```

2. Build all four:

```bash
for t in slim alpine distroless chainguard; do
  docker build -q -f Dockerfile.bases --target "$t" -t "shipit-api:$t" . >/dev/null && echo "built $t"
done
```

3. Compare size, user, shell availability and startup:

```bash
for t in slim alpine distroless chainguard; do
  size=$(docker image ls "shipit-api:$t" --format '{{.Size}}')
  user=$(docker inspect -f '{{.Config.User}}' "shipit-api:$t")
  shell=$(docker run --rm --entrypoint sh "shipit-api:$t" -c 'echo yes' 2>/dev/null || echo no)
  docker run -d --name "bake-$t" -p 127.0.0.1::3000 "shipit-api:$t" >/dev/null
  sleep 2
  port=$(docker port "bake-$t" 3000 | head -1 | cut -d: -f2)
  health=$(curl -s "localhost:$port/healthz")
  printf '%-11s size=%-8s user=%-8s shell=%-4s healthz=%s\n' "$t" "$size" "${user:-root}" "$shell" "$health"
  docker rm -f "bake-$t" >/dev/null
done
```

4. Count HIGH/CRITICAL vulnerabilities with Trivy (the first run downloads its database):

```bash
for t in slim alpine distroless chainguard; do
  n=$(trivy image -q --severity HIGH,CRITICAL --format json "shipit-api:$t" | jq '[.Results[]?.Vulnerabilities[]?] | length')
  echo "$t: $n HIGH/CRITICAL"
done
```

5. Open the distroless image in dive and find where Node lives:

```bash
dive shipit-api:distroless
```

### Verify

- You have a table with four rows; all four return `{"status":"ok"}`.
- `slim` and `alpine` have a shell; `distroless` and `chainguard` print `shell=no`.
- `distroless` runs as `65532` (nonroot) and `chainguard` as a non-root user too, without any `USER` line in your Dockerfile.
- Vulnerability counts differ between bases; the minimal bases usually report the fewest.

:::hint
`docker run --entrypoint sh` fails on distroless/Chainguard because there is no `/bin/sh` — that's the point. If Trivy is slow, add `--scanners vuln` to skip secret scanning. If `cgr.dev` is blocked on your network, skip the Chainguard target.
:::

:::solution
Example output (numbers change constantly — what matters is the pattern):

```text
slim        size=233MB    user=1000:1000 shell=yes  healthz={"status":"ok"}
alpine      size=172MB    user=1000:1000 shell=yes  healthz={"status":"ok"}
distroless  size=165MB    user=65532   shell=no   healthz={"status":"ok"}
chainguard  size=158MB    user=65532*  shell=no   healthz={"status":"ok"}

slim: 4 HIGH/CRITICAL
alpine: 0 HIGH/CRITICAL
distroless: 1 HIGH/CRITICAL
chainguard: 0 HIGH/CRITICAL
```

\* The exact user value comes from each image's config — check it with `docker inspect`; what matters is that it's non-root.

Discussion:

- The Node binary (~100 MB) dominates every variant, so size differences are modest. Pick on **attack surface, patch cadence and debuggability**, not megabytes.
- Alpine required a separate `npm ci` on musl. With native addons, copying Debian-built `node_modules` into Alpine would crash.
- Distroless's entrypoint is `/nodejs/bin/node` (look at `docker inspect -f '{{json .Config.Entrypoint}}' shipit-api:distroless`), so `CMD` is just the script path.
- Chainguard's free tier only offers `latest`-style tags; it moved to the newest Node major, which can surprise you. For pinned versions you'd need their paid tier, or Docker Hardened Images, which are free.
- In dive, distroless has only a handful of small layers: base files, glibc/libssl, then Node under `/nodejs`.

For shipit-api, a reasonable decision: **slim** for development and early environments, **distroless or a hardened image** for production, built from the same Dockerfile via `--target`.
:::

### Clean up

```bash
docker image rm shipit-api:slim shipit-api:alpine shipit-api:distroless shipit-api:chainguard
```

Keep `Dockerfile.bases` if you want to revisit it.

## Lab 3: Secret mounts vs leaked build args, and cache mounts

:::meta
difficulty: medium
time: 30 min
:::

Goal: see a token leak through `ARG`, prevent it with a secret mount, and measure what a cache mount buys you.

### Steps

1. Create a fake private-registry config. It only applies to a fictional `@acme` scope, so public packages install normally:

```bash
cat > /tmp/demo.npmrc <<'EOF'
@acme:registry=https://npm.acme.example/
//npm.acme.example/:_authToken=npm_FAKE_TOKEN_123456
EOF
```

2. The leaky way:

```bash
cat > Dockerfile.leak <<'EOF'
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_TOKEN
RUN echo "@acme:registry=https://npm.acme.example/" > .npmrc \
 && echo "//npm.acme.example/:_authToken=${NPM_TOKEN}" >> .npmrc \
 && npm ci --omit=dev \
 && rm .npmrc
EOF
docker build -q --build-arg NPM_TOKEN=npm_FAKE_TOKEN_123456 -t token:leak -f Dockerfile.leak .
docker history --no-trunc --format '{{.CreatedBy}}' token:leak | grep -o 'NPM_TOKEN=[^ ]*'
```

3. The safe way:

```bash
cat > Dockerfile.secret <<'EOF'
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    --mount=type=cache,target=/root/.npm \
    npm config get @acme:registry && npm ci --omit=dev
EOF
docker build --progress=plain --secret id=npmrc,src=/tmp/demo.npmrc -t token:safe -f Dockerfile.secret . 2>&1 | grep -E 'acme|added'
docker history --no-trunc --format '{{.CreatedBy}}' token:safe | grep -c FAKE_TOKEN || true
docker run --rm token:safe sh -c 'cat /root/.npmrc 2>&1; ls -la /root'
```

4. Measure the cache mount. Add a dependency (changes the lockfile), then build with and without the cache mount:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund dayjs@^1
sed '/type=cache/d' Dockerfile.secret > Dockerfile.nocache
grep -c 'type=cache' Dockerfile.nocache || true
time docker build -q --secret id=npmrc,src=/tmp/demo.npmrc -t token:nocache -f Dockerfile.nocache .
time docker build -q --secret id=npmrc,src=/tmp/demo.npmrc -t token:safe -f Dockerfile.secret .
```

### Verify

- Step 2 prints `NPM_TOKEN=npm_FAKE_TOKEN_123456` — the token is in the image metadata for anyone who can pull it.
- Step 3 prints `https://npm.acme.example/` during the build (the secret was visible to `npm`), the history grep prints `0`, and `/root/.npmrc` doesn't exist (or is empty) in the image.
- In step 4 the cache-mounted build is faster, because npm only downloads the new package; the other build downloads everything.

:::hint
Both builds in step 4 miss the layer cache (the lockfile changed), so the difference comes purely from npm's download cache in `/root/.npm`. Run each a second time after another dependency change to confirm the pattern; network speed adds noise.
:::

:::solution
```text
$ docker history ... token:leak | grep -o 'NPM_TOKEN=[^ ]*'
NPM_TOKEN=npm_FAKE_TOKEN_123456

#8 0.512 https://npm.acme.example/
#8 3.104 added 82 packages in 3s
0
cat: /root/.npmrc: No such file or directory

# step 4
token:nocache   real 0m14.9s
token:safe      real 0m4.2s
```

- BuildKit records the values of build args used by a `RUN` (`RUN |1 NPM_TOKEN=...`) in the image config history. Deleting `.npmrc` in the same `RUN` kept the file out of the layer, but not the arg out of the metadata.
- The secret mount is a tmpfs-backed file that exists only during that `RUN`; it's not in the layer, the history or the cache key — rotating the token doesn't even bust the cache.
- With `--provenance=mode=max`, build args are also written into the provenance attestation — another reason secrets must never be args.
- Revoke any real token that ever went through an `ARG`.

Revert the extra dependency:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm uninstall --package-lock-only --no-audit --no-fund dayjs
```
:::

### Clean up

```bash
rm -f Dockerfile.leak Dockerfile.secret Dockerfile.nocache /tmp/demo.npmrc
docker image rm token:leak token:safe token:nocache
```

## Lab 4: Multi-platform build with attestations

:::meta
difficulty: hard
time: 40 min
:::

Goal: publish shipit-api for `linux/amd64` and `linux/arm64` with SBOM and provenance, inspect the index, run the non-native variant, and speed up the build with cross-compilation.

### Steps

1. Start a local registry (skip if it's still running from module 03):

```bash
docker run -d --name registry -p 127.0.0.1:5001:5000 registry:3
```

2. Check your builder supports multi-platform:

```bash
docker buildx ls
docker info --format '{{.Driver}} {{json .DriverStatus}}'
```

3. Build and push both platforms with attestations, timing it (amd64 steps run under emulation):

```bash
time docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --sbom=true --provenance=mode=max \
  -t localhost:5001/shipit-api:1.1.0 \
  --push .
```

4. Inspect the result:

```bash
docker buildx imagetools inspect localhost:5001/shipit-api:1.1.0
docker buildx imagetools inspect localhost:5001/shipit-api:1.1.0 --format '{{json .SBOM}}' | jq 'keys'
docker buildx imagetools inspect localhost:5001/shipit-api:1.1.0 --format '{{json .SBOM}}' \
  | jq -r '.["linux/amd64"].SPDX.packages[].name' | grep -E '^(express|pg|ioredis)$'
docker buildx imagetools inspect localhost:5001/shipit-api:1.1.0 --format '{{json .Provenance}}' \
  | jq '.["linux/arm64"].SLSA.invocation.configSource // .["linux/arm64"].SLSA.buildDefinition.externalParameters.configSource'
```

5. Run each platform:

```bash
docker run --rm --platform linux/arm64 localhost:5001/shipit-api:1.1.0 node -p "process.arch"
docker run --rm --platform linux/amd64 localhost:5001/shipit-api:1.1.0 node -p "process.arch"
```

6. Cross-compile the platform-independent stages: change the first `FROM` in your `Dockerfile` to

```dockerfile
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build-base
```

then rebuild without cache and compare the time:

```bash
time docker buildx build --no-cache \
  --platform linux/amd64,linux/arm64 \
  -t localhost:5001/shipit-api:1.1.1 --push .
```

### Verify

- `imagetools inspect` lists manifests for `linux/amd64` and `linux/arm64`, plus two `unknown/unknown` attestation manifests.
- The SBOM contains `express`, `pg` and `ioredis`.
- Step 5 prints `arm64` and `x64`.
- The cross-compiled build (step 6) is faster than the emulated one, because `npm ci` and `tsc` ran natively for both targets; only the runtime stage's `apt-get` ran under emulation.

:::hint
If step 3 fails with "Multi-platform build is not supported for the docker driver", your engine uses the classic image store. Either enable the containerd image store (Docker Desktop: Settings → General → "Use containerd for pulling and storing images") or create a container builder that can reach your local registry:

```bash
docker buildx create --name multiarch --driver docker-container --driver-opt network=host --use
```

`network=host` lets the builder reach `localhost:5001`. If the amd64 build fails with `exec format error`, install emulators: `docker run --privileged --rm tonistiigi/binfmt --install all`.
:::

:::solution
```text
$ docker buildx imagetools inspect localhost:5001/shipit-api:1.1.0
Name:      localhost:5001/shipit-api:1.1.0
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:0c4b...

Manifests:
  Name:        localhost:5001/shipit-api:1.1.0@sha256:a1...
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    linux/amd64

  Name:        localhost:5001/shipit-api:1.1.0@sha256:b2...
  Platform:    linux/arm64

  Name:        localhost:5001/shipit-api:1.1.0@sha256:c3...
  Platform:    unknown/unknown
  Annotations:
    vnd.docker.reference.digest: sha256:a1...
    vnd.docker.reference.type:   attestation-manifest
  ...

$ jq 'keys'
["linux/amd64","linux/arm64"]

express
ioredis
pg

arm64
x64

# timings (example, M-series Mac)
emulated build:        real 1m52s
cross-compiled build:  real 0m41s
```

Why cross-compiling works here: TypeScript output and pure-JS `node_modules` are identical on every platform, so `deps`, `build` and `prod-deps` can run once on your native arm64 builder and be copied into both runtime images. If shipit-api used a native addon (e.g. `bcrypt`), you'd keep `prod-deps` on the target platform:

```dockerfile
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps   # no --platform: builds per target
```

or, with recent npm versions, fetch the target's prebuilt optional dependencies via `npm ci --cpu=x64 --os=linux` (check `npm help ci` for `--cpu/--os/--libc` support in your npm version).

Attestation manifests reference the platform manifest they describe (`vnd.docker.reference.digest`). Scanners and policy engines (e.g. Docker Scout, Kyverno with attestation checks) read them from the registry.
:::

### Clean up

Keep the registry running for Lab 6, or remove it with `docker rm -f registry`. Keep the `$BUILDPLATFORM` change in your Dockerfile.

## Lab 5: Break and fix — the image that won't stay healthy

:::meta
difficulty: medium
time: 30 min
:::

Goal: a teammate "hardened" the image by adding a non-root user, a health check and log files. Now the container won't start, and after a first fix it's permanently unhealthy and silent. Diagnose every problem.

### Steps

1. Create the broken Dockerfile:

```bash
cat > Dockerfile.broken <<'EOF'
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
RUN mkdir -p /app/logs
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=2s --retries=2 CMD curl -fs http://localhost:3000/healthz || exit 1
CMD node dist/index.js >> /app/logs/app.log 2>&1
EOF
docker build -q -t shipit-api:broken -f Dockerfile.broken .
docker run -d --name broken -p 127.0.0.1:3000:3000 shipit-api:broken
sleep 3; docker ps -a --filter name=broken --format '{{.Status}}'
```

2. Investigate with `docker logs`, `docker inspect` (`.State`, `.Config.Cmd`, `.State.Health`) and `docker run --rm --entrypoint ...` against the image. Fix **only the first problem** you find, rebuild, rerun, and investigate again.

3. Run hadolint on the broken file and map each warning to a real-world consequence:

```bash
hadolint Dockerfile.broken
```

4. Write `Dockerfile.fixed` that resolves every issue, and verify it.

### Verify

- `shipit-api:fixed` reaches `(healthy)`.
- `docker logs` shows the app's startup line.
- `docker stop` completes in under a second.
- `hadolint Dockerfile.fixed` reports no warnings (or only ones you consciously ignore with a reason).

:::hint
Problem 1: what user owns `/app/logs`, and what user tries to write to it? Problem 2: what does `.State.Health.Log[-1].Output` say — is `curl` installed in `node:22-slim`? Problem 3: where does stdout go, and what does `docker logs` read? Problem 4: shell-form `CMD` — who is PID 1? Also look at `COPY . .`, `npm install` and the dev dependencies in the final image.
:::

:::solution
Problem 1 — the container exits immediately:

```text
$ docker ps -a --filter name=broken --format '{{.Status}}'
Exited (2) 2 seconds ago
$ docker logs broken
/bin/sh: 1: cannot create /app/logs/app.log: Permission denied
```

`RUN mkdir` ran as root, so `/app/logs` is root-owned; the shell running as `node` can't create the file, and dash exits with 2. (A quick fix would be `chown`, but writing log files is the real mistake.)

Problem 2 — after chown-ing the directory, the container runs but is `unhealthy`:

```text
$ docker inspect -f '{{json .State.Health}}' broken | jq '.Log[-1]'
{ "ExitCode": 1, "Output": "/bin/sh: 1: curl: not found\n" }
```

`node:22-slim` has no curl. Use Node's built-in `fetch` in exec form.

Problem 3 — `docker logs` is empty: stdout is redirected into `/app/logs/app.log` inside the container, so the logging driver sees nothing. Logs vanish with the container, fill the writable layer, and never reach your log collector. Log to stdout/stderr.

Problem 4 — `docker stop` takes 10 seconds: shell-form `CMD` makes `/bin/sh -c` PID 1 (it can't `exec` because of the redirection), and it doesn't forward SIGTERM to node.

hadolint findings (exact output varies by version):

```text
Dockerfile.broken:4 DL3059 info: Multiple consecutive `RUN` instructions. Consider consolidation.
Dockerfile.broken:10 DL3025 warning: Use arguments JSON notation for CMD and ENTRYPOINT arguments
```

DL3025 is Problem 4 in disguise. Just as instructive is what hadolint **can't** see: that `curl` isn't in the base image, that `/app/logs` is root-owned, that `npm install` (instead of `npm ci`) makes installs non-reproducible, that `node:22-slim` is a floating tag, that `COPY . .` before installing busts the cache on every change, and that TypeScript and devDependencies ship in the final image. Linting is a floor, not a review.

`Dockerfile.fixed` — essentially Lab 1's Dockerfile:

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=22
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build-base
WORKDIR /app

FROM build-base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build-base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
```

```bash
hadolint Dockerfile.fixed      # may still suggest pinning apt versions (DL3008) — ignore it consciously in .hadolint.yaml
docker build -q -t shipit-api:fixed -f Dockerfile.fixed .
docker run -d --name fixed -p 127.0.0.1:3001:3000 shipit-api:fixed
sleep 20; docker ps --filter name=fixed --format '{{.Status}}'
docker logs fixed
time docker stop fixed
```
:::

### Clean up

```bash
docker rm -f broken fixed 2>/dev/null || true
docker image rm shipit-api:broken shipit-api:fixed
rm -f Dockerfile.broken Dockerfile.fixed
```

## Lab 6: Challenge — a release pipeline on your laptop

:::meta
difficulty: hard
time: 60 min
:::

Goal: produce a release of shipit-api that would pass a strict platform team's review, using a script you could drop into CI.

### Requirements

Write `release.sh <version>` (e.g. `./release.sh 1.2.0`) in `~/hub-labs/shipit-api` that:

1. Fails unless the git working tree is clean; derives `GIT_SHA` (short and full) from `HEAD`.
2. Resolves the **current digest** of `node:22-bookworm-slim` and builds with the base **pinned by digest** (pass it as a build arg; don't hand-edit the Dockerfile per release).
3. Runs `hadolint` (failing on warnings, with any ignores documented in `.hadolint.yaml`).
4. Builds a local single-platform candidate, then gates on: runs as a **numeric non-root UID**, contains no `typescript`, becomes **healthy** within 30 s, and `trivy` finds **no fixable CRITICAL** vulnerabilities.
5. Builds and pushes a **multi-platform** (`linux/amd64`, `linux/arm64`) image to `localhost:5001/shipit-api` with tags `<version>`, `<major>.<minor>`, `<major>` and `sha-<short sha>`, with OCI labels (`title`, `source`, `version`, `revision`, `created`), **SBOM** and **max provenance**.
6. Prints the immutable deploy reference: `localhost:5001/shipit-api:<version>@sha256:...`.

:::hint
`docker buildx imagetools inspect node:22-bookworm-slim --format '{{json .Manifest}}' | jq -r .digest` gives the index digest. Make the base configurable with `ARG BASE_IMAGE=node:22-bookworm-slim` before the first `FROM` and use `FROM ${BASE_IMAGE}`. For the health gate, poll `docker inspect -f '{{.State.Health.Status}}'`. After pushing, `imagetools inspect <ref> --format '{{json .Manifest}}' | jq -r .digest` gives the pushed index digest. `docker buildx build --metadata-file meta.json` also records it (`containerimage.digest`).
:::

:::solution
Dockerfile changes (top and bottom; the middle stays as in Lab 1/Lab 4):

```dockerfile
# syntax=docker/dockerfile:1
ARG BASE_IMAGE=node:22-bookworm-slim

FROM --platform=$BUILDPLATFORM ${BASE_IMAGE} AS build-base
WORKDIR /app

# ... deps, build, prod-deps stages unchanged ...

FROM ${BASE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

# Per-build metadata last, so it never invalidates cached layers above
ARG VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="shipit-api" \
      org.opencontainers.image.source="https://github.com/roma-g/shipit" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
```

`.hadolint.yaml`:

```yaml
failure-threshold: warning
ignored:
  - DL3008   # apt versions not pinned; the base image is pinned by digest and rebuilt regularly
  # If your hadolint version flags DL3029 for `FROM --platform=$BUILDPLATFORM`, ignore it here too:
  # cross-compilation is intentional.
```

`release.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
VERSION="${1:?usage: release.sh <semver>}"
[[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "not semver: $VERSION" >&2; exit 1; }
MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"
REPO=localhost:5001/shipit-api
cd "$(dirname "$0")"

# 1. clean tree + git metadata
git diff --quiet && git diff --cached --quiet || { echo "working tree not clean" >&2; exit 1; }
GIT_SHA=$(git rev-parse HEAD); SHORT_SHA=$(git rev-parse --short HEAD)
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 2. pin the base by digest
BASE_DIGEST=$(docker buildx imagetools inspect node:22-bookworm-slim --format '{{json .Manifest}}' | jq -r .digest)
BASE_IMAGE="node:22-bookworm-slim@${BASE_DIGEST}"
echo "base: $BASE_IMAGE"

ARGS=(--build-arg "BASE_IMAGE=$BASE_IMAGE" --build-arg "VERSION=$VERSION"
      --build-arg "GIT_SHA=$GIT_SHA" --build-arg "BUILD_DATE=$BUILD_DATE")

# 3. lint
hadolint Dockerfile

# 4. local candidate + gates
docker buildx build "${ARGS[@]}" --load -t shipit-api:candidate .
USER_ID=$(docker inspect -f '{{.Config.User}}' shipit-api:candidate)
[[ "$USER_ID" =~ ^[1-9][0-9]*(:[0-9]+)?$ ]] || { echo "gate: USER must be numeric non-root, got '$USER_ID'" >&2; exit 1; }
if docker run --rm shipit-api:candidate test -d node_modules/typescript; then
  echo "gate: typescript found in runtime image" >&2; exit 1
fi
CID=$(docker run -d shipit-api:candidate)
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' "$CID")
  [ "$STATUS" = healthy ] && break
  sleep 1
done
[ "$STATUS" = healthy ] || { echo "gate: not healthy (status=$STATUS)" >&2; docker logs "$CID" >&2; exit 1; }
trivy image -q --ignore-unfixed --severity CRITICAL --exit-code 1 shipit-api:candidate

# 5. multi-platform push with labels, SBOM and provenance
docker buildx build "${ARGS[@]}" \
  --platform linux/amd64,linux/arm64 \
  --sbom=true --provenance=mode=max \
  -t "$REPO:$VERSION" -t "$REPO:$MAJOR.$MINOR" -t "$REPO:$MAJOR" -t "$REPO:sha-$SHORT_SHA" \
  --push .

# 6. immutable reference
DIGEST=$(docker buildx imagetools inspect "$REPO:$VERSION" --format '{{json .Manifest}}' | jq -r .digest)
echo "deploy: $REPO:$VERSION@$DIGEST"
```

Run it:

```bash
chmod +x release.sh
git add -A && git commit -qm "release tooling"
./release.sh 1.2.0
curl -s localhost:5001/v2/shipit-api/tags/list
```

```text
base: node:22-bookworm-slim@sha256:5f1c...
...
deploy: localhost:5001/shipit-api:1.2.0@sha256:8e2a...
{"name":"shipit-api","tags":["1","1.2","1.2.0","sha-3f9c2ab"]}
```

Points a reviewer would look for:

- Base pinned by digest without editing the Dockerfile per release; a bot can bump the default `ARG` later.
- Gates run on the exact image (same Dockerfile, same args) before anything is pushed; the multi-platform build reuses the cache, so it's fast.
- Labels come last so per-build values don't bust the cache.
- The output is a **digest** reference for deployment manifests; tags are for humans.
- In real CI you'd push to GHCR/ECR, enable tag immutability for `X.Y.Z` and `sha-*`, sign the digest (cosign), and generate tags with `docker/metadata-action` — the logic is the same.
:::

### Clean up

```bash
docker rm -f registry 2>/dev/null || true
docker image rm shipit-api:candidate 2>/dev/null || true
docker buildx rm multiarch 2>/dev/null || true
```

Keep `~/hub-labs/shipit-api` — the Compose and Kubernetes modules deploy this image.
