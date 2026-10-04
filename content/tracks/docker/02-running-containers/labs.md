These labs exercise everyday `docker run` skills on small, self-contained examples. Create a working folder first and keep it for the whole module:

```bash
mkdir -p ~/hub-labs/run && cd ~/hub-labs/run
docker pull node:22-alpine && docker pull alpine:3.22 && docker pull nginx:alpine
```

Several labs use this tiny dependency-free Node server. Save it as `server.js`:

```javascript
// server.js — a tiny HTTP server for container experiments
const http = require("node:http");
const os = require("node:os");

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/slow") {
    // simulates a request that takes 3 seconds
    setTimeout(() => res.end("slow done\n"), 3000);
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ host: os.hostname(), message: process.env.APP_MESSAGE ?? null, pid: process.pid }) + "\n");
});

server.listen(port, "0.0.0.0", () => console.log(`listening on :${port} as pid ${process.pid}`));

if (process.env.GRACEFUL === "true") {
  process.on("SIGTERM", () => {
    console.log("SIGTERM received, draining connections");
    server.close(() => {
      console.log("all connections closed, exiting");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
```

## Lab 1: Walk the container lifecycle

:::meta
difficulty: easy
time: 15 min
:::

Goal: move one container through every state and observe each transition.

### Steps

1. In a second terminal, start watching events:

```bash
docker events --filter container=life --format '{{.Time}} {{.Action}}'
```

2. In the first terminal, drive the lifecycle and check the state after each command:

```bash
state() { docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} pid={{.State.Pid}}' life; }
docker create --name life alpine:3.22 sh -c 'i=0; while true; do i=$((i+1)); echo "tick $i"; sleep 1; done'
state
docker start life;   state
docker pause life;   state
docker logs --tail 2 life; sleep 3; docker logs --tail 2 life   # no new ticks while paused
docker unpause life; state
docker stop life;    state
docker start life;   state
docker logs life | head -3     # logs from BOTH runs: it is the same container
docker kill life;    state
docker rm life
```

### Verify

- States go `created → running → paused → running → exited → running → exited`.
- The events terminal shows `create`, `start`, `pause`, `unpause`, `kill`, `die`, `stop`, `start`, `kill`, `die`, `destroy`.
- After the second `start`, logs still contain "tick 1" from the first run.
- Note the exit codes after `stop` and after `kill` — explain them before opening the solution.

:::hint
`sh` running as PID 1 has no SIGTERM handler. What does `docker stop` do after 10 seconds when SIGTERM is ignored?
:::

:::solution
```text
created exit=0 pid=0
running exit=0 pid=51234
paused exit=0 pid=51234
running exit=0 pid=51234
exited exit=137 pid=0
running exit=0 pid=51410
exited exit=137 pid=0
```

