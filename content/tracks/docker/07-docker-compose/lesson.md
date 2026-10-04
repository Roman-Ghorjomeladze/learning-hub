In modules 05 and 06 you wired volumes and networks with long `docker run` commands. That doesn't scale past two containers and it isn't reviewable. **Docker Compose** lets you declare the whole application (services, images or builds, networks, volumes, config and startup order) in one `compose.yaml`, then bring it up with one command. It's the standard for local development, CI integration tests and small single-host deployments.

## The mental model: a declarative project

Compose is a **client-side tool** (the `docker compose` CLI plugin, written in Go). It reads your YAML, builds an in-memory model, and talks to the Docker Engine API to create exactly the same objects you created by hand: containers, networks, volumes. There's no Compose daemon and nothing Compose-specific on the server, just **labels** on objects (`com.docker.compose.project=shipit`, `com.docker.compose.service=api`) that Compose uses to find what it owns.

```text
 compose.yaml ─┐
 compose.override.yaml ─┼─▶ docker compose (CLI) ──merge + interpolate──▶ model
 .env ─────────┘                                        │
                                                        ▼ Engine API
            ┌──────────────── project "shipit" ─────────────────────┐
            │ network shipit_default    volume shipit_pgdata        │
            │ containers: shipit-api-1  shipit-db-1  shipit-cache-1 │
            └───────────────────────────────────────────────────────┘
```

Key ideas:

- **Project**: a name (default: the directory name, or `name:` in the file, or `-p`) that namespaces everything. Two checkouts in different directories don't collide.
- **Service**: a template for one or more identical containers (`api`, `db`). Containers are named `<project>-<service>-<n>`.
- **Desired state**: `docker compose up` is idempotent. It compares the model with what's running (using a config hash label) and recreates only containers whose configuration changed.
- **Default network**: every project gets a user-defined bridge `<project>_default`; every service joins it and is resolvable by **service name** via the embedded DNS you met in module 06.

:::info Compose versions and the file name
Use `docker compose` (with a space). The old Python `docker-compose` v1 is end-of-life. The Go plugin was "Compose v2" for years; in 2025 it jumped to **v5** (skipping 3 and 4 to avoid confusion with the legacy file-format versions). v5 is functionally the same as v2 and adds an official Go SDK, so anything written for "Compose v2" applies. Check yours with `docker compose version`. The preferred file name is `compose.yaml` (`docker-compose.yml` still works). The top-level `version:` key is obsolete and ignored; leave it out. Compose implements the open **Compose Specification**.
:::

## The shipit stack

Throughout this module you'll build this:

```text
                 ┌───────────── network: edge ─────────────┐
 Mac :3000 ─────▶│  api (Node 22, Express)                 │
                 └──────┬──────────────────────────────────┘
                        │   network: data (internal)
            ┌───────────┼──────────────────────────┐
            │  migrate (one-off job) ──▶ db (postgres:18) ◀── volume pgdata
            │                          cache (redis:8)      │
            └──────────────────────────────────────────────┘
 startup order:  db healthy ─▶ migrate completed ─▶ api starts ─▶ api healthy
                 cache healthy ─┘
```

Here's the complete `compose.yaml`. The rest of the lesson explains each part.

```yaml
name: shipit

x-api-build: &api-build      # extension field + YAML anchor: shared build config
  context: .
  target: dev

services:
  api:
    build: *api-build
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      PORT: "3000"
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
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
    networks: [edge, data]
    develop:
      watch:
        - action: sync
          path: ./src
          target: /app/src
        - action: rebuild
          path: package.json

  migrate:
    build: *api-build
    command: ["node", "src/migrate.js"]
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
    depends_on:
      db:
        condition: service_healthy
    restart: "no"
    networks: [data]

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
    networks: [data]

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
    restart: unless-stopped
    networks: [data]

  adminer:
    image: adminer
    profiles: [tools]
    ports:
      - "127.0.0.1:8080:8080"
    networks: [edge, data]

volumes:
  pgdata:
  redisdata:

networks:
  edge: {}
  data:
    internal: true
```

## Services: `image` vs `build`

A service either pulls an **image** or **builds** one (or both: build it and tag it with that name).

```yaml
api:
  build:
    context: .                # sent to BuildKit, honours .dockerignore
    dockerfile: Dockerfile    # default
    target: dev               # multi-stage target (module 04)
    args:
      NODE_VERSION: "22"
    platforms: [linux/amd64, linux/arm64]   # used by `docker compose build` with a multi-platform builder
    cache_from: [type=registry,ref=ghcr.io/roma/shipit-api:cache]
  image: shipit-api:dev       # name/tag for the built image
```

