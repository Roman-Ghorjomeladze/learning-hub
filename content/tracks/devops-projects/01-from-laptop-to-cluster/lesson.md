## The brief

You are the only platform engineer on a small team. The team has a TypeScript API, **shipit-api**, that stores items in PostgreSQL and caches reads in Redis. Today it runs with `npm run dev` on laptops. Your job is to give it a real delivery path that you can rebuild from nothing:

1. A **production-shaped service**: health endpoints, config from env vars, graceful shutdown, tests.
2. A **multi-arch container image** (linux/arm64 + linux/amd64) so the same tag runs on your Mac and on x86 cloud nodes.
3. A **cluster provisioned by Terraform**: kind, Gateway API CRDs, a Gateway implementation, metrics-server, namespaces and the database secret.
4. **Your own Helm charts** for the app and its data stores, deployed by Terraform's `helm_release` (and, as the final challenge, by Argo CD).
5. **One command** that creates everything from zero, verifies it end to end, and another that destroys it.

The labs for this module are milestones. Each one ends in a commit you could show someone. When you finish, you have a repository you can walk an interviewer through in ten minutes, and you can answer "why did you do it that way?" for every file.

:::info What "portfolio-grade" means here
Not "big". It means: reproducible (one command), explained (a README with an architecture diagram and decisions), verified (an automated smoke test, not "it worked on my machine"), and honest about trade-offs (what you would change for production on EKS/GKE). Interviewers care far more about your reasoning than about the number of tools.
:::

## What you will build

```text
shipit/
├── app/                       # shipit-api source (Node 22 + TypeScript)
│   ├── src/                   # config.ts, app.ts, db.ts, cache.ts, server.ts
│   ├── test/                  # node:test unit tests with fake dependencies
│   ├── Dockerfile             # multi-stage, multi-arch, non-root
│   ├── compose.yaml           # local Postgres + Redis for development
│   └── package.json / tsconfig*.json / eslint.config.mjs
├── deploy/
│   ├── charts/shipit-api/     # your app chart (Deployment, Service, HTTPRoute, PDB, HPA, NetworkPolicy)
│   ├── charts/shipit-data/    # Postgres StatefulSet + Redis Deployment
│   ├── argocd-bootstrap/      # tiny chart holding the Argo CD Application (challenge)
│   └── envs/local/values.yaml # environment-specific values (used by Terraform AND Argo CD)
├── infra/                     # Terraform root module
│   ├── versions.tf  variables.tf  cluster.tf  platform.tf  app.tf  outputs.tf
│   └── tests/plan.tftest.hcl  # terraform test with mock providers (used in Project 2)
├── scripts/smoke.sh           # end-to-end verification through the Gateway
└── Makefile                   # up / down / recreate / verify / image targets
```

Project 2 adds `.github/workflows/` to this same repository, and Project 3 breaks it on purpose. Create it as a real Git repository on GitHub from the first milestone.

## Architecture

