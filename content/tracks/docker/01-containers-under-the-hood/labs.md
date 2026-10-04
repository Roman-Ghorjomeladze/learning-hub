These labs poke at the Linux machinery underneath your containers. Several use `--privileged` and `--pid=host` to step "outside" a container into the Linux VM that your Mac runtime manages. That is safe here because the VM is disposable; never do it on shared or production hosts.

Prerequisites: module 00 done, a running runtime, `jq` installed. Pull the images once to save time:

```bash
docker pull alpine:3.22 && docker pull nginx:alpine && docker pull node:22-alpine
```

:::info Where is "the host"?
On a Mac, the "host" for containers is the runtime's Linux VM. `--pid=host` joins the VM's PID namespace, and PIDs reported by `docker inspect` are VM PIDs. On a Linux server the same commands show the real host.
:::

## Lab 1: Find a container's process and its namespaces

:::meta
difficulty: easy
time: 20 min
:::

Goal: prove that a container is just a process with different namespace inodes.

### Steps

1. Start nginx and get its PID as seen by the VM:

```bash
docker run -d --name web nginx:alpine
WEB_PID=$(docker inspect -f '{{.State.Pid}}' web); echo "$WEB_PID"
```

2. List processes inside the container, then from the VM's PID namespace:

```bash
docker exec web ps -o pid,ppid,user,comm
docker run --rm --pid=host alpine:3.22 ps -o pid,ppid,user,comm | grep -E "nginx|containerd-shim|PID"
```

3. Compare namespace inodes of the nginx master process with PID 1 of the VM, using a privileged helper that shares the VM's PID namespace:

```bash
docker run --rm --privileged --pid=host alpine:3.22 sh -c "
  for ns in pid net mnt uts ipc user cgroup; do
    printf '%-7s vm=%-22s nginx=%s\n' \$ns \$(readlink /proc/1/ns/\$ns) \$(readlink /proc/$WEB_PID/ns/\$ns)
  done"
```

4. Check the hostname and network interfaces the container sees:

```bash
docker exec web hostname
docker exec web ip addr show eth0
```

### Verify

- Inside the container, nginx's master process is PID 1; in the VM it has the PID from step 1, and its parent is a `containerd-shim-runc-v2` process.
- Six namespaces differ between the VM's PID 1 and nginx; `user` is identical.
- The hostname equals the first 12 characters of the container ID (`docker ps`).

:::hint
If `$WEB_PID` is empty in the helper, make sure you ran step 1 in the same terminal — the variable is expanded on your Mac before the command is sent. The double quotes around the `sh -c` script are deliberate: `$WEB_PID` is expanded by your shell, while `\$ns` is escaped so the container's shell expands it.
:::

:::solution
Typical output:

```text
$ docker exec web ps -o pid,ppid,user,comm
PID   PPID  USER     COMMAND
    1     0 root     nginx
   30     1 nginx    nginx
   31     1 nginx    nginx

$ docker run --rm --pid=host alpine:3.22 ps -o pid,ppid,user,comm | grep -E "nginx|containerd-shim|PID"
PID   PPID  USER     COMMAND
48190     1 root     containerd-shim
48213 48190 root     nginx
48251 48213 101      nginx

pid     vm=pid:[4026531836]       nginx=pid:[4026532240]
net     vm=net:[4026531840]       nginx=net:[4026532242]
mnt     vm=mnt:[4026531841]       nginx=mnt:[4026532237]
uts     vm=uts:[4026531838]       nginx=uts:[4026532238]
ipc     vm=ipc:[4026531839]       nginx=ipc:[4026532239]
user    vm=user:[4026531837]      nginx=user:[4026531837]
cgroup  vm=cgroup:[4026531835]    nginx=cgroup:[4026532301]
```

Observations:

- The parent of nginx is the shim, not dockerd — runc has already exited.
- Worker processes run as UID 101 (`nginx` user inside the container); the VM has no user with that name, so `ps` shows the number. UIDs are just numbers shared with the kernel because there is no user namespace.
- `user` matches: container root is the VM's root (with fewer capabilities). On some runtimes, the VM's PID 1 itself lives in a nested namespace; the point is that nginx's inodes differ from the ones around it.
:::

