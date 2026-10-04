These labs need Docker and a terminal. Scanners run as containers, so nothing else is required; optionally `brew install trivy grype cosign` if you prefer native tools. Docker Scout is built into Docker Desktop (`docker scout`); on OrbStack/Colima you can install the Scout CLI plugin or simply use Trivy/Grype.

```bash
mkdir -p ~/docker-labs/08-sec && cd ~/docker-labs/08-sec
```

## Lab 1: Harden a container one flag at a time

:::meta
difficulty: easy
time: 20 min
:::

Goal: observe what each hardening flag changes from inside the container.

### Steps

1. Baseline: what does a default container have?

   ```bash
   docker run --rm alpine sh -c 'id; grep -E "Cap(Eff|Bnd)" /proc/self/status; grep NoNewPrivs /proc/self/status; touch /x && echo writable-rootfs'
   ```

2. Drop all capabilities (still root):

   ```bash
   docker run --rm --cap-drop ALL alpine sh -c 'id; grep CapEff /proc/self/status; touch /x && chown nobody /x || echo "chown denied"'
   ```

3. Non-root + no-new-privileges. Compare the kernel's `NoNewPrivs` flag with and without the option (with it set, no setuid binary or file capability can ever raise privileges again):

   ```bash
   docker run --rm --user 1000:1000 alpine sh -c 'id; grep NoNewPrivs /proc/self/status'
   docker run --rm --user 1000:1000 --security-opt no-new-privileges alpine sh -c 'grep NoNewPrivs /proc/self/status'
   ```

4. Read-only root filesystem plus a `noexec` tmpfs:

   ```bash
   docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m alpine sh -c '
     touch /etc/x 2>&1 | head -1
     cp /bin/busybox /tmp/bb && /tmp/bb echo "exec from tmp works?" || echo "noexec blocked it"'
   ```

5. PID limit vs a fork bomb (safe: limited to 50 processes and killed by `--rm` on exit):

   ```bash
   docker run --rm --pids-limit 50 alpine sh -c 'for i in $(seq 1 100); do sleep 30 & done 2>&1 | tail -1; echo "spawned: $(ls /proc | grep -c "^[0-9]")"'
   ```

6. Decode the default capability set. Copy the `CapBnd` hex value from step 1 and run:

   ```bash
   docker run --rm alpine sh -c 'apk add -q libcap && capsh --decode=00000000a80425fb'
   ```

### Verify

- Step 1 shows `uid=0(root)`, a non-zero `CapEff`, `NoNewPrivs: 0`, and `writable-rootfs`.
- Step 2 shows `CapEff: 0000000000000000` and `chown denied`.
- Step 3 shows `NoNewPrivs: 1` only with the flag.
- Step 4 shows `Read-only file system` and `noexec blocked it` (`Permission denied`).
- Step 5 shows `can't fork` / `Resource temporarily unavailable` errors and fewer than 50 processes.
- Step 6 lists 14 capabilities such as `cap_chown`, `cap_net_raw`, `cap_setuid`.

:::hint
If your `CapBnd` value differs from the one in step 6, use yours. Docker's default set has been stable for years, but the hex depends on the kernel's capability numbering.
:::

:::solution
The commands are the solution. What you learned:
- Default containers run as root with 14 capabilities; `--cap-drop ALL` empties the effective set, so even root can't `chown` files it doesn't own or bypass file permissions.
- `no-new-privileges` sets the kernel flag that prevents setuid binaries (like `su` or `sudo`, if an image ships them) from raising privileges.
- `--read-only` blocks writes everywhere except explicit mounts, and `noexec` on `/tmp` stops an attacker from executing a dropped binary there.
- `--pids-limit` contains fork bombs and runaway worker spawning.
:::

### Clean up

Nothing to clean up (all containers used `--rm`).

## Lab 2: Leak a secret, then build it properly

:::meta
difficulty: medium
time: 25 min
:::

Goal: prove that `ARG`, `ENV` and "copy then delete" leak secrets, then use a BuildKit secret mount that doesn't.

### Steps

1. Create a fake token and a leaky Dockerfile:

   ```bash
   mkdir -p secret-lab && cd secret-lab
   echo "//registry.npmjs.org/:_authToken=npm_FAKE_TOKEN_123" > .npmrc
   echo '{"name":"secret-lab","version":"1.0.0","dependencies":{"ms":"^2.1.3"}}' > package.json
   cat > Dockerfile.leaky <<'EOF'
   FROM node:22-alpine
   ARG NPM_TOKEN
   ENV NPM_TOKEN=$NPM_TOKEN
   WORKDIR /app
   COPY .npmrc package.json ./
   RUN npm install && rm .npmrc
   EOF
   docker build -f Dockerfile.leaky --build-arg NPM_TOKEN=npm_FAKE_TOKEN_123 -t secret-lab:leaky .
   ```

