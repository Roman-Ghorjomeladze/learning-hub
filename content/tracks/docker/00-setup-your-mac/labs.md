These labs get your Mac ready for every other track. You need macOS 13 or newer, an admin account and a network connection. Commands assume zsh (the macOS default) and Apple Silicon; Intel differences are noted where they matter.

When a lab says "your runtime", substitute the one you installed: Docker Desktop (context `desktop-linux`), OrbStack (`orbstack`) or Colima (`colima`).

## Lab 1: Install and verify the toolchain

:::meta
difficulty: easy
time: 30 min
:::

Goal: have one container runtime and every CLI used in the hub installed, and prove each one works.

### Steps

1. Install Homebrew if `brew --version` fails (see the lesson), then make sure it is up to date:

```bash
brew update
```

2. Install **one** runtime (pick A, B or C) and start it:

```bash
# A
brew install --cask docker-desktop && open -a Docker
# B
brew install --cask orbstack && open -a OrbStack
# C
brew install colima docker docker-buildx docker-compose
colima start --cpu 4 --memory 8 --disk 100 --vm-type vz --vz-rosetta --mount-type virtiofs
```

3. Install the CLI tools:

```bash
brew install kubectl kind helm k9s jq yq dive trivy hadolint
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
```

4. Save this check script as `~/bin/hub-check.sh` (create `~/bin` if needed), make it executable and run it:

```bash
#!/usr/bin/env bash
# hub-check.sh — verify the learning-hub toolchain
set -u
fail=0
check() {  # name, command...
  local name=$1; shift
  if out=$("$@" 2>&1 | head -n1); then
    printf '  %-10s OK   %s\n' "$name" "$out"
  else
    printf '  %-10s FAIL %s\n' "$name" "$out"; fail=1
  fi
}
echo "Container engine:"
check docker   docker version --format 'client {{.Client.Version}} / server {{.Server.Version}}'
check compose  docker compose version --short
check buildx   docker buildx version
check context  docker context show
echo "CLI tools:"
check kubectl  kubectl version --client
check kind     kind version
check helm     helm version --short
check k9s      k9s version --short
check terraform terraform version
check jq       jq --version
check yq       yq --version
check dive     dive --version
check trivy    trivy --version
check hadolint hadolint --version
exit $fail
```

```bash
mkdir -p ~/bin
# paste the script into ~/bin/hub-check.sh, then:
chmod +x ~/bin/hub-check.sh
~/bin/hub-check.sh
```

### Verify