- `docker stop` took ~10 seconds and still ended with **137**: `sh` as PID 1 ignored SIGTERM, so Docker sent SIGKILL after the timeout. The `kill` event before `die` in the event stream is Docker sending the signals (you'll see `kill` with signal 15, then again with signal 9).
- `docker kill` sends SIGKILL right away: 137 immediately.
- `docker start` reuses the same container: same writable layer, same log file — so earlier ticks are still in `docker logs`. `docker run` would have created a new container.
- While paused, the processes are frozen by the cgroup freezer; no ticks are logged, and the PID stays the same.
:::

### Clean up

```bash
docker rm -f life 2>/dev/null || true
```

Stop the `docker events` command with Ctrl-C.

## Lab 2: Ports, environment, exec, logs and cp

:::meta
difficulty: easy
time: 20 min
:::

Goal: run the Node server with configuration, reach it, look inside it and pull files out of it.

### Steps

1. Create an env file — note the quotes on purpose:

```bash
cat > app.env <<'EOF'
# configuration for the demo server
APP_MESSAGE="hello from env-file"
PORT=3000
EOF
```

2. Run the server with the env file, publish the port on localhost only, and add a label:

```bash
docker run -d --name api \
  --env-file app.env \
  -p 127.0.0.1:8080:3000 \
  --label lab=run \
  -v "$PWD/server.js":/app/server.js:ro -w /app \
  node:22-alpine node server.js
curl -s localhost:8080
```

3. Override a value with `-e` on a new container and compare (port 8081):

```bash
docker run -d --name api2 --env-file app.env -e APP_MESSAGE=from-flag \
  -p 127.0.0.1:8081:3000 --label lab=run \
  -v "$PWD/server.js":/app/server.js:ro -w /app node:22-alpine node server.js
curl -s localhost:8081
```

4. Look inside the first container:

```bash
docker exec api env | grep -E 'APP_MESSAGE|PORT|NODE_VERSION'
docker exec api ps -o pid,user,comm
docker top api
docker port api
docker logs api
```

5. Create a file inside the container and copy it out; copy a file in:

```bash
docker exec api sh -c 'date > /tmp/report.txt'
docker cp api:/tmp/report.txt ./report.txt && cat report.txt
echo '{"ok":true}' > fixture.json && docker cp fixture.json api:/tmp/ && docker exec api cat /tmp/fixture.json
```

### Verify

- `curl localhost:8080` returns JSON whose `message` is `"\"hello from env-file\""` — with literal quotes.
- `curl localhost:8081` returns `"from-flag"`: `-e` wins over `--env-file`.
- `docker port api` prints `3000/tcp -> 127.0.0.1:8080`.
- `report.txt` exists on your Mac with the container's date.

:::hint
`--env-file` does not process quotes. If you want the value without quotes, remove them from the file. Compose's `env_file`/`.env` handling *does* strip quotes — the same file behaves differently in the two tools.
:::

:::solution
```text
$ curl -s localhost:8080
{"host":"4f2a9c1b7d3e","message":"\"hello from env-file\"","pid":1}
$ curl -s localhost:8081
{"host":"9b8e7a6c5d4f","message":"from-flag","pid":1}
$ docker exec api env | grep -E 'APP_MESSAGE|PORT|NODE_VERSION'
NODE_VERSION=22.x.x
APP_MESSAGE="hello from env-file"
PORT=3000
$ docker port api
3000/tcp -> 127.0.0.1:8080
```

Notes:

- `host` is the container ID prefix (UTS namespace hostname) and `pid` is 1 — node is PID 1.
- `NODE_VERSION` comes from the image's `ENV`; your env file and flags are layered on top.
- Fix the quoting by writing `APP_MESSAGE=hello from env-file` (no quotes; spaces are fine).
- `docker cp` works on stopped containers too — useful to retrieve files from a crashed container before removing it.
:::

### Clean up

Keep `api` and `api2` for Lab 5, or remove them now with `docker rm -f api api2`.

## Lab 3: Restart policies and live limit changes

:::meta
difficulty: medium
time: 20 min
:::

Goal: see how restart policies react to failures and manual stops, and change limits without recreating a container.

### Steps

1. A worker that crashes after 2 seconds, with `on-failure:3`:

```bash
docker run -d --name flaky --restart on-failure:3 --label lab=run alpine:3.22 sh -c 'echo "starting"; sleep 2; echo "crash!"; exit 1'
sleep 25
docker inspect -f 'status={{.State.Status}} restarts={{.RestartCount}} exit={{.State.ExitCode}}' flaky
docker logs flaky | grep -c starting
```

2. A worker that exits **successfully** with the same policy:

```bash
docker run -d --name finisher --restart on-failure:3 --label lab=run alpine:3.22 sh -c 'echo done; exit 0'
sleep 3; docker inspect -f 'status={{.State.Status}} restarts={{.RestartCount}}' finisher
```

3. `always` vs a manual stop:

```bash
docker run -d --name always --restart always --label lab=run alpine:3.22 sleep 600
docker stop always
sleep 2; docker inspect -f 'status={{.State.Status}}' always
```

4. Change the restart policy and limits of a running container:

```bash
docker run -d --name tunable --label lab=run alpine:3.22 sleep 600
docker update --restart unless-stopped --memory 128m --memory-swap 128m --cpus 0.5 tunable
docker inspect -f 'policy={{.HostConfig.RestartPolicy.Name}} mem={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}}' tunable
docker exec tunable cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max
```

5. Optional: restart your runtime (quit and reopen Docker Desktop/OrbStack, or `colima restart`) and check which of `always` and `tunable` come back.

### Verify

- `flaky` ends `exited` with `restarts=3` and four "starting" lines (1 run + 3 restarts).
- `finisher` stays `exited` with `restarts=0` — exit code 0 is not a failure.
- `always` stays `exited` after `docker stop` (manual stops are respected until the daemon restarts).
- `tunable` shows `memory.max` = `134217728` and `cpu.max` = `50000 100000` without being recreated.
- After an engine restart (optional step), both `always` and `tunable` (`unless-stopped`, never stopped manually) are running again; if you had stopped `tunable` manually, it would stay stopped.

:::hint
The gaps between restarts grow (back-off), which is why step 1 waits 25 seconds. If `restarts` is still below 3, wait a little longer and inspect again.
:::

:::solution
```text
status=exited restarts=3 exit=1
4
status=exited restarts=0
status=exited
policy=unless-stopped mem=134217728 cpus=500000000
134217728
50000 100000
```

- `on-failure:N` counts restarts, not runs: 1 original run + 3 restarts.
- `NanoCpus` stores CPUs × 10⁹ (0.5 → 500000000).
- The difference between `always` and `unless-stopped` only shows on a daemon restart: an `always` container you stopped manually is started again; an `unless-stopped` one is not.
- In Kubernetes the equivalents are the pod's `restartPolicy` (`Always`, `OnFailure`, `Never`) with CrashLoopBackOff as the back-off mechanism.
:::

### Clean up

```bash
docker rm -f flaky finisher always tunable
```

## Lab 4: Break and fix — the deploy that takes 10 seconds per container

:::meta
difficulty: medium
time: 30 min
:::

Goal: diagnose and fix slow, ungraceful shutdowns — the PID 1 problem in practice.

### Steps

1. Run the server the way a teammate does in their deploy script, and time a stop:

```bash
docker run -d --name slowstop -v "$PWD/server.js":/app/server.js:ro -w /app \
  node:22-alpine sh -c "node server.js"
sleep 1
time docker stop slowstop
docker inspect -f 'exit={{.State.ExitCode}}' slowstop
docker logs slowstop
docker rm slowstop
```

2. The deploy takes over 10 seconds per container and the exit code looks like a crash. Find out **why** by checking which process is PID 1 and which signal handlers exist. Useful commands:

```bash
docker run -d --name slowstop -v "$PWD/server.js":/app/server.js:ro -w /app node:22-alpine sh -c "node server.js"
docker exec slowstop ps -o pid,ppid,comm
docker exec slowstop sh -c 'grep SigCgt /proc/1/status'
```

3. Fix it in three different ways and time each stop. Your target: `docker stop` completes in well under a second, the exit code is 0 or 143, and an in-flight request is not cut off in the graceful variant.

4. Test the graceful variant under load: start a slow request, then stop the container while it is in flight:

```bash
curl -s localhost:8090/slow & sleep 0.5; time docker stop <container>; wait
```

### Verify

- Each fixed variant stops in well under a second (except the graceful one, which waits for the in-flight `/slow` request: ~3 s).
- The graceful variant logs `SIGTERM received, draining connections` and `all connections closed, exiting`, exits with 0, and `curl` prints `slow done`.

:::hint
The image's command is `sh -c "node server.js"`. Depending on the shell, `sh` either stays as PID 1 (and doesn't forward SIGTERM to node), or execs node — which then is PID 1 without an application-level SIGTERM handler. Either way, nobody acts on SIGTERM. Fixes to consider: run `node` directly *and* handle SIGTERM; `--init`; `exec` in the shell command.
:::

