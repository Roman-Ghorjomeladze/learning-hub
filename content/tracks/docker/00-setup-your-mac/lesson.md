This module sets up your Mac once for the whole hub: Docker, Kubernetes, Terraform and the projects track all rely on the tools installed here. More importantly, it explains *what you are actually running* when you type `docker run` on a Mac — because most "Docker is weird on my Mac" problems (slow `npm install` in a bind mount, an image that crashes with `exec format error`, `Cannot connect to the Docker daemon`) come straight from the architecture described below.

## The mental model: Docker on a Mac is a Linux VM

Containers are a **Linux kernel feature** (namespaces + cgroups + layered filesystems — module 01 goes deep). macOS has a different kernel (XNU), so it cannot run Linux containers natively. Every Mac container runtime therefore does the same thing:

1. Boots a small **Linux virtual machine** using Apple's Virtualization framework (`vz`) or QEMU.
2. Runs the Docker Engine (`dockerd` + `containerd` + `runc`) **inside that VM**.
3. Exposes the engine's API socket on your Mac (a Unix socket file such as `~/.docker/run/docker.sock`).
4. Forwards published ports from the VM to `localhost` on your Mac, and shares selected Mac folders into the VM so bind mounts work.

```text
 macOS (your laptop)                         Linux VM (arm64)
 ┌─────────────────────────────┐            ┌─────────────────────────────────┐
 │  docker CLI  kubectl  kind  │            │  dockerd ──► containerd ──► runc│
 │      │                      │  API over  │     │                     │     │
 │      └── ~/.docker/run/ ────┼── socket ──┼─────┘            container processes
 │          docker.sock        │            │                  (node, postgres) │
 │                             │            │                                  │
 │  ~/code/shipit  ◄───────────┼─ VirtioFS ─┼──► /Users/roma/code/shipit (mount)│
 │  localhost:3000 ◄───────────┼─ port fwd ─┼──► container :3000                │
 └─────────────────────────────┘            └─────────────────────────────────┘
```

The `docker` command on your Mac is just an **HTTP client**. It sends REST calls to whatever socket the current *context* points to. If the VM is stopped, or the socket path is wrong, the CLI has nobody to talk to — that is the classic `Cannot connect to the Docker daemon at unix:///var/run/docker.sock` error.

Consequences you will feel every day:

| Effect | Why |
| --- | --- |
| Bind mounts are slower than on Linux | Every file operation crosses the VM boundary through a file-sharing layer (VirtioFS). `node_modules` with tens of thousands of small files hurts most. |
| Container IPs (`172.17.0.x`) are not reachable from macOS (Docker Desktop, Colima) | They live on a bridge inside the VM. Use published ports (`-p 3000:3000`). |
| `--network host` means the **VM's** network by default | Not your Mac's interfaces. Recent Docker Desktop versions have an opt-in host-networking setting, but don't rely on it for portable setups. |
| The VM has its own CPU/RAM/disk budget | Containers can't use more than the VM has. Postgres + Redis + a kind cluster can easily need 6–8 GB. |
| amd64 images run under emulation | Your Apple Silicon Mac is arm64. amd64-only images run via Rosetta or QEMU — slower, and occasionally broken. |
| Reaching your Mac from a container needs a special name | `host.docker.internal` resolves to the Mac host (works in Docker Desktop, OrbStack and Colima). |

:::mac Apple Silicon vs Intel
On Apple Silicon (M1–M4) the VM is **arm64**, so `docker pull node:22` fetches the `linux/arm64` variant automatically. On an Intel Mac the VM is amd64 and emulation questions mostly disappear — but your images then won't be tested on arm64, which matters if you deploy to AWS Graviton. Check what you have with `uname -m` (`arm64` or `x86_64`).
:::

## Choosing a container runtime

You need exactly **one** runtime running at a time (you can install several, but running two engines at once just burns RAM). The three realistic choices in 2026:

| | Docker Desktop | OrbStack | Colima |
| --- | --- | --- | --- |
| What it is | Docker's official app: engine, GUI, Compose, buildx, Scout, extensions, optional Kubernetes | Fast, native-feeling macOS app running Docker and Linux machines | Open-source CLI wrapper around Lima VMs |
| Licence | Free for personal use, education, non-commercial open source and small businesses (fewer than 250 employees **and** less than $10M annual revenue); paid subscription otherwise | Free for personal use; paid licence for commercial use | MIT, free for everyone |
| Resource use | Heaviest; fixed memory allocation (Resource Saver pauses the VM when idle) | Light; memory grows and shrinks dynamically | Light; fixed allocation you configure |
| File sharing | VirtioFS (default); paid "synchronized file shares" for big repos | VirtioFS with aggressive caching — usually the fastest bind mounts | VirtioFS (with `vz`) or sshfs/9p |
| amd64 emulation | Rosetta (toggle in settings) or QEMU | Rosetta by default | Rosetta with `--vz-rosetta`, or QEMU |
| Networking extras | `host.docker.internal` | Container IPs reachable from macOS, automatic `*.orb.local` domains | Basic; `--network-address` for a reachable VM IP |
| Kubernetes | Optional built-in (kubeadm or kind-based) | Optional built-in single-node cluster | Optional k3s via `--kubernetes` |
| Best for | The "official" experience, GUI, docs match exactly | Daily driver on a laptop: speed and battery | Fully free/OSS, scriptable, CI-like |

**Recommendation for this hub:** any of them works, because all labs use the standard `docker` CLI and kind for Kubernetes. If you are learning on your own machine, OrbStack is the most pleasant; Docker Desktop is the reference implementation that matches Docker's docs and many company setups; Colima is the zero-cost OSS answer if licensing matters. Don't enable the built-in Kubernetes of any of them — the Kubernetes track uses **kind**, which you can create and destroy in seconds.

:::warning Licensing is a real-world interview and compliance topic
Docker Desktop's subscription requirement applies to *commercial use in larger companies*, not to the Docker Engine itself (which is Apache-2.0 open source). Many companies moved to Colima, OrbStack (with commercial licences), Rancher Desktop or Podman Desktop for this reason. If you install a runtime on a work laptop, check your employer's policy.
:::

## Install Homebrew and the runtime

Homebrew is the package manager everything else uses. If `brew --version` already works, skip this.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Apple Silicon installs to /opt/homebrew; add it to your shell:
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
brew --version
```

:::mac Where Homebrew lives
Apple Silicon: `/opt/homebrew`. Intel: `/usr/local`. `brew --prefix` prints the right one; use `$(brew --prefix)` in scripts instead of hard-coding paths.
:::

Then pick **one** runtime:

```bash
# Option A — Docker Desktop (the cask is named docker-desktop)
brew install --cask docker-desktop
open -a Docker            # first start asks for permissions and the licence agreement

# Option B — OrbStack
brew install --cask orbstack
open -a OrbStack

# Option C — Colima (CLI-only; install the docker CLI and plugins separately)
brew install colima docker docker-buildx docker-compose
colima start --cpu 4 --memory 8 --disk 100 --vm-type vz --vz-rosetta --mount-type virtiofs
```

With Colima, the Homebrew `docker-buildx` and `docker-compose` formulae install CLI *plugins*; tell the docker CLI where they are by adding this to `~/.docker/config.json` (create the file if needed, merge if it exists):

```json
{
  "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]
}
```

Docker Desktop and OrbStack bundle the CLI, Compose and buildx for you.

## Verify the installation

Run these right after installing — and whenever something feels off:

```bash
docker version          # Client AND Server sections; no Server = no daemon reachable
docker info             # engine details: OS, arch, CPUs, memory, storage driver, cgroup version
docker context ls       # which endpoint the CLI is using (marked with *)
docker compose version  # Compose v2 plugin
docker buildx version   # BuildKit client
docker run --rm hello-world
```

Read `docker info` deliberately the first time. The useful lines:

```text
 Server Version: 29.x.x
 Storage Driver: overlayfs            # containerd image store (default for new installs)
  driver-type: io.containerd.snapshotter.v1
 Cgroup Driver: cgroupfs
 Cgroup Version: 2
 Kernel Version: 6.x.x-linuxkit       # the VM's Linux kernel, not macOS
 Operating System: Docker Desktop     # or OrbStack / Ubuntu (Colima)
 Architecture: aarch64                # arm64 VM on Apple Silicon
 CPUs: 8
 Total Memory: 7.6GiB                 # the VM's memory, not your Mac's