```text
                        your Mac (Apple Silicon)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  curl -H "Host: shipit.local" http://localhost:8080/items                 │
 │            │                                                              │
 │            ▼  host port 8080 ──► kind extraPortMappings ──► nodePort 30080│
 │ ┌──────────────────────── kind cluster "shipit" ────────────────────────┐ │
 │ │  control-plane node                worker node                        │ │
 │ │                                                                        │ │
 │ │  ns: gateway                                                           │ │
 │ │   ┌───────────────────────────────┐                                    │ │
 │ │   │ Traefik (Gateway API provider)│  GatewayClass "traefik"            │ │
 │ │   │ Service type NodePort :30080  │  Gateway "traefik-gateway" :8000   │ │
 │ │   └──────────────┬────────────────┘                                    │ │
 │ │                  │ HTTPRoute (ns shipit, host shipit.local)            │ │
 │ │  ns: shipit      ▼                                                     │ │
 │ │   ┌──────────────────────────┐   readiness: /readyz (DB + Redis)       │ │
 │ │   │ Service shipit-api :80   │   liveness:  /healthz                   │ │
 │ │   └──────┬───────────┬───────┘                                         │ │
 │ │          ▼           ▼                                                 │ │
 │ │   ┌───────────┐ ┌───────────┐   Deployment, 2 replicas, PDB, (HPA)     │ │
 │ │   │shipit-api │ │shipit-api │   non-root, read-only rootfs             │ │
 │ │   └──┬─────┬──┘ └──┬─────┬──┘                                          │ │
 │ │      │     └───────┼─────┼────────────┐                                │ │
 │ │      ▼             ▼     │            ▼                                │ │
 │ │   ┌─────────────────────┐│     ┌──────────────┐                        │ │
 │ │   │ postgres (StatefulSet│     │ redis (Deploy)│  cache only,          │ │
 │ │   │ + PVC "standard")    │     │ no persistence│  no AOF/RDB           │ │
 │ │   └─────────────────────┘      └──────────────┘                        │ │
 │ │   Secret shipit-db (created by Terraform, random password)             │ │
 │ │                                                                        │ │
 │ │  ns: kube-system: metrics-server (for HPA)     ns: argocd (challenge)  │ │
 │ └────────────────────────────────────────────────────────────────────────┘ │
 │                                                                            │
 │  Terraform (infra/) ──► kind provider ──► cluster                          │
 │                     ──► kubectl apply  ──► Gateway API CRDs                │
 │                     ──► helm provider  ──► traefik, metrics-server,        │
 │                                            shipit-data, shipit-api         │
 │                     ──► kubernetes provider ──► namespaces, secret         │
 │                                                                            │
 │  docker buildx ──► ghcr.io/<you>/shipit-api:<tag>  (arm64 + amd64)         │
 │            or  ──► shipit-api:dev  ──► kind load (fast local loop)         │
 └────────────────────────────────────────────────────────────────────────────┘
```

Two flows matter, and you should be able to draw both on a whiteboard.

**Provisioning flow** (Terraform, in dependency order): kind cluster → Gateway API CRDs → namespaces → Traefik (creates GatewayClass + Gateway) and metrics-server → random password → Secret → `shipit-data` release → `shipit-api` release. Terraform derives most of this order from references; you add `depends_on` only where the dependency is invisible (a CRD that a chart needs to exist).

**Request flow**: `curl localhost:8080` → Docker port mapping into the kind control-plane container → kube-proxy NodePort 30080 → a Traefik pod → Traefik matches the HTTPRoute by `Host` header → Service `shipit-api` endpoints (only **Ready** pods) → container port 3000.

:::try Trace a request before you build anything
Look at the diagram and answer without notes: if both shipit-api pods fail their readiness probe, what does the client receive, and which component generates the response? (Answer: Traefik answers, typically `503 Service Unavailable`, because the Service has no ready endpoints. The app never sees the request.) You will verify this for real in Project 3.
:::

## The service: shipit-api in one page

The full source is in Lab 1. The shape is what matters:

| Concern | Decision |
| --- | --- |
| HTTP framework | Express 5 (native async error handling, no wrapper needed) |
| Config | `PORT`, `DATABASE_URL`, `REDIS_URL`, `SHUTDOWN_DELAY_MS`; missing required vars = exit 1 with a clear log line |
| Liveness `/healthz` | Always 200 while the process can serve HTTP. Never checks dependencies |
| Readiness `/readyz` | `SELECT 1` + Redis `PING` with a 1 s timeout; 503 when shutting down |
| `/items` | `GET` reads through a 30 s Redis cache (`x-cache: hit|miss` header); `POST` writes to Postgres and invalidates the cache |
| Migrations | `CREATE TABLE IF NOT EXISTS` at startup with retries (good enough here; see trade-offs) |
| Testability | `createApp(store, cache, state)` takes interfaces, so tests use in-memory fakes, no Docker needed |
| Shutdown | SIGTERM → fail readiness → wait `SHUTDOWN_DELAY_MS` → `server.close()` → close pool and Redis → exit 0; hard exit after 10 s |

:::warning Liveness must not check dependencies
If `/healthz` checked Postgres, a 30-second database failover would make kubelet restart every API pod at once. Restarting does not fix the database and turns a blip into an outage with cold starts. Liveness answers "is this process wedged?"; readiness answers "should I get traffic right now?".
:::

### Graceful shutdown: why the delay exists

When a pod is deleted (rollout, scale-down, node drain), two things happen **in parallel**: kubelet sends SIGTERM to the container, and the endpoints controller removes the pod from the Service's EndpointSlices, which Traefik and kube-proxy then pick up. There is no ordering guarantee between them. If your app exits immediately on SIGTERM, Traefik may still route a few requests to it for a second or two, and those fail with 502.

