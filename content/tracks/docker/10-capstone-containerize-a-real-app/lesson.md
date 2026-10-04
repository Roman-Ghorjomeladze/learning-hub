This capstone is where you prove you can take an application from "runs on my laptop" to a set of production-grade container images and Compose stacks that another engineer, a CI pipeline or a server can use with confidence. There is no new theory here: everything comes from modules 00 to 09. What's new is putting it all together, making trade-offs, and documenting them.

Treat it like a real ticket at work. Read the brief, sketch the architecture, then work through the milestones in the labs. Each milestone has a reference solution; try first, compare after.

## The brief

> **Ticket SHIP-142: Containerize shipit for production**
>
> shipit is a small inventory service. It has a TypeScript API (`shipit-api`, Node.js 22, Express, PostgreSQL, Redis) and a tiny static web UI (`shipit-web`, HTML + vanilla JS) that lists and adds items.
>
> We want to run it identically on developer Macs (Apple Silicon), in CI (amd64 Linux) and on a single amd64 or Graviton (arm64) VM in AWS. Deliver:
>
> 1. Production Dockerfiles for both apps: multi-stage, multi-arch (`linux/amd64`, `linux/arm64`), non-root, with healthchecks, small and reproducible.
> 2. A development Compose setup with hot reload, migrations and gated startup.
> 3. A prod-like Compose setup using the published images, hardened at runtime, with secrets and network isolation.
> 4. Images published to GitHub Container Registry (GHCR) with SBOM and provenance attestations, scanned with no fixable critical vulnerabilities.
> 5. A README that lets a new teammate run, test, debug and release the project in under 15 minutes.

## Architecture

```text
                        ┌──────────────────────── network: edge ────────────────────────┐
  browser ──▶ :8080 ──▶ │  web  (nginx-unprivileged, static files, /api/* reverse proxy) │
                        │        │                                                       │
                        │        ▼  http://api:3000                                      │
                        │  api  (Node 22, compiled TS, non-root, read-only rootfs)       │
                        └────────┬───────────────────────────────────────────────────────┘
                                 │      network: data  (internal: true, no egress)
                    ┌────────────┼───────────────────────────────┐
                    │  migrate (one-off: node dist/migrate.js)   │
                    │      │                                     │
                    │      ▼                                     │
                    │  db (postgres:18) ◀── volume pgdata         │
                    │  cache (redis:8-alpine) ◀── volume redisdata│
                    └────────────────────────────────────────────┘

 Startup order:   db healthy ──┐
                  cache healthy ┼──▶ migrate exits 0 ──▶ api healthy ──▶ web starts
 Secrets:         db_password (file) ──▶ db (POSTGRES_PASSWORD_FILE), api + migrate (DB_PASSWORD_FILE)
 Published ports: prod: only web (8080).  dev: web 8080, api 3000, db 127.0.0.1:5432 for GUI clients
```

Key design decisions (you may make different ones if you can justify them):

| Decision | Choice | Why |
| --- | --- | --- |
| API runtime base | `node:22-alpine` (stretch: distroless) | Small, has a shell for healthchecks and debugging; distroless is smaller in attack surface but harder to debug |
| TypeScript in prod | Compile with `tsc` in a build stage; ship only `dist/` + prod `node_modules` | No compiler or dev deps at runtime |
| Build stage platform | `FROM --platform=$BUILDPLATFORM` for the TypeScript compile | JS output is architecture-independent; compiling natively avoids slow emulation |
| Web server | `nginxinc/nginx-unprivileged` | Runs as non-root on 8080 with zero capabilities |
| API exposure | Only through nginx at `/api/*` | One origin, no CORS, one published port in prod |
| Migrations | Separate `migrate` service using the API image | Runs once before the API, safe with multiple API replicas |
| Secrets | Compose file secrets, `*_FILE` env convention | Not in env, not in layers, not in `docker inspect` |
| Data | Named volumes; DB and Redis on an internal network | Persistence, no internet access for data stores |

## Repository layout

