A dense reference for daily Docker, Compose and buildx work. `<c>` = container, `<img>` = image, `<svc>` = Compose service.

## Contexts, info and system

| Command | What it does |
| --- | --- |
| `docker version` / `docker info` | Client/server versions; daemon config, storage driver, security options |
| `docker context ls` / `docker context use <name>` | List/switch engines (Docker Desktop, OrbStack, Colima, remote) |
| `docker system df [-v]` | Disk usage by images, containers, volumes, build cache |
| `docker system events` / `docker events --since 10m` | Daemon event stream (create, start, die, oom, kill, health_status) |
| `docker login ghcr.io -u <user> --password-stdin` | Log in to a registry (token on stdin) |

## Running containers

```bash
docker run -d --name api -p 127.0.0.1:3000:3000 -e NODE_ENV=production --restart unless-stopped img:tag
docker run --rm -it --entrypoint sh img:tag          # shell instead of the default command
docker run --rm --platform linux/amd64 img uname -m   # force a platform (emulated on Apple Silicon)
docker run --init ...                                # tini as PID 1: forwards signals, reaps zombies
docker run --env-file .env ...                       # env vars from a file
docker run -w /app -v "$PWD":/app node:22-alpine npm test
```

| Flag | Meaning |
| --- | --- |
| `-d` / `--rm` / `-it` | Detached / remove on exit / interactive TTY |
| `-p host:ctr`, `-p 127.0.0.1:h:c`, `-p c`, `-P` | Publish all interfaces / localhost only / random host port / all `EXPOSE`d |
| `-e K=V`, `--env-file f` | Environment |
| `--name`, `--hostname`, `--label k=v` | Identity and metadata |
| `--network n`, `--network-alias a` | Attach to network, extra DNS name |
| `--restart no\|on-failure[:N]\|always\|unless-stopped` | Restart policy |
| `--memory 256m --cpus 0.5 --pids-limit 200` | Resource limits |
| `--user 1000:1000` | Run as UID:GID |
| `--entrypoint`, args after image | Override ENTRYPOINT / CMD |
| `--stop-timeout 20` | Grace period before SIGKILL |

## Container lifecycle

| Command | What it does |
| --- | --- |
| `docker ps [-a] [-q] [--filter status=exited]` | List containers |
| `docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'` | Custom columns |
| `docker start\|stop\|restart <c>` | Lifecycle (`stop` = SIGTERM, then SIGKILL after 10 s) |
| `docker kill [-s HUP] <c>` | Send a signal (default SIGKILL) |
| `docker rm [-f] <c>` / `docker container prune` | Remove one / all stopped |
| `docker exec -it <c> sh` / `docker exec -u 0 <c> id` | Run in a running container / as root |
| `docker logs -f --since 10m -n 100 --timestamps <c>` | Logs |
| `docker cp <c>:/path ./local` / `docker cp ./f <c>:/path` | Copy files (works on stopped containers) |
| `docker wait <c>` | Block until exit, print exit code |
| `docker update --memory 512m --restart always <c>` | Change limits/policy live |
| `docker rename old new` | Rename |

## Inspecting and debugging

```bash
docker inspect -f '{{.State.Status}} {{.State.ExitCode}} OOM={{.State.OOMKilled}}' <c>
docker inspect -f '{{json .State.Health}}' <c> | jq
docker inspect -f '{{json .Mounts}}' <c> | jq
docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\n"}}{{end}}' <c>
docker inspect -f '{{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} caps={{.HostConfig.CapDrop}}' <c>
docker stats [--no-stream]          # CPU, mem/limit, net, block IO, PIDs
docker top <c>                      # processes
docker diff <c>                     # writable-layer changes (A/C/D)
docker port <c>                     # published ports
docker debug <c|img>                # toolbox shell (Docker Desktop, paid)
docker run --rm -it --network container:<c> --pid container:<c> nicolaka/netshoot
```

| Exit code | Meaning |
| --- | --- |
| 0 | Finished OK (is the CMD a foreground server?) |
| 1 | App error: read logs |
| 125 | docker run / daemon error |
| 126 | Not executable (permissions, directory) |
| 127 | Not found (typo, missing binary, bad shebang, CRLF) |
| 137 | SIGKILL: OOMKilled, `docker kill`, stop timeout |
| 139 | SIGSEGV: native crash, arch/libc mismatch |
| 143 | SIGTERM: stopped without handling it |

## Images

