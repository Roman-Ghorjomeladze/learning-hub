Thirty questions you're likely to meet in interviews for backend, full-stack and platform roles, ordered from fundamentals to senior-level design and troubleshooting. Answer out loud first, then open the model answer. Good answers explain *why*, mention trade-offs, and connect to real experience ("in our NestJS service we...").

## Fundamentals

### What is a container, and how is it different from a virtual machine?

:::details Model answer
A container is a normal Linux process (or process tree) isolated with **namespaces** (its own view of PIDs, network, mounts, hostname, IPC, users) and constrained with **cgroups** (CPU, memory, PIDs, I/O), running from a layered filesystem image. All containers on a host **share the host kernel**.

A VM virtualises hardware and runs its own kernel on a hypervisor. Consequences: containers start in milliseconds and have tiny overhead, but isolation is weaker (a kernel vulnerability affects all containers), and you can't run a different kernel (Linux containers on macOS run inside a Linux VM). In practice they're complementary: cloud VMs run container hosts.
:::

### What's the difference between an image and a container?

:::details Model answer
An **image** is an immutable, content-addressed template: a stack of read-only filesystem layers plus config (entrypoint, env, user, exposed ports), identified by a digest. A **container** is a running (or stopped) instance of an image: the image layers plus a thin **writable layer**, its own namespaces, cgroup, network config and lifecycle. One image can back many containers. Deleting a container deletes its writable layer; the image is untouched.
:::

### Explain `CMD` vs `ENTRYPOINT`, and exec form vs shell form.

