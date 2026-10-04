You have probably typed `docker run -p 5432:5432 postgres` a hundred times. This module turns that habit into control: knowing which state a container is in and why, how its configuration is assembled, how signals reach your Node process, what an exit code tells you, and how to keep a laptop or server clean. Everything here maps directly to Kubernetes later — restart policies, resource limits, graceful shutdown and exit codes work the same way in pods.

## The lifecycle: states and transitions

```text
              docker create            docker start
   image ───────────────────► CREATED ─────────────► RUNNING ◄──────┐
                                  │                  │  │  ▲        │ restart policy
                                  │       docker pause│  │  │unpause │ (on-failure /
                                  │                  ▼  │  │        │  always / ...)
                                  │               PAUSED │  │        │
                                  │                     │  │        │
                                  │   process exits, docker stop,   │
                                  │   docker kill, OOM kill         │
                                  │                     ▼           │
                                  │                  EXITED ────────┘ (RESTARTING in between)
                                  │                     │ docker start (same container,
                                  │                     │  same writable layer)
                                  ▼    docker rm        ▼
                               (removed)  ◄──────── docker rm  (writable layer deleted)
```

- `docker run` = `docker create` + `docker start` (+ attach to output, unless `-d`).
- A container is **running as long as its main process (PID 1) runs**. When PID 1 exits, the container exits — regardless of other processes inside.
- **Exited** containers keep their writable layer, logs and configuration until `docker rm`. `docker start` restarts the *same* container; `docker run` always creates a *new* one.
- **Paused** freezes all processes using the cgroup freezer (no CPU, memory kept). Rarely used outside debugging.
- **Restarting** appears while a restart policy brings a container back. **Dead** means removal failed (rare; usually a busy mount).

```bash
docker ps                      # running only
docker ps -a                   # all, including exited
docker ps -a --format 'table {{.Names}}\t{{.State}}\t{{.Status}}'
docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' api
docker events --filter container=api   # live stream of create/start/die/oom/kill/destroy
```

## Anatomy of docker run

```text
docker run [OPTIONS] IMAGE[:TAG|@DIGEST] [COMMAND] [ARG...]
           └── how to run ─┘└── what ──────────┘└─ overrides the image's CMD ─┘
```

The most important options:

| Flag | Meaning |
| --- | --- |
| `-d`, `--detach` | Run in the background, print the container ID |
| `-i`, `--interactive` | Keep STDIN open (needed to pipe input or type into it) |
| `-t`, `--tty` | Allocate a pseudo-terminal (colours, line editing, Ctrl-C behaviour) |
| `--rm` | Remove the container automatically when it exits |
| `--name api` | Give it a stable name (otherwise random, e.g. `quirky_turing`) |
| `-p 3000:3000` | Publish a port |
| `-e KEY=value`, `--env-file` | Environment variables |
| `-v`, `--mount` | Volumes and bind mounts (covered in the storage module) |
| `--network` | Which network to attach to (covered in the networking module) |
| `--restart` | Restart policy |
| `--memory`, `--cpus`, `--pids-limit` | Resource limits |
| `-u 1000:1000` | Run as a specific user/group |
| `-w /app` | Working directory |
| `--entrypoint` | Override the image's `ENTRYPOINT` |
| `--init` | Run a tiny init (tini) as PID 1 |
| `-l`, `--label` | Metadata for filtering and tooling |

Typical combinations:

```bash
docker run --rm -it node:22-alpine sh             # throwaway interactive shell
docker run -d --name redis -p 6379:6379 redis:8-alpine   # long-running service
docker run --rm -v "$PWD":/work -w /work node:22-alpine npm test   # one-off task
echo '{"a":1}' | docker run --rm -i ghcr.io/jqlang/jq .a         # pipe data through a tool
```

:::tip `-it` only when a human is at the keyboard
`-t` changes how output is produced (CRLF line endings, no clean piping) and fails in CI with "the input device is not a TTY". Use `-it` for interactive shells, `-i` alone when piping input, and neither in scripts.
:::

## Ports

A container has its own network namespace, so a server listening on port 3000 inside is invisible from outside until you **publish** it:

| Syntax | Result |
| --- | --- |
| `-p 8080:3000` | Host port 8080 on **all interfaces** → container port 3000 |
| `-p 127.0.0.1:8080:3000` | Only reachable from the host itself |
| `-p 3000` | Random high host port → container 3000 (`docker port api 3000` tells you which) |
| `-p 5353:53/udp` | UDP |
| `-P` | Publish every port the image `EXPOSE`s to random host ports |

```bash
docker run -d --name web -p 127.0.0.1:8080:80 nginx:alpine
docker port web
```

- `EXPOSE` in a Dockerfile is **documentation** — it does not publish anything.
- The app inside must listen on `0.0.0.0` (all interfaces in its namespace), not `127.0.0.1`. A Node server bound to `localhost` inside a container is unreachable through a published port — a very common "connection reset" mystery.

:::warning Published ports bypass your expectations
By default `-p 5432:5432` binds to `0.0.0.0` — every interface of the host. On a Linux server, Docker's NAT rules are evaluated before many host firewall setups (e.g. ufw), so a "firewalled" database can be wide open. Bind to `127.0.0.1` for anything that should not be public, and on servers prefer not publishing database ports at all (use a private network between containers).
:::

## Environment variables

Configuration goes in through environment variables (twelve-factor style), matching how `shipit-api` reads `PORT`, `DATABASE_URL` and `REDIS_URL`:

```bash
# -e NODE_ENV (no value) copies NODE_ENV from your shell; it's omitted if unset there
# --env-file reads KEY=value lines
docker run --rm \
  -e PORT=3000 \
  -e DATABASE_URL=postgres://shipit:shipit@db:5432/shipit \
  -e NODE_ENV \
  --env-file .env.local \
  node:22-alpine node -e 'console.log(process.env.PORT, process.env.NODE_ENV)'
```

Precedence: image `ENV` < `--env-file` < `-e` (later flags win over earlier ones).

