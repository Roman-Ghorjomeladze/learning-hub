"A container is a lightweight VM" is the most common — and most misleading — answer in interviews. A container is **a normal Linux process** (or a group of them) that the kernel lies to about what it can see and limits in what it can use. There is no container object in the Linux kernel. Once you see that, most Docker behaviour stops being magic: why PID 1 matters, why `free` shows the wrong memory, why a container can be OOM-killed while the host is fine, and why `--privileged` is dangerous.

## The mental model: four ingredients

```text
            ┌───────────────────────────── a "container" ─────────────────────────────┐
            │                                                                          │
            │   process tree: node dist/index.js (PID 1 inside, PID 48213 on the host)│
            │                                                                          │
            │  1. NAMESPACES  what it can SEE    pid, net, mnt, uts, ipc, user, cgroup │
            │  2. CGROUPS     what it can USE    memory.max, cpu.max, pids.max, io.max │
            │  3. ROOT FS     what files it has  overlayfs: image layers + writable layer
            │  4. SECURITY    what it may DO     capabilities, seccomp, AppArmor/SELinux│
            │                                                                          │
            └──────────────────────────── all on ONE shared Linux kernel ─────────────┘
```

1. **Namespaces** give the process its own view of system resources: its own PID numbers, network interfaces, mount table, hostname and so on.
2. **Control groups (cgroups)** account for and limit resources: memory, CPU time, number of processes, block I/O.
3. **A root filesystem** assembled from read-only image layers plus a thin writable layer, using a union filesystem (overlayfs), then made the process's `/` with `pivot_root`.
4. **Reduced privileges**: a trimmed set of Linux capabilities, a seccomp filter blocking dangerous syscalls, and an LSM profile (AppArmor or SELinux) — so that "root in the container" is a weaker root.

:::mac Where these labs really run
On your Mac, every container in this module runs inside the runtime's Linux VM (module 00). "The host" in commands like `--pid=host` means that VM, and PIDs from `docker inspect` are VM PIDs. That's convenient: you can use `--privileged` experiments freely, because the worst case is restarting a disposable VM.
:::

Docker, containerd, Kubernetes and Podman are all just convenient ways to set up those four things and start a process inside them.

## Namespaces: what a process can see

A namespace wraps a global system resource so processes inside it get an isolated instance. Linux has eight types; Docker uses seven by default (the time namespace is rarely used).

| Namespace | Isolates | Effect in a container | Docker flag to share the host's |
| --- | --- | --- | --- |
| `pid` | Process IDs | Your app is PID 1 and sees only its own processes | `--pid=host` |
| `net` | Network interfaces, routes, iptables, ports | Own `eth0`, own `localhost`, own port 3000 | `--network host` |
| `mnt` | Mount table | Own `/`, own mounts; host filesystems invisible | (n/a — use volumes/bind mounts) |
| `uts` | Hostname and domain name | `hostname` returns the container ID | `--uts=host` |
| `ipc` | System V IPC, POSIX message queues, shared memory | Own `/dev/shm` | `--ipc=host` (or `container:<name>`) |
| `user` | UID/GID mappings | Root inside can map to an unprivileged UID outside | not used by default; enabled by `userns-remap` or rootless mode |
| `cgroup` | View of the cgroup hierarchy | `/sys/fs/cgroup` shows only the container's own cgroup | `--cgroupns=host` |

Every process's namespaces are visible as symlinks under `/proc/<pid>/ns`. Two processes are in the same namespace when the inode numbers match:

```bash
docker run --rm alpine ls -l /proc/self/ns
# lrwxrwxrwx ... cgroup -> cgroup:[4026532301]
# lrwxrwxrwx ... ipc -> ipc:[4026532239]
# lrwxrwxrwx ... mnt -> mnt:[4026532237]
# lrwxrwxrwx ... net -> net:[4026532242]
# lrwxrwxrwx ... pid -> pid:[4026532240]
# lrwxrwxrwx ... user -> user:[4026531837]     <- same as the host: no user namespace
# lrwxrwxrwx ... uts -> uts:[4026532238]
```