:::details Model answer
`ENTRYPOINT` defines the executable; `CMD` provides default arguments (or the whole command if there's no entrypoint). Arguments after the image name in `docker run` replace `CMD`; replacing `ENTRYPOINT` needs `--entrypoint`. A common pattern is `ENTRYPOINT ["docker-entrypoint.sh"]` plus `CMD ["node", "dist/main.js"]`, where the script ends with `exec "$@"`.

**Exec form** (`["node", "app.js"]`) runs the binary directly as PID 1, so it receives signals. **Shell form** (`node app.js`) runs `/bin/sh -c "node app.js"`; the shell becomes PID 1 and usually doesn't forward SIGTERM, causing 10-second stops and ungraceful shutdowns. Use exec form.
:::

### How do image layers and the build cache work?

:::details Model answer
Each filesystem-changing Dockerfile instruction (`RUN`, `COPY`, `ADD`) produces a layer, a tarball of changes. BuildKit caches each step keyed by the instruction and its inputs (parent layer, command string, checksums of copied files). If a step's key changes, that step and **all later steps** rebuild.

So you order instructions from least to most frequently changing: base image, system packages, `COPY package*.json` + `npm ci`, then `COPY src`. Combine with `.dockerignore` (so irrelevant files don't change checksums) and `RUN --mount=type=cache` for package manager caches. Layers are shared between images with the same base, saving disk and pull time.
:::

### What's the difference between `COPY` and `ADD`?

:::details Model answer
Both copy files into the image. `ADD` additionally auto-extracts local tar archives and can fetch remote URLs (and Git repos with newer syntax). Prefer `COPY` because it's explicit and predictable; use `ADD` only when you specifically want extraction or a checksummed remote download (`ADD --checksum=sha256:... https://...`).
:::

### What does `EXPOSE` do?

:::details Model answer
Nothing at the network level. It documents which port the app listens on and is used by `docker run -P` to publish all exposed ports to random host ports. Publishing requires `-p`/`ports:`. Container-to-container traffic on a shared network doesn't need `EXPOSE` or publishing at all.
:::

## Storage and networking

### Named volumes vs bind mounts vs tmpfs: when do you use each?

:::details Model answer
- **Named volumes**: Docker-managed storage, portable, pre-populated from the image when empty, fast on macOS (they live in the VM). Use for databases and any data that must outlive containers.
- **Bind mounts**: a host path mapped into the container. Use for source code in development and single config files. They depend on the host's layout and permissions, and on macOS they cross the VM file-sharing layer (slower). Never for production code; the image should contain it.
- **tmpfs**: RAM-only, gone on stop. Use for scratch space with a read-only root filesystem and for secrets you never want on disk.

Gotchas I'd mention: a bind mount over `/app` hides the image's `node_modules`; `-v` silently creates missing host paths while `--mount` errors; permission issues are about numeric UIDs.
:::

### How do containers on the same host find each other?

:::details Model answer
Put them on the same **user-defined network**. Docker runs an embedded DNS server (reachable at `127.0.0.11` inside each container) that resolves container names, network aliases and Compose service names to container IPs. You connect with the name and the **container** port, e.g. `postgres://db:5432`. The default `bridge` network has no DNS between containers (only IPs or the deprecated `--link`), which is why Compose creates a project network automatically.
:::

### How does `-p 8080:3000` actually work?

:::details Model answer
On Linux, the daemon installs DNAT rules (iptables by default; nftables is an alternative backend) that rewrite packets arriving on host port 8080 to the container's IP and port 3000, plus forwarding rules, and starts a `docker-proxy` userland process for cases NAT doesn't cover (like connections to `127.0.0.1` on the host). On Docker Desktop for Mac there's an extra hop: a forwarder on macOS listens on 8080 and relays into the Linux VM.

Practical consequences: the app must listen on `0.0.0.0` inside the container; published ports bind on all host interfaces unless you specify `127.0.0.1:`; and Docker's NAT rules bypass firewalls like ufw, so you filter in the `DOCKER-USER` chain or don't publish internal services.
:::

### A containerised app can't connect to Postgres at `localhost:5432`. Why?

:::details Model answer
Inside a container, `localhost` is that container's own network namespace. If Postgres runs in another container, use its service/container name on a shared network (`db:5432`). If Postgres runs on the host (your Mac), use `host.docker.internal` (on Linux add `--add-host=host.docker.internal:host-gateway`), and make sure Postgres listens on an address reachable from the container.
:::

## Compose

### What does `depends_on` guarantee, and how do you wait until a database is ready?

:::details Model answer
Short-form `depends_on` only orders **container start**: Postgres's process may be up but not accepting connections yet. To wait for readiness, give the dependency a `healthcheck` (e.g. `pg_isready`) and use `depends_on: { db: { condition: service_healthy } }`. For one-off jobs like migrations, `condition: service_completed_successfully`. The app should still retry connections, because in production dependencies restart independently and Compose ordering doesn't exist in Kubernetes.
:::

### Explain `.env`, `env_file` and `environment` in Compose.

:::details Model answer
`.env` in the project directory is used for **interpolation** of `${VAR}` in the Compose file; it doesn't set anything in containers by itself. `environment:` and `env_file:` set variables **inside containers**; `environment` wins over `env_file`, and `docker compose run -e` wins over both. For interpolation, shell variables beat `.env`. Use `${VAR:?message}` to fail fast on missing required values, and `docker compose config` to see the resolved result.
:::

### How do you structure Compose for dev vs production-like environments?

:::details Model answer
A base `compose.yaml` with what's common, plus overrides: `compose.override.yaml` (auto-loaded) for dev conveniences like `develop.watch`, published DB ports and debug flags; and an explicit `compose.prod.yaml` passed with `-f` that swaps `build` for registry images, adds resource limits, hardening, secrets and log rotation. Merge rules: scalars are replaced, maps merged, lists like `ports` combined, and `!reset`/`!override` handle removal/replacement. Profiles toggle optional services (admin UIs, seeders). Some teams prefer a standalone prod file for clarity, which is fine if it's validated in CI.
:::

### How would you set up hot reload for a Node.js service in Docker on a Mac?

:::details Model answer
Avoid bind-mounting the whole project: it hides the container's `node_modules`, brings macOS-built native modules into Linux, and is slow through VirtioFS. Use **`docker compose watch`**: a `sync` rule copies `./src` into the container, where `node --watch`, nodemon or `tsx watch` restarts the process; a `rebuild` rule on `package.json`/lockfile rebuilds the image so dependencies are installed inside Linux. Alternatives: bind-mount only `src/` and keep `node_modules` in a volume.
:::

## Production images

### How do you build a small, secure production image for a TypeScript/NestJS service?

:::details Model answer
A multi-stage Dockerfile: a build stage with all dependencies runs `npm ci` and `tsc`/`nest build`; a production-dependencies stage runs `npm ci --omit=dev`; the final stage starts from a minimal runtime (`node:22-slim`/`-alpine` or distroless/hardened), copies only `dist/`, production `node_modules` and `package.json`, sets `NODE_ENV=production`, runs as a non-root `USER`, uses exec-form `CMD`, and defines a `HEALTHCHECK` that works without curl. Plus a strict `.dockerignore`, lockfiles copied before sources for caching, cache mounts, pinned base images (digest in prod), OCI labels, and no secrets in ARG/ENV/layers (BuildKit secret mounts for private registries). Then measure: image size, `docker history`, and a scan.
:::

### How do you build images for both Apple Silicon and x86 servers?

:::details Model answer
Use buildx with a builder that supports multiple platforms (the `docker-container` driver, or Docker Desktop's), and `docker buildx build --platform linux/amd64,linux/arm64 --push`. The result is an image **index** (manifest list) with one manifest per platform; each host pulls the matching one. Foreign-platform stages run under QEMU/Rosetta emulation, which is slow, so put architecture-independent work (TypeScript compile, frontend bundling, Go cross-compilation) in stages pinned to `--platform=$BUILDPLATFORM`, and keep stages that produce native binaries (npm native modules) on the target platform. In CI, native runners per architecture are fastest.
:::

### What causes `exec format error`?

:::details Model answer
The kernel can't execute the file: most commonly a binary for a different CPU architecture (an arm64 image built on a Mac deployed to an amd64 server, or host-built native `node_modules` copied into the image), and sometimes a script without a `#!` shebang executed directly. Check `docker image inspect -f '{{.Architecture}}'` and `docker buildx imagetools inspect`, build multi-arch, and always install dependencies inside the image.
:::

### Alpine, slim, distroless or hardened images: how do you choose?

:::details Model answer
- **Alpine**: small, has a shell, uses musl libc; occasional incompatibilities with native modules and DNS edge cases.
- **Debian slim**: glibc, broad compatibility, a bit larger; a safe default for Node.
- **Distroless / Docker Hardened Images / Chainguard**: only the runtime and its libraries, no shell or package manager, few CVEs, smaller attack surface; debugging needs ephemeral debug containers or `docker debug`.

I pick slim or Alpine for most services and distroless/hardened for internet-facing or compliance-sensitive services once the team has a debugging story. Whatever the base, rebuild regularly to pick up patches.
:::

## Security

### How do you harden a container at runtime?

:::details Model answer
Least privilege, layered: run as non-root; `--cap-drop ALL` and add back only what's proven necessary; `--security-opt no-new-privileges`; `--read-only` root filesystem with tmpfs for `/tmp` and volumes only where data is written; memory, CPU and PID limits; keep the default seccomp and AppArmor/SELinux profiles; only the edge service publishes ports, and data stores sit on internal networks. Never `--privileged`, never mount `docker.sock`, never host namespaces for apps. On hosts, consider rootless Docker or user namespaces, and audit with docker-bench-security (CIS Docker Benchmark).
:::

### Why is mounting `/var/run/docker.sock` into a container dangerous?

:::details Model answer
The Docker API has no fine-grained authorisation by default: anything that can talk to the socket can create a privileged container that mounts the host's root filesystem, which is full root on the host. Tools like CI runners, Traefik or Portainer ask for it; if unavoidable, use a filtering socket proxy that exposes only the needed read-only endpoints, mount it read-only, and never expose such containers publicly. For CI builds, prefer rootless BuildKit or remote builders.
:::

### How do you handle secrets with Docker?

:::details Model answer
Build time: BuildKit secret mounts (`RUN --mount=type=secret,id=npmrc ...` with `docker build --secret`), or SSH mounts for private Git. Never `ARG`/`ENV`/`COPY` secrets: they persist in history, image config or layers even if deleted later. Runtime: inject at start, preferably as files (Compose/Swarm/Kubernetes secrets, `*_FILE` conventions) or fetched from a secret manager using workload identity (IAM roles, IRSA). Environment variables are acceptable for low-risk config but leak via `docker inspect`, `/proc`, crash reports and logs.
:::

### How do you secure the image supply chain?

:::details Model answer
Minimal, trusted base images pinned by digest and updated by a bot (Renovate/Dependabot); rebuild regularly with `--pull`; scan in CI (Trivy, Grype, Docker Scout) and gate on fixable critical/high findings with documented exceptions; generate SBOMs and SLSA provenance (`--sbom=true --provenance=mode=max`); sign image digests with cosign (keyless via CI OIDC) and verify at deploy time (e.g. Kyverno or policy-controller in Kubernetes); deploy by digest. And treat CI itself as supply chain: pin third-party actions to commit SHAs and minimise token permissions. The 2026 Trivy GitHub Actions compromise, where version tags were repointed to credential-stealing code, is a good recent example of why.
:::

## Troubleshooting and operations

### A container exits immediately after `docker run`. How do you debug it?

:::details Model answer
Outside-in: `docker ps -a` for the exit code; `docker logs` for the error. Map the code: 0 means the command finished (not a foreground server), 1 is an app error, 125 a docker/daemon error, 126 not executable, 127 not found (typo, missing binary, CRLF or wrong shebang), 137 SIGKILL/OOM, 139 segfault. Then `docker inspect` to confirm entrypoint, cmd, env and mounts, and reproduce interactively with `docker run --rm -it --entrypoint sh <image>` to run the command by hand.
:::

### A container keeps getting killed with exit code 137. What do you check?

:::details Model answer
Whether it was the OOM killer or a stop timeout: `docker inspect -f '{{.State.OOMKilled}}'` and `docker events` (an `oom` event, or `kill signal=15` followed ~10 s later by `signal=9`). For OOM: measure real usage with `docker stats`, raise the limit or fix the leak, and for Node cap the heap below the container limit (`--max-old-space-size`) so you get a stack trace instead of a silent kill. For stop timeouts: exec-form `CMD`, a SIGTERM handler, and `--init`/`init: true` so signals reach the app.
:::

### Your app works in the container but you can't reach it from the host. Walk me through it.

:::details Model answer
1. `docker ps`: is the port published, and to which container port? 2. Logs: is it listening on `0.0.0.0` or only `127.0.0.1` inside the container? 3. `docker port` and, from a netshoot container sharing the network namespace, `ss -ltnp` to see the actual listening socket. 4. Test from a sibling container on the same network: if that works, it's a publish/bind issue; if not, it's the app. 5. Check host-side: correct host port, `127.0.0.1` vs LAN binding, firewalls/VPNs, and on a Mac remember container IPs aren't routable from macOS.
:::

### How do you debug a distroless container that has no shell?

:::details Model answer
Don't modify the image. Start a tools container that joins the target's namespaces: `docker run --rm -it --pid container:app --network container:app nicolaka/netshoot`. You can see its processes, sockets and traffic, and browse its filesystem via `/proc/<pid>/root`. Docker Desktop's `docker debug` automates this, and in Kubernetes the equivalent is `kubectl debug` with ephemeral containers. Many distroless images also publish `:debug` variants with busybox for local investigation.
:::

### Your Docker host ran out of disk. What do you look at and how do you prevent it?

:::details Model answer
`docker system df -v` to see whether images, build cache, volumes or containers dominate, and check `/var/lib/docker/containers` for huge json-file logs (no rotation by default). Clean up with targeted prunes (`builder prune --filter until=...`, `image prune -a --filter until=...`, `container prune`), being careful with volumes. Prevent it with daemon-level log rotation (`max-size`, `max-file`, or the `local` driver), scheduled pruning on build hosts, monitoring disk usage, and shipping logs to a central system instead of keeping them on the node.
:::

## Senior-level design

### Compose on a single VM or Kubernetes: how do you decide?

:::details Model answer
Compose is great for local development, CI integration tests and small single-host deployments (internal tools, low-traffic services) where simplicity beats availability: one VM, restart policies, a reverse proxy, backups. Its limits: no multi-host scheduling, no rolling updates or self-healing across nodes, limited secret management, manual scaling. Kubernetes (or ECS/Cloud Run) adds scheduling, service discovery, rolling deployments, autoscaling and a rich ecosystem, at the cost of significant operational complexity. I'd choose based on availability requirements, team size and existing platform: if the company already runs EKS with good tooling, deploy there; for a single internal service with a small team, a managed container service or even Compose on a VM can be the right call.
:::

### How do you run database migrations safely in containerised deployments?

:::details Model answer
Run them as a **separate one-off job** before the new app version takes traffic: a Compose service with `service_completed_successfully`, a Kubernetes Job or Helm hook, or a CI/CD step, using the same image as the app. Avoid running migrations in every replica's startup (race conditions, slow starts, partial failures). Make migrations idempotent and backwards compatible (expand/contract: add columns before code uses them, remove only after no version needs them) so old and new versions can run side by side during rolling deploys, and take a backup before risky changes.
:::

### What makes an application "container-friendly"?

:::details Model answer
Twelve-factor habits: config from the environment (and secrets from files), logs to stdout/stderr as structured lines, stateless processes with state in backing services or volumes, fast startup, graceful shutdown on SIGTERM (stop accepting connections, finish in-flight work, close pools) within the grace period, separate liveness (`/healthz`) and readiness (`/readyz`) endpoints, listening on `0.0.0.0` and a configurable port, retrying dependency connections instead of crashing, and one main process per container. These make the same image run correctly under Compose, ECS and Kubernetes.
:::