| Command | What it does |
| --- | --- |
| `docker pull img:tag [--platform linux/amd64]` | Pull |
| `docker images` / `docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}'` | List |
| `docker image inspect -f '{{.Os}}/{{.Architecture}}' img` | Platform of a local image |
| `docker history --no-trunc img` | Layers and the commands that made them |
| `docker tag src:tag ghcr.io/me/app:1.0.0` | Add a tag |
| `docker push ghcr.io/me/app:1.0.0` | Push |
| `docker rmi img` / `docker image prune [-a] [--filter until=168h]` | Remove one / dangling (all unused with `-a`) |
| `docker save img -o img.tar` / `docker load -i img.tar` | Export/import image tarballs |
| `docker scout quickview\|cves\|recommendations img` | Vulnerability analysis (Docker Scout) |
| `trivy image --severity HIGH,CRITICAL --ignore-unfixed img` | Scan (Trivy) |

## Building (BuildKit / buildx)

```bash
docker build -t app:dev .                                  # default builder
docker build --target dev -t app:dev .                     # stop at a stage
docker build --build-arg NODE_VERSION=22 --progress=plain --no-cache .
docker build --secret id=npmrc,src=$HOME/.npmrc .          # RUN --mount=type=secret,id=npmrc,target=/root/.npmrc
docker build --ssh default .                               # RUN --mount=type=ssh
docker build -f docker/Dockerfile.prod --pull .            # other Dockerfile, refresh base image

docker buildx ls                                           # builders and supported platforms
docker buildx create --name multi --driver docker-container --use --bootstrap
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/me/app:1.0.0 --push .
docker buildx build --sbom=true --provenance=mode=max --push -t ghcr.io/me/app:1.0.0 .
docker buildx build --cache-from type=registry,ref=ghcr.io/me/app:cache \
                    --cache-to type=registry,ref=ghcr.io/me/app:cache,mode=max --push .
docker buildx build --metadata-file meta.json ...          # digest in meta.json
docker buildx imagetools inspect ghcr.io/me/app:1.0.0      # platforms, digests, attestations
docker buildx imagetools create -t me/app:latest me/app:1.0.0   # retag remotely
docker buildx du / docker builder prune [--all] [--filter until=168h]
docker buildx history ls                                   # recent builds (timings, errors)
docker init                                                # scaffold Dockerfile, compose.yaml, .dockerignore
```

### Dockerfile quick reference

| Instruction | Notes |
| --- | --- |
| `# syntax=docker/dockerfile:1` | First line: latest stable Dockerfile frontend |
| `FROM [--platform=$BUILDPLATFORM] img AS name` | Stage; `$BUILDPLATFORM`/`$TARGETPLATFORM`/`$TARGETARCH` are predefined |
| `ARG NAME=default` | Build-time variable (visible in history: never secrets) |
| `ENV K=V` | Runtime env baked into the image |
| `WORKDIR /app` | Create and cd |
| `COPY [--from=stage] [--chown=u:g] [--chmod=755] src dst` | Copy files (prefer over `ADD`) |
| `RUN --mount=type=cache,target=/root/.npm npm ci` | Cache mount, not stored in the layer |
| `USER node` | Drop root |
| `EXPOSE 3000` | Documentation only |
| `HEALTHCHECK CMD ...` | Health status for Docker/Compose |
| `ENTRYPOINT ["exe"]` + `CMD ["args"]` | Exec form; `CMD` is the overridable default |
| `LABEL org.opencontainers.image.source=...` | OCI metadata |

## Volumes and mounts

```bash
docker volume create pgdata && docker volume ls && docker volume inspect pgdata
docker run -v pgdata:/var/lib/postgresql postgres:18                 # named volume (postgres 18+ path)
docker run --mount type=volume,src=pgdata,dst=/var/lib/postgresql postgres:18
docker run --mount type=bind,src="$PWD/conf",dst=/etc/app,readonly app   # fails if src missing (good)
docker run -v "$PWD/conf":/etc/app:ro app                                # creates src dir if missing
docker run --tmpfs /tmp:rw,noexec,nosuid,size=64m app
docker run --rm -v pgdata:/data:ro -v "$PWD":/backup alpine tar czf /backup/pgdata.tgz -C /data .   # backup
docker run --rm -v pgdata2:/data -v "$PWD":/backup alpine tar xzf /backup/pgdata.tgz -C /data        # restore
docker volume prune            # unused anonymous volumes only
docker volume prune --all      # + unused NAMED volumes (careful)
```

## Networking