### Clean up

Keep `web` running for Lab 2.

## Lab 2: Enter namespaces with nsenter

:::meta
difficulty: medium
time: 25 min
:::

Goal: use `nsenter` to join *some* of a container's namespaces — the technique behind `docker exec`, and a real debugging trick for minimal images that have no shell or tools.

### Steps

1. Start a privileged debug container in the VM's PID namespace with networking tools installed:

```bash
WEB_PID=$(docker inspect -f '{{.State.Pid}}' web)
docker run --rm -it --privileged --pid=host -e WEB_PID="$WEB_PID" alpine:3.22 sh
```

2. Inside it, install tools and join **only the network namespace** of nginx:

```bash
apk add --no-cache util-linux iproute2 curl
nsenter -t "$WEB_PID" -n ip addr       # nginx's interfaces, seen with YOUR tools
nsenter -t "$WEB_PID" -n ss -ltnp      # what listens inside nginx's network namespace
nsenter -t "$WEB_PID" -n curl -sI http://localhost:80 | head -1
```

3. Compare with your debug container's own view and with the mount namespace:

```bash
ip addr | grep -E "^[0-9]+:"           # the VM's interfaces (docker0, veth..., eth0)
nsenter -t "$WEB_PID" -m ls /etc/nginx # nginx's filesystem
ls /etc/nginx 2>&1                     # not in your container
```

4. Look at the container's root filesystem through `/proc` without entering any namespace:

```bash
ls /proc/$WEB_PID/root/usr/share/nginx/html
cat /proc/$WEB_PID/cgroup
exit
```

5. The Docker-native equivalent of step 2 is to share a network namespace explicitly:

```bash
docker run --rm --network container:web curlimages/curl -sI http://localhost:80
```

### Verify

- `ip addr` via `nsenter -n` shows only `lo` and `eth0` with a `172.17.x.x` address — nginx's interfaces — while the debug container (VM network) shows `docker0` and `veth*` interfaces.
- `ss -ltnp` shows nginx listening on `0.0.0.0:80`.
- Step 5 returns `HTTP/1.1 200 OK`.

:::hint
`nsenter -t <pid>` targets a process; the flags pick namespaces: `-n` net, `-m` mount, `-u` uts, `-i` ipc, `-p` pid, `-U` user, `-C` cgroup. Joining only `-n` keeps your own filesystem (and therefore your own tools) while seeing the container's network — perfect for debugging images that have no `curl` or `ip`.
:::

:::solution
```text
/ # nsenter -t "$WEB_PID" -n ip addr
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 ...
    inet 127.0.0.1/8 scope host lo
2: eth0@if7: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ...
    inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0

/ # nsenter -t "$WEB_PID" -n ss -ltnp
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511          0.0.0.0:80         0.0.0.0:*     users:(("nginx",pid=48213,fd=6))
```

`eth0@if7` is one end of a **veth pair**; the other end (`veth...@if2`) is attached to the `docker0` bridge in the VM's network namespace. That's how container traffic leaves the namespace.

`/proc/<pid>/root` is a magic link to the process's root directory, so you can read a container's files from the host without `docker exec` — handy for distroless images.

`--network container:web` makes the new container join `web`'s network namespace, so `localhost` is shared. Kubernetes pods work exactly like this: all containers in a pod share one network namespace (held by the "pause" container), which is why they can reach each other on `localhost`.

Kubernetes has a first-class version of this trick too: `kubectl debug -it <pod> --image=busybox --target=<container>` starts an *ephemeral container* sharing the target's namespaces.
:::

### Clean up

```bash
docker rm -f web
```

## Lab 3: cgroup limits from the inside

:::meta
difficulty: medium
time: 25 min
:::

Goal: watch Docker's resource flags turn into cgroup v2 files, and observe throttling and process limits in action.

### Steps

1. Memory, CPU and PID limits as files:

```bash
docker run --rm --memory 128m --cpus 0.5 --pids-limit 20 alpine:3.22 sh -c '
  echo "memory.max: $(cat /sys/fs/cgroup/memory.max)"
  echo "cpu.max:    $(cat /sys/fs/cgroup/cpu.max)"
  echo "pids.max:   $(cat /sys/fs/cgroup/pids.max)"
  echo "free says:"; free -m | sed -n 2p'
```

2. CPU throttling: burn CPU for 5 seconds under a 0.5 CPU quota, then read `cpu.stat`:

```bash
docker run --rm --cpus 0.5 alpine:3.22 sh -c '
  timeout 5 sh -c "while :; do :; done"
  cat /sys/fs/cgroup/cpu.stat'
```

3. Repeat step 2 without `--cpus` and compare `nr_throttled`.

4. PID limit: try to start 50 background processes with a limit of 20:

```bash
docker run --rm --pids-limit 20 alpine:3.22 sh -c '
  for i in $(seq 1 50); do sleep 30 & done 2>&1 | tail -2
  read n < /sys/fs/cgroup/pids.current; echo "running: $n"'
```

5. Watch live usage of a running container with `docker stats`:

```bash
docker run -d --name burner --cpus 0.5 --memory 64m alpine:3.22 sh -c 'while :; do :; done'
docker stats --no-stream burner
docker rm -f burner
```

### Verify

- Step 1 prints `134217728`, `50000 100000`, `20` — and `free` shows the VM's memory, not 128 MB.
- Step 2: `usage_usec` is about 2,500,000 (0.5 CPU × 5 s) and `nr_throttled` is around 50 (one per 100 ms period).
- Step 3: `usage_usec` is about 5,000,000 and `nr_throttled` is 0.
- Step 4 prints `can't fork: Resource temporarily unavailable` and `running` stays at or below 20.
- `docker stats` shows CPU % hovering around 50% and the 64 MiB limit.

:::hint
`cpu.max` is `$QUOTA $PERIOD` in microseconds. 0.5 CPU = 50,000 µs of runtime allowed in every 100,000 µs period. Each period in which the cgroup hits its quota counts as one throttled period.
:::

:::solution
```text
memory.max: 134217728
cpu.max:    50000 100000
pids.max:   20
free says:
Mem:           7838         701        6340 ...

usage_usec 2501344
user_usec 2499870
system_usec 1474
nr_periods 51
nr_throttled 50
throttled_usec 2476108
```

`throttled_usec` ≈ 2.5 s: half of the wall time, the process was ready to run but not allowed to. In production, this is what CPU-limited Node services experience as p99 latency spikes: a GC pause or burst of work uses up the quota early in the period and every request waits for the next period. Watch `nr_throttled` / `throttled_usec` (exported by cAdvisor as `container_cpu_cfs_throttled_*` in Kubernetes) rather than average CPU.

Step 4 reads the counter with the shell builtin `read` rather than `$(cat ...)` on purpose: at the limit, even starting `cat` would fail. The fork failure is the kernel refusing `clone()` once `pids.current` hits `pids.max` — the same protection that stops a fork bomb in one container from freezing the whole host. Note that threads count too: a Node process uses ~10 threads (libuv pool + V8), so a very low `--pids-limit` can break it.
:::

### Clean up

```bash
docker rm -f burner 2>/dev/null || true
```

## Lab 4: Layers, copy-on-write and the OCI layout

:::meta
difficulty: medium
time: 30 min
:::

Goal: see image layers on disk, watch copy-on-write and whiteouts in a container's writable layer, and open an image in its OCI form.

### Steps

1. Build a tiny three-layer image:

```bash
mkdir -p ~/hub-labs/layers && cd ~/hub-labs/layers
cat > Dockerfile <<'EOF'
FROM alpine:3.22
RUN echo "v1" > /data.txt && dd if=/dev/zero of=/big.bin bs=1M count=20
RUN rm /big.bin
EOF
docker build -t layers-demo .
```

2. Inspect the layers:

```bash
docker history layers-demo
docker image inspect layers-demo --format '{{json .RootFS.Layers}}' | jq
docker image ls layers-demo
```

3. Start a container, modify, add and delete files, then ask Docker what changed:

```bash
docker run -d --name cow layers-demo sleep 3600
docker exec cow sh -c 'echo v2 > /data.txt; echo hi > /new.txt; rm /etc/motd'
docker diff cow
```

4. Find the writable layer (upperdir) of the container and look at it from the VM:

```bash
UPPER=$(docker exec cow sh -c "grep ' / ' /proc/self/mountinfo | tr ',' '\n' | grep upperdir= | cut -d= -f2")
echo "$UPPER"
docker run --rm --privileged --pid=host -e UPPER="$UPPER" alpine:3.22 sh -c '
  P=$(pidof dockerd || pidof containerd); P=${P%% *}
  ls -la /proc/$P/root$UPPER /proc/$P/root$UPPER/etc'
```

5. Save the image and look at its OCI layout:

```bash
docker save layers-demo -o layers-demo.tar
mkdir -p oci && tar -xf layers-demo.tar -C oci
cat oci/oci-layout; echo
jq . oci/index.json
MANIFEST=$(jq -r '.manifests[0].digest' oci/index.json | cut -d: -f2)
jq . "oci/blobs/sha256/$MANIFEST"
```

### Verify

- `docker history` shows the `rm /big.bin` layer at `0B` while the `dd` layer is about 20 MB — and the image is ~28 MB, not ~8 MB.
- `docker diff` shows `C /data.txt`, `A /new.txt`, `D /etc/motd` (plus `C /etc` and similar parent-directory entries).
- In the upperdir you find `data.txt`, `new.txt`, and in `etc/` a character device `motd` with major/minor `0, 0` — the whiteout.
- `index.json` points to a manifest (or to an index that points to one) whose `layers` array has one entry per filesystem layer.

:::hint
If `pidof dockerd` and `pidof containerd` both return nothing on your runtime, list candidate processes with `docker run --rm --pid=host alpine:3.22 ps -o pid,comm | grep -iE "dockerd|containerd"`. You need *any* process in the engine's mount namespace, because the upperdir path only exists there. If `index.json`'s first entry is itself an index (media type `...image.index.v1+json`), follow one more level: open that blob and take a manifest digest from it.
:::

:::solution
```text
$ docker history layers-demo
IMAGE          CREATED          CREATED BY                                      SIZE
3b1f0c2d9e8a   10 seconds ago   RUN /bin/sh -c rm /big.bin # buildkit           0B
<missing>      11 seconds ago   RUN /bin/sh -c echo "v1" > /data.txt && dd i…   21MB
<missing>      2 weeks ago      CMD ["/bin/sh"]                                 0B
<missing>      2 weeks ago      ADD alpine-minirootfs-3.22.x-aarch64.tar.gz …   8.5MB

$ docker diff cow
C /data.txt
A /new.txt
C /etc
D /etc/motd

$ ls -la .../upper  (abridged)
-rw-r--r--    1 root root   3 data.txt
drwxr-xr-x    2 root root  60 etc
-rw-r--r--    1 root root   3 new.txt
$ ls -la .../upper/etc
c---------    1 root root 0, 0 motd
```

Lessons:

- **Deleting in a later layer does not shrink the image.** The 20 MB still ships in the `dd` layer; the `rm` layer only adds a whiteout. Clean up in the *same* `RUN` that created the files (module 03), or use multi-stage builds (module 04).
- **Copy-up**: `data.txt` was copied into the upperdir before being modified; the image layer is untouched, so other containers still see `v1`.
- **Whiteouts** in overlayfs are character devices with device number 0/0.
- The OCI layout (`oci-layout`, `index.json`, `blobs/sha256/...`) is exactly what a registry stores. Every file is named by its digest, so tampering is detectable. The manifest's `config` blob holds `Cmd`, `Env`, history and the `diff_ids` that `docker image inspect` showed as `RootFS.Layers`.
:::