:::solution
Diagnosis:

```text
$ docker exec slowstop ps -o pid,ppid,comm
PID   PPID  COMMAND
    1     0 node
$ docker exec slowstop sh -c 'grep SigCgt /proc/1/status'
SigCgt: 0000000100004602    # bit 14 (0x4000) = signal 15, SIGTERM, is "caught"
```

BusyBox `sh -c` with a single command execs it, so node is PID 1. Surprisingly, `SigCgt` shows SIGTERM as caught — but that is Node's **internal** handler, which only restores terminal settings and then re-raises the signal with the default action. For PID 1 the default action is "ignore", so nothing happens (after the first SIGTERM, check `SigCgt` again: the bit is cleared). The app code registers no SIGTERM listener (unless `GRACEFUL=true`), so `docker stop` waits 10 s and sends SIGKILL → exit 137. (With bash or a multi-command string, `sh` would stay PID 1 and not forward the signal — same result.)

Fix A — tini as PID 1 (`--init`): node is no longer PID 1, so SIGTERM's default action (terminate) applies:

```bash
docker run -d --name fix-a --init -v "$PWD/server.js":/app/server.js:ro -w /app node:22-alpine node server.js
sleep 1; time docker stop fix-a; docker inspect -f 'exit={{.State.ExitCode}}' fix-a   # fast, exit=143
docker rm fix-a
```

Fix B — handle SIGTERM in the app (graceful), run node directly (no shell):

