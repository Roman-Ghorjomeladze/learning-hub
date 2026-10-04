In these labs you build the **shipit** stack with Compose and then evolve it. Lab 1 creates the project that every later lab reuses, so do it first.

Prerequisites: Docker with Compose (`docker compose version` should print v2.24 or newer; current releases are numbered 5.x), `curl`, and optionally `jq`. No local Node.js needed; everything runs in containers.

## Lab 1: Build the shipit stack from scratch

:::meta
difficulty: medium
time: 40 min
:::

Goal: write the app, a multi-target Dockerfile and a `compose.yaml` with Postgres, Redis, healthchecks, a migration job and gated startup, then bring it all up with one command.

### Steps

1. Create the project and the app code:

   ```bash
   mkdir -p ~/docker-labs/shipit/src && cd ~/docker-labs/shipit
   cat > package.json <<'EOF'
   {
     "name": "shipit-api",
     "version": "1.0.0",
     "private": true,
     "type": "module",
     "scripts": { "start": "node src/server.js", "migrate": "node src/migrate.js" },
     "dependencies": { "express": "^5.1.0", "pg": "^8.16.0", "redis": "^5.8.0" }
   }
   EOF

   cat > src/server.js <<'EOF'
   import os from 'node:os';
   import express from 'express';
   import pg from 'pg';
   import { createClient } from 'redis';

   const { PORT = '3000', DATABASE_URL, REDIS_URL } = process.env;
   const pool = new pg.Pool({ connectionString: DATABASE_URL });
   const redis = createClient({ url: REDIS_URL });
   redis.on('error', (err) => console.error('redis error:', err.message));
   await redis.connect();

   const app = express();
   app.use(express.json());

   app.get('/healthz', (_req, res) => res.json({ status: 'ok', host: os.hostname() }));
   app.get('/readyz', async (_req, res) => {
     try {
       await pool.query('SELECT 1');
       await redis.ping();
       res.json({ status: 'ready' });
     } catch (err) {
       res.status(503).json({ status: 'not ready', error: err.message });
     }
   });
   app.get('/items', async (_req, res) => {
     const cached = await redis.get('items');
     if (cached) return res.set('x-cache', 'hit').json(JSON.parse(cached));
     const { rows } = await pool.query('SELECT id, name, created_at FROM items ORDER BY id');
     await redis.set('items', JSON.stringify(rows), { EX: 30 });
     res.set('x-cache', 'miss').json(rows);
   });
   app.post('/items', async (req, res) => {
     const { rows } = await pool.query('INSERT INTO items(name) VALUES ($1) RETURNING *', [req.body.name]);
     await redis.del('items');
     res.status(201).json(rows[0]);
   });

   const server = app.listen(Number(PORT), () => console.log(`shipit-api listening on ${PORT}`));
   process.on('SIGTERM', () => {
     console.log('SIGTERM received, shutting down');
     server.close(async () => { await pool.end(); await redis.quit(); process.exit(0); });
   });
   EOF

   cat > src/migrate.js <<'EOF'
   import pg from 'pg';
   const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
   await client.connect();
   await client.query(`CREATE TABLE IF NOT EXISTS items (
     id serial PRIMARY KEY,
     name text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`);
   console.log('migrations applied');
   await client.end();
   EOF
   ```

2. Generate a lockfile (inside a container, so you don't need Node on your Mac):

   ```bash
   docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only
   ```

3. Add the Dockerfile and `.dockerignore`:

   ```bash
   cat > Dockerfile <<'EOF'
   # syntax=docker/dockerfile:1
   FROM node:22-alpine AS base
   WORKDIR /app
   COPY package.json package-lock.json ./

   FROM base AS dev
   RUN npm ci
   COPY src ./src
   CMD ["node", "--watch", "src/server.js"]

   FROM base AS prod
   ENV NODE_ENV=production
   RUN npm ci --omit=dev && npm cache clean --force
   COPY --chown=node:node src ./src
   USER node
   EXPOSE 3000
   CMD ["node", "src/server.js"]
   EOF

   printf 'node_modules\n.git\n.env\nsecrets\n*.log\n' > .dockerignore
   printf 'POSTGRES_USER=shipit\nPOSTGRES_PASSWORD=shipit-dev-pw\nPOSTGRES_DB=shipit\n' > .env
   cp .env .env.example
   ```

4. Write `compose.yaml` yourself with these requirements, using the lesson as a reference:
   - services `api`, `migrate`, `db` (`postgres:18`), `cache` (`redis:8-alpine`);
   - `api` and `migrate` build the `dev` target (share it with a YAML anchor);
   - healthchecks on `db` (`pg_isready`), `cache` (`redis-cli ping`) and `api` (`/healthz`);
   - `api` waits for `db` and `cache` to be healthy and `migrate` to complete successfully;
   - Postgres data in a named volume at the correct path for 18+;
   - only `api` is published, on `127.0.0.1:3000`.

5. Validate and start:

   ```bash
   docker compose config -q && echo "compose.yaml is valid"
   docker compose up -d --wait
   docker compose ps -a
   ```

### Verify

```bash
curl -s localhost:3000/readyz                                             # {"status":"ready"}
curl -s -X POST localhost:3000/items -H 'content-type: application/json' -d '{"name":"keyboard"}'
curl -si localhost:3000/items | grep -i x-cache                           # miss
curl -si localhost:3000/items | grep -i x-cache                           # hit
docker compose logs migrate                                               # "migrations applied"
docker compose down && docker compose up -d --wait && curl -s localhost:3000/items   # data survived
```

`docker compose ps -a` shows `migrate` as `Exited (0)` and the others as `(healthy)`.

:::hint
- Inside `healthcheck.test` with `CMD-SHELL`, write `$${POSTGRES_USER}` so Compose passes a literal `$` to the container shell instead of interpolating at parse time.
- If `up --wait` fails, run `docker compose ps -a` and `docker compose logs <service>` for the one that isn't healthy.
:::

:::solution
```yaml
name: shipit

x-api-build: &api-build
  context: .
  target: dev

x-db-url: &db-url postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}

services:
  api:
    build: *api-build
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      PORT: "3000"
      DATABASE_URL: *db-url
      REDIS_URL: redis://cache:6379
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 10s
    restart: unless-stopped

  migrate:
    build: *api-build
    command: ["node", "src/migrate.js"]
    environment:
      DATABASE_URL: *db-url
    depends_on:
      db:
        condition: service_healthy
    restart: "no"

  db:
    image: postgres:18
    environment:
      POSTGRES_USER: ${POSTGRES_USER:?set POSTGRES_USER in .env}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: ${POSTGRES_DB:-shipit}
    volumes:
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
    restart: unless-stopped

  cache:
    image: redis:8-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

volumes:
  pgdata:
```

The `x-db-url` anchor holds a string, so both services get exactly the same connection string. All services join the default `shipit_default` network, which is why `db` and `cache` resolve by name.
:::

### Clean up

Keep the project for the next labs. To stop it: `docker compose down` (keeps data). To reset completely: `docker compose down -v --rmi local`.

## Lab 2: Interpolation, env precedence and `docker compose config`

:::meta
difficulty: easy
time: 20 min
:::

Goal: understand exactly where each variable comes from by inspecting the rendered model instead of guessing.

### Steps

Work in `~/docker-labs/shipit`.

1. Render the model and find the resolved `DATABASE_URL`:

   ```bash
   docker compose config | grep DATABASE_URL
   ```

2. Override from the shell and compare:

   ```bash
   POSTGRES_DB=override docker compose config | grep DATABASE_URL
   ```

3. Break the required variable:

   ```bash
   POSTGRES_PASSWORD= docker compose config
   ```

4. Add an `env_file` and see the precedence inside the container. Create `api.env` with `LOG_LEVEL=debug` and `PORT=4000`, add to the `api` service:

   ```yaml
   env_file:
     - path: ./api.env
       required: false
   ```

   then run:

   ```bash
   docker compose run --rm --no-deps api node -e 'console.log(process.env.LOG_LEVEL, process.env.PORT)'
   docker compose run --rm --no-deps -e LOG_LEVEL=warn api node -e 'console.log(process.env.LOG_LEVEL)'
   ```

5. Prove `.env` doesn't leak into containers by itself:

   ```bash
   docker compose run --rm --no-deps api node -e 'console.log(process.env.POSTGRES_PASSWORD ?? "not set")'
   ```

### Verify

- Step 2 shows `.../override`; shell beats `.env`.
- Step 3 fails with `required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD in .env`.
- Step 4 prints `debug 3000` (`environment` beats `env_file` for `PORT`) and then `warn` (`run -e` beats everything).
- Step 5 prints `not set`.

:::hint
Precedence inside the container, highest first: `run -e` → `environment` → `env_file` → image `ENV`. Interpolation: shell → `.env`.
:::

:::solution
The commands are the solution. The key mental split: `.env` and your shell feed **interpolation** of `${...}` in the YAML. Only `environment:` and `env_file:` put variables into containers. `POSTGRES_PASSWORD` reaches the `db` container only because `db.environment` references it.

Remove the `env_file` block and `api.env` afterwards (or keep it, it's harmless with `required: false`).
:::

### Clean up

```bash
rm -f api.env   # and remove the env_file block from compose.yaml
```

## Lab 3: Hot reload with `docker compose watch`

:::meta
difficulty: medium
time: 25 min
:::

Goal: edit code on your Mac and see the API reload in about a second, add a dependency and see an automatic rebuild, all without bind mounts.

### Steps

1. Add a `develop.watch` section to the `api` service:

   ```yaml
   develop:
     watch:
       - action: sync
         path: ./src
         target: /app/src
       - action: rebuild
         path: package.json
       - action: rebuild
         path: package-lock.json
   ```

2. Start watching (leave it running in one terminal):

   ```bash
   docker compose up --watch
   ```

3. In a second terminal, change the health response and curl it:

   ```bash
   sed -i '' "s/status: 'ok'/status: 'ok', version: 2/" src/server.js     # macOS sed
   sleep 2; curl -s localhost:3000/healthz
   ```

4. Add a dependency and watch the rebuild:

   ```bash
   docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only ms@2
   ```

   Then use it in `src/server.js` (`import ms from 'ms';` and add `uptime: ms(process.uptime() * 1000)` to the `/healthz` response).

5. Confirm the container has no bind mounts:

   ```bash
   docker inspect -f '{{json .Mounts}}' shipit-api-1
   ```

### Verify

- After step 3, the first terminal logs `Syncing ... after changes were detected` and `Restarting 'src/server.js'`, and curl shows `"version":2`.
- After step 4, the first terminal shows a rebuild and container recreation, and `/healthz` includes `uptime`.
- Step 5 prints `[]`.

:::hint
`sync` alone doesn't restart anything; the restart comes from `node --watch` in the dev image's `CMD`. If changes don't show up, check that `path` is relative to the compose file and that `target` matches `WORKDIR` + `src`.
:::

:::solution
The final `api` service gains:

```yaml
    develop:
      watch:
        - action: sync
          path: ./src
          target: /app/src
        - action: rebuild
          path: package.json
        - action: rebuild
          path: package-lock.json
```

How it works: Compose watches `./src` on macOS; on change it copies just the changed files into `/app/src` inside the container. `node --watch` sees the change and restarts the process. Changes to `package.json`/lockfile trigger `rebuild`: the `dev` stage runs `npm ci` inside Linux, so native modules match the container's architecture, and the container is recreated. No `node_modules` ever crosses the macOS file-sharing layer.

Stop watching with Ctrl+C (containers keep running; `docker compose down` to stop them).
:::

### Clean up

Ctrl+C in the watch terminal. Keep the project.

## Lab 4: Break & fix: the stack that won't come up

:::meta
difficulty: medium
time: 30 min
:::

Goal: diagnose a broken Compose project using only `docker compose config`, `ps -a`, `logs` and `inspect`.

### Steps

1. Create a separate broken copy:

   ```bash
   cp -R ~/docker-labs/shipit ~/docker-labs/shipit-broken && cd ~/docker-labs/shipit-broken
   cat > compose.yaml <<'EOF'
   name: shipit-broken

   services:
     api:
       build:
         context: .
         target: dev
       ports:
         - "127.0.0.1:3100:3000"
       environment:
         PORT: "3000"
         DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}
         REDIS_URL: redis://redis:6379
       depends_on: [db, cache]

     migrate:
       build:
         context: .
         target: dev
       command: ["node", "src/migrate.js"]
       environment:
         DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
       depends_on: [db]

     db:
       image: postgres:18
       environment:
         POSTGRES_USER: ${POSTGRES_USER}
         POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
         POSTGRES_DB: ${POSTGRES_DB}
       volumes:
         - pgdata:/var/lib/postgresql/data
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
         interval: 5s
         retries: 10

     cache:
       image: redis:8-alpine

   volumes:
     pgdata:
   EOF
   docker compose up -d
   sleep 15
   curl -s localhost:3100/readyz
   ```

2. Find and fix **five** problems. Some cause immediate failures, some are time bombs that bite later.

### Verify

After your fixes: `docker compose down -v && docker compose up -d --wait` succeeds, `curl -s localhost:3100/readyz` returns ready, a POST to `/items` works, and `docker inspect -f '{{json .Mounts}}' shipit-broken-db-1` shows only the named volume.

:::hint
Look for: a hostname that means the wrong thing inside a container; a service name that doesn't exist; a startup order that only orders start, not readiness (twice); and a volume path that doesn't match the Postgres 18 image. The healthcheck interpolation is a sixth, subtler one: it works here by luck. Why?
:::

:::solution
Problems:

1. `DATABASE_URL` uses `localhost` in `api`. Inside the api container, `localhost` is the api container. Use `db`.
2. `REDIS_URL` points to `redis`, but the service is named `cache`. `docker compose logs api` shows `getaddrinfo ENOTFOUND redis`. Use `redis://cache:6379`.
3. `api` uses short `depends_on`, so it starts before Postgres accepts connections and before migrations ran. Use `condition: service_healthy` for `db` (and add a healthcheck plus condition for `cache`), and `service_completed_successfully` for `migrate`.
4. `migrate` also uses short `depends_on: [db]`; it can run before Postgres is ready and fail with `ECONNREFUSED`. `docker compose ps -a` shows it `Exited (1)`. Use `condition: service_healthy`.
5. The volume is mounted at `/var/lib/postgresql/data`, but for `postgres:18` the data lives under `/var/lib/postgresql` (the image's `VOLUME`). Data goes to an anonymous volume; `docker inspect` shows two mounts. Mount `pgdata:/var/lib/postgresql`.

Bonus (6): the healthcheck uses `${POSTGRES_USER}`, which Compose interpolates at parse time from `.env`. It works only because the same values happen to be in `.env`. Use `$${POSTGRES_USER}` so the container's own environment is used, which stays correct if the db service's env is changed independently.

Fixed `api` and `migrate` sections:

```yaml
  api:
    build: { context: ., target: dev }
    ports: ["127.0.0.1:3100:3000"]
    environment:
      PORT: "3000"
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      REDIS_URL: redis://cache:6379
    depends_on:
      db: { condition: service_healthy }
      cache: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
  migrate:
    build: { context: ., target: dev }
    command: ["node", "src/migrate.js"]
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
    depends_on:
      db: { condition: service_healthy }
```

plus `volumes: [pgdata:/var/lib/postgresql]` and the `$$` healthcheck on `db`, and a `redis-cli ping` healthcheck on `cache`.

Diagnosis path you should have used: `docker compose ps -a` (which services exited, with which code) → `docker compose logs <svc>` (the actual error) → `docker compose config` (what the values resolved to) → `docker inspect` (mounts).
:::

### Clean up

```bash
docker compose down -v --rmi local; cd .. && rm -rf shipit-broken
```

## Lab 5: Profiles, a prod-like override and secrets

:::meta
difficulty: hard
time: 40 min
:::

Goal: keep one base file and derive a prod-like variant: production image target, no watch, no published DB, resource limits, the DB password as a Compose secret, and an optional admin UI behind a profile.

### Steps

Back in `~/docker-labs/shipit`.

1. Add an Adminer service under a `tools` profile:

   ```yaml
   adminer:
     image: adminer
     profiles: [tools]
     ports: ["127.0.0.1:8080:8080"]
     depends_on:
       db: { condition: service_healthy }
   ```

   Run `docker compose up -d` (no adminer), then `docker compose --profile tools up -d` and open http://localhost:8080 (server `db`, user/password from `.env`).

2. Make the app accept a password file. Add `src/config.js`:

   ```javascript
   import { readFileSync } from 'node:fs';
   export function databaseUrl() {
     if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
     const pw = readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim();
     const { DB_USER, DB_HOST = 'db', DB_NAME } = process.env;
     return `postgres://${DB_USER}:${encodeURIComponent(pw)}@${DB_HOST}:5432/${DB_NAME}`;
   }
   ```

   and use `databaseUrl()` instead of `process.env.DATABASE_URL` in `server.js` and `migrate.js`.

3. Create the secret file: `mkdir -p secrets && openssl rand -base64 24 > secrets/db_password.txt`.

4. Write `compose.prod.yaml` so that `docker compose -f compose.yaml -f compose.prod.yaml up -d --wait`:
   - builds the `prod` target for `api` and `migrate`;
   - removes the `develop` section and `DATABASE_URL` from `api`/`migrate`, uses `DB_USER`, `DB_NAME`, `DB_PASSWORD_FILE` instead;
   - gives `db` the password via `POSTGRES_PASSWORD_FILE` and a secret, and removes `POSTGRES_PASSWORD` from its environment;
   - limits `api` to 0.5 CPU and 256 MB memory;
   - uses a separate project name or volume so it doesn't reuse the dev database (the password differs!).

5. Inspect the merged model with `docker compose -f compose.yaml -f compose.prod.yaml config` before running it.

### Verify

```bash
docker compose -p shipit-prod -f compose.yaml -f compose.prod.yaml up -d --wait
curl -s localhost:3000/readyz                                       # ready
docker inspect shipit-prod-api-1 -f '{{.Config.User}}'              # node
docker inspect shipit-prod-api-1 -f '{{range .Config.Env}}{{println .}}{{end}}' | grep -i pass   # only DB_PASSWORD_FILE
docker compose -p shipit-prod exec api cat /run/secrets/db_password  # the secret is a file
docker stats --no-stream shipit-prod-api-1                          # MEM LIMIT 256MiB
```

:::hint
- To remove a key in an override, use `!reset`: `DATABASE_URL: !reset null` inside `environment`, or `develop: !reset {}`.
- `-p shipit-prod` gives you separate containers, networks and volumes (`shipit-prod_pgdata`).
- Stop the dev stack first (`docker compose down`) since both publish port 3000.
:::

:::solution
```yaml
# compose.prod.yaml
secrets:
  db_password:
    file: ./secrets/db_password.txt

x-prod-env: &prod-env
  DATABASE_URL: !reset null
  NODE_ENV: production
  DB_USER: ${POSTGRES_USER}
  DB_NAME: ${POSTGRES_DB}
  DB_PASSWORD_FILE: /run/secrets/db_password

services:
  api:
    build:
      target: prod
    environment: *prod-env
    secrets: [db_password]
    develop: !reset {}
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M

  migrate:
    build:
      target: prod
    environment: *prod-env
    secrets: [db_password]

  db:
    environment:
      POSTGRES_PASSWORD: !reset null
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
```

```bash
docker compose down
docker compose -p shipit-prod -f compose.yaml -f compose.prod.yaml config | less
docker compose -p shipit-prod -f compose.yaml -f compose.prod.yaml up -d --build --wait
```

Notes:
- The base file still requires `POSTGRES_PASSWORD` for interpolation (`:?`), so keep it in `.env` or relax the guard; in a real setup the base would not contain secrets at all.
- The official postgres image reads `POSTGRES_PASSWORD_FILE`; your app reads `DB_PASSWORD_FILE`. The secret never appears in `docker inspect` env output.
- In the prod stage the container runs as `node`; the secret file must be readable by that user. With file-based secrets Compose bind-mounts the file, so its host permissions apply; `chmod 644 secrets/db_password.txt` if you get `EACCES`, and keep the directory itself out of git.
:::

### Clean up

```bash
docker compose -p shipit-prod down -v --rmi local
```

## Lab 6: Challenge: scale the API behind nginx

:::meta
difficulty: hard
time: 35 min
:::

Goal: run three API replicas behind an nginx reverse proxy that's the only published service, and show requests being spread across replicas.

### Requirements

- Add a `proxy` service (`nginx:alpine`) that publishes `127.0.0.1:8000:80` and proxies to `api:3000`. Deliver its config with a Compose `configs:` entry (not a bind mount in `volumes:`).
- `api` must no longer publish a host port (use `!reset` in an override file `compose.scale.yaml`, or edit the base).
- `docker compose -f compose.yaml -f compose.scale.yaml up -d --scale api=3 --wait` works.
- `for i in $(seq 1 9); do curl -s localhost:8000/healthz; echo; done` shows at least two different `host` values.
- Explain in one sentence why nginx must be restarted (or configured with a resolver) after you change the replica count.

:::hint
`proxy` should `depends_on: api` with `condition: service_healthy`. nginx resolves `api` when it loads its config; with three replicas the embedded DNS returns three IPs and nginx round-robins across them.
:::

:::solution
```text
# nginx/default.conf
upstream shipit_api {
    server api:3000;
}
server {
    listen 80;
    location / {
        proxy_pass http://shipit_api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```yaml
# compose.scale.yaml
services:
  api:
    ports: !reset []
  proxy:
    image: nginx:alpine
    ports: ["127.0.0.1:8000:80"]
    configs:
      - source: nginx_conf
        target: /etc/nginx/conf.d/default.conf
    depends_on:
      api: { condition: service_healthy }
configs:
  nginx_conf:
    file: ./nginx/default.conf
```

```bash
mkdir -p nginx   # then create nginx/default.conf as above
docker compose down
docker compose -f compose.yaml -f compose.scale.yaml up -d --scale api=3 --wait
for i in $(seq 1 9); do curl -s localhost:8000/healthz; echo; done
docker compose -f compose.yaml -f compose.scale.yaml exec proxy nslookup api 127.0.0.11
```

Why the restart: open-source nginx resolves upstream hostnames once at startup, so it only knows the IPs that existed then. After `--scale api=5` it keeps sending to the original three until reloaded (`docker compose restart proxy`). Alternatives: `resolver 127.0.0.11 valid=10s;` with a variable in `proxy_pass`, or a proxy that watches Docker (Traefik).

Note that the proxy is now the only service with a published port, and `api` replicas no longer fight over host port 3000.
:::

### Clean up

```bash
docker compose -f compose.yaml -f compose.scale.yaml down -v --rmi local
```