- Every line prints `OK`.
- The docker line shows **both** a client and a server version.
- `terraform version` shows a current 1.x release (not 1.5.7 — that would be Homebrew core's frozen formula).

:::hint
If the docker line fails with "Cannot connect", the runtime is installed but not running, or the CLI points at another context. Run `docker context ls`. If `docker compose` fails under Colima, you forgot `cliPluginsExtraDirs` in `~/.docker/config.json`.
:::

:::solution
For Colima, the missing piece is usually the plugin directory:

```bash
mkdir -p ~/.docker
cat ~/.docker/config.json 2>/dev/null   # if it exists, merge by hand instead of overwriting
echo '{ "cliPluginsExtraDirs": ["'"$(brew --prefix)"'/lib/docker/cli-plugins"] }' > ~/.docker/config.json
docker compose version
```

If terraform shows 1.5.7, remove the core formula and install from the tap:

```bash
brew uninstall terraform
brew install hashicorp/tap/terraform
terraform version
```

If a single tool is missing, `brew install <tool>` and re-run the script. The script's exit code is 0 only when everything passed, so you can reuse it later (`~/bin/hub-check.sh && echo ready`).
:::

### Clean up

Nothing to clean up — keep these tools.

## Lab 2: Hello container — and where it really runs

:::meta
difficulty: easy
time: 15 min
:::

Goal: run your first containers and prove to yourself that they run in a Linux VM, not on macOS.

### Steps

1. Run the classic test image and read its output — it describes the client → daemon → registry flow:

```bash
docker run --rm hello-world
```

2. Compare the kernel and architecture on your Mac and in a container:

```bash
uname -sm                                   # Darwin arm64
docker run --rm alpine uname -srm           # Linux 6.x... aarch64
docker run --rm --platform linux/amd64 alpine uname -m   # x86_64 (emulated)
```

3. Compare CPU count and memory:

```bash
sysctl -n hw.ncpu; echo "$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 )) GiB"
docker run --rm alpine sh -c 'nproc; free -m | head -2'
```

4. Start a web server and reach it from the Mac:

```bash
docker run -d --name hello-web -p 8080:80 nginx:alpine
curl -sI http://localhost:8080 | head -1
docker inspect hello-web --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

5. Try to reach the container IP directly (replace with the IP you got):

```bash
curl -s --max-time 3 http://172.17.0.2 || echo "not reachable from macOS"
```

6. Reach your Mac *from* a container. Start a tiny server on the Mac, then call it:

```bash
python3 -m http.server 9999 --bind 127.0.0.1 &   # serves the current dir on the Mac
docker run --rm curlimages/curl -s -o /dev/null -w '%{http_code}\n' http://host.docker.internal:9999/
kill %1
```

### Verify

- `uname` in the container says `Linux`, not `Darwin`.
- `nproc`/`free` in the container show the **VM's** resources, which are smaller than your Mac's.
- `curl localhost:8080` returns `HTTP/1.1 200 OK`.
- The container IP is not reachable from macOS on Docker Desktop and Colima (OrbStack is the exception: it routes container IPs to the Mac).
- The request to `host.docker.internal` returns `200`.

:::hint
If step 6 prints `000` or times out, your Mac's firewall may block Python, or you are on a runtime that resolves `host.docker.internal` differently. Try `--add-host=host.docker.internal:host-gateway` on the `docker run`.
:::

:::solution
Expected output (values vary):

```text
$ uname -sm
Darwin arm64
$ docker run --rm alpine uname -srm
Linux 6.10.14-linuxkit aarch64
$ docker run --rm --platform linux/amd64 alpine uname -m
x86_64
$ docker run --rm alpine sh -c 'nproc; free -m | head -2'
8
              total        used        free      shared  buff/cache   available
Mem:           7838         612        6501           2         724        7004
$ curl -sI http://localhost:8080 | head -1
HTTP/1.1 200 OK
```

The container's kernel is the VM's Linux kernel. Port `8080` works because the runtime forwards it from macOS into the VM; the container IP lives on a bridge inside the VM, so macOS has no route to it. `host.docker.internal` is a DNS name the runtime injects that points back at the Mac.
:::

### Clean up

```bash
docker rm -f hello-web
docker image rm hello-world
```

## Lab 3: Size the VM and watch limits apply

:::meta
difficulty: medium
time: 20 min
:::

Goal: change the VM's CPU and memory, confirm the engine sees it, and see the difference between the VM budget and a per-container limit.

### Steps

1. Record the current values:

```bash
docker info --format 'cpus={{.NCPU}} mem={{.MemTotal}}' | tee /tmp/vm-before.txt
```

2. Change the VM to **4 CPUs and 6 GB** of memory:
   - Docker Desktop: Settings → Resources → Advanced → CPU limit 4, Memory limit 6 GB → Apply & restart.
   - OrbStack: Settings → System → CPU limit 4, Memory limit 6 GB (restart OrbStack if asked).
   - Colima: `colima stop && colima start --cpu 4 --memory 6`.

3. Check again:

```bash
docker info --format 'cpus={{.NCPU}} mem={{.MemTotal}}'
docker run --rm alpine sh -c 'nproc; free -m | sed -n 2p'
```

4. Now apply a **container** limit below the VM size and look at it from inside (cgroup v2 files):

```bash
docker run --rm --cpus 1.5 --memory 256m alpine sh -c 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max; nproc'
```

5. Restore the sizes you want to keep for the hub (recommended: 6 CPUs / 8–10 GB if your Mac has 16 GB+).

### Verify

- `docker info` reflects the new CPU count and roughly 6 GB (`MemTotal` ≈ 6,000,000,000+ bytes; the kernel reserves a little).
- In step 4, `cpu.max` shows `150000 100000` and `memory.max` shows `268435456`.
- `nproc` in step 4 still prints 4 — explain why in your own words before opening the solution.

:::hint
`--cpus` is implemented as a CFS **quota** (time slices per period), not by hiding CPUs. `nproc` counts the CPUs the process may be scheduled on (its affinity set), which `--cpus` does not change. Which flag would change it?
:::

:::solution
```text
$ docker run --rm --cpus 1.5 --memory 256m alpine sh -c 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max; nproc'
150000 100000
268435456
4
```

- `cpu.max` = `quota period`: the container may use 150 ms of CPU time per 100 ms period, i.e. 1.5 CPUs worth, spread over any of the 4 CPUs.
- `memory.max` = 256 × 1024 × 1024 bytes.
- `nproc` still says 4 because `--cpus` limits *time*, not *which* CPUs. `--cpuset-cpus 0,1` would pin the container to two CPUs and `nproc` would print 2.

This is why Node.js (and the JVM, Go) may size thread pools from the visible CPU count and over-subscribe a CPU-limited container. Module 02 comes back to this.

The VM limit is the outer box for everything; container limits are inner boxes inside it. A container with no `--memory` can use the whole VM.
:::

### Clean up

Nothing to remove. Make sure you left the VM at a size you are happy with.

## Lab 4: Shell completion and aliases

:::meta
difficulty: easy
time: 15 min
:::

Goal: tab-complete `docker`, `kubectl`, `helm` and `terraform`, and have short aliases that keep completion.

### Steps

1. Back up and edit `~/.zshrc`:

```bash
cp ~/.zshrc ~/.zshrc.bak 2>/dev/null || true
code ~/.zshrc   # or nano ~/.zshrc
```

2. Add the block from the lesson (Homebrew `FPATH`, `compinit`, `kubectl completion`, aliases `d`, `dc`, `dps`, `k`, `tf`, `compdef k=kubectl`).

3. Enable Terraform's completion (it edits your rc file for you) and reload:

```bash
terraform -install-autocomplete
exec zsh
```

4. Test completions: type each line and press Tab where shown:

```text
docker run --rest<TAB>        → --restart
docker context use <TAB>      → lists your contexts
k get dep<TAB>                → deployments
helm rep<TAB>                 → repo
tf pl<TAB>                    → plan
```

### Verify

- `docker run --rest<TAB>` completes to `--restart`.
- `type dps` shows the alias.
- `dps` prints a table with the columns NAMES, IMAGE, STATUS, PORTS.

:::hint
If nothing completes, check order: the `FPATH` line must come **before** `compinit`. Run `echo $fpath | tr ' ' '\n' | grep site-functions` to confirm the Homebrew directory is on the path. If `docker` completion is still missing, generate it: `docker completion zsh > ~/.zsh/completions/_docker` and add `~/.zsh/completions` to `fpath`. kubectl completes resource *types* without a cluster, but resource *names* need a reachable cluster.
:::

:::solution
A working `~/.zshrc` section:

```bash
if type brew &>/dev/null; then
  FPATH="$(brew --prefix)/share/zsh/site-functions:${FPATH}"
fi
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit

source <(kubectl completion zsh)
source <(helm completion zsh)

alias d='docker'
alias dc='docker compose'
alias dps='docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"'
alias k='kubectl'
alias tf='terraform'
compdef k=kubectl

autoload -U +X bashcompinit && bashcompinit
complete -o nospace -C "$(brew --prefix)/bin/terraform" terraform tf
```

The last two lines are what `terraform -install-autocomplete` adds (it uses bash-style completion via `bashcompinit`); adding `tf` to the `complete` line makes the alias complete too. If completion caches look stale after changes, delete `~/.zcompdump*` and run `exec zsh`.
:::

### Clean up

Keep the configuration. If something went wrong, restore with `cp ~/.zshrc.bak ~/.zshrc`.

## Lab 5: Break and fix — "Cannot connect to the Docker daemon"

:::meta
difficulty: medium
time: 20 min
:::

Goal: diagnose a broken CLI setup the way you would on a teammate's laptop. A "setup script" left your shell in a bad state; find every problem without reinstalling anything.

### Steps

1. Note your working context name, then run the sabotage in **a new terminal tab** (it only affects that shell and your CLI config):

```bash
docker context show            # remember this, e.g. orbstack
docker context create staging --docker "host=unix:///tmp/staging-docker.sock" --description "old staging engine"
docker context use staging
export DOCKER_HOST=unix:///var/run/docker-old.sock
```

2. Now try to use Docker:

```bash
docker ps
```

3. Diagnose. Without looking at the commands above, use only these tools to explain the failure: `docker context ls`, `docker context inspect`, `env | grep DOCKER`, `ls -l <socket path>`, `docker version`.

4. Fix it so `docker ps` works, the CLI is back on your real runtime, and the bogus context is gone.

### Verify

- `docker version` shows a Server section.
- `docker context ls` marks your runtime with `*` and `staging` is gone.
- `env | grep DOCKER_HOST` prints nothing.

:::hint
There are **two** independent problems. The CLI resolves the endpoint in this order: `-H` flag → `DOCKER_HOST` → `--context` → `DOCKER_CONTEXT` → the current context saved in `~/.docker/config.json`. `docker context ls` prints a warning when `DOCKER_HOST` overrides the selected context — read it.
:::

:::solution
Diagnosis:

```bash
$ docker ps
Cannot connect to the Docker daemon at unix:///var/run/docker-old.sock. Is the docker daemon running?

$ env | grep DOCKER
DOCKER_HOST=unix:///var/run/docker-old.sock     # problem 1: env var overrides every context

$ ls -l /var/run/docker-old.sock
ls: /var/run/docker-old.sock: No such file or directory

$ docker context ls
Warning: DOCKER_HOST environment variable overrides the active context. ...
NAME        DESCRIPTION          DOCKER ENDPOINT
staging *   old staging engine   unix:///tmp/staging-docker.sock   # problem 2: wrong current context
orbstack    OrbStack             unix:///Users/roma/.orbstack/run/docker.sock
```

Fix both:

```bash
unset DOCKER_HOST                 # problem 1 (also remove any export from ~/.zshrc / ~/.zprofile)
docker ps                         # still fails: now it uses the 'staging' context → /tmp/staging-docker.sock
docker context use orbstack       # problem 2 (use your runtime's context name)
docker context rm staging
docker version
```

Habits worth keeping:

- When the error names a socket path, check that path exists (`ls -l`). A missing file means "runtime stopped or wrong path"; "permission denied" means an ownership problem.
- `grep -n DOCKER_HOST ~/.zshrc ~/.zprofile ~/.bash_profile 2>/dev/null` finds persistent overrides.
- `docker context inspect <name> --format '{{.Endpoints.docker.Host}}'` shows where a context points.
- If the right context points at a correct but missing socket, the runtime itself is down: start it (`open -a OrbStack`, `open -a Docker`, `colima start`) and check its status (`colima status`).
:::

### Clean up

Close the sabotaged terminal tab. Confirm in a fresh tab that `docker context show` prints your runtime.

## Lab 6: Challenge — measure the bind-mount tax

:::meta
difficulty: hard
time: 30 min
:::

Goal: produce numbers that justify the "keep `node_modules` in a volume" advice on *your* machine and runtime.

### Requirements

- Create a working directory `~/hub-labs/fs-bench` on your Mac.
- Using only the `alpine` image, time how long it takes to **create 20,000 small files**, then **stat all of them**, in three locations:
  1. a bind mount of `~/hub-labs/fs-bench`,
  2. a named volume `fsbench`,
  3. the container's own writable layer (e.g. `/tmp` inside the container).
- Print the three timings side by side, and compute roughly how many times slower the bind mount is than the volume.
- Bonus: repeat with a second runtime (if you have one installed) and compare.

No step-by-step this time — use what you know about `-v`, named volumes and `sh` loops.

:::hint
A loop like `i=0; while [ $i -lt 20000 ]; do echo x > f$i; i=$((i+1)); done` creates files in POSIX `sh`. Wrap it with `time sh -c '...'` (BusyBox in alpine provides a `time` applet). `find . -type f | xargs stat > /dev/null` stats them. Remove files between runs so each run starts empty.
:::

:::solution
```bash
mkdir -p ~/hub-labs/fs-bench && cd ~/hub-labs/fs-bench

cat > bench.sh <<'EOF'
#!/bin/sh
# usage: bench.sh <dir>   (BusyBox `time` prints real/user/sys to stderr)
cd "$1" && rm -rf bench && mkdir bench && cd bench
echo "== $1: create 20000 files"
time sh -c 'i=0; while [ $i -lt 20000 ]; do echo x > "f$i"; i=$((i+1)); done'
echo "== $1: stat all files"
time sh -c 'find . -type f -exec stat {} + > /dev/null'
cd .. && rm -rf bench
EOF
chmod +x bench.sh

docker volume create fsbench
docker run --rm -v "$PWD":/bind -v fsbench:/vol -v "$PWD/bench.sh":/bench.sh:ro alpine sh -c '
  /bench.sh /bind
  /bench.sh /vol
  /bench.sh /tmp
'
```

Typical result on Apple Silicon with VirtioFS (your numbers will differ):

```text
== /bind: create 20000 files
real	0m 9.80s
== /bind: stat all files
real	0m 2.10s
== /vol: create 20000 files
real	0m 1.30s
== /vol: stat all files
real	0m 0.14s
== /tmp: create 20000 files
real	0m 1.25s
== /tmp: stat all files
real	0m 0.13s
```

(`user`/`sys` lines omitted.)

Named volumes and the container layer both live on the VM's own disk, so they perform like native Linux. The bind mount pays the VM-boundary cost on every file operation — here roughly 7× slower for creation and 15× for stat. OrbStack usually narrows the gap considerably thanks to caching; Colima with sshfs (if you didn't pass `--mount-type virtiofs`) is much worse.

The practical takeaway: bind-mount source code you edit, keep dependency trees (`node_modules`) and build output in named volumes or inside the image, and use Compose file sync for large repos.
:::

### Clean up

```bash
docker volume rm fsbench
rm -rf ~/hub-labs/fs-bench
```
