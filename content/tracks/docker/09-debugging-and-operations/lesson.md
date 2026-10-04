Every engineer who uses Docker seriously ends up with a mental runbook: "it exited with 137, so...", "exec format error means...". This module gives you that runbook up front, along with the tools to gather evidence quickly and the day-2 operations (logs, disk, monitoring) that keep a Docker host healthy.

## The debugging mindset: gather evidence in layers

Don't guess and rebuild. Work outside-in, from the cheapest evidence to the most invasive:

```text
 1. State      docker ps -a                      Is it running? Exited? Restarting? Exit code?
 2. Logs       docker logs --tail 100 <c>        What did the process say before it died?
 3. Config     docker inspect <c>                What was it actually started with? (cmd, env, mounts, net, limits)
 4. Events     docker events --since 10m         What did the daemon do? (oom, die, kill, health_status)
 5. Resources  docker stats / top                CPU, memory, PIDs right now
 6. Inside     docker exec / debug / netshoot    Look around in the container's namespaces
 7. Reproduce  docker run --rm -it --entrypoint sh <image>   Start the image by hand and run the command yourself
```

Most problems are solved by steps 1 to 3.

## Exit codes: the first clue

When the main process (PID 1) of a container ends, the container stops and records its exit code. `docker ps -a` shows `Exited (137) 2 minutes ago`; `docker inspect -f '{{.State.ExitCode}}' <c>` gives the number.

Codes above 128 mean "killed by signal *code − 128*".

| Code | Meaning | Typical causes | First checks |
| --- | --- | --- | --- |
| **0** | Process finished successfully | The command isn't a long-running server (e.g. `CMD ["node"]` with no script, a shell that ran and exited, a daemon that forked into the background) | What's the `CMD`? Does it stay in the foreground? |
| **1** | Generic application error | Uncaught exception, failed config validation, can't connect to DB at startup | `docker logs` |
| **125** | `docker run` itself failed | Bad flag, port already allocated, unknown network, invalid mount | The error printed by the CLI; the container may never have started |
| **126** | Command found but **can't be executed** | Script without exec permission, a directory, or wrong format | `ls -l` the entrypoint; `chmod +x` in the Dockerfile |
| **127** | Command **not found** | Typo in `CMD`, binary not in this image or not on `PATH`, script with a bad shebang (`#!/bin/bash` in Alpine), CRLF line endings | `docker run --rm -it --entrypoint sh <img>` then `which <cmd>` |
| **137** | SIGKILL (128+9) | **OOM killer** (memory limit), `docker kill`, or `docker stop` timed out (app ignored SIGTERM for 10 s) | `.State.OOMKilled`, `docker events`, stop timing |
| **139** | SIGSEGV (128+11) | Segfault in native code: incompatible native module (musl vs glibc, wrong arch), emulation bugs | Rebuild native deps for the target; try a glibc base (`-slim`) |
| **143** | SIGTERM (128+15) | Container was stopped and the process exited due to SIGTERM without handling it | Usually fine; for graceful shutdown, handle SIGTERM and exit 0 |

:::tip 137 has three causes, tell them apart
```bash
docker inspect -f 'OOMKilled={{.State.OOMKilled}} Exit={{.State.ExitCode}} Finished={{.State.FinishedAt}}' <c>
docker events --since 30m --filter container=<c>     # look for "oom" before "die", or "kill" signal=9
```
`OOMKilled=true` means the kernel killed it for exceeding its memory limit. A `kill` event with `signal=15` followed ~10 s later by `signal=9` means `docker stop` gave up waiting: your app ignores SIGTERM.
:::

## Playbook: the common failures

### Container exits immediately

1. `docker ps -a` → exit code. `docker logs <c>` → often the answer (missing env var, config error).
2. If the logs are empty, the process may not have started at all (126/127) or may have exited cleanly (0). Check `docker inspect -f '{{.Config.Entrypoint}} {{.Config.Cmd}}' <c>`.
3. Reproduce interactively with a shell instead of the real command:

   ```bash
   docker run --rm -it --entrypoint sh shipit-api:dev
   # inside: ls -l, env, which node, node src/server.js
   ```

4. For Compose: `docker compose ps -a` and `docker compose logs <service>`. A service that restarts in a loop shows `Restarting (1) 3 seconds ago`.

Classic causes: shell scripts edited on Windows (CRLF: `/bin/sh^M: not found`), `#!/bin/bash` in an Alpine image that only has `sh`, an `ENTRYPOINT` script that forgets `exec "$@"`, a server bound only after a failed DB connection.

### OOMKilled