`--env-file` format is deliberately simple: `KEY=value` lines, `#` comments, **no quote processing and no variable expansion**. `GREETING="hello"` sets the value to `"hello"` *including the quotes* (Compose's `.env` handling is different — it strips quotes). This difference has broken many deployments.

:::warning Environment variables are not secret
Anyone who can run `docker inspect` sees every env var in plain text, they leak into crash reports and child processes, and they end up in shell history when passed with `-e`. Fine for local dev; in production use secret mounts (Compose/Swarm secrets, Kubernetes Secrets mounted as files, AWS Secrets Manager) and read files.
:::

## Restart policies

| Policy | Restarts when the process exits... | After daemon/VM restart | After `docker stop` |
| --- | --- | --- | --- |
| `no` (default) | never | not started | stays stopped |
| `on-failure[:N]` | only with a non-zero exit code (max N attempts) | started if it was running | stays stopped |
| `always` | always | started | **started again** when the daemon restarts |
| `unless-stopped` | always | started, unless you stopped it manually | stays stopped |

```bash
docker run -d --name worker --restart on-failure:5 my-worker
docker update --restart unless-stopped worker   # change it on an existing container
docker inspect -f '{{.RestartCount}} {{.HostConfig.RestartPolicy.Name}}' worker
```

- Restarts use an **increasing delay** (starting at 100 ms and doubling, reset after the container has run successfully for a while), so a crash-looping container doesn't spin the CPU. Kubernetes' `CrashLoopBackOff` is the same idea.
- A restart policy doesn't help if the container can't start at all (e.g. the command doesn't exist — `docker run` fails with 127), and it can't be combined with `--rm`.
- For a laptop dev database, `unless-stopped` is convenient. In production, the orchestrator (Kubernetes, ECS, systemd) should own restarts, not Docker's policy.

## Resource limits

Without limits, a container may use all the CPU and memory of the host (or VM). Module 01 showed these become cgroup files; here's the user's view:

```bash
# hard memory limit with no swap, a soft reservation, a CPU quota,
# fork-bomb protection and a higher open-files limit
docker run -d --name api \
  --memory 512m --memory-swap 512m \
  --memory-reservation 256m \
  --cpus 1.5 \
  --pids-limit 200 \
  --ulimit nofile=65536:65536 \
  shipit-api:dev

docker stats --no-stream api           # live usage vs limits
docker update --memory 768m --memory-swap 768m api   # change limits without recreating
```

When memory runs out, the kernel OOM-kills a process in the container: exit code **137**, `.State.OOMKilled = true`. With CPU limits, nothing is killed — the process is **throttled**.

:::info Sizing Node.js in a container
- Recent Node versions look at the cgroup memory limit when choosing the default V8 heap size, but the heap is only part of the process's memory: `Buffer`s, native addons, thread stacks and the code itself live outside it. Set the heap explicitly to leave headroom: `-e NODE_OPTIONS=--max-old-space-size=384` for a 512 MiB limit.
- `os.cpus().length` reports every CPU of the host, not your `--cpus` quota. Node ≥ 18.14 has `os.availableParallelism()`, but it also ignores CFS quotas. If you size worker pools (cluster mode, piscina, `UV_THREADPOOL_SIZE`), configure them explicitly from an env var.
:::

## Logs

Docker captures whatever PID 1 writes to **stdout and stderr** and hands it to a logging driver. Apps should log to stdout (JSON lines are ideal), not to files inside the container.

```bash
docker logs api                       # everything so far
docker logs -f --tail 100 api         # follow, starting with the last 100 lines
docker logs --since 10m -t api        # last 10 minutes, with timestamps
docker logs api 2>/dev/null           # stdout only (stderr goes to your stderr)
```

The default `json-file` driver stores logs on the host (VM) disk **without rotation** unless configured. A chatty container can fill the disk:

```bash
docker run -d --log-opt max-size=10m --log-opt max-file=3 shipit-api:dev
```

Or set defaults for the whole engine in `daemon.json` (Docker Desktop: Settings → Docker Engine):

```json
{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }
```

The `local` driver is compressed and rotated by default. In production, logs usually go to a collector (Fluent Bit, CloudWatch via `awslogs`, Loki) — on Kubernetes the node's container runtime writes them to files that an agent ships.

## exec, attach and cp

- **`docker exec`** starts a **new process** inside a running container's namespaces. It's how you debug:

```bash
docker exec -it api sh                       # shell (if the image has one)
docker exec api env                          # what env does the app really have?
docker exec -u root -w /tmp api ls -la       # as another user / in another directory
docker exec -e DEBUG=1 api node scripts/check.js
```

- **`docker attach`** connects your terminal to the **existing PID 1's** stdin/stdout/stderr. Ctrl-C sends SIGINT to PID 1 (it may stop the container!). Detach with **Ctrl-P Ctrl-Q** (only works with `-it` containers). Use attach for interactive programs started with `-it`; use exec for everything else.
- **`docker cp`** copies files between your machine and a container (running or stopped) — great for grabbing a heap dump or a generated report:

```bash
docker cp api:/app/heap.heapsnapshot .
docker cp ./fixtures.json api:/tmp/fixtures.json
```

Other observation tools: `docker top api` (processes), `docker stats` (live CPU/mem/net/IO), `docker port api`, `docker diff api` (filesystem changes), `docker wait api` (block until exit and print the code).

## inspect and format templates

`docker inspect` returns the full JSON for containers, images, networks and volumes. `--format` (or `-f`) takes a **Go template**:

```bash
docker inspect api                                               # full JSON
docker inspect -f '{{.State.Status}}' api
docker inspect -f '{{.Config.Image}} {{.Config.Cmd}}' api
docker inspect -f '{{json .Config.Env}}' api | jq
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' api
docker inspect -f '{{(index .NetworkSettings.Ports "3000/tcp" 0).HostPort}}' api
docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' api
docker inspect -f '{{index .Config.Labels "com.example.team"}}' api
```

The same template language works for listing commands:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker ps --format '{{json .}}' | jq -r '.Names'
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}'
```

:::tip Template or jq?
Templates are great for one field. For anything with filtering or arrays, pipe JSON into jq: `docker inspect api | jq '.[0].Mounts[] | {Source, Destination}'`.
:::

## Stopping: signals, PID 1 and graceful shutdown

```text
docker stop api            SIGTERM ──► wait up to 10 s ──► SIGKILL
docker stop -t 30 api      SIGTERM ──► wait up to 30 s ──► SIGKILL
docker kill api            SIGKILL immediately
docker kill -s SIGHUP api  any signal (e.g. reload config)
```

The stop signal can be changed with `STOPSIGNAL` in the Dockerfile or `--stop-signal`, the timeout with `--stop-timeout`. Kubernetes does the same: SIGTERM, wait `terminationGracePeriodSeconds` (default 30), then SIGKILL.

Three things commonly break graceful shutdown:

1. **PID 1 ignores unhandled signals.** A Node process that is PID 1 and has no `SIGTERM` listener does *not* terminate on SIGTERM. `docker stop` waits the full timeout and kills it — slow deploys and dropped requests.
2. **A shell in between.** Shell-form `CMD node dist/index.js` becomes `/bin/sh -c "node dist/index.js"`: the shell is PID 1 and (depending on the shell) doesn't forward SIGTERM to node. Use exec form: `CMD ["node", "dist/index.js"]`. Wrapper scripts must end with `exec node ...`.
3. **`npm start` as the command.** npm adds a process layer and has historically not forwarded signals reliably; it also adds startup time. Run `node` directly in containers.

`--init` puts **tini** in front of your process as PID 1. tini forwards signals to the child and reaps zombies. Your app is then not PID 1, so default signal actions apply again (an app without a handler dies on SIGTERM with exit code 143).

**Graceful shutdown in Node** means: stop accepting new connections, finish in-flight requests, close DB/Redis pools, exit with 0 — within the grace period:

```typescript
const server = app.listen(port);

function shutdown(signal: string) {
  console.log(`${signal} received, draining`);
  server.close(async () => {          // stops accepting; callback fires when connections end
    await pool.end();                  // Postgres
    await redis.quit();                // Redis
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();   // hard deadline < grace period
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));       // Ctrl-C in `docker run -it`
```

In NestJS, call `app.enableShutdownHooks()` and implement `OnApplicationShutdown`/`beforeApplicationShutdown` in providers.

:::deep Why PID 1 ignores signals
The kernel marks the init process of each PID namespace with `SIGNAL_UNKILLABLE`. Signals sent from *inside* the namespace to init are dropped unless init has installed a handler; signals from the parent namespace (like the runtime's SIGTERM) are also not given their default "terminate" action for the same reason — only `SIGKILL` and `SIGSTOP` are forced from the ancestor namespace. This protects the system from accidentally killing init on a real machine; in a container it means your app must opt in to handling signals. Node does install an internal SIGTERM/SIGINT handler, but it only restores terminal settings and then re-raises the signal with the default action — which, for PID 1, is "ignore". So unless your code registers `process.on("SIGTERM", ...)`, a bare `node server.js` running as PID 1 ignores `docker stop` and gets SIGKILLed after the timeout. The same process *not* running as PID 1 (e.g. under `--init`) dies on SIGTERM with exit code 143.

Zombie reaping is the second init duty: when a child exits, it stays in the process table until its parent calls `wait()`. Orphaned grandchildren are re-parented to PID 1. If PID 1 is your app and it spawns processes (e.g. `child_process.exec` of a shell that starts something in the background), zombies can pile up until `pids.max` is hit. tini (`--init`) or `dumb-init` solve both problems in ~20 KB.
:::

## Exit codes

| Code | Meaning | Typical cause |
| --- | --- | --- |
| `0` | Success | Normal exit, graceful shutdown |
| `1` | Application error | Uncaught exception, `process.exit(1)` |
| `125` | `docker run` itself failed | Unknown flag, port already allocated, invalid option |
| `126` | Command can't be executed | File not executable, permission denied |
| `127` | Command not found | Typo in `CMD`, binary missing from image, wrong `PATH` |
| `128 + n` | Killed by signal `n` | — |
| `130` | 128 + 2 (SIGINT) | Ctrl-C |
| `137` | 128 + 9 (SIGKILL) | OOM kill, `docker kill`, stop timeout exceeded |
| `139` | 128 + 11 (SIGSEGV) | Native crash (bad native module, emulation issue) |
| `143` | 128 + 15 (SIGTERM) | Terminated by SIGTERM without handling it (e.g. with `--init`) |

```bash
docker run --rm alpine sh -c 'exit 3'; echo "exit code: $?"      # 3
docker run --rm alpine nosuchcmd; echo $?                          # 127
docker run --rm --no-such-flag alpine true; echo $?                # 125
docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Error}}' api
```

:::try Read three exit codes
Run each, predict the code first, then check:

```bash
docker run --rm node:22-alpine node -e 'throw new Error("boom")'; echo $?
docker run --rm alpine /etc/passwd; echo $?
docker run -d --name sleepy alpine sleep 300 && docker kill sleepy && docker inspect -f '{{.State.ExitCode}}' sleepy; docker rm sleepy
```
:::

## Labels, filters and bulk operations

Labels are key/value metadata on containers, images, volumes and networks. They cost nothing and make automation and cleanup safe:

```bash
docker run -d --name api \
  --label com.example.project=shipit \
  --label com.example.env=dev \
  shipit-api:dev