```

:::try Read the engine with format templates
Instead of scrolling `docker info`, ask for exactly what you want:

```bash
docker info --format 'arch={{.Architecture}} cpus={{.NCPU}} mem={{.MemTotal}} kernel={{.KernelVersion}}'
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}'
```

`MemTotal` is in bytes. Divide by 1024³ to get GiB. Templates like these come back in every module.
:::

## Docker contexts: which daemon am I talking to?

A **context** bundles an endpoint (a Unix socket, an SSH host, or a TCP address with TLS) under a name. Each runtime creates its own:

| Runtime | Context name | Socket |
| --- | --- | --- |
| Docker Desktop | `desktop-linux` | `~/.docker/run/docker.sock` (plus `/var/run/docker.sock` if you allow the default socket in settings) |
| OrbStack | `orbstack` | `~/.orbstack/run/docker.sock` |
| Colima | `colima` | `~/.colima/default/docker.sock` |
| Fallback | `default` | `/var/run/docker.sock` (or `$DOCKER_HOST`) |

```bash
docker context ls
docker context use orbstack        # persistently switch (stored in ~/.docker/config.json)
docker --context colima ps         # one-off command against another engine
docker context inspect orbstack --format '{{.Endpoints.docker.Host}}'

# Remote engine over SSH — handy for a Linux box or EC2 instance
docker context create lab-box --docker "host=ssh://roma@10.0.0.5"
```

Resolution order matters when debugging: **`--host`/`-H` flag → `DOCKER_HOST` env var → `--context` flag → `DOCKER_CONTEXT` env var → current context in `~/.docker/config.json`**. A stale `export DOCKER_HOST=...` in your `.zshrc` silently overrides every context you select — a very common cause of "I switched runtimes and now nothing works".

:::warning Two runtimes, two sets of images
Images, containers and volumes live **inside each runtime's VM**. If you build `shipit-api` under OrbStack and then switch the context to Docker Desktop, the image is "gone" — it is in the other VM. Pick one runtime and stop the others (`colima stop`, quit Docker Desktop / OrbStack).
:::

## Size the VM: CPU, memory, disk

The VM is a fixed box all your containers share. Reasonable starting points for this hub (Postgres, Redis, the API, and later a 3-node kind cluster):

| Resource | Minimum | Comfortable |
| --- | --- | --- |
| CPUs | 4 | 6–8 |
| Memory | 6 GB | 8–12 GB |
| Disk | 60 GB | 100 GB |

Where to change it:

- **Docker Desktop**: Settings → Resources → Advanced (CPU limit, memory limit, swap, disk usage limit). Also Settings → General for the VM manager, file sharing implementation and the Rosetta toggle.
- **OrbStack**: Settings → System (memory limit, CPU limit). Memory is allocated on demand, so a high limit is fine.
- **Colima**: `colima stop && colima start --cpu 6 --memory 10 --disk 100`, or edit the profile with `colima start --edit` (stored in `~/.colima/default/colima.yaml`). Disk size can only be increased, not shrunk.

Disk fills up silently. Images, build cache and stopped containers accumulate:

```bash
docker system df              # what's using space: images, containers, volumes, build cache
docker system df -v           # per-object breakdown
docker builder prune          # build cache is often the biggest consumer
docker system prune           # stopped containers, unused networks, dangling images, build cache
```

:::info The VM disk is a sparse file
Docker Desktop stores everything in one disk image (`Docker.raw`) under `~/Library/Containers/com.docker.docker/`. Finder may report its maximum size, while `du -h` shows the real usage. Pruning inside Docker frees space in the image; the file shrinks over time (TRIM). Never delete it by hand while Docker runs.
:::

## Bind mounts, file sharing and performance

When you run `docker run -v "$PWD":/app ...`, the Linux kernel in the VM needs to see your Mac's folder. Runtimes do this with a **shared filesystem**:

- **VirtioFS** (default in Docker Desktop on modern macOS, OrbStack, and Colima with `--vm-type vz --mount-type virtiofs`): a virtio device that maps host files into the guest. Much faster than the old gRPC-FUSE/osxfs and sshfs options.
- Still, every `stat`, `open` and `read` crosses the VM boundary. A Node project's `npm install` creates 30,000+ files; doing that in a bind mount can be several times slower than on a Linux host.

Practical patterns for Node/NestJS dev containers:

```bash
# Keep source code bind-mounted, but put node_modules in a named volume that lives inside the VM
docker run --rm -it \
  -v "$PWD":/app \
  -v shipit_node_modules:/app/node_modules \
  -w /app node:22 npm install
