Containers feel isolated, so it's tempting to treat them as tiny VMs. They aren't. A container is a normal Linux process with some kernel features turned on; a vulnerability in your app, in the image, or in the way you run it can give an attacker a foothold on the host. This module teaches you to think like an attacker, then layer controls so a single mistake isn't game over.

## The threat model

All containers on a host **share one kernel**. Isolation comes from namespaces (what a process can see), cgroups (what it can use), capabilities, seccomp and LSMs like AppArmor/SELinux (what it can do). Each of these narrows the attack surface; none is perfect alone.

```text
 ┌───────────────────────── What can go wrong ─────────────────────────┐
 │ 1. Supply chain   vulnerable/malicious base image or npm package    │
 │ 2. Build          secrets baked into layers, untrusted build inputs │
 │ 3. Registry       tampered image, mutable tag swapped              │
 │ 4. Runtime        RCE in your app → attacker runs code in container │
 │ 5. Escape         container → host via kernel bug, privileged mode, │
 │                   docker.sock, sensitive mounts, excess caps        │
 │ 6. Lateral        container → other containers, cloud metadata, DB  │
 └─────────────────────────────────────────────────────────────────────┘
```

Your goal is **defense in depth**: assume step 4 will happen eventually (an npm dependency with an RCE, an SSRF, a deserialisation bug) and make sure the attacker lands in a box with no tools, no privileges, no secrets lying around, no write access and no path to the host.

:::info Root in a container is (mostly) root on the host
Without user namespaces, UID 0 in a container *is* UID 0 on the host kernel, just restricted by namespaces, capabilities and seccomp. If any of those barriers fails (a kernel bug, a `--privileged` flag, a mounted host directory), the attacker is host root. That's why "run as non-root" is the first rule.
:::

## Least privilege at runtime

Here's a hardened `docker run` for the shipit API. Each flag closes a door; the rest of this section explains them.

```bash
docker run -d --name shipit-api \
  --user 1000:1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 256m --cpus 0.5 --pids-limit 200 \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/roma/shipit-api:1.4.2
```

And the Compose equivalent:

```yaml
services:
  api:
    image: ghcr.io/roma/shipit-api:1.4.2
    user: "1000:1000"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    deploy:
      resources:
        limits: { cpus: "0.5", memory: 256M, pids: 200 }   # don't also set pids_limit
```

### 1. Run as non-root

Set `USER` in the Dockerfile (module 04) so the image is safe by default, and optionally enforce it at runtime with `--user`. Official Node images ship a `node` user (UID 1000); distroless images have a `nonroot` user (UID 65532).

```dockerfile
COPY --chown=node:node dist ./dist
USER node
```

Gotchas: non-root processes need write access to any directory they write to (module 05). Traditionally they also can't bind ports below 1024; Docker relaxes this inside containers (it sets `net.ipv4.ip_unprivileged_port_start=0` in each container's network namespace), but other runtimes, Kubernetes setups and host networking may not. Listening on 3000 or 8080 and publishing to 80/443 is the portable choice.

### 2. Drop capabilities

Linux splits root's powers into ~40 **capabilities**. Docker grants containers a default subset of 14, including `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `NET_RAW` (raw sockets, used for ping and packet spoofing), `NET_BIND_SERVICE` and `MKNOD`. A Node API needs **none** of them.

```bash
docker run --cap-drop ALL ...                                  # start from zero
docker run --cap-drop ALL --cap-add NET_BIND_SERVICE ...       # add back only what you can justify
```

Check what a process has:

```bash
docker run --rm alpine grep Cap /proc/self/status
docker run --rm --cap-drop ALL alpine grep Cap /proc/self/status   # CapEff: 0000000000000000
```

(Decode masks with `capsh --decode=<hex>` from the `libcap` package.) Never use `--cap-add SYS_ADMIN`: it's "the new root" and enables mounts and many escapes.

### 3. `no-new-privileges`