```text
shipit/
├── api/
│   ├── src/
│   │   ├── config.ts       # env + *_FILE secrets
│   │   ├── server.ts       # Express app: /healthz /readyz /items
│   │   └── migrate.ts      # idempotent schema migration
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── Dockerfile          # targets: dev, runtime
│   └── .dockerignore
├── web/
│   ├── public/
│   │   ├── index.html
│   │   └── app.js
│   ├── nginx/default.conf
│   ├── Dockerfile
│   └── .dockerignore
├── compose.yaml            # development (watch, published dev ports)
├── compose.prod.yaml       # prod-like (GHCR images, hardening, secrets)
├── .env.example
├── secrets/                # gitignored; db_password.txt
├── .github/workflows/images.yml   # stretch: CI build/scan/push
└── README.md
```

## Acceptance criteria

Your capstone is done when all of these are true. The labs' "Verify" sections check them milestone by milestone.

**Images**

- [ ] `api` and `web` images build for `linux/amd64` and `linux/arm64` from a clean checkout with `docker buildx build`.
- [ ] Both images run as a non-root user (`docker inspect -f '{{.Config.User}}'` is not empty or `root`).
- [ ] Both images define a `HEALTHCHECK` that works with the binaries in the image.
- [ ] The API runtime image contains no TypeScript compiler, no dev dependencies, no source `.ts` files and no secrets (`docker history --no-trunc` is clean).
- [ ] Image sizes (uncompressed, arm64): **api ≤ 200 MB**, **web ≤ 80 MB**. Record the actual numbers in the README.
- [ ] Changing only `src/` doesn't re-run `npm ci` (dependency layers are cached).

**Development stack** (`docker compose up --watch`)

- [ ] One command brings up web, api, migrate, db, cache; `migrate` exits 0 before `api` starts.
- [ ] Editing `api/src/*.ts` reloads the API within ~2 s without a rebuild; editing `web/public/*` is visible on refresh.
- [ ] Changing `api/package.json` triggers a rebuild automatically.
- [ ] `http://localhost:8080` lists items and can add one; data survives `docker compose down && docker compose up`.

**Prod-like stack** (`docker compose -f compose.yaml -f compose.prod.yaml ...` or a standalone `compose.prod.yaml`)