2. Hunt for the token three ways:

   ```bash
   docker history --no-trunc secret-lab:leaky | grep -c FAKE_TOKEN
   docker inspect secret-lab:leaky -f '{{.Config.Env}}'
   docker save secret-lab:leaky -o leaky.tar && mkdir -p layers && tar -xf leaky.tar -C layers
   # every blob that is a tar archive is a layer; list the files inside each one
   for f in layers/blobs/sha256/*; do tar -tf "$f" 2>/dev/null | grep -q 'app/.npmrc' && echo "found .npmrc in layer ${f##*/}"; done
   ```

3. Rewrite as `Dockerfile` using a BuildKit secret mount so the token is available only during `npm install`, build it as `secret-lab:clean`, and repeat the hunt.

### Verify

- The leaky image exposes the token in `docker history`, in `Config.Env`, and inside a layer blob.
- The clean image: `docker history --no-trunc secret-lab:clean | grep -c FAKE_TOKEN` prints `0`, `Config.Env` doesn't contain it, and no layer contains `app/.npmrc`.

:::hint
`RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm install` and `docker build --secret id=npmrc,src=.npmrc`. Also add `.npmrc` to `.dockerignore` so it can't be `COPY`'d by accident.
:::

:::solution
```bash
cat > Dockerfile <<'EOF'
# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm install
EOF
echo ".npmrc" > .dockerignore
docker build --secret id=npmrc,src=.npmrc -t secret-lab:clean .

docker history --no-trunc secret-lab:clean | grep -c FAKE_TOKEN         # 0
docker inspect secret-lab:clean -f '{{.Config.Env}}'                     # no NPM_TOKEN
docker save secret-lab:clean -o clean.tar && rm -rf layers-clean && mkdir layers-clean && tar -xf clean.tar -C layers-clean
for f in layers-clean/blobs/sha256/*; do tar -tf "$f" 2>/dev/null | grep -q 'app/.npmrc' && echo "found in ${f##*/}"; done; echo "scan done"
```

Why the leaky version leaked:
- `ARG` values used during the build are recorded in the image history (and in provenance attestations).
- `ENV` is stored in the image config and inherited by every container.
- `COPY .npmrc` creates a layer containing the file; the later `rm` only adds a whiteout in a new layer. The original layer still holds it.

The secret mount exists only for that one `RUN` and is never part of a layer.
:::

### Clean up

```bash
cd .. && rm -rf secret-lab; docker rmi secret-lab:leaky secret-lab:clean
```

## Lab 3: Scan, compare base images, and gate on severity

:::meta
difficulty: medium
time: 30 min
:::

Goal: scan an outdated image and modern alternatives, read the results critically, and produce a CI-style pass/fail.

### Steps

1. Define a scanner alias using the Trivy container (it caches its DB in a volume):

   ```bash
   alias trivy='docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache aquasec/trivy'
   ```

   Mounting the socket lets Trivy read local images. That's acceptable here: a well-known tool, run locally, briefly, never exposed. Pin the image to a specific version tag or digest in real pipelines (see the lesson's supply-chain warning).

2. Pull and scan an end-of-life Node image and two current ones:

   ```bash
   for img in node:18-alpine node:22-alpine gcr.io/distroless/nodejs22-debian12; do
     docker pull -q $img
     echo "== $img"; trivy image --quiet --severity HIGH,CRITICAL --format table $img | grep -E '^Total|Total:' || true
   done
   docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' | grep -E 'node|distroless'
   ```

3. Only show what you can actually fix:

   ```bash
   trivy image --quiet --severity HIGH,CRITICAL --ignore-unfixed node:18-alpine
   ```

4. Gate like CI would:

   ```bash
   trivy image --quiet --exit-code 1 --severity CRITICAL --ignore-unfixed node:22-alpine; echo "exit=$?"
   ```

5. If you use Docker Desktop, compare with Scout:

   ```bash
   docker scout quickview node:18-alpine
   docker scout recommendations node:18-alpine
   ```