Even as non-root, a process could regain privileges by executing a **setuid** binary (like `su`, `sudo`, `ping` in some images) or a file with capabilities. `--security-opt no-new-privileges` sets the kernel's `PR_SET_NO_NEW_PRIVS` flag: `execve` can never grant more privileges than the parent had. It costs nothing for normal apps. You can make it the default for all containers with `"no-new-privileges": true` in `daemon.json`.

### 4. Read-only root filesystem + tmpfs

`--read-only` mounts the container's root filesystem read-only. An attacker with code execution can't drop a binary, modify your JS files, or install tools. Give the app explicit writable places:

- `--tmpfs /tmp` for scratch (add `noexec` so dropped files can't be executed),
- named volumes for real data (`/app/uploads`).

Finding what an app writes: run it normally and use `docker diff <container>`, then decide which paths need tmpfs or volumes. Nginx, for example, needs `/var/cache/nginx` and `/var/run` (or `/tmp`) writable.

### 5. Resource limits

Memory, CPU and **PID limits** stop a compromised or buggy container from starving the host (fork bombs, memory leaks). `--pids-limit` is often forgotten and is a cheap guard.

### 6. Never do these

| Flag / mount | Why it's dangerous |
| --- | --- |
| `--privileged` | Disables almost all isolation: all capabilities, all devices, no seccomp/AppArmor. Effectively root on the host. |
| `-v /var/run/docker.sock:/var/run/docker.sock` | Full control of the Docker daemon = root on the host (start a privileged container mounting `/`). |
| `-v /:/host` or `/etc`, `/proc`, `/sys` mounts | Direct host file access. |
| `--pid=host`, `--network=host`, `--ipc=host` | Remove namespace isolation (sometimes needed for monitoring agents; never for apps). |
| `--cap-add SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN` | Broad powers that enable many escapes. |
| `--security-opt seccomp=unconfined` / `apparmor=unconfined` | Removes kernel-level syscall and file restrictions. |

:::warning The docker.sock trap
Tools like Traefik, Portainer, Watchtower, some CI runners and "Docker-in-Docker" setups ask for the Docker socket. Anyone who can talk to that socket can run `docker run --privileged -v /:/host alpine chroot /host`, game over. If you must, use a **socket proxy** that only allows read-only API calls (e.g. listing containers), mount it read-only, and never expose it to internet-facing services. For CI builds, prefer rootless BuildKit or remote builders over mounting the host socket.
:::

:::try Feel the difference
```bash
# Default: root with Docker's default capabilities
docker run --rm alpine sh -c 'id; touch /x && chown nobody /x && echo "chown ok (CAP_CHOWN)"'
# Still root, but no capabilities: root can no longer give files away
docker run --rm --cap-drop ALL alpine sh -c 'touch /x && chown nobody /x || echo "chown denied without CAP_CHOWN"'
# Fully hardened: non-root, no caps, read-only root filesystem
docker run --rm --user 1000:1000 --cap-drop ALL --read-only --security-opt no-new-privileges alpine \
  sh -c 'id; touch /x || echo "root fs is read-only"'
```
:::

## Kernel guardrails: seccomp, AppArmor and SELinux

These are on by default; your job is mostly **not to turn them off**.

- **seccomp** filters system calls. Docker's default profile is an allowlist that blocks dozens of dangerous or obscure syscalls (`mount`, `reboot`, `kexec_load`, `add_key`, `bpf`, `ptrace` on older kernels, namespace creation via `unshare`/`clone` flags for unprivileged users, etc.). Many container-escape exploits rely on exactly these. Check it's active: `docker info --format '{{.SecurityOptions}}'` shows `name=seccomp,profile=builtin`. You can supply a tighter custom profile with `--security-opt seccomp=profile.json`.
- **AppArmor** (Ubuntu/Debian hosts) applies the `docker-default` profile, which denies writes to sensitive `/proc` and `/sys` paths and mounting. **SELinux** (RHEL/Fedora hosts) labels container processes and files (`container_t`) so they can't touch host files; that's why bind mounts on SELinux hosts sometimes need `:z`/`:Z`.

:::mac On a Mac you're protected by the VM, too
Your containers run inside a Linux VM, so even a full container escape lands in the VM, not macOS. That's a nice extra layer for local dev, but don't let it shape habits: your images run on bare Linux hosts, EC2 instances and Kubernetes nodes in production. Docker Desktop's **Enhanced Container Isolation** (business subscriptions) adds user-namespace isolation for all containers.
:::

## User namespaces and rootless Docker

**User namespaces** map UIDs inside the container to unprivileged UIDs on the host: root (0) inside becomes, say, 100000 outside. If the process escapes, it's a nobody on the host.

- **`userns-remap`**: the daemon still runs as root, but containers get remapped UIDs. Enable with `"userns-remap": "default"` in `daemon.json`. Caveats: volume ownership looks different, some features (host network/PID modes, certain mounts) are restricted.
- **Rootless mode**: the **daemon itself** runs as an ordinary user, inside a user namespace, so neither the daemon nor containers have host root. Install with `dockerd-rootless-setuptool.sh install`. Trade-offs: no ports below 1024 without extra config, slower networking (slirp4netns/pasta), some storage drivers and cgroup features need setup. Podman is rootless by default and is a common alternative on Linux servers.
- **Kubernetes** now supports user namespaces for pods (`hostUsers: false`), so the concept carries over.

## Secrets: never in ENV, never in layers

Every image layer is a tarball anyone with pull access can extract. `docker history` shows every command and `ENV` value.

```dockerfile
# ❌ All of these leak
ENV NPM_TOKEN=npm_abc123                       # visible in docker inspect / history, inherited at runtime
ARG NPM_TOKEN                                  # build args are recorded in image history/provenance
COPY .npmrc .                                  # in a layer forever, even if a later RUN deletes it
RUN echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > .npmrc && npm ci && rm .npmrc   # still in history
```

**Build-time: BuildKit secret mounts.** The secret is mounted as a file for the duration of one `RUN` and never written to a layer:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --omit=dev
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t shipit-api .
# or from an env var:
NPM_TOKEN=... docker build --secret id=npm_token,env=NPM_TOKEN .
```

For private Git dependencies use `RUN --mount=type=ssh` with `docker build --ssh default`. Multi-stage builds help too: a secret used only in a builder stage never reaches the final image, but use secret mounts anyway, because builder-stage layers may be cached or pushed.

**Runtime**: inject secrets when the container starts, as files (Compose/Kubernetes secrets) or from a secret manager (AWS Secrets Manager/SSM via the task role, Vault). Environment variables are acceptable for low-risk config but leak easily (crash dumps, `/proc/<pid>/environ`, logging middleware that prints `process.env`, child processes).

:::try Find a leaked secret
```bash
printf 'FROM alpine\nRUN echo "API_KEY=supersecret" > /k && rm /k\nENV DB_PASS=hunter2\n' | docker build -t leaky -
docker history --no-trunc leaky | grep -E 'supersecret|hunter2'
docker inspect leaky -f '{{.Config.Env}}'
docker rmi leaky
```
Both secrets are recoverable, even though the file was deleted.
:::

## Image hygiene: minimal bases, patching, scanning

### Minimal base images

Fewer packages means fewer CVEs and fewer tools for an attacker (no shell, no package manager, no curl).

| Base | Size (approx.) | Shell | Notes |
| --- | --- | --- | --- |
| `node:22` (Debian) | ~1 GB | yes | Build stages only |
| `node:22-slim` | ~200 MB | yes | Good general runtime |
| `node:22-alpine` | ~150 MB | yes (busybox) | musl libc; occasional native-module issues |
| `gcr.io/distroless/nodejs22-debian12` | ~150 MB | no | Just Node + glibc + CA certs; `nonroot` user |
| Docker Hardened Images / Chainguard | small | usually no | Minimal, frequently rebuilt, near-zero known CVEs; Docker made its hardened images free (Apache 2.0) in late 2025 |

Sizes vary by version; measure with `docker images`. Distroless/hardened images have no shell, so debug with the techniques in module 09 (ephemeral debug containers, `docker debug`).

### Keep images patched

A pinned image is a frozen set of vulnerabilities. Process beats heroics:

- **Rebuild regularly** (weekly or on base image updates) even if your code didn't change, with `--pull` so you get the latest base.
- **Pin by digest in production** for reproducibility (`node:22-alpine@sha256:...`) and let a bot (Renovate, Dependabot) open PRs when the digest changes.
- Run `npm audit`/`npm ci --omit=dev` and keep dev dependencies out of the runtime image.

### Scan images

Scanners compare the packages in your image (OS packages and language dependencies like `node_modules`) against vulnerability databases.

```bash
# Docker Scout (built into Docker Desktop / CLI)
docker scout quickview shipit-api:1.4.2
docker scout cves --only-severity critical,high shipit-api:1.4.2
docker scout recommendations shipit-api:1.4.2       # suggests better base image tags

# Trivy (open source)
trivy image --severity HIGH,CRITICAL --ignore-unfixed shipit-api:1.4.2
trivy image --exit-code 1 --severity CRITICAL shipit-api:1.4.2   # fail CI on criticals

# Grype (open source, from Anchore)
grype shipit-api:1.4.2 --fail-on high
```

No tool installed? Run scanners as containers: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy image shipit-api:1.4.2` (here mounting the socket is a deliberate, local, short-lived choice).

How to act on results:

1. **Fix what's fixable**: rebuild with a newer base, bump the dependency.
2. **Triage the rest**: is the vulnerable package even used at runtime? Is the vulnerable code path reachable? Record accepted risks (e.g. `.trivyignore` or VEX statements) with an expiry date, not silently.
3. **Gate in CI** on *new* critical/high vulnerabilities with a fix available, not on every low-severity CVE, or developers will learn to ignore the gate.

:::warning Your security tools are supply chain too
In March 2026, attackers compromised the Trivy project's GitHub Actions and rewrote existing version tags to point at malicious code that stole CI secrets from anyone using those actions. Pipelines that referenced actions by **mutable tag** (`@v0.x` or `@master`) ran the malicious version automatically. Pin third-party GitHub Actions to a **full commit SHA**, give CI jobs minimal token permissions, and treat scanners, linters and build plugins with the same suspicion as runtime dependencies.
:::

## SBOMs, provenance and signing

**SBOM** (Software Bill of Materials): a machine-readable list of every package in an image (SPDX or CycloneDX format). When the next Log4Shell-style CVE drops, you query SBOMs instead of rescanning everything.

**Provenance**: a signed statement of *how* an image was built (source repo, commit, builder, build args), following the SLSA framework.

BuildKit can attach both as **attestations** when pushing:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --sbom=true --provenance=mode=max \
  -t ghcr.io/roma/shipit-api:1.4.2 --push .

docker buildx imagetools inspect ghcr.io/roma/shipit-api:1.4.2 --format '{{json .SBOM}}' | head
docker scout sbom ghcr.io/roma/shipit-api:1.4.2       # or: syft ghcr.io/roma/shipit-api:1.4.2
```

**Signing** proves an image came from you and wasn't altered. **cosign** (Sigstore) supports **keyless** signing: in CI, it uses the job's OIDC identity (e.g. GitHub Actions) to get a short-lived certificate, and records the signature in a public transparency log. Always sign the **digest**, not a tag:

```bash
# In GitHub Actions with `permissions: id-token: write`
cosign sign --yes ghcr.io/roma/shipit-api@sha256:3f1c...

# Anywhere: verify who signed it
cosign verify ghcr.io/roma/shipit-api@sha256:3f1c... \
  --certificate-identity-regexp 'https://github.com/roma/shipit/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

In Kubernetes, admission controllers (Kyverno, Sigstore policy-controller) can reject unsigned images. That's where signing really pays off.

:::deep Why tags are not trustworthy, and digests are
A tag like `shipit-api:1.4.2` is a mutable pointer in the registry; anyone with push access (or an attacker with stolen credentials) can move it to different content. A **digest** (`sha256:...`) is the hash of the image manifest, which itself contains hashes of the config and every layer: change one byte anywhere and the digest changes. That's content addressing, the same idea as Git commits.

So the secure chain is: build → push → get the digest from the push output (`docker buildx build --metadata-file`) → sign the digest → deploy by digest (or verify the signature for the tag's current digest at admission). Multi-arch images have an **index** digest pointing to per-platform manifest digests; sign and deploy the index digest so every architecture is covered. Docker Content Trust (Notary v1) is the older Docker-native signing mechanism; it's legacy now, and Sigstore/cosign or Notation (Notary v2) are the current options.
:::

## Auditing the host: CIS Benchmark and docker-bench-security

The **CIS Docker Benchmark** is a consensus checklist covering host configuration, daemon settings, image and runtime practices. **docker-bench-security** automates many of its checks:

```bash
git clone https://github.com/docker/docker-bench-security.git
cd docker-bench-security
sudo sh docker-bench-security.sh         # on a Linux Docker host
```

It reports `[PASS]`, `[WARN]`, `[INFO]` per check, grouped by benchmark section: for example "Ensure that privileged containers are not used", "Ensure that the container's root filesystem is mounted as read only", and daemon checks for live-restore, the userland proxy, no-new-privileges and logging. (Check numbers change between benchmark versions.) Run it on servers; on a Mac it inspects the VM and is less meaningful. Treat it as a conversation starter, not a score to max out.

Other daemon-level hardening worth knowing (`/etc/docker/daemon.json` on Linux):

```json
{
  "no-new-privileges": true,
  "live-restore": true,
  "userland-proxy": false,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "icc": false
}
```

(`icc: false` disables inter-container traffic on the default bridge; user-defined networks are the cleaner way to isolate.) Protect the daemon itself: never expose the Docker API on TCP without mutual TLS, and treat membership in the `docker` group as root access.

## A hardening checklist for shipit

```text
Image
  [ ] Multi-stage, minimal runtime base (slim / distroless / hardened), pinned by digest
  [ ] USER non-root, files owned correctly, no setuid binaries needed
  [ ] No secrets in ENV/ARG/layers; BuildKit secret mounts for npm tokens
  [ ] Scanned in CI (fail on fixable critical/high), SBOM + provenance attached, signed by digest
  [ ] Rebuilt at least weekly with --pull
Runtime
  [ ] --cap-drop ALL (add back only what's proven necessary)
  [ ] --security-opt no-new-privileges
  [ ] --read-only + tmpfs /tmp (noexec) + volumes only where needed
  [ ] memory, cpu and pids limits
  [ ] default seccomp/AppArmor left on; never --privileged, never docker.sock
  [ ] only the edge service publishes ports; DB/Redis on an internal network
  [ ] secrets as files or from a secret manager
Host
  [ ] patched kernel and Docker Engine; docker group = root, treated as such
  [ ] docker-bench-security reviewed; logs rotated; rootless or userns where feasible
```

## Summary

- Containers share the host kernel; layer controls so one failure isn't fatal.
- Non-root, `--cap-drop ALL`, `no-new-privileges`, read-only rootfs + tmpfs, and resource limits cost almost nothing and stop most post-exploitation.
- Keep seccomp/AppArmor on; never `--privileged` or mount `docker.sock` into app containers.
- Secrets go through BuildKit secret mounts at build time and files or secret managers at runtime, never ENV/ARG/layers.
- Use minimal bases, rebuild often, scan in CI, attach SBOM/provenance, sign digests with cosign, and pin CI actions by SHA.