```bash
docker run -d --name fix-b -e GRACEFUL=true -p 127.0.0.1:8090:3000 \
  -v "$PWD/server.js":/app/server.js:ro -w /app node:22-alpine node server.js
sleep 1
curl -s localhost:8090/slow & sleep 0.5; time docker stop fix-b; wait
docker inspect -f 'exit={{.State.ExitCode}}' fix-b    # exit=0
docker logs fix-b
docker rm fix-b
```

```text
slow done
real    0m2.6s
exit=0
listening on :3000 as pid 1
SIGTERM received, draining connections
all connections closed, exiting
```

Fix C — combine both for production: `--init` (zombie reaping and signal forwarding) **plus** the app's SIGTERM handler (draining). In a Dockerfile: exec-form `CMD ["node", "server.js"]`, and either `docker run --init` or `tini` installed in the image as `ENTRYPOINT` (Kubernetes has no `--init` flag, so most teams bake tini or dumb-init into the image).

If you must use a shell wrapper (e.g. to run migrations first), end it with `exec`:

```bash
sh -c 'node migrate.js && exec node server.js'
```

Why it matters: Kubernetes sends SIGTERM on every rollout, scale-down and node drain. An app that ignores it is SIGKILLed after `terminationGracePeriodSeconds`, dropping in-flight requests and DB transactions.
:::

### Clean up

```bash
docker rm -f slowstop fix-a fix-b 2>/dev/null || true
```

## Lab 5: Inspect templates, labels and targeted cleanup

:::meta
difficulty: medium
time: 25 min
:::

Goal: extract exactly the information you need with templates and jq, and clean up precisely by label.

### Steps

1. Create a small labelled fleet (re-create `api`/`api2` from Lab 2 if you removed them):

```bash
for env in dev staging; do
  for i in 1 2; do
    docker run -d --name "web-$env-$i" \
      --label com.example.project=shipit --label com.example.env=$env \
      --memory 64m -p 127.0.0.1::80 nginx:alpine
  done
done
docker run -d --name unrelated alpine:3.22 sleep 600
```

2. Answer each question with **one command** (write yours first, then compare with the solution):
   1. Names and status of all `shipit` containers, as a table.
   2. The host port mapped to port 80 of `web-dev-1`.
   3. The IP address of `web-staging-2`.
   4. The memory limit of every `shipit` container, as `name=bytes` lines.
   5. All labels of `web-dev-2` as pretty JSON.
   6. The image and command of every running container, using jq.
3. Stop all `staging` containers, then remove only the **stopped** `shipit` containers with a prune filter.
4. Remove everything else with the `shipit` label.

### Verify

- Your one-liners print the expected values.
- After step 3 the staging containers are gone; dev containers and `unrelated` remain.
- After step 4 only `unrelated` (and anything from earlier labs) remains.

:::hint
`docker ps` accepts multiple `--filter` flags (AND-combined for different keys). `index` reads map keys containing dots or slashes: `{{index .Config.Labels "com.example.env"}}`. Port mappings are `map[string][]PortBinding`: `{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}`. `docker container prune` accepts `--filter label=...`.
:::

:::solution
```bash
# 1
docker ps -a --filter label=com.example.project=shipit --format 'table {{.Names}}\t{{.Status}}'
# 2
docker inspect -f '{{(index .NetworkSettings.Ports "80/tcp" 0).HostPort}}' web-dev-1
#    or simply: docker port web-dev-1 80
# 3
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' web-staging-2
# 4
docker inspect -f '{{.Name}}={{.HostConfig.Memory}}' $(docker ps -q --filter label=com.example.project=shipit)
# 5
docker inspect -f '{{json .Config.Labels}}' web-dev-2 | jq
# 6
docker inspect $(docker ps -q) | jq -r '.[] | "\(.Name) \(.Config.Image) \(.Config.Cmd | join(" "))"'

# step 3
docker stop $(docker ps -q --filter label=com.example.env=staging)
docker container prune -f --filter label=com.example.project=shipit
# step 4
docker rm -f $(docker ps -aq --filter label=com.example.project=shipit)
```

Notes:

- `.Name` from inspect includes a leading `/` (`/web-dev-1`) — a historical quirk.
- `docker ps --filter` with two different keys ANDs them; repeating the *same* key ORs them (`--filter label=a --filter label=b` requires both labels, but `--filter status=exited --filter status=created` matches either).
- `prune` with a label filter is the safest way to clean up only what a script created. Compose uses the same mechanism with its `com.docker.compose.project` label.
:::

