Each lab below is one milestone of the capstone. Do them in order: each builds on the previous one. Every milestone has its own acceptance checks in **Verify** and a complete reference solution. Try to write each piece yourself first; the solutions exist so you're never stuck, not as copy-paste material.

**Prerequisites**: Docker (Desktop, OrbStack or Colima) with buildx and Compose, `git`, `curl`, `jq`, a GitHub account (for milestone 5). Optional: `brew install dive trivy`. No local Node.js is needed: you'll generate lockfiles inside containers.

```bash
mkdir -p ~/code/shipit && cd ~/code/shipit
git init
printf 'node_modules/\ndist/\n.env\nsecrets/\n*.log\n' > .gitignore
```

## Milestone 1: The API image

:::meta
difficulty: medium
time: 75 min
:::

Goal: a TypeScript API with a multi-stage Dockerfile whose default target is a small, non-root production image with a working healthcheck, plus a `dev` target for hot reload.

### Steps

1. Create `api/` with the application code:

   ```bash
   mkdir -p api/src && cd api
   cat > package.json <<'EOF'
   {
     "name": "shipit-api",
     "version": "1.0.0",
     "private": true,
     "type": "module",
     "scripts": {
       "build": "tsc -p tsconfig.json",
       "dev": "tsx watch src/server.ts",
       "start": "node dist/server.js",
       "migrate": "node dist/migrate.js"
     },
     "dependencies": {
       "express": "^5.1.0",
       "pg": "^8.16.0",
       "redis": "^5.8.0"
     },
     "devDependencies": {
       "@types/express": "^5.0.3",
       "@types/node": "^22.18.0",
       "@types/pg": "^8.15.0",
       "tsx": "^4.20.0",
       "typescript": "^5.9.0"
     }
   }
   EOF
   cat > tsconfig.json <<'EOF'
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "outDir": "dist",
       "rootDir": "src",
       "strict": true,
       "esModuleInterop": true,
       "skipLibCheck": true
     },
     "include": ["src"]
   }
   EOF
   ```

   `src/config.ts` (reads `NAME_FILE` secrets, so the same code works with env vars in dev and secret files in prod):

   ```typescript
   import { readFileSync } from 'node:fs';

   // Read NAME from NAME_FILE (a mounted secret) if set, otherwise from NAME.
   function secret(name: string): string | undefined {
     const file = process.env[`${name}_FILE`];
     return file ? readFileSync(file, 'utf8').trim() : process.env[name];
   }

   function databaseUrl(): string {
     if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
     const password = secret('DB_PASSWORD');
     const { DB_USER, DB_NAME, DB_HOST = 'db', DB_PORT = '5432' } = process.env;
     if (!DB_USER || !DB_NAME || !password) {
       throw new Error('Set DATABASE_URL, or DB_USER, DB_NAME and DB_PASSWORD/DB_PASSWORD_FILE');
     }
     return `postgres://${DB_USER}:${encodeURIComponent(password)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
   }

   export const config = {
     port: Number(process.env.PORT ?? 3000),
     databaseUrl: databaseUrl(),
     redisUrl: process.env.REDIS_URL ?? 'redis://cache:6379',
   };
   ```

   `src/server.ts`:

   ```typescript
   import os from 'node:os';
   import express from 'express';
   import pg from 'pg';
   import { createClient } from 'redis';
   import { config } from './config.js';

   const log = (level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
     console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

   const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
   const redis = createClient({ url: config.redisUrl });
   redis.on('error', (err: Error) => log('error', 'redis error', { err: err.message }));
   await redis.connect();

   const app = express();
   app.disable('x-powered-by');
   app.use(express.json({ limit: '10kb' }));

   // Liveness: the process is up. Never touches dependencies.
   app.get('/healthz', (_req, res) => {
     res.json({ status: 'ok', host: os.hostname() });
   });

   // Readiness: can we serve traffic right now?
   app.get('/readyz', async (_req, res) => {
     try {
       await pool.query('SELECT 1');
       await redis.ping();
       res.json({ status: 'ready' });
     } catch (err) {
       res.status(503).json({ status: 'not ready', error: (err as Error).message });
     }
   });

   app.get('/items', async (_req, res) => {
     const cached = await redis.get('items');
     if (cached) {
       res.set('x-cache', 'hit').json(JSON.parse(cached));
       return;
     }
     const { rows } = await pool.query('SELECT id, name, created_at FROM items ORDER BY id');
     await redis.set('items', JSON.stringify(rows), { EX: 30 });
     res.set('x-cache', 'miss').json(rows);
   });

   app.post('/items', async (req, res) => {
     const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
     if (!name) {
       res.status(400).json({ error: 'name is required' });
       return;
     }
     const { rows } = await pool.query(
       'INSERT INTO items(name) VALUES ($1) RETURNING id, name, created_at',
       [name],
     );
     await redis.del('items');
     res.status(201).json(rows[0]);
   });

   const server = app.listen(config.port, '0.0.0.0', () => log('info', 'shipit-api listening', { port: config.port }));

   function shutdown(signal: string) {
     log('info', 'shutting down', { signal });
     server.close(async () => {
       await Promise.allSettled([pool.end(), redis.close()]);
       process.exit(0);
     });
     setTimeout(() => process.exit(1), 8000).unref(); // hard stop before Docker's 10 s SIGKILL
   }
   process.on('SIGTERM', () => shutdown('SIGTERM'));
   process.on('SIGINT', () => shutdown('SIGINT'));
   ```

   `src/migrate.ts`:

   ```typescript
   import pg from 'pg';
   import { config } from './config.js';

   const client = new pg.Client({ connectionString: config.databaseUrl });
   await client.connect();
   try {
     await client.query('BEGIN');
     await client.query(`
       CREATE TABLE IF NOT EXISTS items (
         id         serial PRIMARY KEY,
         name       text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`);
     await client.query('COMMIT');
     console.log(JSON.stringify({ level: 'info', msg: 'migrations applied' }));
   } catch (err) {
     await client.query('ROLLBACK');
     throw err;
   } finally {
     await client.end();
   }
   ```

2. Generate the lockfile inside a container:

   ```bash
   docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund
   ```

3. Write `api/.dockerignore` and `api/Dockerfile` meeting these requirements:
   - stages: `build` (compile TS on `$BUILDPLATFORM`), `prod-deps` (`npm ci --omit=dev` on the target platform), `dev` (all deps + `tsx watch`), and `runtime` as the **last** stage so it's the default target;
   - npm cache mount for faster rebuilds;
   - runtime: `node:22-alpine`, `NODE_ENV=production`, only `dist/`, prod `node_modules` and `package.json`; code owned by root (not writable by the app user); `USER node`;
   - exec-form `CMD`, `EXPOSE 3000`, a `HEALTHCHECK` using `node` (no curl in the image);
   - OCI labels (`org.opencontainers.image.source`, `.title`, `.licenses` or similar).

4. Build and inspect:

   ```bash
   docker build -t shipit-api:local .
   docker image ls shipit-api:local
   docker inspect -f 'user={{.Config.User}} cmd={{.Config.Cmd}} health={{.Config.Healthcheck.Test}}' shipit-api:local
   docker run --rm --entrypoint sh shipit-api:local -c 'ls /app; ls /app/node_modules | grep -c . ; ls /app/node_modules/.bin 2>/dev/null | head'
   ```

5. Smoke test without a database (liveness only works; readiness needs Postgres and Redis, which come in milestone 3). The app connects to Redis at startup, so start a throwaway Redis on a network first:

   ```bash
   docker network create m1
   docker run -d --name m1-redis --network m1 redis:8-alpine
   docker run -d --name m1-api --network m1 -p 3000:3000 \
     -e DATABASE_URL=postgres://x:y@nowhere:5432/z -e REDIS_URL=redis://m1-redis:6379 shipit-api:local
   sleep 3; curl -s localhost:3000/healthz; curl -s localhost:3000/readyz
   sleep 15; docker inspect -f '{{.State.Health.Status}}' m1-api
   time docker stop m1-api
   ```

6. Prove the cache works: change a string in `src/server.ts`, rebuild with `--progress=plain`, and confirm the `npm ci` steps are `CACHED`.

### Verify

- Image ≤ 200 MB (`docker image ls`), `user=node`, healthcheck defined.
- `/app` contains `dist`, `node_modules`, `package.json` only; no `src`, no `typescript` or `tsx` in `node_modules`.
- `/healthz` returns 200; `/readyz` returns 503 (no DB) without crashing the process; health status becomes `healthy`.
- `docker stop` takes well under a second and the logs show `shutting down`.
- Rebuild after a code change shows `CACHED` for both `npm ci` steps.

:::hint
- `FROM --platform=$BUILDPLATFORM node:22-alpine AS build` for the compile stage. `$BUILDPLATFORM` is predefined by BuildKit.
- `RUN --mount=type=cache,target=/root/.npm npm ci` keeps the npm download cache between builds without putting it in a layer.
- `COPY --from=build /app/dist ./dist` without `--chown` keeps files owned by root, and `node` can still read them.
:::

:::solution
`api/.dockerignore`:

```text
node_modules
dist
npm-debug.log
.env
*.md
Dockerfile
.dockerignore
```

`api/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

# ---- build: compile TypeScript on the builder's native platform ----
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- prod-deps: production dependencies for the TARGET platform ----
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ---- dev: used by compose.yaml with `docker compose watch` ----
FROM node:${NODE_VERSION}-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
EXPOSE 3000
CMD ["npx", "tsx", "watch", "src/server.ts"]

# ---- runtime: the default (last) stage ----
FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="shipit-api" \
      org.opencontainers.image.description="shipit inventory API" \
      org.opencontainers.image.source="https://github.com/your-github-user/shipit" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# Root-owned, read-only for the app user: a compromised process can't modify its own code.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
```

Why this shape:
- `build` runs natively even when you build `linux/amd64` on an arm64 Mac; its output is plain JS, identical for every target.
- `prod-deps` runs per target platform, so a future native dependency gets the right binaries.
- `runtime` is last, so `docker build .` (and CI without `--target`) produces the production image. Compose dev uses `target: dev`.
- Copying lockfiles before sources keeps `npm ci` cached when only code changes.
- A typical result is roughly 150–200 MB, most of it the Node runtime and npm. Stretch goal: delete npm from the runtime (`RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx` before `USER node`) or switch the runtime to `gcr.io/distroless/nodejs22-debian12` (then the healthcheck becomes `["CMD", "/nodejs/bin/node", "-e", "..."]`).

Clean up the smoke test: `docker rm -f m1-api m1-redis; docker network rm m1`.
:::

### Clean up

```bash
docker rm -f m1-api m1-redis 2>/dev/null; docker network rm m1 2>/dev/null
cd ~/code/shipit && git add -A && git commit -qm "Milestone 1: API image"
```

## Milestone 2: The web image

:::meta
difficulty: medium
time: 45 min
:::

Goal: a static frontend served by non-root nginx that reverse-proxies `/api/*` to the API, with security headers and a healthcheck.

### Steps

1. Create the frontend:

   ```bash
   cd ~/code/shipit && mkdir -p web/public web/nginx
   cat > web/public/index.html <<'EOF'
   <!doctype html>
   <html lang="en">
   <head>
     <meta charset="utf-8">
     <meta name="viewport" content="width=device-width, initial-scale=1">
     <title>shipit</title>
     <link rel="stylesheet" href="style.css">
   </head>
   <body>
     <main>
       <h1>shipit</h1>
       <form id="add">
         <input id="name" placeholder="New item" required maxlength="100">
         <button type="submit">Add</button>
       </form>
       <ul id="items"></ul>
       <p id="status"></p>
     </main>
     <script src="app.js"></script>
   </body>
   </html>
   EOF
   cat > web/public/style.css <<'EOF'
   body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
   form { display: flex; gap: .5rem; } input { flex: 1; padding: .4rem; } #status { color: #666; }
   EOF
   cat > web/public/app.js <<'EOF'
   const list = document.getElementById('items');
   const statusEl = document.getElementById('status');

   async function load() {
     const res = await fetch('/api/items');
     if (!res.ok) throw new Error(`HTTP ${res.status}`);
     const items = await res.json();
     list.replaceChildren(...items.map((item) => {
       const li = document.createElement('li');
       li.textContent = item.name;
       return li;
     }));
     statusEl.textContent = `${items.length} items (cache: ${res.headers.get('x-cache')})`;
   }

   document.getElementById('add').addEventListener('submit', async (event) => {
     event.preventDefault();
     const input = document.getElementById('name');
     await fetch('/api/items', {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ name: input.value }),
     });
     input.value = '';
     await load();
   });

   load().catch((err) => { statusEl.textContent = `API error: ${err.message}`; });
   EOF
   ```

2. Write `web/nginx/default.conf`:
   - listen on 8080; serve `/usr/share/nginx/html`;
   - `location = /nginx-health` returns 200 without logging;
   - `/api/` proxies to `http://api:3000/` with the `/api` prefix stripped, using Docker's DNS resolver (`127.0.0.11`) with a variable so nginx starts even if the API is down and re-resolves when the API container is recreated;
   - headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, a `Content-Security-Policy` of `default-src 'self'`; `server_tokens off`.

3. Write `web/Dockerfile` based on `nginxinc/nginx-unprivileged:alpine` with a `HEALTHCHECK` using `wget`, and a `.dockerignore`.

4. Build and test it alone:

   ```bash
   docker build -t shipit-web:local ./web
   docker run -d --name m2-web -p 8080:8080 shipit-web:local
   curl -sI localhost:8080 | grep -iE 'HTTP/|content-security|x-frame|server:'
   curl -s localhost:8080/nginx-health
   curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/api/items     # 502: no api yet, but nginx is up
   docker inspect -f 'user={{.Config.User}}' shipit-web:local
   docker image ls shipit-web:local
   ```

### Verify

- `HTTP/1.1 200 OK` with the security headers, and `Server: nginx` without a version.
- `/nginx-health` returns `ok`; `/api/items` returns 502 (API absent) rather than nginx failing to start.
- Image user is `101` (or `nginx`), image ≤ 80 MB.

:::hint
With a variable in `proxy_pass`, nginx resolves the name at request time using `resolver`. Combine `rewrite ^/api/(.*)$ /$1 break;` with `proxy_pass $api_upstream;` to strip the prefix. Note that `add_header` directives are inherited by locations only if the location defines none of its own.
:::

:::solution
`web/nginx/default.conf`:

```text
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    server_tokens off;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'self'" always;

    # Docker's embedded DNS; re-resolve so API restarts/IP changes are picked up.
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $api_upstream http://api:3000;

    location = /nginx-health {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    location /api/ {
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass $api_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 2s;
        proxy_read_timeout 10s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

`web/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Pin to a version tag or digest in real projects, e.g. nginxinc/nginx-unprivileged:<version>-alpine@sha256:...
FROM nginxinc/nginx-unprivileged:alpine
LABEL org.opencontainers.image.title="shipit-web" \
      org.opencontainers.image.source="https://github.com/your-github-user/shipit"
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/nginx-health || exit 1
```

`web/.dockerignore`:

```text
Dockerfile
.dockerignore
*.md
```

Notes:
- The base image already sets `USER 101` and keeps its pid file and temp paths under `/tmp`, so it can run read-only with zero capabilities (milestone 4).
- Using `resolver` + variable avoids two classic problems: nginx refusing to start with `host not found in upstream "api"` when the API isn't up yet, and nginx sending traffic to a stale IP after the API container is recreated.
- The CSP blocks inline scripts and styles, which is why the JS and CSS are separate files.
:::

### Clean up

```bash
docker rm -f m2-web
git add -A && git commit -qm "Milestone 2: web image"
```

## Milestone 3: The development stack

:::meta
difficulty: medium
time: 75 min
:::

Goal: `docker compose up --watch` gives you the full stack with gated startup, migrations and hot reload.

### Steps

1. Create `.env.example` and `.env`:

   ```bash
   cat > .env.example <<'EOF'
   POSTGRES_USER=shipit
   POSTGRES_DB=shipit
   POSTGRES_PASSWORD=change-me
   EOF
   cp .env.example .env
   ```

2. Write `compose.yaml` with services `web`, `api`, `migrate`, `db`, `cache`:
   - `api` and `migrate` build `./api` with `target: dev`; `migrate` runs `npx tsx src/migrate.ts`;
   - DB settings passed as `DB_HOST`/`DB_USER`/`DB_NAME`/`DB_PASSWORD` (share them with an anchor); `POSTGRES_PASSWORD` is required (`:?`);
   - healthchecks on `db`, `cache`, `api` (web's comes from its image);
   - start order: db and cache healthy → migrate completed → api healthy → web;
   - `api` watch: sync `./api/src` → `/app/src`; rebuild on `package.json` and `package-lock.json`;
   - `web`: bind-mount `./web/public` read-only over the html directory and the nginx config read-only (static files are tiny, so a bind mount is fine here; explain why in a comment);
   - published ports: web `127.0.0.1:8080`, api `127.0.0.1:3000`, db `127.0.0.1:5432`;
   - named volumes for Postgres (correct 18+ path) and Redis.

3. Run it:

   ```bash
   docker compose config -q && docker compose up --watch
   ```

4. In another terminal, exercise it:

   ```bash
   curl -s localhost:8080/api/readyz
   curl -s -X POST localhost:8080/api/items -H 'content-type: application/json' -d '{"name":"standing desk"}'
   open http://localhost:8080          # add an item in the browser too
   ```

5. Hot reload: change the `/healthz` response in `api/src/server.ts`, then `curl -s localhost:3000/healthz`. Change the `<h1>` in `web/public/index.html` and refresh the browser.

### Verify

- `docker compose ps -a`: `migrate` is `Exited (0)`; `db`, `cache`, `api`, `web` are `healthy`.
- The UI lists and adds items, and the status line shows `cache: miss` then `cache: hit` on refresh.
- API code changes are live within ~2 s without a rebuild; `web` changes are visible on refresh.
- `docker compose down && docker compose up -d --wait` keeps your items.

:::hint
`web` has `depends_on: api: condition: service_healthy`. If `web` never starts, check `docker compose ps -a` and `docker inspect -f '{{json .State.Health}}' shipit-api-1`. If migrations fail, `docker compose logs migrate`.
:::

:::solution
```yaml
# compose.yaml (development)
name: shipit

x-db-env: &db-env
  DB_HOST: db
  DB_USER: ${POSTGRES_USER:-shipit}
  DB_NAME: ${POSTGRES_DB:-shipit}
  DB_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}

x-api-build: &api-build
  context: ./api
  target: dev

services:
  web:
    build: ./web
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      # Static files are few and small, so a read-only bind mount is fast enough even on macOS,
      # and it avoids the html dir (owned by root) needing to be writable for `watch` sync.
      - ./web/public:/usr/share/nginx/html:ro
      - ./web/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      api:
        condition: service_healthy

  api:
    build: *api-build
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      <<: *db-env
      PORT: "3000"
      REDIS_URL: redis://cache:6379
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 15s
    develop:
      watch:
        - action: sync
          path: ./api/src
          target: /app/src
        - action: rebuild
          path: ./api/package.json
        - action: rebuild
          path: ./api/package-lock.json

  migrate:
    build: *api-build
    command: ["npx", "tsx", "src/migrate.ts"]
    environment: *db-env
    depends_on:
      db:
        condition: service_healthy
    restart: "no"

  db:
    image: postgres:18
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-shipit}
      POSTGRES_DB: ${POSTGRES_DB:-shipit}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  cache:
    image: redis:8-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
  redisdata:
```

Notes:
- Everything shares the default project network in dev; isolation comes in the prod-like file.
- The dev `api` runs as root inside the `dev` stage, which keeps `watch` sync simple. The production image is non-root.
- `tsx watch` restarts the process when synced files change; no image rebuild needed. A dependency change triggers `rebuild` automatically.
:::

### Clean up

```bash
docker compose down        # keep volumes for later milestones
git add -A && git commit -qm "Milestone 3: dev stack"
```

## Milestone 4: The prod-like stack

:::meta
difficulty: hard
time: 75 min
:::

Goal: a standalone `compose.prod.yaml` that runs prebuilt images with production hardening, secrets, isolation, limits and log rotation. For now, use your local images (`shipit-api:local`, `shipit-web:local`); milestone 5 switches to GHCR.

### Steps

1. Create the secret:

   ```bash
   mkdir -p secrets && openssl rand -base64 24 | tr -d '\n' > secrets/db_password.txt
   chmod 644 secrets/db_password.txt     # readable by the non-root users inside containers
   ```

2. Rebuild the production images from the current code: `docker build -t shipit-api:local ./api && docker build -t shipit-web:local ./web`.

3. Write `compose.prod.yaml` meeting the acceptance criteria from the lesson:
   - images by variables: `${API_IMAGE:-shipit-api:local}`, `${WEB_IMAGE:-shipit-web:local}`; no `build:` anywhere;
   - networks: `edge` (web, api) and `data` (internal: api, migrate, db, cache);
   - only `web` publishes a port (`8080:8080`);
   - `web`, `api`, `migrate`: `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, tmpfs `/tmp`, and CPU/memory/PID limits (`deploy.resources.limits`); share the security settings via an anchor;
   - `db` and `cache`: `no-new-privileges`, `cap_drop: [ALL]` plus only the capabilities their entrypoints need to fix ownership and drop to their service user;
   - `db_password` secret used by `db` (`POSTGRES_PASSWORD_FILE`) and by `api`/`migrate` (`DB_PASSWORD_FILE`);
   - json-file logging with rotation on every service; `restart: unless-stopped` (except `migrate`).

4. Run it under its own project name (so it gets its own volumes) and test:

   ```bash
   docker compose -f compose.prod.yaml config -q
   docker compose -f compose.prod.yaml up -d --wait
   curl -s localhost:8080/api/readyz
   curl -s -X POST localhost:8080/api/items -H 'content-type: application/json' -d '{"name":"prod item"}'
   ```

5. Audit it:

   ```bash
   for c in $(docker compose -f compose.prod.yaml ps -q); do
     docker inspect -f '{{.Name}} user={{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} nnp={{.HostConfig.SecurityOpt}} mem={{.HostConfig.Memory}} log={{.HostConfig.LogConfig.Config}}' $c
   done
   docker compose -f compose.prod.yaml ps --format 'table {{.Service}}\t{{.Ports}}'
   docker inspect $(docker compose -f compose.prod.yaml ps -q) | grep -F -c "$(cat secrets/db_password.txt)"   # expect 0
   docker compose -f compose.prod.yaml exec cache sh -c 'wget -qO- -T 3 https://example.com >/dev/null && echo "internet!" || echo "no egress"'
   time docker compose -f compose.prod.yaml stop
   ```

### Verify

- `up --wait` succeeds; readiness returns `ready` through nginx.
- Only `web` shows a published port.
- `web`, `api`: `ro=true`, `capdrop=[ALL]`, `no-new-privileges`, memory limits set, log rotation present.
- The password count in `docker inspect` is `0`.
- `cache` has no egress.
- `stop` completes in under 3 seconds.

:::hint
- YAML merge keys (`<<: *hardened`) let you share a block of settings; keys you set explicitly on a service override merged ones (e.g. `restart: "no"` on `migrate`).
- Official postgres and redis entrypoints start as root, `chown` their data directories and drop to their service user with `gosu`/`su-exec`. That needs `CHOWN`, `SETUID`, `SETGID` and usually `DAC_OVERRIDE`/`FOWNER`. If a container fails to start, read its logs and adjust; that's the method from module 08.
:::

:::solution
```yaml
# compose.prod.yaml (prod-like, no builds)
name: shipit-prod

x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"

x-hardened: &hardened
  read_only: true
  cap_drop: [ALL]
  security_opt: ["no-new-privileges:true"]
  tmpfs:
    - /tmp:rw,noexec,nosuid,size=16m
  restart: unless-stopped
  logging: *logging

x-stateful: &stateful
  security_opt: ["no-new-privileges:true"]
  cap_drop: [ALL]
  cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]
  restart: unless-stopped
  logging: *logging

x-api-env: &api-env
  NODE_ENV: production
  DB_HOST: db
  DB_USER: ${POSTGRES_USER:-shipit}
  DB_NAME: ${POSTGRES_DB:-shipit}
  DB_PASSWORD_FILE: /run/secrets/db_password
  REDIS_URL: redis://cache:6379

services:
  web:
    <<: *hardened
    image: ${WEB_IMAGE:-shipit-web:local}
    ports:
      - "8080:8080"
    deploy:
      resources:
        limits: { cpus: "0.25", memory: 64M, pids: 100 }
    depends_on:
      api:
        condition: service_healthy
    networks: [edge]

  api:
    <<: *hardened
    image: ${API_IMAGE:-shipit-api:local}
    environment: *api-env
    secrets: [db_password]
    deploy:
      resources:
        limits: { cpus: "0.5", memory: 256M, pids: 200 }
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    networks: [edge, data]

  migrate:
    <<: *hardened
    image: ${API_IMAGE:-shipit-api:local}
    command: ["node", "dist/migrate.js"]
    environment: *api-env
    secrets: [db_password]
    restart: "no"
    deploy:
      resources:
        limits: { cpus: "0.5", memory: 128M, pids: 50 }
    depends_on:
      db:
        condition: service_healthy
    networks: [data]

  db:
    <<: *stateful
    image: postgres:18
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-shipit}
      POSTGRES_DB: ${POSTGRES_DB:-shipit}
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    volumes:
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 15s
    deploy:
      resources:
        limits: { memory: 512M }
    networks: [data]

  cache:
    <<: *stateful
    image: redis:8-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    deploy:
      resources:
        limits: { memory: 128M }
    networks: [data]

secrets:
  db_password:
    file: ./secrets/db_password.txt

networks:
  edge: {}
  data:
    internal: true

volumes:
  pgdata:
  redisdata:
```

Notes:
- `api` needs `edge` so nginx can reach it and `data` for the stores; `web` is only on `edge`, so even a compromised nginx can't reach Postgres.
- The API image's own `HEALTHCHECK` is used for `depends_on: service_healthy`; you don't need to repeat it in Compose.
- The password lives in one file, read by Postgres's entrypoint (`POSTGRES_PASSWORD_FILE`) and by the API's `config.ts` (`DB_PASSWORD_FILE`). It never appears in env vars.
- In a real deployment, `secrets/db_password.txt` would be provisioned by your infrastructure (e.g. fetched from AWS Secrets Manager at boot), not created by hand.
- Stretch: run `db` with `read_only: true` plus tmpfs for `/var/run/postgresql` and `/tmp`, and run `cache` as `user: redis` with zero capabilities.
:::

### Clean up

```bash
docker compose -f compose.prod.yaml down     # keep volumes; add -v to reset
git add -A && git commit -qm "Milestone 4: prod-like stack"
```

## Milestone 5: Multi-arch images on GHCR, attested and scanned

:::meta
difficulty: hard
time: 75 min
:::

Goal: publish both images for amd64 and arm64 to GitHub Container Registry with SBOM and provenance, scan them, record their sizes, and run the prod-like stack from the registry.

### Steps

1. Create a GitHub personal access token (classic) with `write:packages` and `read:packages`, then log in:

   ```bash
   export GHCR_OWNER=your-github-username        # must be lowercase in image names
   read -s GHCR_TOKEN && export GHCR_TOKEN       # paste the token, press Enter
   echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_OWNER" --password-stdin
   ```

2. Update the `org.opencontainers.image.source` labels in both Dockerfiles to `https://github.com/$GHCR_OWNER/shipit` (GHCR uses it to link the package to the repository).

3. Create a multi-platform builder:

   ```bash
   docker buildx create --name shipit-builder --driver docker-container --use --bootstrap
   docker buildx inspect --bootstrap | grep -i platforms
   ```

4. Build and push both images with tags `1.0.0` and `sha-<short git sha>`, for `linux/amd64,linux/arm64`, with `--sbom=true --provenance=mode=max`. Time the API build and notice which stages run under emulation.

5. Inspect what you pushed:

   ```bash
   docker buildx imagetools inspect ghcr.io/$GHCR_OWNER/shipit-api:1.0.0
   # attestations are stored per platform
   docker buildx imagetools inspect ghcr.io/$GHCR_OWNER/shipit-api:1.0.0 \
     --format '{{json (index .SBOM "linux/arm64").SPDX}}' | jq '.packages | length'
   docker buildx imagetools inspect ghcr.io/$GHCR_OWNER/shipit-api:1.0.0 \
     --format '{{json (index .Provenance "linux/arm64").SLSA}}' | jq 'keys'
   ```

6. Measure sizes. Uncompressed size of the native (arm64) image locally, and compressed (download) size of each platform from the registry manifests:

   ```bash
   for app in api web; do docker pull -q ghcr.io/$GHCR_OWNER/shipit-$app:1.0.0 >/dev/null; done
   docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' | grep shipit-

   for app in api web; do
     repo=ghcr.io/$GHCR_OWNER/shipit-$app
     for arch in arm64 amd64; do
       digest=$(docker buildx imagetools inspect $repo:1.0.0 --raw \
         | jq -r --arg a $arch '.manifests[] | select(.platform.os=="linux" and .platform.architecture==$a) | .digest')
       mb=$(docker buildx imagetools inspect $repo@$digest --raw | jq '[.layers[].size] | add / 1000000 | floor')
       echo "$app linux/$arch compressed: ${mb} MB"
     done
   done
   ```

   Optional: `dive ghcr.io/$GHCR_OWNER/shipit-api:1.0.0` to see the size of each layer.

7. Scan both images and gate on fixable criticals:

   ```bash
   for app in api web; do
     docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache aquasec/trivy \
       image --quiet --severity CRITICAL,HIGH --ignore-unfixed ghcr.io/$GHCR_OWNER/shipit-$app:1.0.0
     docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache aquasec/trivy \
       image --quiet --exit-code 1 --severity CRITICAL --ignore-unfixed ghcr.io/$GHCR_OWNER/shipit-$app:1.0.0 \
       && echo "$app: gate PASSED" || echo "$app: gate FAILED"
   done
   ```

8. Run the prod-like stack from GHCR:

   ```bash
   export API_IMAGE=ghcr.io/$GHCR_OWNER/shipit-api:1.0.0 WEB_IMAGE=ghcr.io/$GHCR_OWNER/shipit-web:1.0.0
   docker compose -f compose.prod.yaml up -d --wait && curl -s localhost:8080/api/readyz
   ```

### Verify

- `imagetools inspect` lists `linux/amd64` and `linux/arm64` manifests plus attestation manifests (`unknown/unknown`).
- The SBOM has dozens of packages; provenance is present.
- Sizes recorded (uncompressed arm64 locally, compressed per platform from the registry); api ≤ 200 MB and web ≤ 80 MB uncompressed.
- Both scan gates pass (or you've documented why one doesn't and how you'll fix it).
- The stack runs from GHCR images.

:::hint
- `--push` is required for multi-platform builds with the `docker-container` driver (or use `--output type=oci,dest=...`).
- If the push is denied, check the token scopes, that the image name is lowercase, and that you're logged in to `ghcr.io` (not Docker Hub).
- New GHCR packages are private by default. Make them public in the package settings on GitHub if you want anonymous pulls.
:::

:::solution
```bash
cd ~/code/shipit
SHA=$(git rev-parse --short HEAD)

time docker buildx build ./api \
  --builder shipit-builder \
  --platform linux/amd64,linux/arm64 \
  --sbom=true --provenance=mode=max \
  -t ghcr.io/$GHCR_OWNER/shipit-api:1.0.0 \
  -t ghcr.io/$GHCR_OWNER/shipit-api:sha-$SHA \
  --push

docker buildx build ./web \
  --builder shipit-builder \
  --platform linux/amd64,linux/arm64 \
  --sbom=true --provenance=mode=max \
  -t ghcr.io/$GHCR_OWNER/shipit-web:1.0.0 \
  -t ghcr.io/$GHCR_OWNER/shipit-web:sha-$SHA \
  --push
```

What you should observe:
- The `build` stage (TypeScript compile) appears once and runs natively on arm64 because of `--platform=$BUILDPLATFORM`; it's shared by both targets.
- `prod-deps` runs twice, once per platform; the amd64 one is emulated and noticeably slower. With pure-JS dependencies the output is identical, but with native modules it would differ, which is why it must run per target.
- Each tag points to an **index** with two image manifests and two attestation manifests.

Tagging scheme: an immutable semver tag for releases plus `sha-<commit>` for traceability. Deploy by digest when you can (`docker buildx imagetools inspect <ref>` shows it), so what runs is exactly what you scanned.

Typical sizes: api around 150–200 MB uncompressed (npm and the Node runtime dominate), web around 50–60 MB. Compressed sizes in the registry are roughly a third of that.
:::

### Clean up

```bash
docker compose -f compose.prod.yaml down
git add -A && git commit -qm "Milestone 5: multi-arch images on GHCR"
```

## Milestone 6: README, review and stretch goals

:::meta
difficulty: medium
time: 60 min
:::

Goal: make the project usable by someone else, score yourself against the rubric, and optionally automate releases in CI.

### Steps

1. Write `README.md` with at least these sections: Overview + architecture diagram, Prerequisites, Quickstart (dev), Running the prod-like stack, Configuration (table of env vars and secrets), Migrations, Images (tags, platforms, sizes, scan summary), Releasing, Troubleshooting (top 5 problems and commands), Known limitations.

2. Do a fresh-clone test: `git clone ~/code/shipit /tmp/shipit-test && cd /tmp/shipit-test`, follow only your README, and time how long it takes to get the UI running. Fix anything that wasn't documented.

3. Review every acceptance criterion in the lesson and score yourself with the rubric. Write the score and the top 3 improvements at the end of the README.

4. Stretch goals (pick any):
   - **CI**: add `.github/workflows/images.yml` that builds both images for both platforms on tag pushes, pushes to GHCR with SBOM/provenance, and fails on fixable criticals. Pin every action to a commit SHA.
   - **Sign** the pushed digests with cosign (keyless in CI) and verify them before deploying.
   - **Distroless API** runtime and compare size and scan results.
   - **Deploy by digest**: make `compose.prod.yaml` use `image@sha256:...` from the build metadata.
   - **Fully read-only Postgres** with tmpfs for its runtime directories.

### Verify

- A fresh clone gets to a working UI in under 15 minutes following only the README.
- Every acceptance criterion is checked or has a note explaining the gap.
- Rubric score and improvement list are in the README.

:::hint
Use `docker compose config` output and `docker inspect` snippets from the earlier milestones as evidence in the README. For the CI workflow, start from the official "GitHub Actions with Docker" examples linked in the resources and check each action's README for its current major version.
:::

:::solution
README skeleton:

```text
# shipit

Inventory service: TypeScript API (Express, Postgres, Redis) + static web UI behind nginx.

## Architecture
(diagram from the capstone lesson; note networks, volumes, secret, startup order)

## Prerequisites
Docker 27+ with Compose and buildx (Docker Desktop, OrbStack or Colima). Apple Silicon and x86 supported.

## Quickstart (development)
cp .env.example .env
docker compose up --watch
open http://localhost:8080      # API on :3000, Postgres on 127.0.0.1:5432

## Prod-like run
mkdir -p secrets && openssl rand -base64 24 | tr -d '\n' > secrets/db_password.txt && chmod 644 secrets/db_password.txt
export API_IMAGE=ghcr.io/<owner>/shipit-api:1.0.0 WEB_IMAGE=ghcr.io/<owner>/shipit-web:1.0.0
docker compose -f compose.prod.yaml up -d --wait

## Configuration
| Variable | Service | Default | Notes |
| PORT | api | 3000 | |
| DATABASE_URL | api, migrate | - | dev shortcut; overrides DB_* |
| DB_HOST / DB_USER / DB_NAME | api, migrate | db / shipit / shipit | |
| DB_PASSWORD / DB_PASSWORD_FILE | api, migrate | - | prefer *_FILE (Compose secret) |
| REDIS_URL | api | redis://cache:6379 | |

## Migrations
Run automatically by the `migrate` service before the API starts. Manually: docker compose run --rm migrate

## Images
| Image | Platforms | Size (arm64/amd64) | Scan (fixable crit/high) |
| shipit-api | amd64, arm64 | 1xx MB / 1xx MB | 0 / n |
| shipit-web | amd64, arm64 | 5x MB / 5x MB | 0 / n |

## Releasing
git tag v1.0.1 && git push --tags   (CI builds, scans, pushes 1.0.1 and sha-<commit>)

## Troubleshooting
- api unhealthy: docker compose logs api; docker inspect -f '{{json .State.Health}}' <container>
- migrate exited 1: docker compose logs migrate (DB password mismatch after changing .env? reset with down -v in dev)
- 502 from /api: api not healthy yet, or wrong upstream; check nginx logs: docker compose logs web
- permission denied on secret: chmod 644 secrets/db_password.txt
- exec format error on a server: image not built for that platform; check imagetools inspect

## Known limitations / next steps
...
## Self-assessment
Score: xx/100. Top improvements: ...
```

(Shown as plain text so it renders inside this lab; in your real README, use proper Markdown tables and fenced code blocks.)

CI workflow sketch (`.github/workflows/images.yml`). Replace each `@vN` with the full commit SHA of the release you've reviewed (keep the version as a comment):

```yaml
name: images
on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        app: [api, web]
    steps:
      - uses: actions/checkout@v5                # pin: actions/checkout@<sha> # v5.x
      - uses: docker/setup-qemu-action@v3        # pin to SHA
      - uses: docker/setup-buildx-action@v3      # pin to SHA
      - uses: docker/login-action@v3             # pin to SHA
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5          # pin to SHA
        with:
          images: ghcr.io/${{ github.repository_owner }}/shipit-${{ matrix.app }}
          tags: |
            type=semver,pattern={{version}}
            type=sha
      - id: build
        uses: docker/build-push-action@v6        # pin to SHA
        with:
          context: ./${{ matrix.app }}
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          sbom: true
          provenance: mode=max
          cache-from: type=gha,scope=${{ matrix.app }}
          cache-to: type=gha,mode=max,scope=${{ matrix.app }}
      - name: Scan (fail on fixable criticals)
        run: |
          docker run --rm -v "$HOME/.docker/config.json:/root/.docker/config.json:ro" \
            aquasec/trivy:<pinned-version> image --exit-code 1 --severity CRITICAL --ignore-unfixed \
            ghcr.io/${{ github.repository_owner }}/shipit-${{ matrix.app }}@${{ steps.build.outputs.digest }}
```

Notes:
- `GITHUB_TOKEN` with `packages: write` can push to GHCR packages owned by the repository's owner; no personal token in CI.
- The API's production image is the Dockerfile's last stage, so no `target` is needed in CI.
- Scanning by digest guarantees you scan exactly what you pushed. Image names must be lowercase; if your GitHub username has capitals, lowercase it in a previous step.
- For keyless signing, add `permissions: id-token: write`, install cosign with `sigstore/cosign-installer` (pinned), and run `cosign sign --yes ghcr.io/...@${{ steps.build.outputs.digest }}`.
:::

### Clean up

```bash
rm -rf /tmp/shipit-test
docker buildx rm shipit-builder
docker volume rm trivy-cache 2>/dev/null
# Keep ~/code/shipit: the Kubernetes track deploys these images.
```