### Clean up

```bash
docker rm -f cow
docker image rm layers-demo
rm -rf ~/hub-labs/layers
```

## Lab 5: Break and fix — the worker that keeps dying

:::meta
difficulty: medium
time: 20 min
:::

Goal: diagnose a container that dies with no error message in its logs.

### Steps

1. A teammate's "report worker" builds reports in memory. Start it exactly as they do:

```bash
docker run -d --name report-worker --memory 128m --memory-swap 128m node:22-alpine node -e '
  const chunks = [];
  setInterval(() => {
    chunks.push(Buffer.alloc(8 * 1024 * 1024, 1));
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1048576);
    console.log(`report rows buffered: ${chunks.length * 8} MB (V8 heap ${heapMB} MB)`);
  }, 300);'
```

2. In a second terminal, watch engine events for it (start this quickly, or re-run the worker afterwards):

```bash
docker events --filter container=report-worker
```

3. Wait ~10 seconds. Then investigate **without** re-reading the command above. Use `docker ps -a`, `docker logs`, `docker inspect`, and the events output. Answer:
   - How did the process end?
   - Why didn't Node print an out-of-memory error?
   - What would you change?

### Verify

You can state, with evidence from Docker commands, that the kernel OOM killer terminated the process because the container's cgroup reached its memory limit.

:::hint
Look at `.State.ExitCode`, `.State.OOMKilled` and `.HostConfig.Memory` in `docker inspect`. Exit codes above 128 mean "killed by signal (code − 128)". Then compare the "V8 heap" number in the logs with the "buffered" number. Where do `Buffer`s live?
:::

:::solution
```bash
$ docker ps -a --filter name=report-worker --format '{{.Status}}'
Exited (137) 12 seconds ago

$ docker logs --tail 3 report-worker
report rows buffered: 96 MB (V8 heap 4 MB)
report rows buffered: 104 MB (V8 heap 4 MB)
report rows buffered: 112 MB (V8 heap 4 MB)

$ docker inspect report-worker --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} limit={{.HostConfig.Memory}}'
exit=137 oom=true limit=134217728

# docker events output:
container oom 5f1c... (image=node:22-alpine, name=report-worker)
container die 5f1c... (exitCode=137, image=node:22-alpine, name=report-worker)
```

Diagnosis:

- `137 = 128 + 9` → the process got `SIGKILL`. `OOMKilled=true` and the `oom` event confirm the kernel's OOM killer did it, because the cgroup hit `memory.max` (128 MiB).
- Node printed nothing because `SIGKILL` cannot be caught: no `uncaughtException`, no "JavaScript heap out of memory". That message only appears when the **V8 heap** limit is hit — and the heap was tiny. `Buffer` data is allocated **outside** the V8 heap, so `--max-old-space-size` would not have helped.
- The host (VM) had plenty of free memory; only this cgroup was full.

Fixes, in order of preference:

1. Fix the design: stream the report (write chunks to a file/S3 or the HTTP response) instead of buffering everything.
2. Size the limit from measurements (`docker stats`, `memory.current` under realistic load) with headroom.
3. Add monitoring for OOM events: `docker events`, or `kube_pod_container_status_last_terminated_reason="OOMKilled"` in Kubernetes.

Run it again with `--memory 256m` and it survives a few seconds longer — proof that the limit, not a bug in Node, ends it.
:::

### Clean up

```bash
docker rm -f report-worker
```

## Lab 6: Challenge — build a container without Docker's help

:::meta
difficulty: hard
time: 45 min
:::

Goal: assemble a working "container" from Linux primitives, so you can explain in an interview exactly what runc does.

### Requirements

Work inside `docker run --rm -it --privileged alpine:3.22 sh` (your sandbox). Using `unshare`, `chroot` (or `pivot_root`), `mount` and the cgroup filesystem:

1. Get a real root filesystem: export the filesystem of a `busybox` container (from your Mac) and copy the tarball into the sandbox, or download Alpine's minirootfs inside it.
2. Start `/bin/sh` from that rootfs in **new PID, mount, UTS, IPC and network namespaces**, so that:
   - `ps` shows `sh` as PID 1 and nothing from the sandbox,
   - `hostname` prints `toybox`,
   - `ip link` (or `cat /proc/net/dev`) shows only `lo`.
3. Put the process in a **new cgroup** with `memory.max` of 32 MiB and `pids.max` of 10, and prove the PID limit works.
4. Write down which runc responsibilities you did **not** implement.

:::hint
Two terminals help: one in the sandbox for the toy container, another to `docker exec` into the sandbox for cgroup setup. Inside a privileged container, `/sys/fs/cgroup` may be read-only or namespaced: `mount -o remount,rw /sys/fs/cgroup` works in a privileged container. Enable controllers for children with `echo "+memory +pids" > /sys/fs/cgroup/cgroup.subtree_control` — and remember the cgroup v2 "no internal processes" rule: a cgroup with enabled child controllers can't contain processes itself, so first move existing processes into a leaf cgroup.
:::

:::solution
On your Mac, export a rootfs and copy it into a sandbox:

```bash
docker create --name rootfs-src busybox:latest
docker export rootfs-src -o busybox-rootfs.tar
docker rm rootfs-src
docker run -d --name sandbox --privileged alpine:3.22 sleep infinity
docker cp busybox-rootfs.tar sandbox:/busybox-rootfs.tar
docker exec -it sandbox sh
```

In the sandbox (terminal 1):

```bash
apk add --no-cache util-linux
mkdir -p /toy && tar -xf /busybox-rootfs.tar -C /toy

# cgroup setup: make the hierarchy writable, move existing procs to a leaf, enable controllers
mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
mkdir -p /sys/fs/cgroup/sandbox /sys/fs/cgroup/toy
for p in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$p" > /sys/fs/cgroup/sandbox/cgroup.procs 2>/dev/null; done
echo "+memory +pids" > /sys/fs/cgroup/cgroup.subtree_control
echo $((32*1024*1024)) > /sys/fs/cgroup/toy/memory.max
echo 10 > /sys/fs/cgroup/toy/pids.max

# Move THIS shell into the toy cgroup; children inherit it
echo $$ > /sys/fs/cgroup/toy/cgroup.procs

unshare --pid --fork --mount --uts --ipc --net --mount-proc=/toy/proc \
  chroot /toy /bin/sh -c 'hostname toybox; exec /bin/sh'
```

Inside the toy container:

```bash
ps                      # PID 1 = sh
hostname                # toybox
cat /proc/net/dev       # only lo
for i in $(seq 1 20); do sleep 60 & done   # fails after ~8: "can't fork"
cat /sys/fs/cgroup/pids.current 2>/dev/null || echo "(cgroupfs not mounted in toy — check from terminal 2)"
```

Terminal 2 (`docker exec -it sandbox sh`):

```bash
cat /sys/fs/cgroup/toy/pids.current /sys/fs/cgroup/toy/pids.max /sys/fs/cgroup/toy/memory.max
```

`--mount-proc=/toy/proc` mounts a fresh `/proc` for the new PID namespace inside the chroot, which is why `ps` only sees the toy's processes.

What runc does that you skipped:

- **`pivot_root`** instead of `chroot` (chroot can be escaped by a root process; pivot_root detaches the old root entirely) and unmounting the old root.
- A **layered root filesystem** (overlay mount of image layers + writable layer) instead of a plain directory.
- **Networking**: creating a veth pair, moving one end into the namespace, assigning an IP (Docker's libnetwork does this, not runc itself).
- **Security**: dropping capabilities, `no_new_privs`, a seccomp filter, AppArmor/SELinux labels, read-only/masked paths like `/proc/kcore`, user namespace mapping.
- Setting **env vars, user/group, working dir, rlimits** and devices (`/dev/null`, `/dev/pts`) from `config.json`.
- Reporting state and exit status to a supervisor (the shim).
:::

### Clean up

```bash
docker rm -f sandbox
rm -f busybox-rootfs.tar
```