```

- Bind-mount only what you edit (source), not dependency or build output directories.
- Use Compose's `develop.watch` (Compose track) to *sync* files instead of mounting them.
- Docker Desktop shares only certain paths (by default `/Users`, `/Volumes`, `/private`, `/tmp`, `/var/folders`). Mounting a path outside those gives an error or an empty directory — check Settings → Resources → File sharing.
- File-change events (used by `nodemon`, `tsc --watch`, Vite) generally propagate through VirtioFS, but if a watcher misses changes, switch it to polling (`CHOKIDAR_USEPOLLING=1`, `--poll`).

:::deep How the pieces fit: vz, VirtioFS, Rosetta, and the network
On macOS 13+ the runtimes use Apple's **Virtualization.framework** ("vz"), a high-level hypervisor API on top of Hypervisor.framework. It gives the guest paravirtual devices: virtio-net for networking, virtio-blk for the disk image, **virtio-fs** for shared folders and virtio-vsock for fast host↔guest sockets.

- **The Docker socket on your Mac** is a proxy: the runtime listens on a Unix socket on macOS and forwards bytes over vsock to the real `/var/run/docker.sock` inside the VM.
- **Published ports** work the same way: when you run `-p 3000:3000`, the engine tells the runtime's host-side helper to listen on `localhost:3000` on macOS and forward connections into the VM, where Docker's own NAT (iptables/nftables) sends them to the container.
- **Rosetta for Linux**: Apple ships a Linux build of Rosetta 2 that vz can expose to the guest. The Linux kernel registers it with `binfmt_misc`, so when the guest tries to execute an x86-64 ELF binary, the kernel hands it to Rosetta, which translates it to arm64 on the fly. This is much faster than QEMU user-mode emulation, which the runtimes fall back to when Rosetta is unavailable or for other architectures (e.g. `linux/riscv64`).
- **Emulation is not perfect**: some amd64 binaries use CPU features (AVX, specific syscalls) that emulation does not support, giving crashes or `illegal instruction`. Prefer multi-arch images (almost all official images are) and build your own images for both architectures (module 04).

You can see the binfmt handlers from inside the VM:

```bash
docker run --rm --privileged alpine ls /proc/sys/fs/binfmt_misc/
```

Entries like `rosetta` or `qemu-x86_64` show which emulators are registered.
:::

### Running amd64 images on Apple Silicon

```bash
docker run --rm alpine uname -m                         # aarch64 (native)
docker run --rm --platform linux/amd64 alpine uname -m  # x86_64 (emulated)
docker image inspect alpine --format '{{.Os}}/{{.Architecture}}'
```

If you see `exec format error` or the warning *"The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8)"*, the image has no arm64 variant. Options: use a multi-arch alternative, pass `--platform linux/amd64` explicitly (with Rosetta enabled), or build the image yourself for arm64.

## Install the CLI toolchain

Everything later in the hub, in one go:

```bash
brew install kubectl kind helm k9s jq yq dive trivy hadolint
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
```

| Tool | Used for | Check |
| --- | --- | --- |
| `kubectl` | Kubernetes CLI | `kubectl version --client` |
| `kind` | Kubernetes clusters as Docker containers | `kind version` |
| `helm` | Kubernetes package manager | `helm version` |
| `k9s` | Terminal UI for clusters | `k9s version` |
| `terraform` | Infrastructure as code | `terraform version` |
| `jq` | Query JSON (`docker inspect`, `kubectl -o json`) | `jq --version` |
| `yq` | Query/edit YAML (mikefarah's Go version) | `yq --version` |
| `dive` | Explore image layers and wasted space | `dive --version` |
| `trivy` | Scan images, filesystems and IaC for vulnerabilities and misconfigurations | `trivy --version` |
| `hadolint` | Lint Dockerfiles | `hadolint --version` |

:::info Why the HashiCorp tap for Terraform?
In 2023 HashiCorp changed Terraform's licence to the Business Source License (BSL). Homebrew core only ships OSI-licensed software, so its `terraform` formula is frozen at the last open-source version (1.5.x). The official `hashicorp/tap/terraform` formula gives you current releases. The open-source fork **OpenTofu** is available as `brew install opentofu` — the Terraform track covers the differences.
:::

Keep everything current with `brew update && brew upgrade`. To see what is outdated first: `brew outdated`.

## Editor setup (VS Code)

Useful extensions for this hub (install from the Extensions view or with `code --install-extension <id>`):

| Extension | ID | Why |
| --- | --- | --- |
| Container Tools (Microsoft; successor of the "Docker" extension) | `ms-azuretools.vscode-containers` | Explorer for containers/images/volumes, Compose commands, debugging in containers |
| Docker DX (Docker Inc.) | `docker.docker` | Dockerfile/Compose language support, build check warnings, image vulnerability hints |
| Dev Containers | `ms-vscode-remote.remote-containers` | Develop inside a container defined by `devcontainer.json` |
| Kubernetes | `ms-kubernetes-tools.vscode-kubernetes-tools` | Cluster explorer, manifest helpers |
| YAML (Red Hat) | `redhat.vscode-yaml` | Schema validation for Kubernetes and Compose YAML |
| HashiCorp Terraform | `hashicorp.terraform` | HCL syntax, validation, formatting |
| hadolint | `exiasr.hadolint` | Inline Dockerfile lint warnings (uses the `hadolint` binary) |

:::tip Let the CLI open VS Code
In VS Code run "Shell Command: Install 'code' command in PATH" from the command palette. Then `code .` opens the current folder, and `code --install-extension redhat.vscode-yaml` installs extensions from scripts.
:::

## Shell completion and aliases

macOS uses zsh by default. Homebrew installs completion scripts for most formulae into `$(brew --prefix)/share/zsh/site-functions`; zsh only loads them if `compinit` runs **after** that directory is on `fpath`. Add this to `~/.zshrc` (if you use Oh My Zsh, it runs `compinit` for you — just make sure the `fpath` line comes before `source $ZSH/oh-my-zsh.sh`):

```bash
# ~/.zshrc
if type brew &>/dev/null; then
  FPATH="$(brew --prefix)/share/zsh/site-functions:${FPATH}"
