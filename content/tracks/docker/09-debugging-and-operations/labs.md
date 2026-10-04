These labs deliberately break things so you learn to recognise failures by their symptoms. You need Docker and a terminal; `jq` is handy (`brew install jq`).

```bash
mkdir -p ~/docker-labs/09-debug && cd ~/docker-labs/09-debug
```

## Lab 1: The exit code zoo

:::meta
difficulty: easy
time: 20 min
:::

Goal: produce each important exit code on purpose, so you recognise them instantly later.

### Steps

Run each command, then print the exit code with `echo $?` (for `docker run` without `-d`, the CLI exits with the container's code).

```bash
docker run --rm alpine true;                         echo "a: $?"
docker run --rm alpine sh -c 'exit 1';               echo "b: $?"
docker run --rm --no-such-flag alpine true;          echo "c: $?"
docker run --rm alpine /etc;                         echo "d: $?"
docker run --rm alpine nosuchcommand;                echo "e: $?"
docker run --rm alpine sh -c 'sh -c "kill -SEGV \$\$"; exit $?'; echo "f: $?"
```

Signals from outside:

```bash
docker run -d --name z-kill alpine sleep 300 && docker kill z-kill
docker run -d --name z-term --init alpine sleep 300 && docker stop z-term
docker run -d --name z-slow alpine sleep 300 && time docker stop z-slow
docker ps -a --filter name=z- --format 'table {{.Names}}\t{{.Status}}'
```

### Verify

Fill in this table from your output before opening the solution:

| Case | Code | Why |
| --- | --- | --- |
| a | | |
| b | | |
| c | | |
| d | | |
| e | | |
| f | | |
| z-kill | | |
| z-term | | |
| z-slow | | |

:::hint
Codes above 128 are 128 + signal number. SIGKILL = 9, SIGSEGV = 11, SIGTERM = 15. Look at how long `docker stop z-slow` took.
:::

:::solution
| Case | Code | Why |
| --- | --- | --- |
| a | 0 | Command finished successfully |
| b | 1 | Application returned an error |
| c | 125 | The `docker` CLI/daemon failed; the container never ran |
| d | 126 | `/etc` exists but can't be executed (permission denied) |
| e | 127 | Command not found in the image |
| f | 139 | Child process died of SIGSEGV (128+11); the shell propagated it |
| z-kill | 137 | `docker kill` sends SIGKILL (128+9) |
| z-term | 143 | With `--init`, tini forwards SIGTERM to `sleep`, which dies of it (128+15) |
| z-slow | 137 | `sleep` is PID 1 with no signal handler, so the kernel ignores SIGTERM; after 10 s Docker sends SIGKILL. `time` shows ~10 s |

z-slow is the most important one: it's exactly what happens to a Node app started via `npm start` (shell form) or without a SIGTERM handler. Slow deploys and dropped requests follow.
:::

### Clean up

```bash
docker rm -f z-kill z-term z-slow
```

## Lab 2: OOMKilled vs stop timeout, proven with events

:::meta
difficulty: easy
time: 20 min
:::

Goal: tell apart the two most common causes of exit 137 using `inspect` and `events`.

### Steps

1. In a second terminal, start watching events:

   ```bash
   docker events --filter type=container --format '{{.Time}} {{.Actor.Attributes.name}} {{.Action}} {{.Actor.Attributes.signal}}{{.Actor.Attributes.exitCode}}'
   ```

2. A memory hog with a 128 MB limit:

   ```bash
   docker run -d --name hog --memory 128m node:22-alpine \
     node -e 'const a=[]; setInterval(()=>{a.push(Buffer.alloc(10e6).fill(1)); console.log((a.length*10)+"MB")},200)'
   docker wait hog
   docker logs hog | tail -3
   docker inspect -f 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}' hog
   ```

3. A server that ignores SIGTERM:

   ```bash
   docker run -d --name stubborn node:22-alpine node -e 'require("http").createServer((q,r)=>r.end("ok")).listen(3000); console.log("up")'
   time docker stop stubborn
   docker inspect -f 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}' stubborn
   ```

4. Fix the stubborn server **two different ways** and show that `docker stop` returns in well under a second.

### Verify

- The events terminal shows `hog oom` followed by `hog die 137`, and `stubborn kill 15`, then about 10 s later `stubborn kill 9`, then `die 137`.
- `hog` has `OOMKilled=true`; `stubborn` has `OOMKilled=false`, although both exited 137.
- After your fixes, `time docker stop` takes under a second and the exit code is 0 or 143.

:::hint
Way 1: run with `--init`. Way 2: add a SIGTERM handler in the code that closes the server and exits.
:::

:::solution
```bash
# Way 1: tini as PID 1 forwards SIGTERM; node (not PID 1) gets the default action and dies
docker rm -f stubborn
docker run -d --name stubborn --init node:22-alpine node -e 'require("http").createServer((q,r)=>r.end("ok")).listen(3000)'
time docker stop stubborn; docker inspect -f '{{.State.ExitCode}}' stubborn     # 143

# Way 2: handle SIGTERM explicitly (graceful shutdown, exit 0)
docker rm -f stubborn
docker run -d --name stubborn node:22-alpine node -e '
const s=require("http").createServer((q,r)=>r.end("ok")).listen(3000);
process.on("SIGTERM",()=>{console.log("draining");s.close(()=>process.exit(0))})'
time docker stop stubborn; docker inspect -f '{{.State.ExitCode}}' stubborn     # 0
```

In production do both: handle SIGTERM in the app (close the server, finish in-flight requests, close DB pools) *and* use exec-form `CMD ["node", "dist/main.js"]`; add `--init` (Compose `init: true`) if the app spawns child processes, so zombies are reaped. For the hog: raise `--memory` to a measured value or fix the leak; setting `NODE_OPTIONS=--max-old-space-size` below the limit turns a silent kill into a heap error with a stack trace (note that `Buffer` memory lives outside the V8 heap, so it wouldn't help this particular hog).
:::

### Clean up

```bash
docker rm -f hog stubborn
```

## Lab 3: Break & fix: four images that won't start

:::meta
difficulty: medium
time: 30 min
:::

Goal: diagnose entrypoint failures (126, 127, "no such file", "exec format error") from their messages and fix each with the smallest change.

### Steps

1. Create four broken images:

   ```bash
   mkdir -p four && cd four

   # A: Windows line endings
   printf '#!/bin/sh\r\necho "A works"\r\n' > a.sh && chmod +x a.sh
   printf 'FROM alpine\nCOPY a.sh /a.sh\nENTRYPOINT ["/a.sh"]\n' > Dockerfile.a

   # B: bash shebang in an Alpine image
   printf '#!/bin/bash\necho "B works"\n' > b.sh && chmod +x b.sh
   printf 'FROM alpine\nCOPY b.sh /b.sh\nENTRYPOINT ["/b.sh"]\n' > Dockerfile.b

   # C: no shebang at all
   printf 'echo "C works"\n' > c.sh && chmod +x c.sh
   printf 'FROM alpine\nCOPY c.sh /c.sh\nENTRYPOINT ["/c.sh"]\n' > Dockerfile.c

   # D: not executable
   printf '#!/bin/sh\necho "D works"\n' > d.sh && chmod -x d.sh
   printf 'FROM alpine\nCOPY d.sh /d.sh\nENTRYPOINT ["/d.sh"]\n' > Dockerfile.d

   for x in a b c d; do docker build -q -f Dockerfile.$x -t broken-$x . >/dev/null; done
   for x in a b c d; do echo "== $x"; docker run --rm broken-$x; echo "exit=$?"; done
   ```

2. For each, write down the error message and exit code, explain the cause, and fix it (change the script or the Dockerfile, not the base image, except where you decide that's the right fix).

3. Use these investigation tools at least once:

   ```bash
   docker run --rm --entrypoint sh broken-a -c 'od -c /a.sh | head -2'
   docker run --rm --entrypoint sh broken-b -c 'ls -l /bin/bash /bin/sh'
   docker run --rm --entrypoint sh broken-d -c 'ls -l /d.sh'
   ```

### Verify

All four `docker run --rm broken-<x>` commands print `<X> works` and exit 0.

:::hint
- `exec /a.sh: no such file or directory` while the file obviously exists means the *interpreter* named in the shebang doesn't exist. Look for invisible characters.
- `exec format error` doesn't only mean "wrong CPU architecture". The kernel also returns it for a text file with no `#!` line when it's run via `execve` (no shell in between to guess).
:::

:::solution
| Image | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| A | `exec /a.sh: no such file or directory`, exit 127 (some versions: 255) | Shebang is `#!/bin/sh\r`; the kernel looks for an interpreter literally named `sh\r` | Convert to LF: `sed -i '' 's/\r$//' a.sh` (macOS) or `RUN sed -i 's/\r$//' /a.sh` in the Dockerfile; add `*.sh text eol=lf` to `.gitattributes` |
| B | `exec /b.sh: no such file or directory`, exit 127 | Alpine has no bash | Use `#!/bin/sh` (and POSIX syntax), or `RUN apk add --no-cache bash` if you really need bash |
| C | `exec /c.sh: exec format error`, exit 255 or 1 | No shebang; `execve` can't run a plain text file | Add `#!/bin/sh` as the first line |
| D | `exec /d.sh: permission denied`, exit 126 | No execute bit | `chmod +x d.sh` before building, or `COPY --chmod=755 d.sh /d.sh` |

```bash
sed -i '' 's/\r$//' a.sh
sed -i '' '1s|#!/bin/bash|#!/bin/sh|' b.sh
printf '#!/bin/sh\necho "C works"\n' > c.sh
sed -i '' 's|COPY d.sh /d.sh|COPY --chmod=755 d.sh /d.sh|' Dockerfile.d
for x in a b c d; do docker build -q -f Dockerfile.$x -t broken-$x . >/dev/null; docker run --rm broken-$x; done
```

(On Linux, use `sed -i` without the `''`.) The exact exit code for "exec" failures varies between Docker versions (127, 126, 255); the **message** is the reliable signal. And when you see `exec format error` on a binary (not a script), check the image's architecture with `docker image inspect -f '{{.Architecture}}'`.
:::

### Clean up

```bash
for x in a b c d; do docker rmi broken-$x; done; cd .. && rm -rf four
```

## Lab 4: Debug a distroless container from the outside

:::meta
difficulty: medium
time: 25 min
:::

Goal: inspect processes, sockets, files and environment of a container that has no shell, without modifying it.

### Steps

1. Run a distroless Node app:

   ```bash
   mkdir -p dl && cd dl
   cat > server.js <<'EOF'
   const http = require('http');
   const fs = require('fs');
   fs.writeFileSync('/tmp/state.json', JSON.stringify({ started: new Date() }));
   http.createServer((req, res) => res.end('hello from distroless\n')).listen(8080);
   EOF
   printf 'FROM gcr.io/distroless/nodejs22-debian12\nCOPY server.js /app/server.js\nENV SECRET_FLAG=found-me\nCMD ["/app/server.js"]\n' > Dockerfile
   docker build -q -t dl-app . && docker run -d --name dl -p 8090:8080 dl-app
   curl -s localhost:8090
   ```

2. Confirm you can't get a shell: `docker exec -it dl sh`.

3. Using only a sidecar container that shares `dl`'s namespaces, find:
   - the PID and command line of the Node process,
   - the port it listens on,
   - the contents of `/tmp/state.json` inside `dl`,
   - the value of `SECRET_FLAG` in the process environment.

4. If you have Docker Desktop with a paid subscription, also try `docker debug dl`.

### Verify

You can show all four facts with commands run from the sidecar, and `docker diff dl` confirms the `/tmp/state.json` you read is in `dl`'s writable layer.

:::hint
`docker run --rm -it --pid container:dl --network container:dl nicolaka/netshoot`, then explore `ps`, `ss -ltnp`, `/proc/<pid>/root` and `/proc/<pid>/environ`. Distroless runs as root by default unless you set a user; if `/proc/1/root` is denied, match the user or add `--cap-add SYS_PTRACE` to the sidecar.
:::

:::solution
```bash
docker run --rm -it --pid container:dl --network container:dl nicolaka/netshoot sh -c '
  ps -o pid,user,args;
  ss -ltnp;
  cat /proc/1/root/tmp/state.json; echo;
  tr "\0" "\n" < /proc/1/environ | grep SECRET_FLAG'
docker diff dl
```

Expected: PID 1 is `/nodejs/bin/node /app/server.js`; it listens on `*:8080`; `state.json` contains the start time; `SECRET_FLAG=found-me`.

Two lessons:
- Shell-less images don't stop debugging; they move it to a sidecar. `docker debug` packages this pattern; `kubectl debug` does the same in Kubernetes.
- Anything in the environment is readable by anyone who can join the namespace or `docker inspect` the container. That's why secrets belong in files with tight permissions or a secret manager (module 08).
:::

### Clean up

```bash
docker rm -f dl; docker rmi dl-app; cd .. && rm -rf dl
```

## Lab 5: Logs, rotation and reclaiming disk

:::meta
difficulty: medium
time: 25 min
:::

Goal: see unbounded logs vs rotated logs, and clean up disk space deliberately.

### Steps

1. Two chatty containers, one with rotation:

   ```bash
   docker run -d --name noisy-default alpine sh -c 'while true; do echo "$(date) $(head -c 200 /dev/urandom | base64 | tr -d "\n")"; done'
   docker run -d --name noisy-rotated --log-opt max-size=1m --log-opt max-file=2 \
     alpine sh -c 'while true; do echo "$(date) $(head -c 200 /dev/urandom | base64 | tr -d "\n")"; done'
   sleep 20
   for c in noisy-default noisy-rotated; do echo "$c: $(docker logs $c 2>&1 | wc -c) bytes retained"; done
   docker inspect -f '{{.HostConfig.LogConfig}}' noisy-rotated
   ```

2. Stop both and look at disk usage:

   ```bash
   docker stop noisy-default noisy-rotated
   docker system df
   docker system df -v | head -40
   ```

3. Reclaim space **without** deleting images you used in the last 24 hours or any named volume. Write down how much each command freed.

4. Try the `local` driver and compare: `docker run -d --name noisy-local --log-driver local alpine sh -c 'seq 1 200000'` then `docker logs noisy-local | tail -1`.

### Verify

- `noisy-rotated` retains at most about 2 MB of logs; `noisy-default` keeps growing as long as it runs.
- Your cleanup commands report "Total reclaimed space" and `docker volume ls` still shows your named volumes.

:::hint
`docker container prune`, `docker image prune -a --filter until=24h`, `docker builder prune --filter until=24h`, and `docker volume prune` (anonymous only, by default).
:::

:::solution
```bash
docker container prune -f                               # stopped containers (incl. the noisy ones' logs)
docker image prune -a -f --filter until=24h             # images created more than 24h ago and unused
docker builder prune -f --filter until=24h              # old build cache
docker volume prune -f                                  # anonymous volumes only (Engine 23+)
docker system df
```

Notes:
- Removing a container deletes its json-file logs, which is why stopped-but-not-removed containers can hold gigabytes of logs.
- Rotation options apply to containers **created** after you set them. To set them globally, add `log-opts` to the daemon config (Docker Desktop: Settings → Docker Engine) and recreate containers.
- The `local` driver rotates by default (it keeps a few compressed files of limited size), making it a good default for single hosts.
:::

### Clean up

```bash
docker rm -f noisy-default noisy-rotated noisy-local 2>/dev/null
```

## Lab 6: Challenge: on-call incident in a Compose stack

:::meta
difficulty: hard
time: 45 min
:::

Goal: you're paged for a misbehaving stack. Find every problem with evidence, fix it, and write a short incident note.

### Setup

```bash
mkdir -p incident && cd incident
cat > api.js <<'EOF'
const http = require('http');
const cache = [];
for (let i = 0; i < 20; i++) cache.push(Buffer.alloc(10 * 1024 * 1024, 1)); // "warm cache": 200 MB
http.createServer((req, res) => res.end('api ok\n')).listen(3000, () => console.log('api up'));
EOF
cat > worker.sh <<'EOF'
#!/bin/sh
echo "worker started"
while true; do echo "processing job $(date +%s)"; sleep 2; done
EOF
chmod +x worker.sh
cat > compose.yaml <<'EOF'
name: incident
services:
  api:
    image: node:22-alpine
    command: ["node", "/srv/api.js"]
    volumes: ["./api.js:/srv/api.js:ro"]
    ports: ["127.0.0.1:3300:3000"]
    restart: on-failure
    deploy:
      resources:
        limits: { memory: 128M }
  worker:
    image: alpine
    command: sh -c "/srv/worker.sh"
    volumes: ["./worker.sh:/srv/worker.sh:ro"]
  web:
    image: nginx:alpine
    ports: ["127.0.0.1:3301:80"]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/"]
      interval: 5s
      retries: 3
EOF
docker compose up -d
```

### Requirements

1. Explain, with the command output that proves it, why:
   - `curl localhost:3300` fails and `docker compose ps` shows `api` restarting,
   - `docker compose stop worker` takes about 10 seconds,
   - `web` is reported `unhealthy` even though `curl localhost:3301` works.
2. Fix all three without changing what the services do (api still "warms" its 200 MB cache, worker keeps its loop, web keeps a healthcheck).
3. After fixing: `docker compose up -d --wait` succeeds, `docker compose stop` completes in about 1 second, and `docker compose ps` shows everything `healthy`/running.
4. Write a three-line incident note: symptom, root cause, fix, for each issue.

:::hint
- `docker inspect -f '{{.State.OOMKilled}}' incident-api-1` and `docker compose events api`.
- `docker compose top worker`: which process is PID 1, and does it handle SIGTERM?
- `docker inspect -f '{{json .State.Health}}' incident-web-1 | jq '.Log[-1]'` shows the healthcheck's own output.
:::

:::solution
**Evidence**

```bash
docker compose ps -a
docker inspect -f 'OOMKilled={{.State.OOMKilled}} Exit={{.State.ExitCode}} Restarts={{.RestartCount}}' incident-api-1
docker compose top worker            # PID 1 is "sh -c /srv/worker.sh", which runs another sh
time docker compose stop worker
docker inspect -f '{{json .State.Health}}' incident-web-1 | jq '.Log[-1]'
# "exec: \"curl\": executable file not found in $PATH"
```

**Fixed compose.yaml**

```yaml
name: incident
services:
  api:
    image: node:22-alpine
    command: ["node", "/srv/api.js"]
    volumes: ["./api.js:/srv/api.js:ro"]
    ports: ["127.0.0.1:3300:3000"]
    restart: on-failure
    init: true
    deploy:
      resources:
        limits: { memory: 384M }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/"]
      interval: 5s
      retries: 5
  worker:
    image: alpine
    command: ["/srv/worker.sh"]
    init: true
    volumes: ["./worker.sh:/srv/worker.sh:ro"]
  web:
    image: nginx:alpine
    ports: ["127.0.0.1:3301:80"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost/"]
      interval: 5s
      retries: 3
```

```bash
docker compose up -d --wait
curl -s localhost:3300
time docker compose stop
```

**Incident note**

- *api*: Symptom: connection refused, container restarting. Cause: the process allocates ~200 MB at startup but the limit was 128 MB, so the kernel OOM-killed it (OOMKilled=true, exit 137) and `on-failure` restarted it in a loop. Fix: set the limit from measured usage (384 MB) and add a healthcheck so the failure is visible; long-term, reconsider the cache size.
- *worker*: Symptom: `stop` takes 10 s. Cause: shell-form `sh -c` made a shell PID 1, which ignores SIGTERM (no handler as PID 1), so Docker waited 10 s and sent SIGKILL. Fix: exec-form command plus `init: true` so tini forwards SIGTERM; even better, trap TERM in the script and exit cleanly.
- *web*: Symptom: unhealthy while serving traffic. Cause: healthcheck runs `curl`, which doesn't exist in `nginx:alpine`. Fix: use `wget` (busybox), which is in the image. Always test healthcheck commands with `docker exec <c> <cmd>`.
:::

### Clean up

```bash
docker compose down; cd .. && rm -rf incident
```
