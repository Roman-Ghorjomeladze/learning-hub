In these labs you build the first version of `shipit-api`, learn the cache by measuring it, and practise the Dockerfile rules that cause the most real-world trouble. You don't need Node.js on your Mac — dependency locking and builds happen in containers.

The `~/hub-labs/shipit-api` folder created in Lab 2 is reused in module 04; keep it.

## Lab 1: Tags, digests and image metadata

:::meta
difficulty: easy
time: 15 min
:::

Goal: see the difference between a tag and a digest, and read an image's metadata.

### Steps

1. Pull an image by tag and look at its identifiers:

```bash
docker pull redis:8-alpine
docker image inspect redis:8-alpine --format 'id={{.Id}}
repoDigests={{json .RepoDigests}}
platform={{.Os}}/{{.Architecture}}
entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}
user={{json .Config.User}} workdir={{json .Config.WorkingDir}}
exposed={{json .Config.ExposedPorts}}'
```

2. Inspect the multi-platform index in the registry, without pulling:

```bash
docker buildx imagetools inspect redis:8-alpine
```

3. Pull the same content by digest and run it pinned:

```bash
DIGEST=$(docker image inspect redis:8-alpine --format '{{index .RepoDigests 0}}' | cut -d@ -f2)
echo "$DIGEST"
docker run --rm "redis@$DIGEST" redis-server --version
```

4. Give it another name and check that no data was copied:

```bash
docker tag redis:8-alpine my-cache:pinned
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -E 'redis|my-cache'
```

5. Look at the layer history:

```bash
docker history redis:8-alpine
```

### Verify

- `RepoDigests` contains `redis@sha256:...`; `imagetools inspect` shows the same index digest (`Digest:` line) with manifests for several platforms.
- Running by digest works, and `my-cache:pinned` shows the **same image ID** as `redis:8-alpine`.
- The platform is `linux/arm64` on Apple Silicon.

:::hint
`RepoDigests` stores the digest of what the registry served for the tag — for multi-platform images that is the **index** digest, which covers all platforms. Your local image ID refers to the platform-specific content.
:::

:::solution
```text
repoDigests=["redis@sha256:3a3f1c...e9"]
platform=linux/arm64
entrypoint=["docker-entrypoint.sh"] cmd=["redis-server"]
user="" workdir="/data"
exposed={"6379/tcp":{}}

$ docker buildx imagetools inspect redis:8-alpine
Name:      docker.io/library/redis:8-alpine
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:3a3f1c...e9
Manifests:
  Name:      docker.io/library/redis:8-alpine@sha256:...
  Platform:  linux/amd64
  ...
  Platform:  linux/arm64/v8
```

- `docker tag` only adds a name — same ID, no extra disk usage.
- Pinning by index digest is what you put in production manifests and Dockerfiles (`FROM redis:8-alpine@sha256:...`): the tag documents intent, the digest guarantees content, and each platform still resolves to its own manifest.
- An empty `user` means the container starts as root (the Redis entrypoint drops to the `redis` user itself).
:::

### Clean up

```bash
docker image rm my-cache:pinned
```

## Lab 2: Build shipit-api

:::meta
difficulty: medium
time: 35 min
:::

Goal: containerise the shared sample app with a correct, cache-friendly single-stage Dockerfile and run it against real Postgres and Redis.

### Steps

1. Create the project:

```bash
mkdir -p ~/hub-labs/shipit-api/src && cd ~/hub-labs/shipit-api
```

`package.json`:

```json
{
  "name": "shipit-api",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "express": "^5.1.0",
    "ioredis": "^5.4.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.7.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`src/index.ts`:

```typescript
import express from "express";
import { Pool } from "pg";
import { Redis } from "ioredis";

const port = Number(process.env.PORT ?? 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
pool.on("error", (err) => console.error("pg error:", err.message));
redis.on("error", () => {}); // ioredis reconnects on its own; /readyz reports the state
redis.connect().catch(() => {});

async function ensureSchema() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
}

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ready" });
  } catch (err) {
    res.status(503).json({ status: "not ready", error: (err as Error).message });
  }
});

app.get("/items", async (_req, res) => {
  const cached = await redis.get("items").catch(() => null);
  if (cached) {
    res.set("x-cache", "hit").json(JSON.parse(cached));
    return;
  }
  await ensureSchema();
  const { rows } = await pool.query("SELECT id, name, created_at FROM items ORDER BY id");
  await redis.set("items", JSON.stringify(rows), "EX", 30).catch(() => {});
  res.set("x-cache", "miss").json(rows);
});