```bash
docker network ls
docker network create shipit                         # user-defined bridge (DNS at 127.0.0.11)
docker network create --internal data                # no external access
docker network inspect shipit
docker network connect [--alias db] shipit <c>
docker network disconnect shipit <c>
docker run --network host ...                        # share host stack (Linux)
docker run --network none ...                        # loopback only
docker run --add-host=host.docker.internal:host-gateway ...   # reach the host on Linux
docker run --rm --network shipit nicolaka/netshoot dig +short db
docker run --rm --network container:<c> nicolaka/netshoot ss -ltnp
docker network prune
```

## Security flags

```bash
docker run --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --memory 256m --cpus 0.5 --pids-limit 200 img
```

| Never (for apps) | Why |
| --- | --- |
| `--privileged` | All caps, all devices, no seccomp/AppArmor |
| `-v /var/run/docker.sock:...` | Daemon control = host root |
| `--cap-add SYS_ADMIN` | Near-root powers |
| `--security-opt seccomp=unconfined` | Removes syscall filtering |
| Secrets in `ENV`/`ARG`/`COPY` | Visible in history, inspect and layers |

## Docker Compose

```bash
docker compose up -d [--build] [--wait] [svc...]     # create/update and start
docker compose up --watch / docker compose watch     # hot reload via develop.watch
docker compose ps [-a]                               # status, health, ports
docker compose logs -f [--since 10m] [svc]
docker compose exec svc sh
docker compose run --rm [--no-deps] [--service-ports] svc cmd   # one-off container
docker compose build [--no-cache] [svc] / docker compose pull
docker compose restart|stop|start [svc]
docker compose down [-v] [--rmi local] [--remove-orphans]       # -v deletes named volumes!
docker compose config [-q] [--services|--volumes|--profiles]    # rendered model / validate
docker compose top / docker compose events / docker compose ls
docker compose up -d --scale api=3
docker compose --profile tools up -d                 # or COMPOSE_PROFILES=tools
docker compose -f compose.yaml -f compose.prod.yaml up -d       # or COMPOSE_FILE=a.yaml:b.yaml
docker compose -p shipit-prod ...                    # project name
```

### compose.yaml essentials

```yaml
name: shipit
services:
  api:
    build: { context: ./api, target: dev }      # or image: ghcr.io/me/api:1.0.0
    ports: ["127.0.0.1:3000:3000"]
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD:?required}@db:5432/shipit
    env_file: [{ path: ./api.env, required: false }]
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 10s
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    tmpfs: ["/tmp"]
    secrets: [db_password]                     # /run/secrets/db_password
    deploy: { resources: { limits: { cpus: "0.5", memory: 256M, pids: 200 } } }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    networks: [edge, data]
    profiles: [optional-profile]               # only with --profile
    develop:
      watch:
        - { action: sync, path: ./api/src, target: /app/src }
        - { action: rebuild, path: ./api/package.json }
  db:
    image: postgres:18
    volumes: [pgdata:/var/lib/postgresql]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"], interval: 5s, retries: 10 }
volumes: { pgdata: {} }
networks: { edge: {}, data: { internal: true } }
secrets: { db_password: { file: ./secrets/db_password.txt } }
```

| Concept | Rule |
| --- | --- |
| `.env` | Interpolation only (`${VAR}`), not injected into containers |
| Interpolation | `${V:-default}`, `${V:?error}`, `$$` = literal `$` |
| Env precedence (container) | `run -e` > `environment` > `env_file` > image `ENV` |
| Override merge | Scalars replaced, maps merged, lists like `ports` combined; `!reset` / `!override` to change |
| Watch actions | `sync`, `rebuild`, `sync+restart`, `restart`, `sync+exec` |
| `depends_on` conditions | `service_started`, `service_healthy`, `service_completed_successfully` |

## Logs and cleanup

```bash
# /etc/docker/daemon.json (Docker Desktop: Settings → Docker Engine); applies to new containers
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }

docker container prune -f
docker image prune -a -f --filter until=720h
docker builder prune -f --filter until=168h
docker network prune -f
docker system prune                 # stopped containers, unused networks, dangling images, build cache
docker system prune -a --volumes    # nuclear: everything unused incl. anonymous volumes
```

## Mac-specific

| Topic | Note |
| --- | --- |
| Architecture | Apple Silicon = `linux/arm64`; amd64-only images run emulated (slower) |
| Bind mounts | Cross the VM via VirtioFS: keep `node_modules` in the container; prefer `compose watch` |
| Ports | Published ports bind on macOS; use `127.0.0.1:` to keep them off your Wi-Fi |
| Host access | `host.docker.internal` resolves to your Mac |
| Container IPs | `172.x` addresses aren't routable from macOS (except OrbStack) |
| Resources | VM CPU/memory/disk limits are set in Docker Desktop / OrbStack / Colima settings |