Node has its own heap limit, separate from the container's memory limit. Recent Node versions take the container's cgroup memory limit into account when sizing the default heap, but the heap isn't the only memory (buffers, native modules, worker threads). If the container limit is 256 MB and the process grows past it, the kernel kills it instantly with no stack trace, exit 137.

```bash
docker run -d --name hog --memory 128m node:22-alpine node -e 'const a=[]; setInterval(()=>a.push(Buffer.alloc(10e6)),100)'
docker wait hog; docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' hog    # true 137
```

Fixes: raise the limit to what the app really needs (measure with `docker stats`), fix the leak, or cap the heap below the limit (`NODE_OPTIONS=--max-old-space-size=192` for a 256 MB container) so you get a JavaScript heap error with a stack trace instead of a silent kill.

:::mac The VM has its own memory ceiling
On a Mac, all containers share the Linux VM's memory (Docker Desktop: Settings → Resources; OrbStack and Colima manage it differently). Without a per-container `--memory` limit, a leaking container can exhaust the VM, and the OOM killer may pick a *different* container. If several containers die at once, check the VM's memory before blaming the app.
:::

### Container doesn't stop gracefully (slow `docker stop`, exit 137)

`docker stop` sends SIGTERM to PID 1, waits 10 seconds (`--time` / `stop_grace_period`), then sends SIGKILL. Two common reasons PID 1 ignores SIGTERM:

1. **PID 1 is a shell or npm**: `CMD npm start` (shell form) runs `/bin/sh -c "npm start"`; the shell doesn't forward signals to Node. Use exec form `CMD ["node", "dist/main.js"]`.
2. **PID 1 has no default signal handlers**: the kernel doesn't apply default actions (like "terminate on SIGTERM") to PID 1 in a namespace unless the process installs a handler. Node installs no SIGTERM handler unless your code registers one, so as PID 1 it simply ignores SIGTERM. Add a `process.on('SIGTERM', ...)` handler that closes the server, or run with `--init` (Docker injects `tini` as PID 1, which forwards signals and reaps zombies). Compose: `init: true`.

### Port not reachable

Covered in depth in module 06. The short checklist:

```text
docker ps            → PORTS shows 0.0.0.0:3000->3000/tcp?   (no mapping = not published)
docker logs          → "listening on 127.0.0.1"?             (must be 0.0.0.0)
docker port <c>      → right container port?
netshoot ss -ltn     → actually listening, on the expected port?   (--network container:<c>)
curl from a sibling  → works container-to-container but not from host? → publish/bind problem
```

### DNS issues

- Name doesn't resolve between containers → not on the same **user-defined** network, or wrong service name. `docker inspect -f '{{json .NetworkSettings.Networks}}' <c>`.
- External names fail inside containers but work on the host → corporate VPN/DNS, or the daemon picked up a resolver it can't reach. Test with `docker run --rm nicolaka/netshoot dig google.com` and `dig @1.1.1.1 google.com`. Set `dns` in `daemon.json` if needed.
- Intermittent failures with Alpine/musl → musl's resolver behaves differently with `search` domains and TCP fallback; switching to a `-slim` (glibc) image sometimes fixes odd DNS behaviour.

### Permission denied

- On a mount → numeric UID/GID mismatch (module 05). Compare `docker exec <c> id` with `ls -ln` on the path.
- On executing the entrypoint (126) → missing `+x`, or `noexec` mount.
- On binding a port → only relevant with host networking or other runtimes; under Docker bridge networking low ports work for non-root.
- `permission denied while trying to connect to the Docker daemon socket` → on Linux, your user isn't in the `docker` group (and remember that group is root-equivalent), or the daemon isn't running. On a Mac, Docker Desktop/OrbStack/Colima isn't running or `docker context` points elsewhere (`docker context ls`).

### "Works on my machine": architecture mismatches

On Apple Silicon your default platform is `linux/arm64`. Production is often `linux/amd64`.

```text
exec /usr/local/bin/docker-entrypoint.sh: exec format error
```

means the binary in the image is for a different CPU architecture (or the script has no valid shebang). Causes and fixes:

- **You built on your Mac (arm64) and deployed to an amd64 server**: build multi-arch with `docker buildx build --platform linux/amd64,linux/arm64 --push` (module 04), or at least `--platform linux/amd64`.
- **You `COPY`'d host `node_modules` with native binaries** (bcrypt, sharp, better-sqlite3) compiled for macOS into a Linux image: always `npm ci` inside the image and keep `node_modules` in `.dockerignore`.
- **You pulled an image that only exists for amd64**: Docker runs it under emulation (Rosetta or QEMU), which works but is slower and occasionally crashes (139). Check with `docker image inspect -f '{{.Os}}/{{.Architecture}}' <img>` and the warning `The requested image's platform (linux/amd64) does not match the detected host platform`.