- [ ] Uses the images from GHCR by tag (stretch: by digest), builds nothing.
- [ ] Only `web` publishes a port. `db` and `cache` are on an internal network.
- [ ] `api` and `web` run with `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, tmpfs `/tmp`, memory/CPU/PID limits.
- [ ] The DB password is a Compose secret; no password appears in `docker inspect` of any container.
- [ ] Log rotation is configured for every service.
- [ ] `docker compose up -d --wait` succeeds and `curl localhost:8080/api/readyz` returns ready.
- [ ] `docker compose stop` completes in under 3 seconds (graceful SIGTERM handling).

**Supply chain**

- [ ] Images are pushed to `ghcr.io/<you>/shipit-api` and `ghcr.io/<you>/shipit-web` with a version tag and the git SHA as tags.
- [ ] SBOM and provenance attestations are attached (`docker buildx imagetools inspect ... --format '{{json .SBOM}}'` shows data).
- [ ] A scan (Trivy, Grype or Docker Scout) shows no **fixable CRITICAL** vulnerabilities; results summarised in the README.
- [ ] Stretch: a GitHub Actions workflow builds, scans and pushes on every tag, with actions pinned to commit SHAs.

**Documentation**

- [ ] README covers: architecture diagram, prerequisites, dev quickstart, prod-like run, configuration table (env vars + secrets), migrations, debugging tips, release process, image sizes and scan summary, known limitations.

## Rubric

Score yourself honestly after finishing. 80+ means you're operating at a solid senior level with Docker.

| Area | Points | Excellent looks like |
| --- | --- | --- |
| Dockerfiles | 20 | Multi-stage, correct layer ordering, `.dockerignore`, `BUILDPLATFORM` for arch-independent stages, cache mounts, exec-form `CMD`, OCI labels, no secrets |
| Image quality | 15 | Non-root, minimal runtime, size targets met, working healthchecks, app files not writable by the app user |
| Compose (dev) | 15 | Healthcheck-gated startup, migration job, watch configured correctly, interpolation guards (`:?`), sensible defaults |
| Compose (prod-like) | 15 | Hardened runtime, secrets, internal network, limits, log rotation, only web published, no build sections |
| Multi-arch & registry | 10 | Both platforms built and pushed, tags follow a scheme (semver + SHA), attestations attached |
| Security & scanning | 10 | Scan in place with a sensible gate, findings triaged, no fixable criticals, base images pinned |
| Operability | 10 | Graceful shutdown, clear logs to stdout, `/healthz` vs `/readyz`, easy debugging story |
| Documentation | 5 | A teammate can run it in 15 minutes and knows how to release and troubleshoot |

:::tip Work in small, verifiable steps
Commit after each milestone (use a Git repo even if you never push it). If something breaks later, `git diff` against the last working milestone is the fastest debugger you have.
:::

## Milestone plan

| # | Milestone | Covers modules | Time |
| --- | --- | --- | --- |
| 1 | API image: TypeScript, multi-stage, non-root, healthcheck | 03, 04, 08 | 75 min |
| 2 | Web image: static files + nginx reverse proxy, unprivileged | 03, 06, 08 | 45 min |
| 3 | Dev stack: Compose with watch, migrations, gated startup | 05, 06, 07 | 75 min |
| 4 | Prod-like stack: hardening, secrets, isolation, logging | 06, 07, 08, 09 | 75 min |
| 5 | Multi-arch build, GHCR push, attestations, scan, size | 04, 08 | 75 min |
| 6 | README, review against the rubric, stretch goals | all | 60+ min |

:::warning Costs and accounts
Everything here is free: GHCR is free for public images and has a free allowance for private ones on personal accounts. You need a GitHub account and a personal access token (classic) with `write:packages` (and `read:packages`) to push from your Mac. Don't commit the token, and delete it when you're done if you created it just for this.
:::

## Reference: things you'll want at hand

```bash
# Build and inspect
docker buildx build --platform linux/amd64,linux/arm64 -t <ref> --push .
docker buildx imagetools inspect <ref>
docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}'
docker history --no-trunc <image>
dive <image>                                   # brew install dive

# Run and check
docker compose up --watch
docker compose -f compose.yaml -f compose.prod.yaml config
docker compose ps -a; docker compose logs -f api
docker inspect -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' <c>
docker inspect -f '{{json .State.Health}}' <c> | jq

# Supply chain
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
trivy image --severity CRITICAL --ignore-unfixed --exit-code 1 <ref>
docker scout quickview <ref>
```

:::deep Why build the TypeScript stage on $BUILDPLATFORM?
When you run `docker buildx build --platform linux/amd64,linux/arm64` on an Apple Silicon Mac, BuildKit builds the image graph once per target platform. Any stage whose `FROM` resolves to the *target* platform runs under emulation for amd64 (QEMU or Rosetta), which can make `npm ci` and `tsc` several times slower.

`FROM --platform=$BUILDPLATFORM node:22-alpine AS build` pins that stage to the machine doing the build (arm64 on your Mac, amd64 on a GitHub runner). Because `tsc` emits plain JavaScript, its output is identical for every target, so BuildKit can even share the result between both platform builds. The `prod-deps` stage, on the other hand, must run on the *target* platform: if any dependency has native code (bcrypt, sharp, argon2), `npm ci` must fetch or compile binaries for the target architecture and libc. shipit's dependencies are pure JS, but structuring the Dockerfile this way means adding a native module later won't silently break the arm64 or amd64 image.

The same pattern is used for Go (`GOOS`/`GOARCH` cross-compilation with `$TARGETOS`/`$TARGETARCH`) and is what the official multi-platform docs call cross-compilation.
:::

## After the capstone

You now have a reusable template for containerizing services. The Kubernetes track takes these exact images and runs them on a kind cluster with Deployments, Services, probes mapped from `/healthz` and `/readyz`, Secrets, and Gateway API routing. Keep this repository; you'll build on it.