6. Optional: scan with Grype as a second opinion: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock anchore/grype node:18-alpine --only-fixed`.

### Verify

You can answer: Which image has the most high/critical findings? Which is smallest? How many findings disappear with `--ignore-unfixed`? What exit code did step 4 produce, and what would CI do with it?

:::hint
Results change daily as new CVEs are published and images are rebuilt, so your numbers will differ from anyone else's. That's the point: scanning is continuous, not a one-off.
:::

:::solution
Typical observations (numbers vary):
- `node:18-alpine` is end-of-life: it no longer gets rebuilt with fixes, so findings accumulate. Scout's recommendations suggest moving to a supported tag.
- `node:22-alpine` usually has few or zero fixable high/critical OS findings when freshly pulled; most findings in Node images come from the bundled `npm` and its dependencies.
- The distroless image has no shell or package manager and very few packages, so findings are minimal; the trade-off is debugging (module 09).
- `--ignore-unfixed` removes findings with no available patch. You can't fix those by upgrading; track them, assess reachability, and revisit.
- `--exit-code 1` makes the scanner fail the pipeline only for the severities you select. A good gate is "fixable CRITICAL (and maybe HIGH) fails the build"; everything else becomes a report.

For your own images, also scan the **application dependencies**: Trivy and Grype read `package-lock.json` / `node_modules` inside the image, so a vulnerable npm package shows up even on a pristine base image.
:::

### Clean up

```bash
unalias trivy; docker volume rm trivy-cache; docker rmi node:18-alpine
```

## Lab 4: Break & fix: the hardened nginx that won't start

:::meta
difficulty: medium
time: 25 min
:::

Goal: apply strict runtime hardening to nginx, read the failures, and fix them by giving the process exactly what it needs, nothing more.

### Steps

1. Run nginx with full hardening:

   ```bash
   docker run -d --name hard-web -p 8088:80 \
     --cap-drop ALL --security-opt no-new-privileges --read-only \
     nginx:alpine
   sleep 2; docker ps -a --filter name=hard-web --format '{{.Status}}'
   docker logs hard-web 2>&1 | tail -5
   ```

2. Diagnose each error in the logs. Iterate: fix one, rerun, read the next error. Constraints:
   - keep `--cap-drop ALL`, `--read-only` and `no-new-privileges`;
   - don't use `--privileged` or `--user 0` tricks;
   - the root filesystem must stay read-only (only tmpfs mounts allowed).

3. Try two strategies and compare:
   - **A**: keep `nginx:alpine` (master runs as root and switches workers to the `nginx` user) and add back only the capabilities and tmpfs mounts it needs;
   - **B**: switch to `nginxinc/nginx-unprivileged:alpine`, which runs entirely as a non-root user and listens on 8080.

### Verify

`curl -sI localhost:8088 | head -1` returns `HTTP/1.1 200 OK`, and `docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' hard-web` prints `true [ALL]`.

:::hint
Expect errors like `mkdir() "/var/cache/nginx/client_temp" failed (30: Read-only file system)`, `open() "/run/nginx.pid" failed`, and `setgid(101) failed (1: Operation not permitted)`. The last one means the root master process lost the capability to switch the worker's user and group.
:::

:::solution
**Strategy A** (root master, minimal caps):

```bash
docker rm -f hard-web
docker run -d --name hard-web -p 8088:80 \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges --read-only \
  --tmpfs /var/cache/nginx --tmpfs /run --tmpfs /tmp \
  nginx:alpine
curl -sI localhost:8088 | head -1
```

- `/var/cache/nginx` holds temp dirs for request bodies and proxying; `/run` holds the pid file.
- `SETUID`/`SETGID` let the master drop workers to UID 101; `CHOWN` lets it set ownership of its temp directories.
- Binding port 80 works without `NET_BIND_SERVICE` because Docker allows unprivileged low ports inside containers.

**Strategy B** (fully non-root image, no capabilities at all):

```bash
docker rm -f hard-web
docker run -d --name hard-web -p 8088:8080 \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp \
  nginxinc/nginx-unprivileged:alpine
curl -sI localhost:8088 | head -1
docker exec hard-web id        # uid=101(nginx)
```

The unprivileged image keeps its pid file and temp paths under `/tmp` and never needs to switch users, so it runs with **zero** capabilities. The entrypoint may log that it can't modify `/etc/nginx/conf.d` (read-only); that's harmless here. Strategy B is the better production default: nothing to add back, and the container never runs as root.

The method generalises: start from maximum restriction, read each failure, grant the narrowest fix, document why.
:::

### Clean up

```bash
docker rm -f hard-web
```

## Lab 5: Challenge: ship a hardened, scanned, attested and signed shipit image

:::meta
difficulty: hard
time: 60 min
:::

Goal: take the shipit API from module 07 to a production security baseline end to end, using a local registry.

### Requirements