```bash
docker buildx imagetools inspect node:22-alpine      # which platforms does a tag offer?
docker run --rm --platform linux/amd64 alpine uname -m   # x86_64 (emulated)
docker run --rm alpine uname -m                          # aarch64 (native)
```

### Slow builds

- **Cache misses**: `COPY . .` before `npm ci` invalidates the dependency layer on every code change. Copy lockfiles first (module 03).
- **Huge build context**: `docker build` sends the context to BuildKit; a missing `.dockerignore` sends `node_modules` and `.git`. The first line of build output (`transferring context: 812MB`) tells you.
- **Emulated builds**: building `linux/amd64` on Apple Silicon runs every `RUN` under emulation. Use native builders per platform or cross-compilation where possible.
- **No cache in CI**: use `--cache-from`/`--cache-to` (registry or GitHub Actions cache).
- Diagnose with `docker build --progress=plain` (shows timings per step) and `docker buildx history` / the Builds view in Docker Desktop.

## The toolbox

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker logs -f --since 10m --timestamps <c>        # -n 100 for last 100 lines
docker inspect <c> | less                          # everything
docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}' <c>
docker inspect -f '{{json .State.Health}}' <c> | jq # healthcheck history with outputs
docker events --since 1h --filter type=container   # live/recent daemon events: create, start, die, oom, kill, health_status
docker stats                                       # live CPU/mem/net/block IO/PIDs per container
docker top <c>                                     # processes in the container, from the host's view
docker diff <c>                                    # files changed in the writable layer
docker cp <c>:/app/logs/error.log .                # copy files out (works on stopped containers too)
docker exec -it <c> sh                             # shell, if the image has one
docker exec -u 0 -it <c> sh                        # as root, to inspect permissions
```

:::try Read a container's story from events
In one terminal run `docker events --filter type=container`. In another: `docker run --name ev --memory 64m alpine sh -c 'sleep 1; exit 3'`, then `docker rm ev`. Watch the sequence `create → attach → start → die (exitCode=3) → destroy`. Now repeat with `docker run -d --name ev2 nginx:alpine && docker stop ev2` and look for the `kill` event with `signal=15`.
:::

### Debugging containers without a shell

Distroless and hardened images have no shell, so `docker exec -it <c> sh` fails with `executable file not found`. Options:

**1. `docker debug` (Docker Desktop, paid subscriptions).** Attaches a toolbox shell (with a package manager you can use on the fly) to any container or image, even distroless or stopped ones, without modifying them:

```bash
docker debug shipit-api        # shell with access to the container's filesystem and namespaces
docker debug nginx:alpine      # debug an image without running the real entrypoint
```

**2. A sidecar sharing namespaces (works everywhere).** Start a tools container in the target's PID and network namespaces:

```bash
docker run --rm -it --pid container:shipit-api --network container:shipit-api nicolaka/netshoot
# inside:
ps aux                        # you see the target's processes (its node process)
ss -ltnp                      # its sockets
ls /proc/1/root/app           # its filesystem, through /proc/<pid>/root
cat /proc/1/environ | tr '\0' '\n'
```

`busybox` works for the same trick if you only need basic tools: `docker run --rm -it --pid container:shipit-api busybox sh`. Accessing `/proc/1/root` may need the same UID as the target or `--cap-add SYS_PTRACE` on the *debug* container; it's a temporary debug session, not a production setting.

**3. Debug the image, not the container.** `docker run --rm -it --entrypoint /nodejs/bin/node gcr.io/distroless/nodejs22-debian12 -e 'console.log(require("fs").readdirSync("/"))'`, or use the `:debug` variants many distroless images publish, which include busybox.

In Kubernetes, the same idea is `kubectl debug` with ephemeral containers.

:::deep How `docker exec` and namespace sharing actually work
A container is a process tree living in a set of namespaces (mnt, pid, net, uts, ipc, user, cgroup). `docker exec` asks the runtime (runc) to start a *new* process and `setns()` it into all of the target's namespaces and the same cgroup. That's why exec'd processes see the same filesystem, PIDs and network, and why they're counted against the container's memory limit.

`--pid container:X` and `--network container:X` do the same thing selectively at container creation: the new container *joins* X's PID or network namespace but keeps its own mount namespace (its own filesystem with your tools). Because `/proc/<pid>/root` is a magic link to a process's root directory as seen from its mount namespace, a debug container sharing the PID namespace can browse the target's filesystem through it. `docker debug` automates this pattern and adds a persistent toolbox volume. On the host, `nsenter -t <pid> -n -m` is the raw equivalent (find the PID with `docker inspect -f '{{.State.Pid}}' <c>`).
:::

## Logging: drivers and rotation

Docker captures the main process's **stdout and stderr**. Apps in containers should log to stdout/stderr (12-factor), ideally as JSON lines, and never to files inside the container.

The **logging driver** decides where those streams go:

| Driver | Where logs go | `docker logs` works? | Notes |
| --- | --- | --- | --- |
| `json-file` (default) | JSON files under `/var/lib/docker/containers/<id>/` | Yes | **No rotation by default**: logs grow forever |
| `local` | Compact, compressed files | Yes | Rotates by default; recommended for single hosts |
| `journald` | systemd journal | Yes | Good on systemd Linux servers |
| `awslogs`, `gcplogs`, `fluentd`, `gelf`, `syslog`, `splunk` | Remote systems | Yes, via dual logging (local cache) | Ship logs centrally |
| `none` | Discarded | No | |

:::warning The disk-filling default
With the default `json-file` driver and no options, a chatty container can fill a server's disk. Set rotation daemon-wide (Linux `/etc/docker/daemon.json`, Docker Desktop: Settings → Docker Engine) and restart the daemon; it applies to **newly created** containers:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

Or per container: `docker run --log-opt max-size=10m --log-opt max-file=3 ...`, and in Compose:

```yaml
services:
  api:
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```
:::

Logging is blocking by default: if the driver can't keep up (e.g. a remote endpoint is slow), the app's writes to stdout block. `--log-opt mode=non-blocking --log-opt max-buffer-size=4m` trades possible log loss for app latency. In production, a common pattern is `local`/`json-file` with rotation plus a node-level agent (Fluent Bit, Vector, the CloudWatch agent) that tails the files and ships them.

## Disk usage and cleanup

Images, build cache, stopped containers and volumes accumulate quickly, especially on a Mac where the VM disk has a fixed maximum size.

```bash
docker system df                 # summary: images, containers, volumes, build cache (+ reclaimable)
docker system df -v              # per object