docker ps --filter label=com.example.project=shipit
docker ps -a --filter status=exited --filter label=com.example.env=dev
docker ps --filter ancestor=nginx:alpine          # containers from an image
docker ps --filter name=api                       # name contains "api"
docker rm -f $(docker ps -aq --filter label=com.example.project=shipit)
```

Compose sets labels like `com.docker.compose.project` automatically — which is how `docker compose down` knows what to remove.

## Cleanup and prune

| Command | Removes |
| --- | --- |
| `docker container prune` | All stopped containers |
| `docker image prune` | Dangling images (untagged `<none>`) |
| `docker image prune -a` | All images not used by a container |
| `docker volume prune` | Unused **anonymous** volumes (add `-a` for named ones too) |
| `docker network prune` | Unused custom networks |
| `docker builder prune` | Build cache |
| `docker system prune` | Stopped containers, unused networks, dangling images, build cache |
| `docker system prune -a --volumes` | Everything unused, including images and volumes — the "nuke" |

```bash
docker system df                                   # what's taking space
docker container prune --filter until=24h          # stopped more than a day ago
docker image prune -a --filter label=com.example.project=shipit
```

:::warning Volumes hold your data
`docker volume prune -a` and `docker system prune --volumes` delete named volumes that no container currently uses — including the Postgres volume of a project whose containers you just removed. Prefer label-filtered prunes, and back up volumes you care about.
:::

:::try Clean up by label
```bash
for i in 1 2 3; do docker run -d --label lab=cleanup alpine sleep 600; done
docker run -d --name keep-me alpine sleep 600
docker ps --filter label=lab=cleanup --format '{{.ID}} {{.Labels}}'
docker rm -f $(docker ps -q --filter label=lab=cleanup)
docker ps --format '{{.Names}}'     # keep-me is still there
docker rm -f keep-me
```
:::

## Pitfalls and production habits

- **One process per container** (with `--init` if it spawns children). Use Compose or pods to run several cooperating processes.
- **Use exec-form `CMD`/`ENTRYPOINT` and run `node` directly.** Handle SIGTERM and finish well within the grace period.
- **Bind published ports to `127.0.0.1`** unless the service must be public.
- **Always set memory limits** in shared environments, and leave headroom over the V8 heap.
- **Rotate logs** (`local` driver or `max-size`) — unbounded json-file logs are a classic disk-full outage.
- **Never put secrets in `-e` for production**; mount them as files.
- **Label everything you create in scripts** so you can find and clean it up precisely.

## Summary

- `docker run` = create + start; a container lives as long as its PID 1.
- `-p host:container` publishes ports (bind to `127.0.0.1` when possible); `EXPOSE` is documentation.
- Configuration via `-e`/`--env-file` (no quote processing); env vars are visible to anyone who can inspect.
- Restart policies: `no`, `on-failure[:N]`, `always`, `unless-stopped`; with exponential back-off.
- Limits: `--memory` (OOM → 137), `--cpus` (throttling), `--pids-limit`; change live with `docker update`.
- `docker stop` = SIGTERM then SIGKILL after the timeout; PID 1 must handle SIGTERM or use `--init`; avoid shell form and `npm start`.
- Exit codes: 125/126/127 are startup problems, 128+n means killed by signal n.
- Label what you create; prune with filters; be careful with volumes.
