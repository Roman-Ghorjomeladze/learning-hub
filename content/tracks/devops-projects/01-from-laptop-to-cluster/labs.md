Each lab below is a **milestone** of one project. Do them in order, in one Git repository, and commit at the end of each. Later projects (CI/CD and incident drills) build on this repository.

**Prerequisites** (Mac, Apple Silicon or Intel):

```bash
# Docker Desktop or OrbStack must be running. Then:
brew install kind kubectl helm terraform node@22 gh hey
docker version && kind version && kubectl version --client && helm version && terraform version && node --version
```

- Node 22 for local development (`node --version` prints `v22.x`). If Homebrew's `node@22` is keg-only, follow its caveat to add it to your `PATH`, or use `fnm`/`nvm`.
- A GitHub account (for GHCR and, in Project 2, Actions).
- Free ports on your Mac: 3000, 5432, 6379 (local dev) and 8080 (the cluster's Gateway).

Create the repository once:

```bash
mkdir -p ~/code/shipit && cd ~/code/shipit
git init -b main
mkdir -p app/src app/test deploy/charts deploy/envs/local infra scripts
gh repo create shipit --public --source . --remote origin   # or create it in the GitHub UI
```

`.gitignore`

```text
node_modules/
dist/
.env
infra/.terraform/
infra/.kube/
infra/terraform.tfstate*
infra/*.tfplan
*.tgz
```

:::tip Keep a running README
After each milestone, add a section to `README.md`: what you built, the command to run it, and one decision you made. By the end you have the portfolio write-up for free.
:::

## Milestone 1: Write shipit-api and its tests

:::meta
difficulty: medium
time: 60 min
:::

Goal: a small but production-shaped TypeScript service that runs locally against Postgres and Redis, with tests that need neither.

### Steps

1. Create the project files in `app/`:

`app/package.json`

```json
{
  "name": "shipit-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node --import tsx --test test/*.test.ts"
  },
  "dependencies": {
    "express": "^5.2.1",
    "ioredis": "^6.0.0",
    "pg": "^8.23.1"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/express": "^5.0.6",
    "@types/node": "^22.20.5",
    "@types/pg": "^8.23.1",
    "eslint": "^10.12.0",
    "tsx": "^4.23.15",
    "typescript": "~6.0.3",
    "typescript-eslint": "^8.71.0"
  }
}
```

`app/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

`app/tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

`app/eslint.config.mjs`

```javascript
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
```

2. Configuration. Required variables are validated at startup so a misconfigured pod fails loudly instead of half-working:

`app/src/config.ts`

```typescript
export interface Config {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  shutdownDelayMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["DATABASE_URL", "REDIS_URL"].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`missing required env: ${missing.join(", ")}`);
  }
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL as string,
    redisUrl: env.REDIS_URL as string,
    shutdownDelayMs: Number(env.SHUTDOWN_DELAY_MS ?? 5000),
  };
}
```

3. The HTTP app. It depends on **interfaces**, not on `pg` or `ioredis`, which is what makes it testable:

`app/src/app.ts`

```typescript
import express, { type NextFunction, type Request, type Response } from "express";

export interface Item {
  id: number;
  name: string;
  createdAt: string;
}

export interface ItemStore {
  list(): Promise<Item[]>;
  create(name: string): Promise<Item>;
  ping(): Promise<void>;
}

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  ping(): Promise<void>;
}

export interface AppState {
  shuttingDown: boolean;
}

const ITEMS_KEY = "items:all";
const ITEMS_TTL_SECONDS = 30;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function createApp(store: ItemStore, cache: Cache, state: AppState) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // Liveness: is the process able to serve HTTP? Never checks dependencies.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: should this pod receive traffic right now?
  app.get("/readyz", async (_req, res) => {
    if (state.shuttingDown) {
      res.status(503).json({ status: "shutting down" });
      return;
    }
    try {
      await withTimeout(Promise.all([store.ping(), cache.ping()]), 1000);
      res.json({ status: "ready" });
    } catch (err) {
      res.status(503).json({ status: "not ready", error: (err as Error).message });
    }
  });

  // Express 5 forwards rejected promises to the error handler automatically.
  app.get("/items", async (_req, res) => {
    const cached = await cache.get(ITEMS_KEY).catch(() => null); // cache failure = cache miss
    if (cached) {
      res.set("x-cache", "hit").json(JSON.parse(cached));
      return;
    }
    const items = await store.list();
    await cache.set(ITEMS_KEY, JSON.stringify(items), ITEMS_TTL_SECONDS).catch(() => undefined);
    res.set("x-cache", "miss").json(items);
  });

  app.post("/items", async (req, res) => {
    const body = req.body as { name?: unknown } | undefined;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length === 0 || name.length > 200) {
      res.status(400).json({ error: "name is required (1-200 characters)" });
      return;
    }
    const item = await store.create(name);
    await cache.del(ITEMS_KEY).catch(() => undefined);
    res.status(201).json(item);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) {
      console.error(JSON.stringify({ level: "error", msg: "request failed", error: String(err) }));
    }
    res.status(status).json({ error: status >= 500 ? "internal error" : "bad request" });
  });

  return app;
}
```

4. The Postgres store and the Redis cache:

`app/src/db.ts`

```typescript
import pg from "pg";
import type { Item, ItemStore } from "./app.js";

interface ItemRow {
  id: number;
  name: string;
  created_at: Date;
}

const toItem = (row: ItemRow): Item => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
});

export interface PgStore extends ItemStore {
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export function createPgStore(connectionString: string): PgStore {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30_000,
  });
  // Without this listener an idle-client error (e.g. Postgres restart) crashes the process.
  pool.on("error", (err) => {
    console.error(JSON.stringify({ level: "error", msg: "pg pool error", error: err.message }));
  });

  return {
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS items (
          id         SERIAL PRIMARY KEY,
          name       TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    },
    async list() {
      const result = await pool.query<ItemRow>(
        "SELECT id, name, created_at FROM items ORDER BY id DESC LIMIT 100",
      );
      return result.rows.map(toItem);
    },
    async create(name) {
      const result = await pool.query<ItemRow>(
        "INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at",
        [name],
      );
      return toItem(result.rows[0]);
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
  };
}
```

`app/src/cache.ts`

```typescript
import { Redis } from "ioredis";
import type { Cache } from "./app.js";

export interface RedisCache extends Cache {
  close(): Promise<void>;
}

export function createRedisCache(url: string): RedisCache {
  const redis = new Redis(url, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // fail fast instead of queueing commands while disconnected
  });
  redis.on("error", (err: Error) => {
    console.error(JSON.stringify({ level: "error", msg: "redis error", error: err.message }));
  });

  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, "EX", ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
    async ping() {
      await redis.ping();
    },
    async close() {
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
```

5. The entrypoint: config, migrations with retry, listen, graceful shutdown:

`app/src/server.ts`

```typescript
import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "./app.js";
import { createRedisCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { createPgStore } from "./db.js";

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    log("fatal", (err as Error).message);
    return process.exit(1);
  }
})();

const store = createPgStore(config.databaseUrl);
const cache = createRedisCache(config.redisUrl);
const state = { shuttingDown: false };

async function migrateWithRetry(attempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await store.migrate();
      log("info", "migrations applied");
      return;
    } catch (err) {
      log("warn", "database not reachable yet", { attempt, error: (err as Error).message });
      if (attempt === attempts) throw err;
      await sleep(2000);
    }
  }
}

try {
  await migrateWithRetry();
} catch {
  log("fatal", "giving up on database");
  process.exit(1);
}

const app = createApp(store, cache, state);
const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    log("fatal", "listen failed", { error: err.message });
    process.exit(1);
  }
  log("info", "listening", { port: config.port });
});
// Keep idle connections open longer than the proxy in front of us does.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

async function shutdown(signal: string): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true; // /readyz now returns 503
  log("info", "shutdown started", { signal, delayMs: config.shutdownDelayMs });

  // Safety net: never hang longer than the delay + 10s drain.
  setTimeout(() => {
    log("error", "forced exit: drain took too long");
    process.exit(1);
  }, config.shutdownDelayMs + 10_000).unref();

  // Keep serving while endpoints/gateway stop routing to us.
  await sleep(config.shutdownDelayMs);
  // Stop accepting, finish in-flight requests, close idle keep-alive sockets.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([store.close(), cache.close()]);
  log("info", "shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

6. Tests with in-memory fakes (Node's built-in test runner, TypeScript loaded through `tsx`):

`app/test/app.test.ts`

```typescript
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp, type Cache, type Item, type ItemStore } from "../src/app.js";