The system calls behind all of this are `clone()` (create a process in new namespaces), `unshare()` (move the current process into new namespaces) and `setns()` (join an existing namespace — what `docker exec` and `nsenter` do).

:::info Why the user namespace matters for security
Without a user namespace, UID 0 inside the container **is** UID 0 on the host kernel, just with fewer capabilities and filters around it. A container escape as root is a host root compromise. With user namespaces (rootless Docker, Podman, `userns-remap`, or Kubernetes `hostUsers: false`), container root maps to an unprivileged host UID such as 100000. This is also why you should run your app as a non-root `USER` (module 04).
:::

### The PID namespace and the PID 1 problem

Inside a new PID namespace the first process gets PID 1 and takes on init's special duties:

- The kernel **does not apply default signal actions** to PID 1. If PID 1 has no handler for `SIGTERM`, the signal is simply ignored. That is why `docker stop` on a Node app without a `SIGTERM` handler waits 10 seconds and then `SIGKILL`s it.
- PID 1 must **reap zombie** children (call `wait()` on them). A shell script or Node process that spawns children and never reaps them leaves zombies.
- When PID 1 exits, the kernel kills every other process in the namespace — the container is over.

Module 02 shows the fixes (`--init`, exec-form `CMD`, handling `SIGTERM` in Node).

:::try Same process, two PIDs
Start a container, then look at it from the VM's PID namespace:

```bash
docker run -d --name sleeper alpine sleep 3600
docker exec sleeper ps            # sleep is PID 1
docker inspect -f '{{.State.Pid}}' sleeper   # its PID in the VM, e.g. 48213
docker run --rm --pid=host alpine ps -o pid,comm | grep sleep
docker rm -f sleeper
```

The same process has PID 1 in its namespace and a large PID outside. On a Mac, "outside" means the Linux VM.
:::

## cgroups v2: what a process can use

Control groups organise processes into a hierarchy and attach **controllers** to it. Modern distributions, Docker Desktop, OrbStack and Colima all use **cgroup v2**: a single unified tree mounted at `/sys/fs/cgroup`, where each directory is a group and files configure controllers.

Docker creates one cgroup per container (on a systemd host it is something like `/sys/fs/cgroup/system.slice/docker-<id>.scope`). With the default private cgroup namespace, the container sees that directory as its own `/sys/fs/cgroup`.