`docker compose up` builds images that don't exist yet; it does **not** rebuild on code changes unless you pass `--build` (or use `watch`). `docker compose build` builds explicitly; `docker compose pull` refreshes `image:`-only services.

In the shipit file, `migrate` reuses the same build configuration through a YAML anchor (`*api-build`) and just overrides `command`. BuildKit's cache makes the second build instant. Top-level keys starting with `x-` are **extension fields**: Compose ignores them, so they're the conventional place to put anchors you reuse.

:::warning Don't point one service at an image another service builds
It's tempting to write `image: shipit-api:dev` on `migrate` with no `build:`. Compose pulls images for services without `build` *before* it builds the others, so on a clean machine it tries to pull `shipit-api:dev` from Docker Hub and fails. Give every service that needs a locally built image its own `build:` (anchors keep it DRY).
:::

## Ports, expose and container-to-container traffic

`ports` publishes to the host exactly like `-p` (module 06). Quote them: YAML 1.1 parses some `xx:yy` values as base-60 numbers.

```yaml
ports:
  - "127.0.0.1:3000:3000"       # host-only, recommended in dev
  - "9229:9229"                 # Node inspector, if you need it
```

Services talk to each other over the project networks by **service name and container port**: `db:5432`, `cache:6379`. Don't publish Postgres or Redis unless you want to reach them from your Mac, and then bind to `127.0.0.1`.

## Environment variables: three different mechanisms

This is the most confused part of Compose. There are **two separate jobs**:

1. **Interpolation**: substituting `${VAR}` in the YAML itself, at parse time, on your machine.
2. **Container environment**: variables set inside the running container (`environment`, `env_file`).

```text
  shell env ─┐
  .env file ─┼─▶ interpolation of ${...} in compose.yaml ─▶ final model
             │                                                  │
             │                    environment: / env_file: ─────┴─▶ process.env in the container
```

### `.env` (interpolation only)

A file named `.env` in the project directory is read automatically **for interpolation**. Its variables are *not* injected into containers unless you reference them.

```ini
# .env  (commit a .env.example, not this file)
POSTGRES_USER=shipit
POSTGRES_PASSWORD=change-me
POSTGRES_DB=shipit
COMPOSE_PROFILES=
```

Interpolation syntax:

| Syntax | Meaning |
| --- | --- |
| `${VAR}` | Value, or empty string with a warning if unset |
| `${VAR:-default}` | Default if unset **or empty** |
| `${VAR-default}` | Default only if unset |
| `${VAR:?message}` | Fail with message if unset or empty (use for required secrets) |
| `$$` | A literal `$`, passed to the container (see the `pg_isready` healthcheck) |

Precedence for interpolation: **shell environment > `.env` file** (or files passed with `--env-file`). So `POSTGRES_DB=test docker compose up` overrides `.env`.

### `environment` and `env_file` (container environment)

```yaml
api:
  environment:            # map or list form
    NODE_ENV: development
    LOG_LEVEL: ${LOG_LEVEL:-info}
  env_file:
    - path: ./api.env
      required: false     # Compose 2.24+: don't fail if missing
```

Precedence inside the container, highest first: `docker compose run -e` → `environment` → `env_file` → Dockerfile `ENV`.

:::warning Environment variables are not secrets
Anything in `environment` is visible in `docker inspect`, in `docker compose config` output, to every process in the container, and often in crash reports and logs. For local dev that's acceptable. For anything shared or production-like, use `secrets` (below).
:::

:::try See the final model
Run `docker compose config` in a project. It prints the fully merged and interpolated YAML, exactly what Compose will apply. Then try `POSTGRES_PASSWORD= docker compose config` and watch the `:?` guard fail with your message. `docker compose config --services`, `--volumes` and `--profiles` list names, handy in scripts.
:::

## Volumes and networks in Compose

Top-level `volumes:` declares named volumes; Compose prefixes them with the project name (`shipit_pgdata`). Service-level `volumes:` mounts them, or bind mounts, or tmpfs:

```yaml
services:
  api:
    volumes:
      - ./src:/app/src:ro                     # bind (path starts with . or /)
      - type: volume
        source: uploads
        target: /app/uploads
      - type: tmpfs
        target: /tmp
        tmpfs:
          size: 67108864
volumes:
  uploads:
  legacy-data:
    external: true          # created outside Compose; Compose won't create or delete it
    name: my-old-volume
```

Top-level `networks:` declares networks; services list which ones they join. If you specify `networks:` on a service, it **no longer joins `default`** automatically. In the shipit file, `db` and `cache` are only on the internal `data` network, so they can't be reached from the edge or the internet, and `api` bridges the two. Use `aliases` for extra DNS names:

```yaml
services:
  db:
    networks:
      data:
        aliases: [postgres]
```

## Startup order: `depends_on`, healthchecks and one-off jobs

`depends_on` in its short form (`depends_on: [db]`) only orders **container start**. Postgres takes a few seconds after its process starts before it accepts connections, so your API starts, fails to connect and crashes. The fix is a **healthcheck** on the dependency and a **condition** on the dependent:

```yaml
depends_on:
  db:
    condition: service_healthy                 # wait until db's healthcheck passes
    restart: true                              # restart api if db is restarted by Compose
  migrate:
    condition: service_completed_successfully  # wait until the one-off job exits 0
  cache:
    condition: service_started                 # the default for the short form
```

### Healthchecks

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
  interval: 5s          # time between checks
  timeout: 3s           # a check taking longer counts as failed
  retries: 10           # consecutive failures before "unhealthy"
  start_period: 10s     # failures during this grace period don't count
  start_interval: 1s    # check frequency during start_period (Engine 25+)
```

- `CMD` runs the program directly (exec form, no shell); `CMD-SHELL` runs through `/bin/sh -c` so you can use `||`, pipes and env vars.
- The check runs **inside** the container, so the tool must exist in the image. Slim images may lack `curl`/`wget`; for Node images, a `node -e "fetch(...)"` one-liner always works. Distroless images need a tiny health binary or a check built into the app.
- `docker compose ps` shows `(healthy)`, `(unhealthy)` or `(health: starting)`. `docker inspect --format '{{json .State.Health}}' <container>` shows the last outputs, which is where you debug a failing check.

:::tip Healthy is not the same as ready
A healthcheck in Compose (and Docker in general) does not route traffic or restart unhealthy containers by itself; it's a status. Compose uses it for `depends_on` and `up --wait`. In Kubernetes you'll split this into liveness, readiness and startup probes, which is why shipit has both `/healthz` and `/readyz`.
:::

### Migrations as a one-off service

Running migrations in the API's startup command works but races when you scale to several replicas. A dedicated `migrate` service with `restart: "no"` runs once, exits 0, and gates the API via `service_completed_successfully`. You can also run it on demand:

```bash
docker compose run --rm migrate              # one-off container, removed afterwards
docker compose run --rm api node src/seed.js # any command in a service's config
```

`docker compose run` doesn't publish the service's ports unless you add `--service-ports`, and it starts dependencies first.

## Restart policies

| Policy | Behaviour |
| --- | --- |
| `"no"` (default) | Never restart. Quote it: bare `no` is a YAML boolean. |
| `always` | Restart whenever it exits. If you stop it manually it stays stopped, but comes back when the daemon (or Docker VM) restarts |
| `on-failure[:N]` | Restart only on non-zero exit, optionally max N times |
| `unless-stopped` | Like `always`, but stays stopped across daemon restarts if you stopped it |

Restart policies are applied by the Docker Engine, not by Compose, so they also bring your stack back after the Docker VM restarts on your Mac.

## Profiles: optional services

Services with `profiles:` start only when their profile is active. Services without profiles always start.

```bash
docker compose up -d                          # api, migrate, db, cache
docker compose --profile tools up -d          # ...plus adminer
COMPOSE_PROFILES=tools,observability docker compose up -d
```

Good uses: admin UIs, seed jobs, load-test tools, a local Jaeger or Grafana, a mock of an external API. Explicitly naming a service (`docker compose up adminer`) also starts it regardless of profile.

## Multiple files and overrides

Compose automatically merges `compose.yaml` with **`compose.override.yaml`** if it exists. Use the base file for what's common and the override for local-dev tweaks. For other environments, pass files explicitly; later files override earlier ones:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d
# or
export COMPOSE_FILE=compose.yaml:compose.prod.yaml
```

Merge rules worth memorising:

- Single values (`image`, `command`, `restart`) are **replaced**.
- Maps (`environment`, `labels`, `healthcheck` keys) are **merged** key by key.
- Lists like `ports`, `expose`, `dns` are **combined**. You can't remove a port in an override by omitting it; use the `!reset` tag (`ports: !reset []`) or replace the whole value with `!override` (Compose 2.24+).
- Relative paths are resolved from the **first** file's directory.

A prod-like override for shipit:

```yaml
# compose.prod.yaml
services:
  api:
    build:
      target: prod
    image: ghcr.io/roma/shipit-api:${TAG:-latest}
    ports: !override
      - "3000:3000"
    environment:
      NODE_ENV: production
    develop: !reset {}
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
  migrate:
    build:
      target: prod
    image: ghcr.io/roma/shipit-api:${TAG:-latest}
```

`adminer` needs no change: it only runs when the `tools` profile is active.

`include:` (top level, Compose 2.20+) is the other composition tool: it imports another Compose project's file as a unit, with its own relative paths, which is useful when a platform team ships a `compose.yaml` for shared infrastructure.

```yaml
include:
  - ../platform/observability.compose.yaml
```

:::deep How Compose decides to recreate a container
Each container Compose creates carries a label `com.docker.compose.config-hash`, a hash of that service's resolved configuration. On `up`, Compose recomputes the hash; if it differs (an env var, port, image digest, mount, anything), the container is stopped and replaced; otherwise it's left alone. Dependent services may be recreated too. That's why editing a comment does nothing and editing an environment variable recreates exactly one service.

It also explains some surprises:
- Changing a file *inside* the build context doesn't change the hash, because Compose doesn't rebuild unless asked. Use `up --build` or `watch`.
- `--force-recreate` ignores the hash; `--no-recreate` never recreates.
- Orphans: if you rename or delete a service, its old container still carries the project label. `up --remove-orphans` (or `down --remove-orphans`) cleans those up.
- Everything Compose owns can be found with `docker ps --filter label=com.docker.compose.project=shipit`. Compose has no state file; the labels *are* the state.
:::

## Hot reload with `docker compose watch`

Bind-mounting your whole project for live reload has the problems from module 05: it hides `node_modules`, it's slow on macOS, and it puts host-architecture files into a Linux container. **Compose Watch** solves this by watching files on the host and applying rules:

| Action | What happens on change | Typical use |
| --- | --- | --- |
| `sync` | Copies changed files into the running container | Source files with an in-container watcher (`node --watch`, nodemon, Vite) |
| `rebuild` | Rebuilds the image and recreates the container | `package.json`, lockfile, Dockerfile |
| `sync+restart` | Syncs, then restarts the container | Config files read at startup (e.g. `nginx.conf`) |
| `restart` | Restarts the container | Changes that need a restart without syncing |
| `sync+exec` | Syncs, then runs a command in the container | Reload signals, cache busting |

```yaml
develop:
  watch:
    - action: sync
      path: ./src
      target: /app/src
      ignore:
        - "**/*.test.ts"
    - action: rebuild
      path: package.json
    - action: rebuild
      path: package-lock.json
```

```bash
docker compose watch          # start (if needed) and watch, with a compact log view
docker compose up --watch     # same, with the normal interleaved logs
```

With the dev image's command set to `node --watch src/server.js`, saving a file on your Mac syncs it into `/app/src` and Node restarts the process in under a second. Changing a dependency in `package.json` triggers a rebuild that runs `npm install` *inside* the Linux image, so native modules are compiled for the right architecture.

:::mac Why watch beats bind mounts on a Mac
Sync copies only the files that changed, so the container reads from its own fast filesystem. Paths matching `.dockerignore` are ignored automatically, which keeps `node_modules` and `.git` out of it. The container image must contain whatever the sync target needs, plus `stat` and `mkdir` for some actions; Alpine and Debian-based Node images are fine. Files are written as the container's `USER`, so that user must be able to write to the target.
:::

## Secrets and configs

**Secrets** are mounted as files under `/run/secrets/<name>` (a tmpfs-like mount, readable only by the container) instead of environment variables.

```yaml
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password   # many official images support *_FILE
    secrets:
      - db_password
  api:
    secrets:
      - source: db_password
        target: db_password
secrets:
  db_password:
    file: ./secrets/db_password.txt     # gitignored
  # or: environment: DB_PASSWORD          (value taken from your shell env)
```

Your app has to support reading from files. A small helper in shipit:

```javascript
import { readFileSync } from 'node:fs';
export const fromFileOrEnv = (name) =>
  process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : process.env[name];
```

**Configs** are the same idea for non-sensitive files (nginx config, feature flags). They mount at `/<config-name>` by default or wherever you set `target`:

```yaml
services:
  web:
    image: nginx:alpine
    configs:
      - source: nginx_conf
        target: /etc/nginx/conf.d/default.conf
configs:
  nginx_conf:
    file: ./nginx/default.conf
  feature_flags:
    content: |
      {"newCheckout": true}
```

:::warning Compose secrets on a single host are files, not a vault
With plain Compose, a file-based secret is bind-mounted from your disk. It keeps secrets out of `docker inspect`, the environment and image layers, which is a real improvement, but it's not encryption at rest. In production, use your platform's secret store (AWS Secrets Manager, SSM Parameter Store, Kubernetes Secrets with encryption, Vault) and inject at runtime. Build-time secrets are a different mechanism: BuildKit `--secret` (module 08).
:::

## Scaling

```bash
docker compose up -d --scale api=3
```

Each replica is a separate container (`shipit-api-1..3`), all resolvable as `api` through DNS round-robin. Two gotchas:

- A fixed host port (`3000:3000`) can only be bound once, so the second replica fails. Use a range (`"3000-3002:3000"`), no host port, or put a proxy (nginx, Traefik) in front that is the only published service.
- Don't set `container_name` on a scalable service; names must be unique.

`deploy.replicas` in the file does the same declaratively. `deploy.resources.limits` (CPU, memory) is honoured by Compose and is a good habit: it surfaces memory leaks locally before production does.

## Day-to-day commands

```bash
docker compose up -d                 # create/update and start in background
docker compose up -d --build api     # rebuild and recreate just api
docker compose up --wait             # block until services are running/healthy (great in CI)
docker compose ps                    # status, health, ports
docker compose ps -a                 # include exited one-off/job containers
docker compose logs -f api           # follow one service's logs (--since 10m, --tail 100)
docker compose exec api sh           # shell in the running container
docker compose run --rm migrate      # one-off job container
docker compose top                   # processes per container
docker compose restart api
docker compose stop / start
docker compose down                  # remove containers + networks (volumes kept)
docker compose down -v               # ...and named volumes declared in the file: DATA LOSS
docker compose down --rmi local      # ...and images built by this project
docker compose config                # render the final merged, interpolated model
docker compose ls                    # list running Compose projects on this machine
```

:::try Break the startup order on purpose
In the shipit stack, temporarily change the api's `depends_on` to the short form (`depends_on: [db, cache]`) and remove the migrate dependency, then `docker compose down -v && docker compose up`. Watch the API log `ECONNREFUSED` or `relation "items" does not exist` before Postgres is ready. Restore the conditions and repeat: the API now starts only after `db` is healthy and `migrate` exited 0.
:::

## Pitfalls and best practices

- **Commit `compose.yaml` and `.env.example`; gitignore `.env` and `secrets/`.**
- **Use `${VAR:?msg}`** for required values so missing config fails loudly at parse time.
- **Healthchecks on every stateful dependency**, and `condition: service_healthy` on dependents. Still make your app retry connections: in production, dependencies restart independently.
- **Bind published ports to `127.0.0.1`** in dev.
- **Never run `down -v` on a project whose data you care about.** Use `external: true` volumes for anything precious, so Compose never deletes them.
- **One process per container.** Don't run Postgres and the API in one service with a process manager.
- **Pin image tags** (`postgres:18`, better `postgres:18.x` or a digest in production), not `latest`.
- **Use `docker compose config` in CI** to validate files (`docker compose config -q` exits non-zero on errors).
- **Compose is great for single-host deployments** (a small VM, a homelab, internal tools). For multi-host scheduling, rolling updates and self-healing across machines, that's Kubernetes' job (next track).

## Summary

- Compose is a client that turns `compose.yaml` into Engine objects, tracked by labels, namespaced by project.
- `.env` and the shell feed **interpolation**; `environment`/`env_file` feed **containers**.
- Order startup with healthchecks + `depends_on` conditions; model migrations as a one-off service.
- Profiles toggle optional services; override files and `!reset`/`!override` adapt one base to many environments.
- `docker compose watch` gives fast, correct hot reload on a Mac without bind-mounting `node_modules`.
- Secrets mount as files under `/run/secrets`; configs mount non-sensitive files.