class FakeStore implements ItemStore {
  items: Item[] = [];
  healthy = true;
  async list() {
    return [...this.items];
  }
  async create(name: string) {
    const item = { id: this.items.length + 1, name, createdAt: new Date().toISOString() };
    this.items.unshift(item);
    return item;
  }
  async ping() {
    if (!this.healthy) throw new Error("db down");
  }
}

class FakeCache implements Cache {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async del(key: string) {
    this.data.delete(key);
  }
  ping(): Promise<void> {
    return Promise.resolve();
  }
}

describe("shipit-api", () => {
  const store = new FakeStore();
  const cache = new FakeCache();
  const state = { shuttingDown: false };
  let server: Server;
  let base = "";

  const post = (name: string) =>
    fetch(`${base}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });

  before(async () => {
    server = createApp(store, cache, state).listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });

  it("GET /readyz returns 200 when dependencies are healthy", async () => {
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 200);
  });

  it("GET /readyz returns 503 when the database is down", async () => {
    store.healthy = false;
    const res = await fetch(`${base}/readyz`);
    store.healthy = true;
    assert.equal(res.status, 503);
  });

  it("GET /readyz returns 503 while shutting down", async () => {
    state.shuttingDown = true;
    const res = await fetch(`${base}/readyz`);
    state.shuttingDown = false;
    assert.equal(res.status, 503);
  });

  it("POST /items rejects an empty name", async () => {
    const res = await post("   ");
    assert.equal(res.status, 400);
  });

  it("GET /items misses, then hits; POST invalidates the cache", async () => {
    assert.equal((await post("first")).status, 201);

    const first = await fetch(`${base}/items`);
    assert.equal(first.headers.get("x-cache"), "miss");

    const second = await fetch(`${base}/items`);
    assert.equal(second.headers.get("x-cache"), "hit");
    const items = (await second.json()) as Item[];
    assert.equal(items[0]?.name, "first");

    await post("second");
    const third = await fetch(`${base}/items`);
    assert.equal(third.headers.get("x-cache"), "miss");
  });
});
```

7. Local dependencies for development:

`app/compose.yaml`

```yaml
# Local development dependencies. Run the API with `npm run dev` on the host,
# or the full stack (including the built image) with `docker compose --profile full up --build`.
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: shipit
      POSTGRES_PASSWORD: shipit
      POSTGRES_DB: shipit
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "shipit", "-d", "shipit"]
      interval: 2s
      retries: 30

  cache:
    image: redis:8-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    ports:
      - "6379:6379"

  api:
    profiles: ["full"]
    build: .
    environment:
      DATABASE_URL: postgres://shipit:shipit@db:5432/shipit
      REDIS_URL: redis://cache:6379
      SHUTDOWN_DELAY_MS: "1000"
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started

volumes:
  pgdata:
```

8. Install, check, and run:

```bash
cd ~/code/shipit/app
npm install                       # creates package-lock.json: commit it
npm run lint && npm run typecheck && npm test

docker compose up -d db cache
DATABASE_URL=postgres://shipit:shipit@localhost:5432/shipit \
REDIS_URL=redis://localhost:6379 \
npm run dev
```

9. In a second terminal, exercise the API:

```bash
curl -s localhost:3000/readyz
curl -s -X POST -H 'content-type: application/json' -d '{"name":"first item"}' localhost:3000/items
curl -si localhost:3000/items | grep -i x-cache    # miss
curl -si localhost:3000/items | grep -i x-cache    # hit
```

### Verify

- `npm test` reports `# pass 6` and `# fail 0`.
- `/readyz` returns `{"status":"ready"}`; the two `GET /items` calls show `x-cache: miss` then `x-cache: hit`.
- Stop Redis (`docker compose stop cache`): `/readyz` returns 503, but `GET /items` still returns 200 (cache failure is treated as a miss). Start it again (`docker compose start cache`) and `/readyz` recovers within a few seconds without restarting the app.
- Press Ctrl-C on `npm run dev`: the log shows `shutdown started` and, about 5 seconds later, `shutdown complete`.

:::hint
If `npm run dev` exits immediately with `missing required env`, you started it without the two variables. If you see `database not reachable yet` repeatedly, Postgres is not up: `docker compose ps` and `docker compose logs db`. `tsx watch` restarts on file changes; the 5 s shutdown delay applies to each restart, so set `SHUTDOWN_DELAY_MS=0` for local development if it annoys you.
:::

:::solution
The steps contain the complete code. Expected test output (abridged):

```text
▶ shipit-api
  ✔ GET /healthz returns 200
  ✔ GET /readyz returns 200 when dependencies are healthy
  ✔ GET /readyz returns 503 when the database is down
  ✔ GET /readyz returns 503 while shutting down
  ✔ POST /items rejects an empty name
  ✔ GET /items misses, then hits; POST invalidates the cache
# pass 6
# fail 0
```

Common problems:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot find module '.../src/app'` in tests | Import without `.js` extension | With `module: NodeNext`, relative imports must end in `.js` even in `.ts` files |
| `ERR_UNKNOWN_FILE_EXTENSION ".ts"` | Ran `node --test` without `--import tsx` | Use `npm test` |
| ESLint: `'_next' is defined but never used` | Rule override missing | Keep the `argsIgnorePattern: "^_"` rule; Express identifies error handlers by their four parameters, so `_next` must stay |
| `EADDRINUSE :3000` | Another process on 3000 | `lsof -i :3000` and stop it |

Why the Redis check passes again without a restart: `ioredis` reconnects in the background; `enableOfflineQueue: false` makes commands fail fast while disconnected instead of piling up, so readiness reflects reality within one probe.

Commit:

```bash
cd ~/code/shipit && git add . && git commit -m "feat: shipit-api with health endpoints, cache and graceful shutdown"
```
:::

### Clean up

```bash
cd ~/code/shipit/app && docker compose down    # add -v to also delete the Postgres volume
```

## Milestone 2: Containerise and publish a multi-arch image

:::meta
difficulty: medium
time: 45 min
:::

Goal: a small, non-root image, built for `linux/arm64` and `linux/amd64` under one tag, published to GitHub Container Registry (GHCR).

### Steps

1. Add the Dockerfile and `.dockerignore`:

`app/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1

# ---- build: runs on the BUILD machine's arch (fast, no emulation); JS output is arch-neutral
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- prod-deps: runs on the TARGET arch so native modules (if ever added) match the CPU
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- runtime: only what is needed to run
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Numeric UID:GID so Kubernetes can verify runAsNonRoot (the "node" user is 1000:1000)
USER 1000:1000
EXPOSE 3000
# Exec form: node is PID 1 and receives SIGTERM directly
CMD ["node", "dist/server.js"]
```

`app/.dockerignore`

```text
node_modules
dist
test
coverage
.git
.env*
*.md
compose.yaml
Dockerfile
.dockerignore
```

2. Build for your own architecture and run the full stack with Compose:

```bash
cd ~/code/shipit/app
docker build -t shipit-api:dev .
docker image ls shipit-api:dev                  # note the size
docker compose --profile full up -d --build
curl -s localhost:3000/readyz
docker compose exec api id                      # uid=1000 gid=1000
docker compose --profile full down
```

3. Create a separate builder that can produce multi-platform images. Do **not** make it the default (`--use`): the default `docker` builder is the one that loads images into your local image store, which `kind load` and later drills rely on.

```bash
docker buildx create --name multi --driver docker-container --bootstrap
docker buildx inspect multi | grep -i platforms
```

4. Log in to GHCR. The `gh` CLI can mint a token with the right scope:

```bash
gh auth refresh -h github.com -s write:packages
export GH_USER=$(gh api user --jq .login)
gh auth token | docker login ghcr.io -u "$GH_USER" --password-stdin
```

5. Build both platforms and push:

```bash
docker buildx build --builder multi \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/$GH_USER/shipit-api:0.1.0 \
  --push .
docker buildx imagetools inspect ghcr.io/$GH_USER/shipit-api:0.1.0
```

6. On GitHub, open your profile → Packages → `shipit-api` → Package settings, and change visibility to **Public** (so kind and CI can pull without credentials), or keep it private and plan to use an `imagePullSecret`.

### Verify

- `imagetools inspect` lists two manifests: `Platform: linux/amd64` and `Platform: linux/arm64` (plus `unknown/unknown` entries, which are the attestation manifests BuildKit attaches).
- The emulated variant actually runs:

```bash
docker run --rm --platform linux/amd64 ghcr.io/$GH_USER/shipit-api:0.1.0 node -p process.arch   # x64
docker run --rm --platform linux/arm64 ghcr.io/$GH_USER/shipit-api:0.1.0 node -p process.arch   # arm64
```

- `docker run --rm shipit-api:dev` (without env vars) exits with code 1 and logs `missing required env`.

:::hint
`ERROR: Multi-platform build is not supported for the docker driver`: you forgot `--builder multi` (or skipped step 3). If `docker build` later says `No output specified with docker-container driver`, you made `multi` the default; switch back with `docker buildx use default`. `denied: permission_denied: write_package`: the token lacks `write:packages`; repeat step 4. If the amd64 build is very slow, that is QEMU emulating `npm ci --omit=dev`; the `build` stage runs natively thanks to `--platform=$BUILDPLATFORM`.
:::

:::solution
Expected `imagetools inspect` output (digests differ):

```text
Name:      ghcr.io/<you>/shipit-api:0.1.0
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:...

Manifests:
  Name:        ghcr.io/<you>/shipit-api:0.1.0@sha256:...
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    linux/amd64

  Name:        ghcr.io/<you>/shipit-api:0.1.0@sha256:...
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    linux/arm64

  Name:        ghcr.io/<you>/shipit-api:0.1.0@sha256:...
  Platform:    unknown/unknown
  Annotations:
    vnd.docker.reference.type: attestation-manifest
  ...
```

Why each Dockerfile choice matters (be ready to explain in an interview):

- `--platform=$BUILDPLATFORM` on the build stage: TypeScript compiles to arch-neutral JS, so compile once, natively.
- `prod-deps` on the target platform: correct for native modules; costs emulation time.
- `RUN --mount=type=cache,target=/root/.npm`: the npm download cache survives between builds without ending up in a layer.
- `COPY package.json package-lock.json` before `COPY src`: dependency layers are reused when only source changes.
- `USER 1000:1000` (numeric): Kubernetes can verify `runAsNonRoot`; files copied as root are read-only for the app, which is what you want.
- `CMD ["node", "dist/server.js"]`: exec form, so SIGTERM reaches node.
- The runtime image is roughly the size of `node:22-bookworm-slim` plus a few MB of `node_modules`. A distroless base (`gcr.io/distroless/nodejs22-debian12`) shrinks it further and removes the shell, at the cost of harder debugging (`kubectl debug` with an ephemeral container then becomes your shell).

Commit: `git add app/Dockerfile app/.dockerignore && git commit -m "build: multi-stage multi-arch image"`.
:::

### Clean up

```bash
docker compose -f ~/code/shipit/app/compose.yaml --profile full down -v
```

Keep the `multi` builder; the Makefile's `image` target uses it (`BUILDER ?= multi`).

## Milestone 3: Provision the platform with Terraform

:::meta
difficulty: medium
time: 45 min
:::

Goal: one `terraform apply` creates a two-node kind cluster, installs Gateway API CRDs, Traefik as the Gateway implementation, metrics-server, the namespaces and the database Secret.

### Steps

1. Create the Terraform files in `infra/`:

`infra/versions.tf`

```hcl
terraform {
  required_version = ">= 1.10"

  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = ">= 0.6.0, < 1.0.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.36.0, < 4.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
```

`infra/variables.tf`

```hcl
variable "cluster_name" {
  description = "Name of the kind cluster."
  type        = string
  default     = "shipit"
}

variable "node_image" {
  description = "kindest/node image (e.g. kindest/node:v1.34.0). null = the provider's default."
  type        = string
  default     = null
}

variable "host_http_port" {
  description = "Port on your Mac that forwards to the Gateway's NodePort 30080."
  type        = number
  default     = 8080
}

variable "gateway_api_version" {
  description = "Gateway API release (standard channel CRDs). Check Traefik's supported version before bumping."
  type        = string
  default     = "v1.4.0"
}

variable "traefik_chart_version" {
  description = "Traefik Helm chart version. Pin it: `helm search repo traefik/traefik`."
  type        = string
  default     = null
}

variable "metrics_server_chart_version" {
  description = "metrics-server Helm chart version. Pin it: `helm search repo metrics-server/metrics-server`."
  type        = string
  default     = null
}

variable "image_repository" {
  description = "Image repository for shipit-api (shipit-api for kind load, or ghcr.io/<you>/shipit-api)."
  type        = string
  default     = "shipit-api"
}

variable "image_tag" {
  description = "Image tag for shipit-api."
  type        = string
  default     = "dev"
}

variable "deploy_mode" {
  description = "Who deploys the app chart: \"terraform\" (helm_release) or \"argocd\" (Argo CD Application)."
  type        = string
  default     = "terraform"

  validation {
    condition     = contains(["terraform", "argocd"], var.deploy_mode)
    error_message = "deploy_mode must be \"terraform\" or \"argocd\"."
  }
}
```

`infra/cluster.tf`

```hcl
locals {
  kubeconfig_path = abspath("${path.module}/.kube/config")
}

resource "kind_cluster" "this" {
  name            = var.cluster_name
  node_image      = var.node_image
  kubeconfig_path = local.kubeconfig_path
  wait_for_ready  = true

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"

      # Mac localhost:8080 -> node container :30080 -> Traefik NodePort
      extra_port_mappings {
        container_port = 30080
        host_port      = var.host_http_port
      }
    }

    node {
      role = "worker"
    }
  }
}

# Providers configured from the cluster resource. Works because the resources below
# don't need the API server at plan time (no kubernetes_manifest).
provider "kubernetes" {
  host                   = kind_cluster.this.endpoint
  client_certificate     = kind_cluster.this.client_certificate
  client_key             = kind_cluster.this.client_key
  cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
}

provider "helm" {
  kubernetes = {
    host                   = kind_cluster.this.endpoint
    client_certificate     = kind_cluster.this.client_certificate
    client_key             = kind_cluster.this.client_key
    cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
  }
}
```

`infra/platform.tf`

```hcl
# Gateway API CRDs are installed outside Helm: Helm never upgrades CRDs, and
# kubernetes_manifest would need the API server during the very first plan.
resource "terraform_data" "gateway_api_crds" {
  triggers_replace = [kind_cluster.this.id, var.gateway_api_version]

  provisioner "local-exec" {
    command = "kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/${var.gateway_api_version}/standard-install.yaml"
    environment = {
      KUBECONFIG = kind_cluster.this.kubeconfig_path
    }
  }
}

resource "kubernetes_namespace_v1" "gateway" {
  metadata {
    name = "gateway"
  }
}

resource "kubernetes_namespace_v1" "shipit" {
  metadata {
    name = "shipit"
    labels = {
      "pod-security.kubernetes.io/enforce" = "baseline"
      "pod-security.kubernetes.io/warn"    = "restricted"
      "pod-security.kubernetes.io/audit"   = "restricted"
    }
  }
}

resource "helm_release" "traefik" {
  name       = "traefik"
  namespace  = kubernetes_namespace_v1.gateway.metadata[0].name
  repository = "https://traefik.github.io/charts"
  chart      = "traefik"
  version    = var.traefik_chart_version
  wait       = true
  timeout    = 300

  values = [yamlencode({
    providers = {
      kubernetesGateway = { enabled = true }  # creates GatewayClass "traefik" + Gateway "traefik-gateway"
      kubernetesIngress = { enabled = false } # Gateway API only
    }
    gateway = {
      listeners = {
        web = {
          port            = 8000
          protocol        = "HTTP"
          namespacePolicy = { from = "All" } # let HTTPRoutes in other namespaces attach
        }
      }
    }
    service = { spec = { type = "NodePort" } }
    ports = {
      web       = { nodePort = 30080 }
      websecure = { expose = { default = false } }
    }
  })]

  depends_on = [terraform_data.gateway_api_crds]
}

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  namespace  = "kube-system"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = var.metrics_server_chart_version
  wait       = true

  # kind's kubelets use self-signed serving certs.
  values = [yamlencode({ args = ["--kubelet-insecure-tls"] })]
}

resource "random_password" "postgres" {
  length  = 24
  special = false # keeps the DATABASE_URL free of characters that need URL-encoding
}

resource "kubernetes_secret_v1" "shipit_db" {
  metadata {
    name      = "shipit-db"
    namespace = kubernetes_namespace_v1.shipit.metadata[0].name
  }

  # Plain values: the provider base64-encodes them. They ARE stored in Terraform state.
  data = {
    POSTGRES_PASSWORD = random_password.postgres.result
    DATABASE_URL      = "postgres://shipit:${random_password.postgres.result}@postgres:5432/shipit"
  }
}
```

`infra/outputs.tf`

```hcl
output "kubeconfig_path" {
  description = "Use with: export KUBECONFIG=<this>"
  value       = kind_cluster.this.kubeconfig_path
}

output "app_url" {
  description = "How to reach the app through the Gateway."
  value       = "curl -H 'Host: shipit.local' http://localhost:${var.host_http_port}/items"
}
```

2. Find current chart versions and **pin** them in `infra/terraform.tfvars` (commit this file; it contains no secrets):

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo update
helm search repo traefik/traefik
helm search repo metrics-server/metrics-server
```

```hcl
# infra/terraform.tfvars  (use the CHART VERSION column from the output above)
traefik_chart_version        = "<chart version>"
metrics_server_chart_version = "<chart version>"
```

Also open the Traefik documentation for that release and confirm which Gateway API version it supports; adjust `gateway_api_version` if needed.

3. Apply:

```bash
cd ~/code/shipit
terraform -chdir=infra init
terraform -chdir=infra fmt -recursive && terraform -chdir=infra validate
terraform -chdir=infra apply
export KUBECONFIG=$PWD/infra/.kube/config
```

### Verify

```bash
kubectl get nodes -o wide                         # 2 nodes Ready, arch arm64 on Apple Silicon
kubectl get crd | grep gateway.networking.k8s.io  # gatewayclasses, gateways, httproutes, ...
kubectl get gatewayclass                          # traefik   ACCEPTED=True
kubectl get gateway -n gateway                    # traefik-gateway, PROGRAMMED should become True
kubectl get pods -n gateway
kubectl top nodes                                 # works once metrics-server is ready (~1 min)
kubectl get ns shipit --show-labels               # pod-security labels present
curl -i localhost:8080/                           # HTTP/1.1 404 from Traefik: the path works, no routes yet
```

The 404 is the success signal: your request crossed the Docker port mapping, the NodePort and reached Traefik.

:::hint
`curl: (7) Failed to connect`: the cluster was created without the port mapping (check `docker ps` for `0.0.0.0:8080->30080/tcp` on the control-plane container), or Traefik's Service is not NodePort 30080 (`kubectl get svc -n gateway`). `no matches for kind "GatewayClass"` during the Traefik install means the CRDs were not applied first: check the `terraform_data` output and that `kubectl` is on your `PATH`. If `kubectl top` errors, wait a minute; metrics-server needs a scrape cycle.
:::

:::solution
Expected checks:

```text
$ kubectl get gatewayclass
NAME      CONTROLLER                      ACCEPTED   AGE
traefik   traefik.io/gateway-controller   True       2m

$ kubectl get gateway -n gateway
NAME              CLASS     ADDRESS   PROGRAMMED   AGE
traefik-gateway   traefik             True         2m

$ curl -i localhost:8080/
HTTP/1.1 404 Not Found
Content-Type: text/plain; charset=utf-8
...
404 page not found
```

`ADDRESS` may stay empty or show an internal address for a NodePort Service; that is fine on kind.

How Terraform ordered the work (`terraform graph` shows it): the providers depend on `kind_cluster.this`, so every Kubernetes and Helm resource waits for the cluster. `helm_release.traefik` has an explicit `depends_on` on the CRD step because nothing in its arguments references it; that is the textbook case for `depends_on`.

If you want to see what Terraform would destroy before committing to it: `terraform -chdir=infra plan -destroy`.

Commit: `git add infra && git commit -m "infra: kind cluster, Gateway API, Traefik, metrics-server"`. Make sure `.terraform.lock.hcl` is committed and `infra/.kube/` and the state are not.
:::

### Clean up

Leave the cluster running for the next milestone. To remove it: `terraform -chdir=infra destroy`.

## Milestone 4: Write the Helm charts and deploy with Terraform

:::meta
difficulty: hard
time: 75 min
:::

Goal: two charts (data and app), an environment values file, and Terraform `helm_release` resources that deploy them. The app answers through the Gateway.

### Steps

1. The data chart (`deploy/charts/shipit-data/`):

`deploy/charts/shipit-data/Chart.yaml`

```yaml
apiVersion: v2
name: shipit-data
description: In-cluster PostgreSQL and Redis for shipit (disposable environments only)
type: application
version: 0.1.0
appVersion: "17"
```

`deploy/charts/shipit-data/values.yaml`

```yaml
postgres:
  image: postgres:17
  database: shipit
  user: shipit
  existingSecret: shipit-db       # must contain POSTGRES_PASSWORD
  passwordKey: POSTGRES_PASSWORD
  storage: 1Gi
  storageClassName: ""            # empty = cluster default (kind: "standard")
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      memory: 512Mi

redis:
  image: redis:8-alpine
  maxmemory: 64mb
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      memory: 128Mi
```

`deploy/charts/shipit-data/templates/postgres.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  labels:
    app.kubernetes.io/name: postgres
    app.kubernetes.io/part-of: shipit
spec:
  clusterIP: None   # headless: DNS resolves straight to the StatefulSet pod
  selector:
    app.kubernetes.io/name: postgres
  ports:
    - name: postgres
      port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  labels:
    app.kubernetes.io/name: postgres
    app.kubernetes.io/part-of: shipit
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: postgres
  template:
    metadata:
      labels:
        app.kubernetes.io/name: postgres
        app.kubernetes.io/part-of: shipit
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 999      # "postgres" user in the Debian-based official image
        runAsGroup: 999
        fsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: postgres
          image: {{ .Values.postgres.image }}
          ports:
            - name: postgres
              containerPort: 5432
          env:
            - name: POSTGRES_DB
              value: {{ .Values.postgres.database | quote }}
            - name: POSTGRES_USER
              value: {{ .Values.postgres.user | quote }}
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.postgres.existingSecret }}
                  key: {{ .Values.postgres.passwordKey }}
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata   # subdirectory: avoids lost+found issues
          readinessProbe:
            exec:
              command: ["pg_isready", "-h", "127.0.0.1", "-U", {{ .Values.postgres.user | quote }}, "-d", {{ .Values.postgres.database | quote }}]
            periodSeconds: 5
          livenessProbe:
            exec:
              command: ["pg_isready", "-h", "127.0.0.1", "-U", {{ .Values.postgres.user | quote }}]
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 6
          resources:
            {{- toYaml .Values.postgres.resources | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        {{- with .Values.postgres.storageClassName }}
        storageClassName: {{ . }}
        {{- end }}
        resources:
          requests:
            storage: {{ .Values.postgres.storage }}
```

`deploy/charts/shipit-data/templates/redis.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis
  labels:
    app.kubernetes.io/name: redis
    app.kubernetes.io/part-of: shipit
spec:
  selector:
    app.kubernetes.io/name: redis
  ports:
    - name: redis
      port: 6379
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  labels:
    app.kubernetes.io/name: redis
    app.kubernetes.io/part-of: shipit
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: redis
  template:
    metadata:
      labels:
        app.kubernetes.io/name: redis
        app.kubernetes.io/part-of: shipit
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        runAsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: redis
          image: {{ .Values.redis.image }}
          # Pure cache: no RDB snapshots, no AOF, evict least-recently-used keys when full.
          args: ["--save", "", "--appendonly", "no", "--maxmemory", {{ .Values.redis.maxmemory | quote }}, "--maxmemory-policy", "allkeys-lru"]
          ports:
            - name: redis
              containerPort: 6379
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 5
          livenessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 10
          resources:
            {{- toYaml .Values.redis.resources | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
```

2. The app chart (`deploy/charts/shipit-api/`):

`deploy/charts/shipit-api/Chart.yaml`

```yaml
apiVersion: v2
name: shipit-api
description: shipit-api, a Node.js API backed by PostgreSQL and Redis
type: application
version: 0.1.0
appVersion: "1.0.0"
```

`deploy/charts/shipit-api/values.yaml`

```yaml
replicaCount: 2

image:
  repository: ghcr.io/your-github-user/shipit-api
  tag: ""        # empty = .Chart.AppVersion
  digest: ""     # e.g. sha256:abc... ; wins over tag when set
  pullPolicy: IfNotPresent

imagePullSecrets: []

# The chart does not create database credentials. It expects an existing Secret
# with a DATABASE_URL key (created by Terraform in this project).
database:
  existingSecret: shipit-db
  secretKey: DATABASE_URL

redis:
  url: redis://redis:6379

shutdownDelayMs: 5000
terminationGracePeriodSeconds: 30
# Keep the V8 heap below the container memory limit (75% of 256Mi).
nodeOptions: --max-old-space-size=192

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    memory: 256Mi   # no CPU limit on purpose: avoids CFS throttling of the event loop

service:
  port: 80

httpRoute:
  enabled: true
  hostnames:
    - shipit.local
  parentRefs:
    - name: traefik-gateway
      namespace: gateway

podDisruptionBudget:
  enabled: true
  minAvailable: 1

autoscaling:
  enabled: false
  minReplicas: 2
  maxReplicas: 5
  targetCPUUtilizationPercentage: 70

networkPolicy:
  enabled: false
  gatewayNamespace: gateway

podAnnotations: {}
```

`deploy/charts/shipit-api/templates/_helpers.tpl`

```text
{{- define "shipit-api.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "shipit-api.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "shipit-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "shipit-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "shipit-api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "shipit-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: shipit
{{- end -}}

{{- define "shipit-api.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
{{- end -}}
```

`deploy/charts/shipit-api/templates/deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  revisionHistoryLimit: 5
  progressDeadlineSeconds: 120
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0   # never go below the desired number of ready pods
      maxSurge: 1
  selector:
    matchLabels:
      {{- include "shipit-api.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "shipit-api.selectorLabels" . | nindent 8 }}
      {{- with .Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: api
          image: {{ include "shipit-api.image" . | quote }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 3000
          env:
            - name: PORT
              value: "3000"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.database.existingSecret }}
                  key: {{ .Values.database.secretKey }}
            - name: REDIS_URL
              value: {{ .Values.redis.url | quote }}
            - name: SHUTDOWN_DELAY_MS
              value: {{ .Values.shutdownDelayMs | quote }}
            - name: NODE_OPTIONS
              value: {{ .Values.nodeOptions | quote }}
          startupProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 2
            failureThreshold: 30
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
```

`deploy/charts/shipit-api/templates/service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "shipit-api.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
```

`deploy/charts/shipit-api/templates/httproute.yaml`

```yaml
{{- if .Values.httpRoute.enabled }}
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
spec:
  parentRefs:
    {{- toYaml .Values.httpRoute.parentRefs | nindent 4 }}
  hostnames:
    {{- toYaml .Values.httpRoute.hostnames | nindent 4 }}
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: {{ include "shipit-api.fullname" . }}
          port: {{ .Values.service.port }}
{{- end }}
```

`deploy/charts/shipit-api/templates/pdb.yaml`

```yaml
{{- if .Values.podDisruptionBudget.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
spec:
  minAvailable: {{ .Values.podDisruptionBudget.minAvailable }}
  selector:
    matchLabels:
      {{- include "shipit-api.selectorLabels" . | nindent 6 }}
{{- end }}
```

`deploy/charts/shipit-api/templates/hpa.yaml`

```yaml
{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "shipit-api.fullname" . }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}
{{- end }}
```

`deploy/charts/shipit-api/templates/networkpolicy.yaml`

```yaml
{{- if .Values.networkPolicy.enabled }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "shipit-api.fullname" . }}
  labels:
    {{- include "shipit-api.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "shipit-api.selectorLabels" . | nindent 6 }}
  policyTypes: ["Ingress", "Egress"]
  ingress:
    # Only the Gateway's pods may call the API.
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ .Values.networkPolicy.gatewayNamespace }}
      ports:
        - port: 3000
          protocol: TCP
  egress:
    # DNS
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # Postgres and Redis in the same namespace
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: postgres
      ports:
        - port: 5432
          protocol: TCP
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: redis
      ports:
        - port: 6379
          protocol: TCP
{{- end }}
```

3. The environment values file:

`deploy/envs/local/values.yaml`

```yaml
# Environment-specific values for the local kind environment.
# Used by Terraform (helm_release) AND by the Argo CD Application (challenge),
# so both delivery paths produce the same result.
replicaCount: 2

image:
  pullPolicy: IfNotPresent
  # repository and tag are injected by Terraform (-var image_repository / image_tag)

httpRoute:
  hostnames:
    - shipit.local

autoscaling:
  enabled: false

networkPolicy:
  enabled: false
```

4. Lint and render before deploying anything:

```bash
cd ~/code/shipit
helm lint deploy/charts/shipit-data
helm lint deploy/charts/shipit-api -f deploy/envs/local/values.yaml
helm template shipit-api deploy/charts/shipit-api -f deploy/envs/local/values.yaml \
  --set image.repository=shipit-api --set image.tag=dev | less
# Ask the real API server to validate (including the HTTPRoute CRD schema):
helm template shipit-api deploy/charts/shipit-api -f deploy/envs/local/values.yaml \
  | kubectl apply --dry-run=server -n shipit -f -
```

5. Wire the charts into Terraform:

`infra/app.tf`

```hcl
locals {
  charts_dir = abspath("${path.module}/../deploy/charts")
  envs_dir   = abspath("${path.module}/../deploy/envs")
}

resource "helm_release" "shipit_data" {
  name      = "shipit-data"
  namespace = kubernetes_namespace_v1.shipit.metadata[0].name
  chart     = "${local.charts_dir}/shipit-data"
  wait      = true
  timeout   = 300

  depends_on = [kubernetes_secret_v1.shipit_db]
}

resource "helm_release" "shipit_api" {
  count = var.deploy_mode == "terraform" ? 1 : 0

  name      = "shipit-api"
  namespace = kubernetes_namespace_v1.shipit.metadata[0].name
  chart     = "${local.charts_dir}/shipit-api"
  wait      = true
  timeout   = 300

  values = [
    file("${local.envs_dir}/local/values.yaml"),
    yamlencode({
      image = {
        repository = var.image_repository
        tag        = var.image_tag
      }
    }),
  ]

  depends_on = [helm_release.shipit_data, helm_release.traefik]
}
```

6. Load the local image into kind and apply:

```bash
docker build -t shipit-api:dev app
kind load docker-image shipit-api:dev --name shipit
terraform -chdir=infra apply -var image_repository=shipit-api -var image_tag=dev
```

### Verify

```bash
kubectl get pods,svc,pvc -n shipit
kubectl get httproute -n shipit -o jsonpath='{.items[0].status.parents[0].conditions[*].type}{"\n"}'   # Accepted ResolvedRefs
curl -s -H 'Host: shipit.local' localhost:8080/readyz
curl -s -H 'Host: shipit.local' -X POST -H 'content-type: application/json' -d '{"name":"from the cluster"}' localhost:8080/items
curl -si -H 'Host: shipit.local' localhost:8080/items | grep -i x-cache
curl -si localhost:8080/items | head -1          # 404: no route without the right Host
```

Optionally add `127.0.0.1 shipit.local` to `/etc/hosts` and browse to `http://shipit.local:8080/items`.

:::hint
- Pods `ErrImageNeverPull` or `ImagePullBackOff` with `shipit-api:dev`: the image was not loaded into this cluster (`docker exec shipit-control-plane crictl images | grep shipit`), or you built it after loading.
- Pods Running but `0/1 Ready`: `kubectl logs -n shipit deploy/shipit-api` and `kubectl describe pod`. `database not reachable yet` usually means Postgres is still initialising.
- HTTPRoute not `Accepted`: `kubectl describe httproute -n shipit shipit-api` shows the reason (wrong Gateway name/namespace, or `NotAllowedByListeners`).
- Terraform says "No changes" after you edit a template: bump `version` in `Chart.yaml`, because the helm provider does not always notice changes inside a local chart directory.
:::

:::solution
Expected state:

```text
$ kubectl get pods -n shipit
NAME                          READY   STATUS    RESTARTS   AGE
postgres-0                    1/1     Running   0          2m
redis-6d9c...                 1/1     Running   0          2m
shipit-api-7f8b...            1/1     Running   0          1m
shipit-api-7f8b...            1/1     Running   0          1m

$ kubectl get pvc -n shipit
NAME              STATUS   VOLUME    CAPACITY   ACCESS MODES   STORAGECLASS   AGE
data-postgres-0   Bound    pvc-...   1Gi        RWO            standard       2m
```

Things worth noticing:

- The app pods may restart once or twice on the very first install if Postgres takes longer than the 20 s migration retry window. With Terraform's `depends_on` and `wait = true` on `shipit_data`, Postgres is Ready before the app chart is installed, so usually there are no restarts. In production you would not rely on ordering; the retry loop and the restart backoff make the app converge anyway.
- You see Pod Security **warnings** for nothing in the app pods (they meet `restricted`). If you remove the `securityContext` from the app chart and re-render with `kubectl apply --dry-run=server`, you get `Warning: would violate PodSecurity "restricted:latest"`, which is exactly why the namespace warns on `restricted`.
- `helm list -n shipit` shows both releases. They are Helm releases like any other; Terraform is just the client driving them.

Commit: `git add deploy infra && git commit -m "deploy: helm charts for app and data, delivered by terraform"`.
:::

### Clean up

Keep everything running for Milestone 5, which replaces these manual commands with one target.

## Milestone 5: One command from zero

:::meta
difficulty: medium
time: 40 min
:::

Goal: `make recreate` destroys everything and rebuilds a verified environment with no manual steps. This is the headline demo of the project.

### Steps

1. The smoke test drives the whole request path through the Gateway:

`scripts/smoke.sh`

```bash
#!/usr/bin/env bash
# End-to-end check through the Gateway: host -> kind port mapping -> Traefik -> HTTPRoute -> pods.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
HOST="${HOST:-shipit.local}"

req() { curl -fsS --max-time 5 -H "Host: ${HOST}" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "==> waiting for ${BASE_URL}/readyz (Host: ${HOST})"
for i in $(seq 1 60); do
  if req "${BASE_URL}/readyz" >/dev/null 2>&1; then break; fi
  [[ $i -eq 60 ]] && fail "readyz never returned 200"
  sleep 2
done

echo "==> liveness and readiness"
req "${BASE_URL}/healthz" | grep -q '"ok"' || fail "/healthz"
req "${BASE_URL}/readyz" | grep -q '"ready"' || fail "/readyz"

echo "==> write, then read through the cache"
name="smoke-$(date +%s)-$RANDOM"
req -X POST -H 'content-type: application/json' -d "{\"name\":\"${name}\"}" "${BASE_URL}/items" >/dev/null \
  || fail "POST /items"

first=$(req -D - -o /dev/null "${BASE_URL}/items" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-cache"{print $2}')
second=$(req -D - -o /dev/null "${BASE_URL}/items" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-cache"{print $2}')
req "${BASE_URL}/items" | grep -q "${name}" || fail "created item not returned"
[[ "$first" == "miss" ]] || fail "expected first GET to be a cache miss, got '${first}'"
[[ "$second" == "hit" ]] || fail "expected second GET to be a cache hit, got '${second}'"

echo "==> validation"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${HOST}" -X POST \
  -H 'content-type: application/json' -d '{"name":""}' "${BASE_URL}/items")
[[ "$code" == "400" ]] || fail "expected 400 for empty name, got ${code}"

echo "ALL CHECKS PASSED"
```

```bash
chmod +x scripts/smoke.sh
```

2. The Makefile (recipe lines must start with a **tab**, not spaces):

`Makefile`

```makefile
SHELL := /bin/bash
.DEFAULT_GOAL := help

CLUSTER     ?= shipit
GH_USER     ?= your-github-user
IMAGE_REPO  ?= ghcr.io/$(GH_USER)/shipit-api
TAG         ?= dev
LOCAL_IMAGE ?= 1
PLATFORMS   ?= linux/amd64,linux/arm64
BUILDER     ?= multi

export KUBECONFIG := $(CURDIR)/infra/.kube/config
TF := terraform -chdir=infra

ifeq ($(LOCAL_IMAGE),1)
  TF_IMAGE_VARS := -var image_repository=shipit-api -var image_tag=dev
else
  TF_IMAGE_VARS := -var image_repository=$(IMAGE_REPO) -var image_tag=$(TAG)
endif

.PHONY: help deps app-check image image-local up down recreate verify status nuke

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

deps: ## Fail fast if a required tool is missing
	@for t in docker kind kubectl helm terraform node npm curl; do \
	  command -v $$t >/dev/null || { echo "missing tool: $$t"; exit 1; }; \
	done; docker info >/dev/null 2>&1 || { echo "docker daemon not running"; exit 1; }
	@echo "all tools present"

app-check: ## Lint, typecheck and test the app
	cd app && npm ci && npm run lint && npm run typecheck && npm test

image: ## Build and push the multi-arch image to GHCR
	docker buildx build --builder $(BUILDER) --platform $(PLATFORMS) -t $(IMAGE_REPO):$(TAG) --push app
	docker buildx imagetools inspect $(IMAGE_REPO):$(TAG)

image-local: ## Build for the local arch and load it into kind
	docker build -t shipit-api:dev app
	kind load docker-image shipit-api:dev --name $(CLUSTER)

up: deps ## Create everything from zero and verify it
	$(TF) init -input=false
ifeq ($(LOCAL_IMAGE),1)
	$(TF) apply -input=false -auto-approve -target=kind_cluster.this
	$(MAKE) image-local
endif
	$(TF) apply -input=false -auto-approve $(TF_IMAGE_VARS)
	$(MAKE) verify

down: ## Destroy everything Terraform created
	$(TF) init -input=false
	$(TF) destroy -input=false -auto-approve $(TF_IMAGE_VARS)

recreate: ## Destroy, then create from zero (the portfolio demo)
	$(MAKE) down
	time $(MAKE) up

verify: ## End-to-end smoke test through the Gateway
	./scripts/smoke.sh

status: ## Show what is running
	kubectl get gateway,httproute -A
	kubectl get pods,svc,pvc -n shipit

nuke: ## Last resort: delete the cluster and local state without Terraform
	-kind delete cluster --name $(CLUSTER)
	rm -rf infra/terraform.tfstate infra/terraform.tfstate.backup infra/.kube
```

3. Run it:

```bash
make help
make verify            # against the running environment from Milestone 4
make recreate          # destroy + create from zero + verify, timed
```

4. Run the GHCR variant too (no local build; pulls the multi-arch image you pushed in Milestone 2):

```bash
make recreate LOCAL_IMAGE=0 GH_USER=<your-github-user> TAG=0.1.0
```

5. Write the README sections: prerequisites, `make recreate`, architecture diagram (copy the one from the lesson and adapt it), decisions table, acceptance criteria checklist.

### Verify

- `make recreate` ends with `ALL CHECKS PASSED` and prints the elapsed time.
- `make down` followed by `kind get clusters` prints `No kind clusters found.` and `terraform -chdir=infra state list` prints nothing.
- Running `make up` twice in a row is safe: the second run changes nothing and still passes `verify` (idempotency).

:::hint
- `Makefile:NN: *** missing separator. Stop.`: a recipe line is indented with spaces. In most editors, enable "show whitespace".
- The first `apply` with `-target` prints a warning that targeting is for exceptional situations; this bootstrap is one (the image must be loaded into the cluster before the app release is installed). The GHCR variant needs no `-target`.
- If `make down` fails because you deleted the cluster by hand earlier, use `make nuke`, then `make up`.
:::

:::solution
Typical tail of `make recreate`:

```text
==> waiting for http://localhost:8080/readyz (Host: shipit.local)
==> liveness and readiness
==> write, then read through the cache
==> validation
ALL CHECKS PASSED

real    3m41s
```

Design notes for your README:

- **Why Make and not a shell script**: named entry points (`up`, `down`, `verify`), self-documenting `help`, dependency on `deps` so missing tools fail in the first second. Taskfile (`Taskfile.yml`) is an equally good choice with nicer syntax; the interface matters, not the tool.
- **Why `-target` only in local mode**: the cluster must exist before an image can be loaded into it, and the app release must not be installed before the image is there. With a registry image there is no chicken-and-egg problem, which is one reason CI (Project 2) uses GHCR.
- **Why `nuke` exists**: Terraform cannot refresh resources inside a cluster that no longer exists. `nuke` is the escape hatch, kept separate so it is never part of the normal path.
- **Idempotency**: `make up` on an existing environment results in "No changes" plus a passing smoke test. If it does not, something in your config is non-deterministic (for example a timestamp in values).

Commit: `git add Makefile scripts README.md && git commit -m "chore: one-command lifecycle and smoke test"`.
:::

### Clean up

```bash
make down
```

## Milestone 6: Prove zero-downtime, then break it on purpose

:::meta
difficulty: hard
time: 45 min
:::

Goal: demonstrate with numbers that rollouts and pod deletions cause no errors, then remove the graceful-shutdown protections, watch errors appear, explain why, and restore. This is the break-and-fix milestone.

### Steps

1. Bring the environment up (`make up`) and add a load script that counts responses by status code:

`scripts/load.sh`

```bash
#!/usr/bin/env bash
# Usage: scripts/load.sh <seconds> [concurrency]
# Prints a count of responses per HTTP status code.
set -uo pipefail
DURATION=${1:-30}; CONC=${2:-8}
URL="${BASE_URL:-http://localhost:8080}/items"; HOST="${HOST:-shipit.local}"
end=$((SECONDS + DURATION)); tmp=$(mktemp -d)
for w in $(seq "$CONC"); do
  ( while (( SECONDS < end )); do
      curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 -H "Host: $HOST" "$URL"
    done > "$tmp/$w" ) &
done
wait
cat "$tmp"/* | sort | uniq -c | sort -rn
rm -rf "$tmp"
```

```bash
chmod +x scripts/load.sh
```

2. Baseline: restart the deployment while load runs.

```bash
scripts/load.sh 40 8 &
sleep 5 && kubectl rollout restart deploy/shipit-api -n shipit
kubectl rollout status deploy/shipit-api -n shipit
wait
```

3. Dependency outage: delete the Postgres pod and watch readiness (not liveness) react.

```bash
kubectl get pods -n shipit -w &
kubectl delete pod postgres-0 -n shipit
sleep 45; kill %1
kubectl get pods -n shipit -l app.kubernetes.io/name=shipit-api   # RESTARTS still 0
```

4. **Break it.** Remove the shutdown delay and shorten the grace period, out-of-band with kubectl (like a well-meaning colleague "speeding up deploys"):

```bash
kubectl set env deploy/shipit-api -n shipit SHUTDOWN_DELAY_MS=0
kubectl patch deploy/shipit-api -n shipit --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/terminationGracePeriodSeconds","value":1},
  {"op":"replace","path":"/spec/strategy/rollingUpdate/maxUnavailable","value":1}
]'
kubectl rollout status deploy/shipit-api -n shipit

scripts/load.sh 40 16 &
sleep 5 && kubectl rollout restart deploy/shipit-api -n shipit
wait
```

5. Investigate: which component produced the errors, and why now? Then ask Terraform whether anything drifted:

```bash
terraform -chdir=infra plan -var image_repository=shipit-api -var image_tag=dev
```

6. **Fix it** so that Git/Terraform is the source of truth again (see the solution for options), and rerun step 2 to prove zero errors.

### Verify

- Step 2 output contains only `200` lines (for example `  4213 200`).
- Step 3: app pods go `0/1` while Postgres is down, return to `1/1` after it is back, and `RESTARTS` stays `0`.
- Step 4 output contains some `502` and/or `503` lines. With high concurrency you should see a handful; if you see none, raise concurrency to 32 and repeat.
- After the fix, step 2 is clean again and the live Deployment matches the chart (`kubectl get deploy shipit-api -n shipit -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}'` prints `30`).

:::hint
Think about what happens in the first second after a pod is marked Terminating. Who learns about it first, the app (SIGTERM) or Traefik (EndpointSlice update)? And with `maxUnavailable: 1`, how many Ready pods are left at the worst moment? For the Terraform question: what does the helm provider compare when it plans, the live objects or the release stored by Helm?
:::

:::solution
**Why errors appear.** Deleting a pod triggers SIGTERM and endpoint removal in parallel. With `SHUTDOWN_DELAY_MS=0` the app calls `server.close()` immediately: idle keep-alive connections from Traefik are closed and new connections are refused, while Traefik may still route to the pod for a moment. Those requests fail with **502 Bad Gateway** (Traefik could not complete the upstream request). With `terminationGracePeriodSeconds: 1`, in-flight requests are also cut by SIGKILL. With `maxUnavailable: 1` and 2 replicas, there are moments with a single Ready pod or, if the new pod is slow to become Ready, none at all, which Traefik reports as **503 Service Unavailable** ("no available server").

**Why Postgres outage caused no restarts.** `/readyz` failed, so pods were removed from the Service (traffic stopped, requests got 503 from Traefik) but `/healthz` kept returning 200, so kubelet did not restart anything. When Postgres came back, the pool reconnected and readiness recovered by itself. Had liveness checked the database, every pod would have restarted, adding cold-start time to the outage.

**Why `terraform plan` shows "No changes".** The helm provider plans against the release record Helm stored (chart + values), not against the live objects. `kubectl set env` and `kubectl patch` changed live objects only, so Terraform cannot see the drift. Argo CD with `selfHeal: true` (Milestone 8) compares live state continuously and would revert it within minutes. This is a strong interview point about push-based vs pull-based delivery.

**Fix options** (any of these works):

```bash
# 1) Force Helm to re-render and re-apply the release from code
terraform -chdir=infra apply -replace='helm_release.shipit_api[0]' \
  -var image_repository=shipit-api -var image_tag=dev

# 2) Or roll back the Deployment to the previous ReplicaSet spec, then let Terraform own it again
kubectl rollout undo deploy/shipit-api -n shipit   # careful: undo goes back ONE revision; check history first
kubectl rollout history deploy/shipit-api -n shipit

# 3) Or recreate from zero (always available, always truthful)
make recreate
```

Option 1 is the cleanest because the code stays the single source of truth. Then rerun the baseline and confirm only `200`s.

Postmortem sentence for your README: "Out-of-band changes to shutdown settings caused 5xx during rollouts; the push-based pipeline could not detect the drift. Action: deliver the app with Argo CD self-heal; treat `terminationGracePeriodSeconds`, `maxUnavailable` and `SHUTDOWN_DELAY_MS` as a reviewed set."

Commit `scripts/load.sh`.
:::

### Clean up

Leave the environment running if you continue with Milestone 7, otherwise `make down`.

## Milestone 7: Harden with NetworkPolicy and an HPA

:::meta
difficulty: medium
time: 35 min
:::

Goal: turn on the chart's NetworkPolicy and autoscaling through the environment values file, verify both actually work, and record the evidence.

### Steps

1. Edit `deploy/envs/local/values.yaml`:

```yaml
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 5
  targetCPUUtilizationPercentage: 70

networkPolicy:
  enabled: true
```

2. Apply (`make up`) and inspect:

```bash
kubectl get hpa -n shipit
kubectl get networkpolicy -n shipit
make verify                      # still passes: traffic from the gateway namespace is allowed
```

3. Prove the NetworkPolicy blocks other callers:

```bash
# From inside the shipit namespace (not the gateway): should time out
kubectl run np-test -n shipit --rm -it --restart=Never --image=curlimages/curl -- \
  curl -sS -m 3 http://shipit-api/healthz
# From the gateway namespace: allowed
kubectl run np-test -n gateway --rm -it --restart=Never --image=curlimages/curl -- \
  curl -sS -m 3 http://shipit-api.shipit/healthz
```

4. Prove the HPA scales. Generate load from your Mac through the Gateway and watch:

```bash
kubectl get hpa shipit-api -n shipit -w &
hey -z 120s -c 50 -host shipit.local http://localhost:8080/items
kill %1
kubectl get hpa shipit-api -n shipit
```

### Verify

- The test pod in `shipit` times out (`curl: (28)`); the one in `gateway` gets `{"status":"ok"}`.
- `kubectl get hpa` shows a real CPU percentage (not `<unknown>`), `REPLICAS` rises above 2 under load, and drops back to 2 several minutes after the load stops (the default scale-down stabilisation window is 5 minutes).

:::hint
If the NetworkPolicy test from `shipit` succeeds, your CNI is not enforcing policies; kind's default CNI (kindnet) enforces NetworkPolicy in recent kind releases, so check `kind version` and upgrade. If HPA shows `<unknown>`, metrics-server is not ready (`kubectl top pods -n shipit`) or the pods have no CPU request. If replicas do not rise, the cached `/items` endpoint may be too cheap: increase `-c`, or temporarily lower `targetCPUUtilizationPercentage` to 30.
:::

:::solution
Expected:

```text
$ kubectl run np-test -n shipit ... curl -sS -m 3 http://shipit-api/healthz
curl: (28) Connection timed out after 3002 milliseconds
pod "np-test" deleted

$ kubectl get hpa -n shipit
NAME         REFERENCE               TARGETS        MINPODS   MAXPODS   REPLICAS
shipit-api   Deployment/shipit-api   cpu: 183%/70%  2         5         5
```

Why things are wired this way:

- The policy selects only the API pods. Ingress is allowed from the `gateway` namespace (selected by the automatic `kubernetes.io/metadata.name` label) on port 3000. Egress is allowed to DNS, Postgres and Redis only. Forgetting the DNS rule is the most common NetworkPolicy mistake: everything "times out" because names never resolve.
- Kubelet probes keep working because policy implementations, kindnet included, allow traffic from the pod's own node.
- When `autoscaling.enabled` is true, the chart omits `spec.replicas` from the Deployment so Helm and the HPA do not fight over the replica count on every upgrade.
- HPA utilisation is relative to the **request** (100m). That is why an HPA without requests cannot work, a classic incident you will meet in Project 3.

Commit: `git commit -am "deploy: enable networkpolicy and hpa for local env"`.
:::

### Clean up

Nothing to clean; the settings are now part of the environment.

## Milestone 8 (challenge): Hand delivery to Argo CD

:::meta
difficulty: hard
time: 60 min
:::

Goal: switch the app's delivery from Terraform's `helm_release` to Argo CD, while Terraform keeps owning the cluster, platform, data and secret. No step-by-step this time.

### Requirements

1. A variable `deploy_mode` (`"terraform"` or `"argocd"`, already declared with validation) decides who deploys the app chart. In `argocd` mode, Terraform must **not** create `helm_release.shipit_api`.
2. In `argocd` mode Terraform installs Argo CD from the official `argo-helm` chart (pinned version, Dex and notifications disabled) and creates an `Application` that points at **your GitHub repo**, path `deploy/charts/shipit-api`, using `deploy/envs/local/values.yaml`.
3. The Application syncs automatically with `prune` and `selfHeal`.
4. Do not use `kubernetes_manifest` for the Application (remember why). Hint: a tiny local chart is a perfectly good container for one manifest.
5. `make recreate DEPLOY_MODE=argocd` works from zero, and `make down` removes everything, including the app Argo CD created.
6. Demonstrate self-heal: `kubectl scale deploy/shipit-api -n shipit --replicas=1` (with autoscaling disabled) or the `kubectl set env` from Milestone 6 gets reverted by Argo CD without you running anything.

### Verify

- `kubectl get applications -n argocd` shows `shipit-api` with `Synced` and `Healthy`.
- `make verify` passes.
- The out-of-band change from requirement 6 disappears within a few minutes (or immediately after clicking Refresh in the UI).
- Argo CD UI: `kubectl port-forward -n argocd svc/argocd-server 8081:80`, open `http://localhost:8081`, user `admin`, password from `kubectl get secret -n argocd argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`.

:::hint
Argo CD needs the chart and values to be **pushed** to GitHub; it does not read your working tree. Ordering matters: the Argo CD CRDs must exist before the Application is created (`depends_on`), and the Application must be deleted before Argo CD itself so its finalizer can clean up the app. For the Makefile, pass `-var deploy_mode=$(DEPLOY_MODE) -var gitops_repo_url=...` through to both `apply` and `destroy`.
:::

:::solution
**Terraform** (`infra/argocd.tf`):

`infra/argocd.tf`

```hcl
variable "gitops_repo_url" {
  description = "HTTPS URL of the Git repo Argo CD watches (e.g. https://github.com/<you>/shipit.git)."
  type        = string
  default     = ""
}

variable "gitops_revision" {
  description = "Branch, tag or commit Argo CD tracks."
  type        = string
  default     = "main"
}

variable "argocd_chart_version" {
  description = "argo-cd Helm chart version. Pin it: `helm search repo argo/argo-cd`."
  type        = string
  default     = null
}

resource "helm_release" "argocd" {
  count = var.deploy_mode == "argocd" ? 1 : 0

  name             = "argocd"
  namespace        = "argocd"
  create_namespace = true
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.argocd_chart_version
  wait             = true
  timeout          = 600

  values = [yamlencode({
    dex           = { enabled = false }
    notifications = { enabled = false }
    configs = {
      params = { "server.insecure" = true } # plain HTTP behind port-forward
    }
  })]
}

resource "helm_release" "argocd_bootstrap" {
  count = var.deploy_mode == "argocd" ? 1 : 0

  name      = "argocd-bootstrap"
  namespace = "argocd"
  chart     = abspath("${path.module}/../deploy/argocd-bootstrap")

  values = [yamlencode({
    repoURL  = var.gitops_repo_url
    revision = var.gitops_revision
    image = {
      repository = var.image_repository
      tag        = var.image_tag
    }
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

**Bootstrap chart** (`deploy/argocd-bootstrap/`):

`deploy/argocd-bootstrap/Chart.yaml`

```yaml
apiVersion: v2
name: argocd-bootstrap
description: Argo CD Application(s) for shipit
type: application
version: 0.1.0
```

`deploy/argocd-bootstrap/values.yaml`

```yaml
repoURL: ""
revision: main
image:
  repository: shipit-api
  tag: dev
```

`deploy/argocd-bootstrap/templates/application.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shipit-api
  namespace: argocd
  # Deleting the Application also deletes the resources it created (clean teardown).
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: {{ required "repoURL is required" .Values.repoURL | quote }}
    targetRevision: {{ .Values.revision | quote }}
    path: deploy/charts/shipit-api
    helm:
      releaseName: shipit-api
      valueFiles:
        - ../../envs/local/values.yaml   # same file Terraform uses
      valuesObject:                      # highest precedence; Project 2 moves the tag into Git
        image:
          repository: {{ .Values.image.repository | quote }}
          tag: {{ .Values.image.tag | quote }}
  destination:
    server: https://kubernetes.default.svc
    namespace: shipit
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

**Makefile** changes (tabs!):

```makefile
DEPLOY_MODE ?= terraform
GITOPS_REPO ?= https://github.com/$(GH_USER)/shipit.git
TF_MODE_VARS := -var deploy_mode=$(DEPLOY_MODE) -var gitops_repo_url=$(GITOPS_REPO)

# then append $(TF_MODE_VARS) to every `$(TF) apply` and `$(TF) destroy` line, e.g.:
#	$(TF) apply -input=false -auto-approve $(TF_IMAGE_VARS) $(TF_MODE_VARS)
```

Pin the chart: `helm repo add argo https://argoproj.github.io/argo-helm && helm search repo argo/argo-cd`, then set `argocd_chart_version` in `terraform.tfvars`.

**Run it**:

```bash
git add . && git commit -m "deploy: optional argo cd delivery" && git push
make recreate DEPLOY_MODE=argocd GH_USER=<you>
kubectl get applications -n argocd
kubectl set env deploy/shipit-api -n shipit SHUTDOWN_DELAY_MS=0
kubectl get deploy shipit-api -n shipit -o jsonpath='{.spec.template.spec.containers[0].env}' ; echo
# wait for the next reconciliation (default ~3 min) or click Refresh: the env var is back to 5000
```

**Why it is designed this way**

- **No `kubernetes_manifest`**: the Application CRD does not exist at the first plan, and `kubernetes_manifest` needs the CRD schema at plan time. A local chart via `helm_release` defers everything to apply time.
- **Finalizer** `resources-finalizer.argocd.argoproj.io`: deleting the Application deletes what it deployed. Combined with `depends_on = [helm_release.argocd]`, Terraform destroys the Application first (Argo CD still running to process the finalizer), then Argo CD.
- **`valuesObject` for the image**: convenient for this challenge because Terraform already knows the image. In Project 2 you move the tag into a Git-tracked values file so that a commit, not a Terraform variable, decides what runs. That is the GitOps contract.
- **Split responsibilities**: Terraform owns things that change rarely and need imperative bootstrap (cluster, CRDs, controllers, secrets). Argo CD owns things that change often and benefit from continuous reconciliation (the app). Only one tool manages each object; never let both own the same Helm release.
- **Data chart stays in Terraform** here for simplicity. Moving it into a second Argo CD Application is a good extension, as is an "app of apps" or `ApplicationSet` once you have several environments.
:::

### Clean up

```bash
make down DEPLOY_MODE=argocd GH_USER=<you>
kind get clusters      # No kind clusters found.
```