```text
 t=0s   Pod marked Terminating
        ├─► kubelet: SIGTERM to node process ───────────────┐
        └─► endpoints controller removes pod IP              │
             └─► Traefik/kube-proxy update (eventually)       │
                                                              ▼
 t=0s   app: shuttingDown=true, /readyz returns 503, KEEPS SERVING
 t=5s   app: server.close()  (stop accepting, finish in-flight, close idle keep-alives)
 t=5-6s app: pool.end(), redis.quit(), exit 0
 t=15s  app: safety net, process.exit(1) if something hangs
 t=30s  kubelet: SIGKILL (terminationGracePeriodSeconds) — never reached
```

The rule: `SHUTDOWN_DELAY_MS + max drain time < terminationGracePeriodSeconds`. A `preStop: sleep 5` hook achieves the same delay without app code; doing it in the app keeps the image free of a `sleep` binary dependency (distroless images have none) and lets you log it.

:::deep Why PID 1 and `npm start` matter for signals
In a container, your entrypoint is PID 1. The kernel does not apply default signal handlers to PID 1, so a process that does not explicitly handle SIGTERM ignores it, and kubelet must wait the full grace period and SIGKILL it. Node registers no SIGTERM handler by default, but because shipit-api calls `process.on("SIGTERM", ...)` it handles the signal correctly as PID 1.

The classic bug is `CMD ["npm", "start"]`: npm becomes PID 1, and depending on the npm version and shell wrapping, SIGTERM may not reach `node`, or npm exits before node finishes draining. Use `CMD ["node", "dist/server.js"]` (exec form, no shell). If you need a real init (to reap zombie processes spawned by child processes), add `tini` or run with `docker run --init`; in Kubernetes, `shareProcessNamespace` or an init binary in the image does the same job. shipit-api spawns no children, so node as PID 1 is fine.
:::

## The image: multi-stage and multi-arch