### Clean up

```bash
docker rm -f unrelated api api2 2>/dev/null || true
```

## Lab 6: Challenge — a production-style run script

:::meta
difficulty: hard
time: 40 min
:::

Goal: combine everything into a script that runs the demo server the way you would on a single server without an orchestrator.

### Requirements

Write `run-api.sh` that:

1. Accepts the image tag as `$1` (default `node:22-alpine`) and runs `server.js` from this folder.
2. Replaces any existing container named `demo-api` (idempotent: running it twice works).
3. Publishes the app only on `127.0.0.1:8095`.
4. Reads configuration from `prod.env` (create it with `APP_MESSAGE=production` and `GRACEFUL=true`).
5. Limits memory to 128 MiB with no swap, CPU to 0.5 and processes to 100.
6. Restarts on failure at most 5 times, and survives engine restarts unless stopped manually — pick the one policy that best fits and justify it in a comment.
7. Rotates logs: at most 3 files of 5 MB.
8. Uses an init process **and** shuts down gracefully within 15 seconds.
9. Labels the container with `com.example.project=shipit` and the git-style version `com.example.version=$1`.
10. Waits until the app responds on `/` (max 10 s) and exits non-zero with the last 20 log lines if it doesn't.

Then prove: `docker stop demo-api` exits 0 quickly, and `docker inspect` shows every setting.

:::hint
You cannot combine `on-failure:5` and `unless-stopped` — a container has exactly one policy. Decide which requirement matters more. For the wait loop, `curl -fsS --max-time 1` in a `for i in $(seq 1 10)` loop with `sleep 1` works. `--stop-timeout 15` sets the grace period.
:::

:::solution
```bash
#!/usr/bin/env bash
# run-api.sh — run the demo API like a single-host production service
set -euo pipefail
IMAGE="${1:-node:22-alpine}"
NAME=demo-api
cd "$(dirname "$0")"

[ -f prod.env ] || printf 'APP_MESSAGE=production\nGRACEFUL=true\n' > prod.env

docker rm -f "$NAME" >/dev/null 2>&1 || true

# Restart policy: unless-stopped. on-failure:5 would give up after 5 crashes and would not
# start the service after a reboot; for a long-running API we prefer to always come back
# (and alert on RestartCount) — but respect a deliberate manual stop.
docker run -d --name "$NAME" \
  --env-file prod.env \
  -p 127.0.0.1:8095:3000 \
  --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 100 \
  --restart unless-stopped \
  --log-driver json-file --log-opt max-size=5m --log-opt max-file=3 \
  --init --stop-timeout 15 \
  --label com.example.project=shipit \
  --label "com.example.version=$IMAGE" \
  -v "$PWD/server.js":/app/server.js:ro -w /app \
  "$IMAGE" node server.js >/dev/null

for i in $(seq 1 10); do
  if curl -fsS --max-time 1 http://127.0.0.1:8095/ >/dev/null 2>&1; then
    echo "$NAME is up (attempt $i)"
    exit 0
  fi
  sleep 1
done

echo "$NAME did not become ready in 10s; last logs:" >&2
docker logs --tail 20 "$NAME" >&2
exit 1
```

Prove it:

```bash
chmod +x run-api.sh && ./run-api.sh && ./run-api.sh      # idempotent
docker inspect demo-api --format '
policy={{.HostConfig.RestartPolicy.Name}} init={{.HostConfig.Init}} stopTimeout={{.Config.StopTimeout}}
mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}
log={{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}
labels={{json .Config.Labels}}
ports={{json .HostConfig.PortBindings}}'
time docker stop demo-api && docker inspect -f 'exit={{.State.ExitCode}}' demo-api
```

Expected: `exit=0` in well under a second (no in-flight requests), because tini forwards SIGTERM to node and the app's handler closes the server.

Alternative accepted answer: `--restart on-failure:5` with a comment explaining that crash loops should stop and page someone rather than restart forever. Either is fine if justified — this is exactly the trade-off Kubernetes resolves with `restartPolicy: Always` plus back-off and alerting.

This script is roughly what a Compose file or a Kubernetes Deployment declares for you. Keep it — you'll translate it to `compose.yaml` and to a Deployment manifest in later modules.
:::

### Clean up

```bash
docker rm -f demo-api
cd ~ && rm -rf ~/hub-labs/run
```