| `docker run` flag | cgroup v2 file | Meaning |
| --- | --- | --- |
| `--memory 256m` | `memory.max` | Hard limit; exceeding it triggers the OOM killer **inside the cgroup** |
| `--memory-reservation 128m` | `memory.low` | Soft guarantee under memory pressure |
| `--memory-swap` | `memory.swap.max` | Swap allowed (Docker's value is memory **+** swap) |
| `--cpus 1.5` | `cpu.max` → `150000 100000` | CFS quota: 150 ms of CPU per 100 ms period |
| `--cpu-shares 512` | `cpu.weight` | Relative weight when CPUs are contended |
| `--cpuset-cpus 0,1` | `cpuset.cpus` | Which CPUs may be used |
| `--pids-limit 100` | `pids.max` | Maximum number of processes/threads (fork-bomb protection) |
| `--device-read-bps` | `io.max` | Block I/O throttling |

Files worth knowing for debugging:

```bash
cat /sys/fs/cgroup/memory.current   # bytes in use now (includes page cache!)
cat /sys/fs/cgroup/memory.events    # low/high/max/oom/oom_kill counters
cat /sys/fs/cgroup/memory.stat      # anon vs file (cache) breakdown
cat /sys/fs/cgroup/cpu.stat         # usage_usec, nr_throttled, throttled_usec
cat /sys/fs/cgroup/pids.current
```

Two facts that bite Node developers:

- **`free`, `top` and `/proc/meminfo` show the VM/host's memory, not the container limit.** They read `/proc`, which is not namespaced for memory. Tools and runtimes must read the cgroup files to know the real limit. Recent Node versions take the cgroup limit into account when sizing the V8 heap, but `Buffer`s, native addons and thread stacks live outside the heap — so a container can be OOM-killed while the heap looks small.
- **A CPU limit is a time quota, not fewer cores.** `os.cpus().length` still reports every CPU. A process that runs 8 busy threads under `--cpus 1` exhausts its quota early in each 100 ms period and is **throttled** for the rest — visible as latency spikes and a growing `nr_throttled` in `cpu.stat`.

:::warning OOM kills are per cgroup, not per host
When a container exceeds `memory.max`, the kernel OOM-kills a process **inside that cgroup**, even if the host has gigabytes free. You see exit code `137` (128 + SIGKILL) and `"OOMKilled": true` in `docker inspect`. In Kubernetes the same event shows as `OOMKilled` in the pod status. Always check memory first when a container "randomly" dies with 137.
:::

## Overlay filesystems: images, layers and copy-on-write

An image is a stack of **read-only layers**; each layer is a tarball of filesystem changes (files added, changed or deleted) produced by one Dockerfile instruction. When you start a container, the storage driver (overlayfs on all modern setups) stacks those layers and adds one **writable layer** on top:

```text
   container sees:  /  (merged view)
                    ┌──────────────────────────────────────────────┐
   upperdir (rw)    │ /app/logs/today.log   .wh.cache.tmp (whiteout)│  ← this container only
                    ├──────────────────────────────────────────────┤
   lowerdir (ro)    │ layer 3: /app/dist/index.js                   │  COPY dist
                    │ layer 2: /app/node_modules/...                │  RUN npm ci
                    │ layer 1: /usr/local/bin/node, /lib, /etc ...  │  FROM node:22-slim
                    └──────────────────────────────────────────────┘
```

- **Reads** go to the topmost layer that has the file.
- **Writes** to an existing file trigger **copy-up**: the whole file is copied from the lower layer into the upperdir, then modified. Appending one line to a 2 GB file copies 2 GB first.
- **Deletes** create a **whiteout** entry in the upper layer that hides the lower file. The bytes still exist in the lower layer — which is why `RUN rm -rf /big-dir` in a later Dockerfile instruction does **not** make an image smaller.
- Layers are **content-addressed** (identified by the SHA-256 of their content) and shared: ten containers from the same image, or ten images built `FROM node:22-slim`, store those base layers once.
- The writable layer is **ephemeral**: `docker rm` deletes it. Data that must survive goes in volumes, which bypass overlayfs entirely and are also faster for heavy writes (databases!).

You can see the overlay mount from inside any container — the root mount line lists the layer directories:

```bash
docker run --rm alpine sh -c "grep ' / ' /proc/self/mountinfo | tr ',' '\n' | grep -E 'lowerdir|upperdir|workdir'"
```

`docker diff <container>` lists what has changed in the writable layer (`A` added, `C` changed, `D` deleted).

:::info Images vs containers, precisely
- **Image**: immutable. A manifest pointing to a config (default command, env, user, working dir, exposed ports, labels) and an ordered list of layer digests.
- **Container**: an image + a writable layer + runtime configuration (namespaces, cgroups, mounts, network, env overrides) + state (created, running, exited). Many containers can share one image.
:::

:::info Image stores: classic overlay2 vs containerd snapshotters
Since Docker Engine 29 (and earlier in Docker Desktop), new installations use the **containerd image store**: image content and layer snapshots are managed by containerd's overlayfs *snapshotter* instead of Docker's own `overlay2` graph driver. `docker info` shows `Storage Driver: overlayfs` with `driver-type: io.containerd.snapshotter.v1`. The concepts — layers, copy-on-write, whiteouts — are identical; only directory paths differ. The containerd store also enables multi-platform images locally (module 04).
:::

## The OCI specifications

The Open Container Initiative (OCI, under the Linux Foundation) standardises containers so that images built by Docker run on containerd, CRI-O, Podman or any Kubernetes node. Three specs:

- **Image spec** — how an image is stored and addressed:

```text
 image index (multi-platform)   application/vnd.oci.image.index.v1+json
   ├── manifest linux/amd64  ──► config (JSON: Env, Cmd, User, history, rootfs diff_ids)
   │                         ──► layers [sha256:a1.., sha256:b2.., ...] (tar+gzip/zstd)
   └── manifest linux/arm64  ──► config ...  layers ...
```

  Everything is referenced by **digest** (`sha256:...` of its content), so a digest pins exactly one immutable artifact. A tag like `node:22` is just a mutable pointer to an index digest.
- **Runtime spec** — what a low-level runtime executes: a **bundle** directory containing `config.json` (process args, env, namespaces, cgroup limits, mounts, capabilities, seccomp profile) and a `rootfs/`. `runc` is the reference implementation; `crun` (C, fast), `youki` (Rust), gVisor's `runsc` (user-space kernel sandbox) and Kata Containers (lightweight VMs) are alternatives.
- **Distribution spec** — the HTTP API registries implement (`/v2/<name>/manifests/<ref>`, `/v2/<name>/blobs/<digest>`). Docker Hub, GHCR, ECR, Harbor all speak it.

:::try Look at a real image index
```bash
docker buildx imagetools inspect node:22-alpine
docker buildx imagetools inspect node:22-alpine --raw | jq '.manifests[] | {platform, digest}'
```

You get one manifest per platform (amd64, arm64, arm/v7, ...). Your Mac pulls the arm64 one automatically.
:::

## Docker's architecture: from `docker run` to a process

```text
 docker CLI ──REST over unix socket──► dockerd
                                         │  API, image builds (BuildKit), networks,
                                         │  volumes, logging, Compose/Swarm features
                                         ▼ gRPC
                                     containerd
                                         │  image pull & store (snapshotters), container
                                         │  metadata, task lifecycle, events
                                         ▼ spawns one per container
                               containerd-shim-runc-v2
                                         │  keeps stdio open, reports exit status,
                                         │  lets dockerd/containerd restart independently
                                         ▼ exec
                                       runc ── creates namespaces, cgroup, mounts,
                                         │      pivot_root, drops caps, applies seccomp,
                                         │      then execs your process and EXITS
                                         ▼
                                  node dist/index.js  (parent = the shim)
```

What happens on `docker run -d -p 3000:3000 shipit-api`:

1. The CLI sends `POST /containers/create` then `POST /containers/{id}/start` to dockerd.
2. dockerd resolves the image (pulling through containerd if missing), prepares the network (veth pair, bridge, NAT rules for port 3000) and asks containerd to create the container.
3. containerd prepares a snapshot (overlay mount) from the image layers, writes an OCI bundle and starts a **shim**.
4. The shim calls **runc**, which sets up namespaces, cgroups, mounts and security, then executes your entrypoint. runc exits immediately; the shim becomes the container process's parent.
5. dockerd streams logs from the shim's stdio into the logging driver (json-file by default).

Because the shim, not dockerd, is the parent, containers can keep running while dockerd or containerd restarts (`"live-restore": true` in daemon.json). Kubernetes uses the same containerd + shim + runc path, minus dockerd — the kubelet talks to containerd through the **CRI** plugin. That is why "Kubernetes removed Docker" (dockershim removal in 1.24) did not break Docker-built images.

:::deep Build a container by hand with unshare and chroot
You can approximate what runc does with standard tools. Inside a privileged container (so you can create namespaces without touching your real system):

```bash
docker run --rm -it --privileged alpine sh
# --- inside ---
apk add --no-cache util-linux       # provides unshare/nsenter
mkdir -p /mycontainer && cd /mycontainer
# A minimal "rootfs": alpine's busybox is dynamically linked to musl, so copy the loader/libc too
mkdir -p rootfs/bin rootfs/lib rootfs/proc && cp /bin/busybox rootfs/bin/ && \
  cp -a /lib/ld-musl-*.so.1 /lib/libc.musl-*.so.1 rootfs/lib/ && \
  for c in sh ps ls hostname mount cat; do ln -s busybox rootfs/bin/$c; done

unshare --pid --fork --mount --uts --ipc --net \
  chroot rootfs /bin/sh -c 'mount -t proc proc /proc; hostname toy; exec sh'
# --- now inside your toy container ---
ps          # sh is PID 1
hostname    # toy
ls /        # only bin and proc
```

What's missing compared to runc: no cgroup limits (you would `mkdir /sys/fs/cgroup/toy`, write `memory.max` and move the PID into `cgroup.procs`), no layered filesystem, `chroot` instead of the safer `pivot_root`, no capability dropping and no seccomp. Lab 6 asks you to build a fuller version.
:::

## Containers vs virtual machines

| | Container | Virtual machine |
| --- | --- | --- |
| Isolation boundary | Kernel features on a **shared kernel** | Hypervisor + separate guest kernel |
| Startup | Milliseconds (it's a process) | Seconds to minutes (boot a kernel) |
| Overhead | Near zero CPU/memory overhead | Guest OS memory, virtual devices |
| Image size | MBs (only userland files) | GBs (whole OS) |
| Kernel | Must be the host's kernel (Linux containers need a Linux kernel) | Any OS |
| Security | Weaker: a kernel bug can be a container escape | Stronger: hypervisor attack surface is small |
| Typical use | Packaging and running apps, microservices, CI jobs | Multi-tenant isolation, different OSes, strong boundaries |

They combine well: on your Mac, containers run *inside* a VM; on AWS, EKS nodes are VMs running containers; Fargate and Firecracker give each task or function its own micro-VM for stronger isolation; Kata Containers and gVisor sit in between.

:::warning `--privileged` removes most of the walls
`--privileged` gives the container all capabilities, access to all host devices, disables seccomp and AppArmor confinement, and lets it mount filesystems. A privileged container can trivially take over the host (or the VM, on a Mac). It is fine for these learning labs on a disposable VM; never use it for application workloads, and treat requests for it in production (e.g. "the CI runner needs privileged") as a security review item.
:::

## Pitfalls and production notes

- **Don't treat containers as a hard security boundary for untrusted code.** Use non-root users, drop capabilities, keep seccomp on, and for real multi-tenancy use gVisor, Kata or VMs.
- **Don't write heavy data to the container layer.** Copy-up and overlay overhead hurt; data disappears with the container. Use volumes for Postgres/Redis data.
- **Read limits from cgroups, not `/proc/meminfo`.** Monitoring agents and runtimes that don't are wrong inside containers.
- **Watch CPU throttling, not just CPU usage.** A container at "50% CPU" can still be heavily throttled in bursts.
- **Kernel version matters.** All containers share the host kernel: features like io_uring or newer cgroup controllers depend on the host, not the image.

## Summary

- A container = process + namespaces (what it sees) + cgroups (what it uses) + overlay root filesystem (what files it has) + reduced privileges.
- `/proc/<pid>/ns/*` shows namespaces; `/sys/fs/cgroup/*` shows limits and counters such as `memory.events` and `cpu.stat`.
- Images are content-addressed read-only layers; containers add a thin copy-on-write layer; deleting files in later layers doesn't shrink images.
- OCI specs (image, runtime, distribution) make images portable across Docker, containerd, Podman and Kubernetes.
- `docker` CLI → dockerd → containerd → shim → runc → your process; runc exits, the shim stays as the parent.
- Containers share the kernel: lighter and faster than VMs, but a weaker isolation boundary.