app.post("/items", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  await ensureSchema();
  const { rows } = await pool.query("INSERT INTO items (name) VALUES ($1) RETURNING *", [name]);
  await redis.del("items").catch(() => {});
  res.status(201).json(rows[0]);
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

const server = app.listen(port, () => console.log(`shipit-api listening on :${port}`));

function shutdown(signal: string) {
  console.log(`${signal} received, closing server`);
  server.close(async () => {
    await pool.end().catch(() => {});
    redis.disconnect();
    console.log("bye");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

2. Generate `package-lock.json` inside a container (no local Node needed):

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund
ls -l package-lock.json
```

3. Write `.dockerignore` and `Dockerfile`:

```text
node_modules
dist
.git
.env
.env.*
npm-debug.log*
Dockerfile*
.dockerignore
```

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
```

4. Build and run it alone:

```bash
docker build -t shipit-api:dev .
docker run -d --name shipit -p 127.0.0.1:3000:3000 shipit-api:dev
sleep 2
curl -s localhost:3000/healthz; echo
curl -s -w ' (HTTP %{http_code})\n' localhost:3000/readyz
```

5. Add Postgres and Redis on a user-defined network (container names become DNS names — the networking module explains why):

```bash
docker rm -f shipit
docker network create shipit-net
docker run -d --name db --network shipit-net -e POSTGRES_USER=shipit -e POSTGRES_PASSWORD=shipit -e POSTGRES_DB=shipit postgres:17-alpine
docker run -d --name cache --network shipit-net redis:8-alpine
sleep 5
docker run -d --name shipit --network shipit-net -p 127.0.0.1:3000:3000 \
  -e DATABASE_URL=postgres://shipit:shipit@db:5432/shipit \
  -e REDIS_URL=redis://cache:6379 \
  shipit-api:dev
sleep 2
curl -s localhost:3000/readyz; echo
curl -s -X POST localhost:3000/items -H 'content-type: application/json' -d '{"name":"first item"}'; echo
curl -si localhost:3000/items | grep -iE 'x-cache|^\['
curl -si localhost:3000/items | grep -iE 'x-cache'
```

6. Look at what you built:

```bash
docker image ls shipit-api:dev
docker history shipit-api:dev
time docker stop shipit
docker logs shipit | tail -3
```

### Verify

- Alone, `/healthz` returns `{"status":"ok"}` and `/readyz` returns HTTP 503 with a connection error.
- With dependencies, `/readyz` returns `{"status":"ready"}`, `POST /items` returns 201, the first `GET /items` shows `x-cache: miss` and the second `x-cache: hit`.
- `docker stop` completes in well under a second and the logs end with `SIGTERM received, closing server` and `bye` — exec-form CMD plus the app's handler.
- Note the image size (several hundred MB) — you'll cut it drastically in module 04.

:::hint
If `npm ci` fails with "package.json and package-lock.json are not in sync", re-run step 2. If `/readyz` stays 503 with dependencies, check `docker logs db` (Postgres needs a few seconds on first start) and that all three containers are on `shipit-net` (`docker network inspect shipit-net`).
:::

:::solution
```text
$ curl -s localhost:3000/healthz
{"status":"ok"}
$ curl -s -w ' (HTTP %{http_code})\n' localhost:3000/readyz
{"status":"not ready","error":"connect ECONNREFUSED 127.0.0.1:5432"} (HTTP 503)

$ curl -s localhost:3000/readyz
{"status":"ready"}
$ curl -s -X POST localhost:3000/items -H 'content-type: application/json' -d '{"name":"first item"}'
{"id":1,"name":"first item","created_at":"2026-10-04T09:12:44.120Z"}
$ curl -si localhost:3000/items | grep -iE 'x-cache'
x-cache: miss
$ curl -si localhost:3000/items | grep -iE 'x-cache'
x-cache: hit

$ docker image ls shipit-api:dev
REPOSITORY   TAG   IMAGE ID       CREATED         SIZE
shipit-api   dev   5b2c...        1 minute ago    ~330MB
```

Why the Dockerfile is shaped this way:

- `package.json` + `package-lock.json` are copied alone so `npm ci` is cached until dependencies change.
- `.dockerignore` keeps any local `node_modules`/`dist` out — dependencies are always built for Linux inside the image.
- Exec-form `CMD` makes node PID 1 with the app's own SIGTERM handler, so shutdown is immediate and graceful.
- Without `DATABASE_URL`, `pg` falls back to `localhost:5432` — inside the container that's the container itself, hence `ECONNREFUSED 127.0.0.1:5432`.

What's still wrong (fixed in module 04): TypeScript and `@types/*` ship in the image, it runs as root, the base tag is mutable, and there's no `HEALTHCHECK`.
:::

### Clean up

```bash
docker rm -f shipit db cache
docker network rm shipit-net
```

Keep the `shipit-api:dev` image and the project folder.

## Lab 3: Measure the build cache

:::meta
difficulty: medium
time: 25 min
:::

Goal: prove with numbers why dependency manifests are copied before the source.

### Steps

1. In `~/hub-labs/shipit-api`, create a deliberately bad Dockerfile:

```bash
cd ~/hub-labs/shipit-api
cat > Dockerfile.slow <<'EOF'
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
CMD ["node", "dist/index.js"]
EOF
```

2. Build both once to warm the cache:

```bash
docker build -q -t shipit-api:fast -f Dockerfile .
docker build -q -t shipit-api:slow -f Dockerfile.slow .
```

3. Make a source-only change and time rebuilds with full output:

```bash
echo "// touched $(date +%s)" >> src/index.ts
time docker build --progress=plain -t shipit-api:fast -f Dockerfile . 2>&1 | grep -E 'CACHED|RUN|DONE' | tail -12
time docker build --progress=plain -t shipit-api:slow -f Dockerfile.slow . 2>&1 | grep -E 'CACHED|RUN|DONE' | tail -12
```

4. Now make a dependency-only change and rebuild the fast version:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund zod@^3
time docker build --progress=plain -t shipit-api:fast . 2>&1 | grep -E 'CACHED|RUN' | tail -8
```

5. Check whether `touch` (a timestamp change without a content change) busts the cache:

```bash
touch src/index.ts package.json
docker build --progress=plain -t shipit-api:fast . 2>&1 | grep -c CACHED
```

### Verify

- After the source change, the fast build shows `CACHED` for `COPY package.json...` and `RUN npm ci`, and only re-runs `COPY src` and `npm run build`.
- The slow build re-runs `npm ci` and takes noticeably longer.
- After the dependency change, `npm ci` re-runs in the fast build too (expected).
- `touch` alone produces no cache misses.

:::hint
Use `--progress=plain` to see each step's status; BuildKit prints `CACHED` for reused steps. If both builds look equally fast, your network/npm cache may be very quick — compare the `npm ci` lines: present in one output, `CACHED` in the other.
:::

:::solution
Typical timings on an M-series Mac:

```text
# fast, source change
#7 [3/7] COPY package.json package-lock.json ./   CACHED
#8 [4/7] RUN npm ci                               CACHED
#10 [6/7] COPY src ./src
#11 [7/7] RUN npm run build
real    0m4.1s

# slow, source change
#7 [3/5] COPY . .
#8 [4/5] RUN npm ci
#9 [5/5] RUN npm run build
real    0m21.8s
```

- `COPY . .` includes `src/index.ts`, so its checksum changes, and every step after it — including `npm ci` — rebuilds.
- BuildKit's `COPY` cache key is based on **file contents and metadata like permissions, not modification times**, so `touch` doesn't invalidate anything.
- In CI, where runners are often fresh, this ordering only pays off if the cache is persisted: `--cache-to/--cache-from type=registry` or `type=gha` (see the deep dive in the lesson).

Revert the experiment:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm uninstall --package-lock-only --no-audit --no-fund zod
sed -i '' '/^\/\/ touched/d' src/index.ts   # macOS sed; on Linux: sed -i '/^\/\/ touched/d' src/index.ts
```
:::

### Clean up

```bash
rm Dockerfile.slow
docker image rm shipit-api:slow shipit-api:fast
```

## Lab 4: CMD, ENTRYPOINT, shell form and ARG vs ENV drills

:::meta
difficulty: medium
time: 25 min
:::

Goal: lock in the rules by predicting, then observing, how small Dockerfiles behave.

### Steps

1. Set up:

```bash
mkdir -p ~/hub-labs/drills && cd ~/hub-labs/drills
```

2. ENTRYPOINT + CMD. Predict each output before running:

```bash
cat > Dockerfile.entry <<'EOF'
FROM alpine:3.22
ENTRYPOINT ["echo", "entry:"]
CMD ["default-arg"]
EOF
docker build -q -t drill-entry -f Dockerfile.entry .
docker run --rm drill-entry
docker run --rm drill-entry custom args
docker run --rm --entrypoint date drill-entry
docker run --rm --entrypoint echo drill-entry "only CMD replaced?"
```

3. Shell form vs exec form with variables:

```bash
cat > Dockerfile.forms <<'EOF'
FROM alpine:3.22
ENV PORT=3000
CMD ["echo", "exec form says port=$PORT"]
EOF
docker build -q -t drill-exec -f Dockerfile.forms .
sed 's/^CMD .*/CMD echo "shell form says port=$PORT"/' Dockerfile.forms > Dockerfile.forms2
docker build -q -t drill-shell -f Dockerfile.forms2 .
docker run --rm drill-exec
docker run --rm drill-shell
docker run --rm -e PORT=8080 drill-shell
docker inspect -f '{{json .Config.Cmd}}' drill-shell
```

4. ARG vs ENV:

```bash
cat > Dockerfile.args <<'EOF'
FROM alpine:3.22
ARG BUILD_ONLY=from-default
ENV RUNTIME_TOO=baked-in
RUN echo "at build: BUILD_ONLY=$BUILD_ONLY RUNTIME_TOO=$RUNTIME_TOO" | tee /build-info.txt
CMD ["sh", "-c", "echo at runtime: BUILD_ONLY=$BUILD_ONLY RUNTIME_TOO=$RUNTIME_TOO; cat /build-info.txt"]
EOF
docker build -q --build-arg BUILD_ONLY=from-cli -t drill-args -f Dockerfile.args .
docker run --rm drill-args
docker history --no-trunc --format '{{.CreatedBy}}' drill-args | grep BUILD_ONLY
```

5. The single-quote trap:

```bash
printf "FROM alpine:3.22\nCMD ['echo', 'hello']\n" > Dockerfile.quotes
docker build -q -t drill-quotes -f Dockerfile.quotes .
docker inspect -f '{{json .Config.Cmd}}' drill-quotes
docker run --rm drill-quotes
```

### Verify

You predicted correctly (or understand why not) for each command — compare with the solution.

:::hint
Final command = ENTRYPOINT + CMD. Arguments after the image replace CMD; `--entrypoint` replaces ENTRYPOINT **and clears CMD**. Exec form runs the binary directly — nobody expands `$PORT`. A JSON array with single quotes is not valid JSON.
:::

:::solution
```text
$ docker run --rm drill-entry
entry: default-arg
$ docker run --rm drill-entry custom args
entry: custom args
$ docker run --rm --entrypoint date drill-entry
Sat Oct  4 09:30:00 UTC 2026            # --entrypoint also resets CMD, so date gets no args
$ docker run --rm --entrypoint echo drill-entry "only CMD replaced?"
only CMD replaced?

$ docker run --rm drill-exec
exec form says port=$PORT               # no shell → no expansion
$ docker run --rm drill-shell
shell form says port=3000
$ docker run --rm -e PORT=8080 drill-shell
shell form says port=8080
$ docker inspect -f '{{json .Config.Cmd}}' drill-shell
["/bin/sh","-c","echo \"shell form says port=$PORT\""]

$ docker run --rm drill-args
at runtime: BUILD_ONLY= RUNTIME_TOO=baked-in
at build: BUILD_ONLY=from-cli RUNTIME_TOO=baked-in
$ docker history ... | grep BUILD_ONLY
RUN |1 BUILD_ONLY=from-cli /bin/sh -c echo "at build: ..."   # the ARG value is recorded!

$ docker inspect -f '{{json .Config.Cmd}}' drill-quotes
["/bin/sh","-c","['echo', 'hello']"]
$ docker run --rm drill-quotes
/bin/sh: [echo,: not found
```

Takeaways:

- If you need variable expansion with exec form, call a shell explicitly: `CMD ["sh", "-c", "exec node dist/index.js --port=$PORT"]` (note the `exec`), or better, read env vars in the app.
- `ARG` values used by `RUN` are recorded in the image history — never use them for secrets.
- Single-quoted "JSON" silently becomes shell form. `docker build --check` (BuildKit's built-in build checks) and hadolint flag this (`JSONArgsRecommended`, DL3025).
:::

### Clean up

```bash
docker image rm drill-entry drill-exec drill-shell drill-args drill-quotes
cd ~ && rm -rf ~/hub-labs/drills
```

## Lab 5: Break and fix — the leaky, bloated image

:::meta
difficulty: medium
time: 30 min
:::

Goal: a security scan flagged a secret in an image, and the platform team complains it's huge. Find every problem and fix the build.

### Steps

1. Create the broken project exactly as given:

```bash
mkdir -p ~/hub-labs/leaky && cd ~/hub-labs/leaky
cat > server.js <<'EOF'
require("node:http").createServer((_, res) => res.end("ok\n")).listen(3000, () => console.log("up"));
EOF
echo 'STRIPE_SECRET_KEY=sk_test_51FAKEKEYdoNotUse' > .env
mkdir -p node_modules/.cache && head -c 157286400 /dev/zero > node_modules/.cache/big.bin   # 150 MB of "local deps"
git init -q 2>/dev/null || mkdir -p .git
cat > Dockerfile <<'EOF'
FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
RUN apt-get update
RUN apt-get install -y curl
RUN rm -rf /var/lib/apt/lists/*
CMD ["node", "server.js"]
EOF
```

2. Build it and note the output and size:

```bash
docker build -t leaky:bad . 2>&1 | grep -iE 'transferring context|naming'
docker image ls leaky:bad
```

3. Investigate with the tools from this module — do not just read the Dockerfile. Find:
   - what was sent as build context and why it's so large,
   - which secret is in the image and how an attacker would extract it,
   - which layers waste space, using `docker history` and `dive leaky:bad`.

4. Fix the build so that: the context is tiny, no secret or `.git` is in the image, apt leaves nothing behind, and the image is as small as possible with this base. Build as `leaky:good` and compare.

### Verify

- `transferring context` drops from ~150 MB to a few KB.
- `docker run --rm leaky:good ls -la /app` shows only `server.js` (and `Dockerfile` is fine either way).
- `docker run --rm leaky:good cat /app/.env` fails.
- `leaky:good` is ~150 MB+ smaller than `leaky:bad`, and `dive` reports no wasted space from apt lists.

:::hint
`docker run --rm leaky:bad ls -la /app` and `docker run --rm leaky:bad cat /app/.env` are how an attacker reads files — anyone with pull access can. In `dive`, look at the `COPY . .` layer size and at the apt layers: `rm` in its own `RUN` creates a whiteout but the lists still ship in the earlier layer.
:::

:::solution
Investigation:

```text
$ docker build -t leaky:bad . 2>&1 | grep -i 'transferring context'
#5 transferring context: 157.30MB 1.9s

$ docker run --rm leaky:bad ls -la /app
drwxr-xr-x .git
-rw-r--r-- .env
-rw-r--r-- Dockerfile
drwxr-xr-x node_modules
-rw-r--r-- server.js
$ docker run --rm leaky:bad cat /app/.env
STRIPE_SECRET_KEY=sk_test_51FAKEKEYdoNotUse

$ docker history leaky:bad
CREATED BY                                   SIZE
RUN /bin/sh -c rm -rf /var/lib/apt/lists/*   0B      ← whiteouts only
RUN /bin/sh -c apt-get install -y curl       ~20MB
RUN /bin/sh -c apt-get update                ~19MB   ← lists still shipped here
COPY . . # buildkit                          157MB   ← node_modules + .git + .env
WORKDIR /app                                 0B
```

Even after removing the file from the image, **rotate the leaked key** — it was published to every registry and machine that pulled the image.

Fix — `.dockerignore`:

```text
node_modules
.git
.env
.env.*
Dockerfile*
.dockerignore
```

Fix — `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js ./
CMD ["node", "server.js"]
```

```bash
docker build -t leaky:good . 2>&1 | grep -i 'transferring context'   # ~ 100B–1kB
docker image ls leaky
dive leaky:good
```

Improvements: explicit `COPY server.js` (an allow-list beats `COPY . .`), `.dockerignore` as a second safety net, apt update/install/cleanup in one layer, `--no-install-recommends`, and the apt layer placed before the app copy so code changes don't re-run it. Ask yourself whether `curl` is needed at all — every package is attack surface (module 04 swaps to images without a package manager).
:::

### Clean up

```bash
docker image rm leaky:bad leaky:good
cd ~ && rm -rf ~/hub-labs/leaky
```

## Lab 6: Challenge — publish shipit-api to a registry and deploy by digest

:::meta
difficulty: hard
time: 40 min
:::

Goal: practise the full publish flow against a local registry (no account needed), then optionally against GHCR.

### Requirements

1. Run a local registry (`registry:3`) reachable at `localhost:5001` (port 5000 is taken by AirPlay Receiver on macOS).
2. Publish `shipit-api:dev` from Lab 2 as `localhost:5001/shipit-api` with **two tags**: `1.0.0` and `sha-<short git sha>` (initialise a git repo in the project and commit if needed).
3. Using only `curl` against the registry's HTTP API, list the repositories and tags, and read the **digest** of `1.0.0` from the `Docker-Content-Digest` response header.
4. Delete every local copy of the image, then run the API **by digest** from the registry and hit `/healthz`.
5. Run `docker init` in a **copy** of the project and write down three differences between its Dockerfile and yours.
6. Optional: push the same image to `ghcr.io/<your-user>/shipit-api:1.0.0` and make the package private.

:::hint
The registry API: `GET /v2/_catalog`, `GET /v2/<name>/tags/list`, and `HEAD /v2/<name>/manifests/<tag>` with `Accept` headers for OCI index and manifest media types (`application/vnd.oci.image.index.v1+json`, `application/vnd.oci.image.manifest.v1+json`, and the Docker v2 equivalents). For GHCR, create a classic personal access token with `write:packages` and log in with `--password-stdin`.
:::

:::solution
```bash
cd ~/hub-labs/shipit-api
git init -q 2>/dev/null; git add -A && git commit -qm "shipit-api v1" 2>/dev/null || true
SHA=$(git rev-parse --short HEAD)

# 1. local registry
docker run -d --name registry -p 127.0.0.1:5001:5000 registry:3

# 2. tag and push
docker tag shipit-api:dev localhost:5001/shipit-api:1.0.0
docker tag shipit-api:dev "localhost:5001/shipit-api:sha-$SHA"
docker push localhost:5001/shipit-api:1.0.0
docker push "localhost:5001/shipit-api:sha-$SHA"     # "Layer already exists" for every layer

# 3. registry API
curl -s localhost:5001/v2/_catalog; echo
curl -s localhost:5001/v2/shipit-api/tags/list; echo
DIGEST=$(curl -sI \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  localhost:5001/v2/shipit-api/manifests/1.0.0 | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}' | tr -d '\r')
echo "$DIGEST"

# 4. remove local copies, run by digest
docker image rm shipit-api:dev localhost:5001/shipit-api:1.0.0 "localhost:5001/shipit-api:sha-$SHA"
docker run -d --name shipit-digest -p 127.0.0.1:3000:3000 "localhost:5001/shipit-api@$DIGEST"
sleep 2 && curl -s localhost:3000/healthz; echo
docker image ls --digests | grep shipit-api
```

Expected:

```text
{"repositories":["shipit-api"]}
{"name":"shipit-api","tags":["1.0.0","sha-3f9c2ab"]}
sha256:7d1e0b...
{"status":"ok"}
```

Both tags point to the same digest — tags are just names. Deploying `@sha256:...` guarantees the exact bytes you tested, even if someone later re-pushes `1.0.0`.

5. `docker init` in a copy:

```bash
cp -R ~/hub-labs/shipit-api ~/hub-labs/shipit-init && cd ~/hub-labs/shipit-init && rm Dockerfile .dockerignore
docker init     # Node, 22, npm, build: yes, output: dist, start: node dist/index.js, port: 3000
```

Typical differences: it uses a **multi-stage** build (deps, build, final), **cache mounts** (`--mount=type=cache,target=/root/.npm`) and **bind mounts** for `package.json`/lockfile instead of `COPY`, runs as the non-root **`node` user**, installs production dependencies separately with `--omit=dev`, uses an `ARG NODE_VERSION`, and generates a `compose.yaml`. Those are exactly the topics of module 04.

6. GHCR (optional):

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <your-user> --password-stdin
docker pull "localhost:5001/shipit-api@$DIGEST"
docker tag "localhost:5001/shipit-api@$DIGEST" ghcr.io/<your-user>/shipit-api:1.0.0
docker push ghcr.io/<your-user>/shipit-api:1.0.0
```

New GHCR packages are private by default for personal accounts; check under your GitHub profile → Packages → shipit-api → Package settings.
:::

### Clean up

```bash
docker rm -f shipit-digest registry
docker image rm "localhost:5001/shipit-api@$DIGEST" 2>/dev/null || true
rm -rf ~/hub-labs/shipit-init
# Rebuild the dev image for module 04:
cd ~/hub-labs/shipit-api && docker build -t shipit-api:dev .
```