fi
autoload -Uz compinit && compinit

# Docker Desktop / OrbStack ship docker's completion; if `docker <TAB>` does nothing, generate it:
#   mkdir -p ~/.zsh/completions && docker completion zsh > ~/.zsh/completions/_docker
#   and add:  fpath=(~/.zsh/completions $fpath)   before compinit
source <(kubectl completion zsh)

# Aliases used throughout the hub
alias d='docker'
alias dc='docker compose'
alias dps='docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"'
alias k='kubectl'
alias tf='terraform'
compdef k=kubectl   # completion also works for the alias
```

Reload with `exec zsh`, then try `docker run --<TAB>` and `k get po<TAB>`.

:::try Make your first useful alias
Add `dps` above, reload the shell, start a container with `docker run -d --name web -p 8080:80 nginx:alpine`, and compare `docker ps` with `dps`. Then remove it: `docker rm -f web`.
:::

## Troubleshooting the most common setup problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cannot connect to the Docker daemon at unix:///var/run/docker.sock` | Runtime not running, or CLI pointed at the wrong socket | Start the runtime; `docker context ls`; `docker context use <runtime>`; check `echo $DOCKER_HOST` |
| `docker: command not found` | CLI not on `PATH` (Colima without `brew install docker`, or Docker Desktop's symlinks missing) | `brew install docker` (Colima) or Docker Desktop → Settings → Advanced → system/user CLI tools |
| `docker compose` → `'compose' is not a docker command` | Plugin not found | Install `docker-compose` and set `cliPluginsExtraDirs` (Colima) |
| `exec format error` | amd64-only image or binary on arm64 | Use a multi-arch image, `--platform linux/amd64` with Rosetta, or rebuild |
| `no space left on device` during builds | VM disk full | `docker system df`, `docker builder prune`, raise the disk limit |
| Containers killed randomly, exit code 137 | VM (or container) out of memory | Raise VM memory, set realistic `--memory` limits |
| Bind mount is empty | Path not shared with the VM | Add the folder to file sharing; keep projects under `/Users` |
| Everything is slow after switching runtimes | Two VMs running | Quit the runtime you are not using |

:::warning Don't "fix" the socket with chmod 777 or sudo
On a Mac you should never need `sudo docker`. If `docker` only works with sudo, a root-owned socket or config is left over from an old install (often `~/.docker` owned by root). Fix ownership with `sudo chown -R "$USER" ~/.docker` instead of running Docker as root.
:::

## Summary

- Docker on macOS = Docker Engine inside a Linux VM, reached through a forwarded Unix socket.
- Docker Desktop, OrbStack and Colima differ mainly in licensing, resource behaviour and polish; pick one and stop the others.
- `docker context` (and `DOCKER_HOST`) decide which engine the CLI talks to.
- The VM's CPU, memory and disk are a shared budget; prune regularly.
- Bind mounts cross the VM boundary — keep `node_modules` in a volume.
- Apple Silicon is arm64; amd64 images run under Rosetta/QEMU emulation, so build multi-arch images for production.