docker container prune           # stopped containers
docker image prune               # dangling images (untagged <none>)
docker image prune -a            # ALL images not used by a container
docker builder prune             # build cache (add --all, or --filter until=168h)
docker volume prune              # unused anonymous volumes (add --all for named ones: careful!)
docker network prune             # unused networks
docker system prune              # containers + networks + dangling images + build cache
docker system prune -a --volumes # everything unused, incl. anonymous volumes; nuclear option
```

:::warning Prune with intent
`docker system prune -a --volumes` on a dev Mac wipes every image you'll have to re-pull and any anonymous volume (and, with `volume prune --all`, named volumes such as local databases not attached to a container). Prefer targeted commands and filters, e.g. `docker image prune -a --filter until=720h` or `docker builder prune --filter until=168h`. On servers, schedule pruning (cron/systemd timer) rather than waiting for "no space left on device".
:::

:::mac Reclaiming space on macOS
Docker Desktop stores everything in a single VM disk image; pruning frees space inside it, and current versions return freed space to macOS automatically over time. If the disk keeps hitting its limit, raise it in Settings → Resources, or check for one huge offender with `docker system df -v`. OrbStack and Colima use their own disk images with similar behaviour.
:::

## Monitoring resource usage

- **`docker stats`**: live CPU %, memory usage/limit, network and block I/O, PIDs. `docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}'` for scripts.
- **`docker events`**: stream of what's happening (die, oom, health_status changes). Pipe to `jq` with `--format '{{json .}}'`.
- **lazydocker**: a terminal UI for containers, logs, stats and Compose projects (`brew install lazydocker`). Great for daily use.
- **ctop**: a `top`-like view of container metrics. Popular but sees little maintenance nowadays; lazydocker or Docker Desktop's dashboard are safer bets.
- **Production**: cAdvisor + Prometheus + Grafana, or your cloud's container insights. The kernel's cgroup stats are the raw source for all of them.

## Summary

- Work outside-in: state → logs → inspect → events → stats → inside → reproduce.
- Exit codes: 0 finished, 1 app error, 125 docker failed, 126 not executable, 127 not found, 137 SIGKILL/OOM, 139 segfault, 143 SIGTERM.
- Check `.State.OOMKilled` and events to separate OOM from stop timeouts; use exec-form `CMD`, signal handlers and `--init` for clean shutdowns.
- `exec format error` = architecture (or shebang) mismatch; build multi-arch and never copy host `node_modules`.
- Debug shell-less images with `docker debug` or a netshoot/busybox sidecar sharing `--pid`/`--network`.
- Configure log rotation (or the `local` driver) and prune deliberately.