Your Mac builds `linux/arm64` by default. Most cloud nodes (and GitHub's default runners) are `linux/amd64`. Pushing an arm64-only image and deploying it to amd64 nodes gives `exec format error` at container start, the most common Apple Silicon deployment bug. The fix is an **image index** (manifest list) that contains both variants under one tag; the runtime pulls the one matching its node.

The Dockerfile in Lab 2 uses three stages:

```text
 build      FROM --platform=$BUILDPLATFORM node:22  ── npm ci (all deps) + tsc
            runs natively on your Mac even when targeting amd64 (JS output is arch-neutral)

 prod-deps  FROM node:22 (target platform)          ── npm ci --omit=dev
            runs once per target arch; under QEMU for the non-native one

 runtime    FROM node:22-bookworm-slim (target)     ── copy node_modules + dist, USER 1000:1000
```

The trade-off in `prod-deps`: shipit-api's dependencies (`express`, `pg`, `ioredis`) are pure JavaScript, so you could also install them on `$BUILDPLATFORM` and copy them across, avoiding emulation entirely. You keep the target-platform install because it stays correct the day someone adds a native module (`bcrypt`, `sharp`, `argon2`) whose compiled `.node` file must match the target CPU. Correct by default, optimise when measured.

:::mac Apple Silicon notes
- Docker Desktop and OrbStack both ship QEMU/Rosetta emulation, so `docker buildx build --platform linux/amd64,linux/arm64` works out of the box. Emulated stages are 3–10x slower than native.
- The default `docker` builder (docker driver) can only build multi-platform images if Docker Desktop's **containerd image store** is enabled; otherwise create a `docker-container` builder (`docker buildx create --name multi --driver docker-container`) and select it per build with `--builder multi`, keeping the default builder for local `docker build`.
- Multi-platform images built with a `docker-container` builder cannot be `--load`ed into the classic image store. Push them to a registry (`--push`) or load a single platform for local testing.
- kind nodes on your Mac are arm64. `kind load docker-image` needs an image for that architecture.
- Intel Macs: everything works the same; the native arch is amd64 and arm64 is the emulated one.
:::

## Platform: Terraform, kind and Gateway API

You already know each provider from the Terraform track. The interesting part is how they compose in one root module.

```hcl
resource "kind_cluster" "this" { ... }                      # creates cluster, writes kubeconfig

provider "kubernetes" {
  host                   = kind_cluster.this.endpoint       # provider config from a resource
  client_certificate     = kind_cluster.this.client_certificate
  client_key             = kind_cluster.this.client_key
  cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
}

provider "helm" {
  kubernetes = {                                            # helm provider v3: attribute, not block
    host = kind_cluster.this.endpoint
    # ...same credentials
  }
}
```

Configuring a provider from a resource created in the same apply works here because the kubernetes and helm resources you use (`kubernetes_namespace_v1`, `kubernetes_secret_v1`, `helm_release`) do not need to talk to the API server during the first plan. It breaks with `kubernetes_manifest`, which needs the API server at plan time to fetch the CRD schema. That is why the Gateway API CRDs are installed with a `terraform_data` + `local-exec` running `kubectl apply --server-side`, and why the HTTPRoute lives inside the Helm chart rather than in a `kubernetes_manifest`.

:::deep Single root module vs split state, the honest answer
HashiCorp's guidance is to keep cluster creation and in-cluster workloads in **separate** root modules (separate state), because a provider configured from unknown values is fragile, and because blast radius and lifecycle differ: you change the app ten times a day and the cluster twice a year. In production you would have something like `infra/cluster` (EKS, VPC, node groups) and `infra/platform` (Gateway controller, cert-manager, external-dns), with the app delivered by Argo CD rather than Terraform at all.

For a local kind project, one root module is a reasonable simplification: create-from-zero works in a single `apply`, destroy is a single `destroy`, and there is no remote state to coordinate. Saying exactly this in an interview ("I deliberately collapsed it; here is how I would split it for EKS and why") scores better than either over-engineering or not knowing.
:::

### Choosing the Gateway API implementation

Ingress-NGINX reached end of maintenance in March 2026, and Gateway API is the standard routing API. Gateway API itself is just CRDs; you need an **implementation** (a controller plus a data plane). Common choices: Envoy Gateway, Traefik, Istio, Cilium, NGINX Gateway Fabric, Kong.

This project uses **Traefik** because its Helm chart can create the GatewayClass and a Gateway for you, it exposes the listener through a plain NodePort Service (which maps cleanly onto kind's `extraPortMappings`), and it runs as a single small Deployment. Envoy Gateway is an equally good choice and closer to what many platform teams run; it provisions a separate Envoy Deployment and LoadBalancer Service per Gateway, so on kind you would add `cloud-provider-kind` or patch the Service to NodePort. Either way the **HTTPRoute in your chart does not change**, which is the point of Gateway API: application teams own routes, platform teams own gateways.

:::warning CRDs are not managed by Helm upgrades
Helm installs files in a chart's `crds/` directory only on first install and never upgrades or deletes them. Gateway API CRDs are therefore installed separately from the Traefik chart, pinned by `var.gateway_api_version`. Before bumping either, check which Gateway API version your Traefik release supports in the Traefik docs, and check the latest Gateway API release at `https://github.com/kubernetes-sigs/gateway-api/releases`.
:::

## Delivery: two Helm charts

Splitting the app chart from the data chart is deliberate: the data stores have a different lifecycle (you rarely upgrade them, and deleting them deletes data), and in production they would be replaced by managed services (RDS, ElastiCache) without touching the app chart. The app chart only knows two things about its dependencies: the name of a Secret containing `DATABASE_URL`, and a `REDIS_URL` value.

Key properties of the app chart:

- `strategy.rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }`: never drop below the desired ready count during a rollout. A broken new version stalls the rollout instead of taking the service down.
- `startupProbe` on `/healthz` so slow starts do not trigger liveness restarts; `readinessProbe` on `/readyz`; `livenessProbe` on `/healthz`.
- Resource **requests** (needed for scheduling and HPA) and a **memory limit** (needed so a leak is contained). No CPU limit: CPU limits cause throttling and latency spikes for Node's event loop; requests already guarantee a fair share. This is a common senior-level discussion point.
- `NODE_OPTIONS=--max-old-space-size` set below the memory limit, so V8 collects garbage harder before the kernel OOM-kills the container.
- `securityContext`: `runAsNonRoot`, `readOnlyRootFilesystem`, drop all capabilities, `seccompProfile: RuntimeDefault`. The pod passes the `restricted` Pod Security Standard.
- `PodDisruptionBudget` (`minAvailable: 1`) so node drains do not evict both replicas at once.
- Optional `HorizontalPodAutoscaler` and `NetworkPolicy`, off by default and turned on in later milestones.

The environment-specific file `deploy/envs/local/values.yaml` holds replica count, hostname and toggles. Terraform passes it to `helm_release`; in the Argo CD challenge the Application points at the same file. One source of truth for "what does the local environment look like", regardless of which tool applies it. In Project 2, CI bumps the image tag in an equivalent `deploy/envs/dev/values.yaml`.

:::try Predict the rollout
With `replicas: 2`, `maxUnavailable: 0`, `maxSurge: 1`, you deploy a version whose readiness probe always fails. How many pods exist, how many are Ready, and does traffic fail? (Three pods exist: two old Ready, one new not Ready. The rollout stalls until `progressDeadlineSeconds` marks it failed. Traffic keeps flowing to the old pods. Now repeat with `strategy: Recreate`: zero Ready pods, 503 for everyone.)
:::

## Design decisions and trade-offs

Put a version of this table in your README. Interviewers often pick one row and dig.

| Decision | Chosen | Alternatives | Why / trade-off |
| --- | --- | --- | --- |
| Local cluster | kind (1 control plane + 1 worker) | k3d, minikube, Docker Desktop k8s, OrbStack k8s | Upstream Kubernetes, multi-node, used in Kubernetes' own CI, Terraform provider exists. Cost: no LoadBalancer by default (solved with NodePort + port mapping) |
| Gateway implementation | Traefik via Helm | Envoy Gateway, Istio, Cilium | Smallest footprint, creates Gateway for you, NodePort-friendly. Routes are portable, so switching later is cheap |
| Who applies the app | Terraform `helm_release` (milestones), Argo CD (challenge) | `helm upgrade` in a script, Flux | Terraform: one tool, one command, good for bootstrap. Argo CD: continuous reconciliation and drift correction, the production answer. Avoid both managing the same release |
| Data stores | In-cluster Postgres StatefulSet and Redis Deployment, official images | Managed RDS/ElastiCache; operators (CloudNativePG) | Fine for a disposable environment. For production: managed service or an operator for backups, failover, upgrades. Never Bitnami charts (moved behind a paid offering in 2025) |
| Secrets | `random_password` → `kubernetes_secret_v1` from Terraform | External Secrets Operator + a secret manager, Sealed Secrets, SOPS | Simple and never committed to Git. Cost: the password is stored in plain text in Terraform state, so state must be protected (encrypted remote backend in real life) |
| Image delivery to the cluster | `kind load` for the dev loop; GHCR for shared/CI | Local registry container wired into kind | `kind load` is zero-config. GHCR is what CI will use. The local-registry pattern is fastest for heavy iteration but adds containerd config |
| Migrations | At startup, idempotent DDL, with retries | Helm pre-upgrade hook Job, Argo CD PreSync hook, separate migration pipeline step | Startup migration with many replicas means concurrent DDL. `IF NOT EXISTS` is safe; real schema changes need a single-run Job and backward-compatible (expand/contract) migrations |
| Readiness checks Redis | Yes (per spec) | Only check Postgres; degrade without cache | The code already degrades gracefully when Redis fails on reads. Failing readiness on a cache outage removes all pods and causes a full outage for a non-critical dependency. Good discussion point: many teams would drop Redis from readiness |
| CPU limits | None; memory limit only | CPU limit = request | Avoids CFS throttling of the event loop. Requires requests to be set honestly |
| Orchestration of commands | Makefile | Taskfile, Just, plain scripts | Pre-installed on macOS, universally understood. Taskfile is nicer YAML and cross-platform; both are fine |
| Terraform layout | One root module | Separate cluster/platform/app states | Single-command create/destroy locally. Split for real environments (see deep dive) |

## Acceptance criteria

The project is done when all of these are true. Turn them into a checklist in your README.

1. `make recreate` on a machine with Docker, kind, kubectl, helm, terraform and node installed goes from **nothing to a verified running stack** without manual steps, and prints `ALL CHECKS PASSED`.
2. `make down` leaves no kind cluster, no Docker containers from the project, and an empty Terraform state.
3. `docker buildx imagetools inspect ghcr.io/<you>/shipit-api:<tag>` lists **both** `linux/amd64` and `linux/arm64`.
4. `curl -H "Host: shipit.local" localhost:8080/items` returns JSON; a `POST` followed by two `GET`s shows `x-cache: miss` then `x-cache: hit`.
5. `kubectl rollout restart deploy/shipit-api -n shipit` while a request loop runs produces **zero non-2xx responses**.
6. Killing the Postgres pod makes `/readyz` fail and the pods go NotReady; when Postgres returns, they become Ready again **without restarts** (liveness unaffected).
7. The app pod runs as UID 1000 with a read-only root filesystem, and the `shipit` namespace enforces the `baseline` Pod Security Standard and warns on `restricted`.
8. No secret value appears in Git; `git grep -i password` finds only variable names.
9. `helm lint` passes for both charts, `terraform fmt -check` and `terraform validate` pass, and `npm test` passes.
10. The README contains the architecture diagram, the decisions table, and a "production differences" section.

## Rubric

Use this to grade yourself honestly, or hand it to a friend reviewing your repo.

| Area | Needs work | Solid | Excellent |
| --- | --- | --- | --- |
| Reproducibility | Manual steps in README | `make up` works from zero | `make recreate` is idempotent, fails fast on missing tools, and runs in CI (Project 2) |
| Application | Endpoints work | Correct liveness/readiness split, config validation, tests with fakes | Graceful shutdown proven under load, structured logs, cache degradation tested |
| Image | Builds | Multi-stage, non-root, `.dockerignore` | Multi-arch index verified, numeric USER, BuildKit cache mounts, size justified |
| Kubernetes | Pods run | Probes, requests/limits, PDB, rolling strategy | Restricted-compatible security context, NetworkPolicy, HPA demo, zero-downtime proof |
| Terraform | Applies | Clean variables/outputs, pinned providers, `fmt`/`validate` | `terraform test`, explicit reasoning about provider config and state split |
| Helm | Templates render | Values documented, helpers, lint passes | Data/app split, env values file shared by Terraform and Argo CD, digest support |
| Communication | No README | Diagram and run instructions | Decisions table, trade-offs, "what I would change for EKS", known limitations |

## Presenting it in an interview

A structure that works in 5–10 minutes:

1. **Problem** (30 s): "A Node API with Postgres and Redis; I wanted a reproducible path from laptop to cluster."
2. **Diagram** (2 min): walk the provisioning flow, then the request flow.
3. **Two decisions in depth** (3 min): pick ones with real trade-offs, such as readiness vs liveness and why Redis in readiness is debatable, or single Terraform state vs split, or why there is no CPU limit.
4. **Proof** (1 min): the zero-downtime rollout test, the recreate-from-zero time.
5. **Production gap** (1 min): managed Postgres, External Secrets, split state, Argo CD for apps, TLS with cert-manager, observability.

:::tip Measure and quote numbers
Time `make recreate` (typically a few minutes on an M-series Mac, dominated by image pulls). Note the final image size and how much the multi-stage build saved. Concrete numbers make a project memorable and show you actually ran it.
:::

## Common pitfalls

:::warning Pitfalls you will probably hit
- **`exec format error`**: an image built for the wrong architecture. Check with `docker image inspect --format '{{.Architecture}}' <image>` and `kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.architecture}'`.
- **`container has runAsNonRoot and image has non-numeric user (node)`**: kubelet cannot prove a named user is non-root. Use `USER 1000:1000` in the Dockerfile or `runAsUser: 1000` in the pod.
- **`ErrImagePull` from GHCR**: new GHCR packages are private. Make the package public, or create an `imagePullSecret`.
- **`ErrImageNeverPull` / pull attempts for a local image**: an image tagged `:latest` defaults to `imagePullPolicy: Always`. Use a real tag (`:dev`) and `IfNotPresent` with `kind load`.
- **Port 8080 already in use** on your Mac: `extraPortMappings` fails at cluster creation. Change `host_port` or stop the other process (`lsof -i :8080`).
- **HTTPRoute not accepted**: check `kubectl get httproute -n shipit -o yaml` status conditions. `NotAllowedByListeners` means the Gateway's `allowedRoutes` does not include your namespace.
- **Terraform state out of sync** after you deleted the cluster with `kind delete cluster`: refresh fails because the API server is gone. `make nuke` (in Lab 5) deletes the cluster and the local state together.
- **Postgres 18 image volume layout**: from 18 the official image expects the volume at `/var/lib/postgresql` rather than `/var/lib/postgresql/data`. This project pins `postgres:17`; read the image notes before bumping.
:::