1. **Image**: a multi-stage Dockerfile whose final stage is non-root and contains no npm, no build tools and no secrets. Use either `node:22-alpine` with `USER node` or `gcr.io/distroless/nodejs22-debian12` (`CMD ["src/server.js"]`, entrypoint is already `node`).
2. **Registry**: run a local registry on port 5001 (`registry:3`; port 5000 is often taken by AirPlay on macOS).
3. **Build and push** for `linux/arm64` and `linux/amd64` with an SBOM and max provenance attached. (You need a buildx builder using the `docker-container` driver for attestations and multi-platform pushes.)
4. **Scan**: fail if any fixable CRITICAL vulnerability exists. Inspect the attached SBOM.
5. **Sign** the pushed image **by digest** with a cosign key pair, and verify the signature.
6. **Run** it with the full runtime hardening from the lesson (non-root, `--cap-drop ALL`, `no-new-privileges`, `--read-only`, tmpfs `/tmp`, memory/CPU/PID limits) against Postgres and Redis on an internal network, and show `/readyz` returns ready.

:::hint
- `docker buildx create --name attest --driver docker-container --driver-opt network=host --use` lets BuildKit (running in a container) reach `localhost:5001`.
- The push output and `--metadata-file meta.json` give you `containerimage.digest`.
- `cosign generate-key-pair` creates `cosign.key`/`cosign.pub`. Cosign talks to `localhost` registries over plain HTTP automatically. Keyed signing also records an entry in the public Rekor transparency log by default; that's fine for a test digest. Flags differ between cosign major versions, so check `cosign sign --help`.
:::

:::solution
```dockerfile
# syntax=docker/dockerfile:1
# Dockerfile.secure (in ~/docker-labs/shipit)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
COPY --from=deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json ./
COPY --chown=65532:65532 src ./src
USER 65532:65532
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["src/server.js"]
```

(Distroless images have no shell, so Compose/Docker healthchecks need a different approach; module 10 covers a tiny Node-based check you can exec with the image's own `node` binary: `["CMD", "/nodejs/bin/node", "-e", "..."]`.)

```bash
cd ~/docker-labs/shipit
docker run -d --name registry -p 5001:5000 registry:3
docker buildx create --name attest --driver docker-container --driver-opt network=host --use

docker buildx build -f Dockerfile.secure \
  --platform linux/arm64,linux/amd64 \
  --sbom=true --provenance=mode=max \
  -t localhost:5001/shipit-api:1.0.0 \
  --metadata-file meta.json --push .
DIGEST=$(python3 -c 'import json;print(json.load(open("meta.json"))["containerimage.digest"])')
echo $DIGEST

docker buildx imagetools inspect localhost:5001/shipit-api:1.0.0
docker buildx imagetools inspect localhost:5001/shipit-api:1.0.0 --format '{{json .SBOM}}' | head -c 600; echo

# Scan (Trivy needs to reach the host's localhost registry: use host networking on the scanner)
docker run --rm --network host aquasec/trivy image --quiet --insecure \
  --exit-code 1 --severity CRITICAL --ignore-unfixed localhost:5001/shipit-api:1.0.0; echo "scan exit=$?"

# Sign and verify by digest
cosign generate-key-pair
cosign sign --yes --key cosign.key localhost:5001/shipit-api@$DIGEST
cosign verify --key cosign.pub localhost:5001/shipit-api@$DIGEST | head -c 300; echo

# Run hardened
docker network create --internal sec-data
docker network create sec-edge
docker run -d --name sec-db --network sec-data -e POSTGRES_USER=shipit -e POSTGRES_PASSWORD=shipit -e POSTGRES_DB=shipit postgres:18
docker run -d --name sec-cache --network sec-data redis:8-alpine
sleep 5
docker run --rm --network sec-data -e DATABASE_URL=postgres://shipit:shipit@sec-db:5432/shipit \
  localhost:5001/shipit-api@$DIGEST src/migrate.js
docker create --name sec-api --network sec-edge -p 127.0.0.1:3000:3000 \
  --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --memory 256m --cpus 0.5 --pids-limit 100 \
  -e DATABASE_URL=postgres://shipit:shipit@sec-db:5432/shipit -e REDIS_URL=redis://sec-cache:6379 \
  localhost:5001/shipit-api@$DIGEST
docker network connect sec-data sec-api      # attach the internal network before the first start
docker start sec-api
sleep 2; curl -s localhost:3000/readyz
```

Notes:
- The container is created on `sec-edge` (so the port can be published), attached to the internal `sec-data` network, and only then started, so it can reach Postgres and Redis from its first second. Same pattern as module 06's challenge.
- Deploying `@$DIGEST` guarantees you run exactly what you scanned and signed.
- On macOS, `docker run --network host` for Trivy refers to the Docker VM's network, where the registry's published port 5001 is reachable.
- In CI you'd use keyless signing (`cosign sign --yes <ref>@<digest>` with the workflow's OIDC token) instead of a key file.
:::

### Clean up

```bash
docker rm -f sec-api sec-db sec-cache registry
docker network rm sec-data sec-edge
docker buildx rm attest
rm -f cosign.key cosign.pub meta.json
```
