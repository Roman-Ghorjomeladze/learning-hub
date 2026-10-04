Containers are designed to be disposable: you should be able to delete one and start a fresh copy at any time. That only works if you are deliberate about **where state lives**. This module gives you a precise mental model of container storage and the practical skills to run stateful things like PostgreSQL in Docker without losing data.

## The mental model: image layers + one writable layer

Recall from the internals module that an image is a stack of read-only layers. When you start a container, the storage driver (almost always `overlay2` on Linux) adds **one thin writable layer** on top. Every file the container creates or changes lands in that layer.

```text
            container A                container B
         ┌────────────────┐         ┌────────────────┐
         │ writable layer │         │ writable layer │   <- per container, deleted with it
         └───────┬────────┘         └───────┬────────┘
                 └───────────┬──────────────┘
                 ┌───────────┴──────────────┐
                 │  image layer 3 (app)     │
                 │  image layer 2 (deps)    │   <- read-only, shared by all containers
                 │  image layer 1 (base OS) │
                 └──────────────────────────┘
```

Three consequences follow:

1. **Data in the writable layer dies with the container.** `docker rm` deletes it. `docker stop` / `docker start` keeps it, which fools people into thinking it is persistent until the first `docker compose down` or redeploy.
2. **Copy-on-write is expensive for big or busy files.** The first time a container modifies a file that came from a lower layer, overlay2 copies the *whole file* up into the writable layer ("copy-up"). A 2 GB database file touched once means a 2 GB copy. Write-heavy workloads are also slower through the overlay filesystem than through a plain directory.
3. **The writable layer is hard to reach from outside.** It lives under `/var/lib/docker/overlay2/<id>/diff` inside the Docker host (on a Mac, inside the Linux VM). You cannot easily back it up, share it, or move it.

So the rule is: **anything that must outlive the container, or that is written heavily, goes in a mount**, not the writable layer.

:::try See the writable layer
```bash
docker run --name scratch alpine sh -c 'echo hello > /note.txt; apk add --no-cache curl >/dev/null'
docker diff scratch          # A = added, C = changed, D = deleted
docker rm scratch            # ...and it is all gone
```
`docker diff` lists exactly what the container wrote to its writable layer. You will see `/note.txt` plus the files `apk` installed.
:::

## Three kinds of mounts

A mount replaces (or overlays) a path inside the container with storage that is *not* part of the container's writable layer.

```text
 Host / Docker VM                                Container
 ─────────────────────────────────               ───────────────────
 /var/lib/docker/volumes/pgdata/_data  ──volume──▶ /var/lib/postgresql
 /Users/roma/code/shipit/src           ──bind────▶ /app/src
 (RAM)                                  ──tmpfs───▶ /tmp
```

| | Named volume | Bind mount | tmpfs |
| --- | --- | --- | --- |
| Where the data lives | Docker-managed dir (`/var/lib/docker/volumes/<name>/_data`) or a driver backend | Any path on the host you choose | Host memory only |
| Managed by `docker volume` CLI | Yes | No | No |
| Survives container removal | Yes | Yes (it's your host directory) | No, gone on stop |
| Pre-populated from image content | Yes, if the volume is empty | No, host dir hides image content | No |
| Portable across hosts / OSes | Yes (no host path in the config) | No (depends on host layout) | n/a |
| Typical use | Databases, uploads, caches you want to keep | Source code in dev, config files, sharing a host socket | Scratch space, secrets, read-only root fs |
| Performance on macOS | Native VM disk speed | Crosses the VM boundary (slower) | RAM speed |

### Named volumes

A named volume is a directory Docker creates and owns. You refer to it by name, never by host path, which makes it portable and safe.

```bash
docker volume create pgdata
docker volume ls
docker volume inspect pgdata      # shows Mountpoint, Driver, Labels, CreatedAt
docker run -d --name db -e POSTGRES_PASSWORD=secret \
  -v pgdata:/var/lib/postgresql postgres:18
```

If you reference a volume name that does not exist, Docker creates it for you. If you omit the name entirely (`-v /var/lib/postgresql`) you get an **anonymous volume** with a random hash name. Images can also declare `VOLUME` in their Dockerfile, which creates an anonymous volume automatically when you don't mount anything there. The postgres image does this, which is why `docker volume ls` slowly fills with hash-named volumes on a dev machine.

**Volume pre-population**: when you mount an *empty* named volume onto a directory that already has content in the image, Docker copies the image content into the volume first. This is how a fresh volume at `/usr/share/nginx/html` ends up containing nginx's default `index.html`. Bind mounts never do this. Add `volume-nocopy` (with `--mount`) to disable the copy.

### Bind mounts

A bind mount maps a host path straight into the container. The container sees your real files, live, in both directions.

```bash
docker run --rm -it -v "$PWD":/app -w /app node:22-alpine node --version
```

Use bind mounts for:

- **Source code in development**, so edits on the host appear instantly in the container.
- **Single config files** (`./nginx.conf:/etc/nginx/nginx.conf:ro`).
- **Getting output out**, e.g. a test run writing a coverage report to `./coverage`.

Avoid bind mounts for database data in production: they depend on the host's layout, ownership and filesystem, and on a Mac they are slow.

:::warning A bind mount hides what's in the image
Mounting `./src` over `/app` replaces the image's `/app` entirely for that container, including the `node_modules` you installed during `docker build`. The classic symptom is `Error: Cannot find module 'express'` only when running with the mount. The fix is either to not mount the whole app directory, or to put `node_modules` in its own volume (`-v /app/node_modules`) so the bind mount doesn't shadow it. In Compose, `docker compose watch` (module 07) avoids the problem entirely.
:::

### tmpfs mounts

A tmpfs mount is a RAM-backed filesystem that exists only while the container runs. Nothing touches disk.

```bash
docker run --rm --tmpfs /tmp:rw,size=64m,mode=1777 alpine df -h /tmp
# or
docker run --rm --mount type=tmpfs,destination=/tmp,tmpfs-size=67108864 alpine df -h /tmp
```

Use tmpfs for scratch space with a **read-only root filesystem** (module 08), for short-lived sensitive data you never want on disk, and for test databases where speed matters more than durability. tmpfs is Linux-only (works fine on Mac because containers run in a Linux VM).

## `--mount` vs `-v`: two syntaxes, subtle differences

`-v` (`--volume`) is short and old. `--mount` is explicit key=value and is what the docs recommend.

```bash
# named volume
-v pgdata:/var/lib/postgresql
--mount type=volume,source=pgdata,target=/var/lib/postgresql

# bind mount, read-only
-v "$PWD/nginx.conf":/etc/nginx/nginx.conf:ro
--mount type=bind,source="$PWD/nginx.conf",target=/etc/nginx/nginx.conf,readonly

# tmpfs
--tmpfs /tmp
--mount type=tmpfs,target=/tmp,tmpfs-size=64m
```

How `-v` decides what you meant: if the part before the colon **starts with `/` or `.`** (or `~` expanded by your shell), it's a bind mount; otherwise it's a volume name. A typo like `-v data:/data` when you meant `-v ./data:/data` silently creates a named volume called `data`.

The important behavioural difference:

| Situation | `-v` | `--mount` |
| --- | --- | --- |
| Bind source path doesn't exist on host | **Creates an empty directory** (owned by root) | **Errors out** |
| Readability | Positional, colon-separated | Self-describing |
| Volume driver options | Not supported | `volume-driver=...,volume-opt=...` |

The silent directory creation of `-v` is the source of the "my config file is a directory" bug: you mount `./config.yml` from the wrong working directory, Docker creates a *directory* named `config.yml`, and the app fails to parse it. `--mount` would have failed loudly.

:::tip Rule of thumb
Use `--mount` in scripts, docs and anything you share. Use `-v` for quick interactive commands. In Compose, the short syntax (`./src:/app/src:ro`) is fine, but the long syntax (`type: bind`, `source`, `target`, `read_only`, `bind: create_host_path: false`) is clearer for anything unusual.
:::

### Read-only mounts

Add `:ro` or `readonly` whenever the container should only read. It protects you from bugs and limits damage if the container is compromised.

```bash
docker run -d -p 8080:80 \
  --mount type=bind,source="$PWD/site",target=/usr/share/nginx/html,readonly \
  nginx:alpine
```

The same idea applies to named volumes: one writer container mounts `rw`, readers mount `ro`.

## Permissions and UID/GID: the most common volume problem

Linux permission checks use **numeric** user and group IDs, not names. Inside a container, `node` is just a label for UID 1000 in that image's `/etc/passwd`. The kernel checks the numbers against the file's owner numbers on disk.

```text
Host file:  /home/roma/data   owner uid=1001  mode 755
Container:  process runs as uid=1000 ("node")
Result:     EACCES: permission denied, open '/data/out.json'
```

Typical failure modes:

- Your image runs as non-root (good, see module 08), but you mount a host directory owned by a different UID. The app can't write.
- You run a container as root, it writes files into a bind mount, and now those files on your Linux host are owned by root and you can't delete them without `sudo`.
- A named volume is created by Docker as root-owned, and a non-root process can't write to it.

Fixes, in order of preference:

1. **Let the image prepare the directory.** In the Dockerfile, create the directory and `chown` it to the app user *before* the volume is mounted. Because empty named volumes are pre-populated from the image (including ownership), the volume inherits the right owner.

   ```dockerfile
   RUN mkdir -p /app/uploads && chown node:node /app/uploads
   USER node
   VOLUME ["/app/uploads"]   # optional; documents intent
   ```

2. **Run the container as your host UID for dev bind mounts**: `docker run --user "$(id -u):$(id -g)" ...`. The process then writes files you own. (The UID may not exist in `/etc/passwd` inside the container; most programs don't care, though some tools complain about a missing home directory.)
3. **Chown in an entrypoint** that starts as root, fixes ownership, then drops privileges with `gosu`/`su-exec`. The official postgres and redis images do exactly this. It works but means your container starts as root.
4. **Bind-mount options on the host side**: on Linux you can use group permissions (shared GID) or ACLs. Avoid `chmod 777`; it "works" and is a security smell.

:::mac Permissions are friendlier on a Mac, which hides bugs
Docker Desktop, OrbStack and Colima translate ownership for bind mounts from macOS so that files usually appear owned by the container user and writes come back owned by you. That's convenient, but it means a permissions bug can be invisible on your Mac and appear only on a Linux CI runner or server. Test non-root images with named volumes, and check `ls -ln` inside the container (numeric IDs) rather than trusting the Mac behaviour.
:::

:::try Prove that names don't matter, numbers do
```bash
docker run --rm -v demo:/data alpine sh -c 'touch /data/f && ls -ln /data'
docker run --rm -v demo:/data --user 1000:1000 alpine sh -c 'touch /data/g'
# -> touch: /data/g: Permission denied   (volume root is owned by uid 0)
docker run --rm -v demo:/data alpine chown 1000:1000 /data
docker run --rm -v demo:/data --user 1000:1000 alpine sh -c 'touch /data/g && ls -ln /data'
docker volume rm demo
```
:::

## Bind-mount performance on macOS

On Linux, a bind mount is just a kernel bind: zero overhead. On a Mac, containers run inside a Linux VM, so a bind mount from `/Users/roma/code` must cross the VM boundary through a file-sharing layer. Every `stat`, `open` and `readdir` becomes a message between macOS and the VM.

```text
 macOS (APFS)                       Linux VM (ext4)
 /Users/roma/code/shipit ──VirtioFS──▶ mounted path ──bind──▶ container /app
                         (every syscall crosses here)
 Docker volume ─────────────────────── lives on the VM's own disk ──▶ native speed
```

Workloads that touch thousands of small files (`npm install`, TypeScript compilers, Jest, webpack/Vite watchers walking `node_modules`) feel this most.

What you can do:

- **Use VirtioFS** (the default in current Docker Desktop on Apple Silicon; also used by OrbStack and available in Colima with the `vz` VM type). It's much faster than the older gRPC FUSE and osxfs implementations. Check Docker Desktop **Settings → General → file sharing implementation**.
- **Keep `node_modules` out of the bind mount.** Install dependencies in the image and mount a named volume at `/app/node_modules`, or bind-mount only `src/` instead of the whole project.
- **Use `docker compose watch`** to sync changed files into the container rather than live-mounting the whole tree (module 07).
- **Synchronized file shares** (Docker Desktop, paid subscriptions): Docker keeps a cached copy of a host directory inside the VM using Mutagen-based sync, giving near-native speed for large repos. It trades instant consistency for speed; changes propagate within moments.
- **OrbStack** is widely reported to have very fast bind mounts and is a common choice for heavy Node.js monorepos. Benchmark your own project before switching.

:::tip Diagnose before optimising
Time the same command both ways: `time npm test` with the project bind-mounted vs copied into the image. If the difference is large, file sharing is your bottleneck. If not, look elsewhere (CPU limits, emulation of amd64 images on arm64, etc.).
:::

## Volume drivers

The default `local` driver stores data on the Docker host's disk. Volume drivers (plugins) let a named volume live elsewhere: NFS, cloud block storage, distributed filesystems. The `local` driver itself can mount NFS or CIFS shares using `mount` options:

```bash
docker volume create --driver local \
  --opt type=nfs \
  --opt o=addr=10.0.0.10,rw,nfsvers=4 \
  --opt device=:/exports/shipit \
  shipit-nfs
```

In practice, multi-host shared storage is where you move from Docker to Kubernetes (PersistentVolumes and CSI drivers). For single-host Docker and local dev, the `local` driver is what you'll use 99% of the time. Know that drivers exist and that `docker volume create --driver` and `--opt` are the knobs.

## Persisting PostgreSQL data

The official `postgres` image stores its cluster in `PGDATA`. **From PostgreSQL 18 the image changed layout**: `PGDATA` is now version-specific (`/var/lib/postgresql/18/docker`) and the declared `VOLUME` moved up to `/var/lib/postgresql`. Mount your volume at `/var/lib/postgresql` for 18+. For 17 and older, the convention was `/var/lib/postgresql/data`.

```bash
docker volume create shipit-pg
docker run -d --name shipit-db \
  -e POSTGRES_USER=shipit -e POSTGRES_PASSWORD=shipit -e POSTGRES_DB=shipit \
  --mount type=volume,source=shipit-pg,target=/var/lib/postgresql \
  -p 5432:5432 postgres:18
```

:::warning The anonymous-volume trap
If you mount at the *wrong* path (for example the pre-18 `/var/lib/postgresql/data` on an 18 image), the image's declared `VOLUME` still creates an **anonymous** volume for the real data location. Everything appears to work, then a `docker compose down` + `up` creates a new anonymous volume and your data is "gone". After setting up any database container, run `docker inspect -f '{{json .Mounts}}' <container>` and confirm the data directory is on the named volume you expect.
:::

Other rules for databases in containers:

- **One database server per volume.** Never let two Postgres containers write the same data directory.
- **Major upgrades need `pg_upgrade` or dump/restore.** Pointing a `postgres:18` container at a volume initialised by 17 fails at startup ("database files are incompatible with server"). The 18 layout exists precisely to make `pg_upgrade --link` across versions easier.
- **`POSTGRES_PASSWORD` and init scripts only apply to an empty data directory.** Changing the env var later does not change the password of an existing cluster, a frequent source of confusion.
- **Logical backups beat volume snapshots for databases.** A file-level copy of a running database's files can be inconsistent. Use `pg_dump` / `pg_dumpall` (or stop the container first) for anything you care about.

## Backing up and restoring a volume

Docker has no `docker volume backup` command. The idiom is: **start a throwaway container that mounts both the volume and a host directory, and tar between them.**

```bash
# Backup: volume -> ./backups/shipit-pg-YYYYMMDD.tar.gz
mkdir -p backups
docker stop shipit-db            # consistency: stop writers first
docker run --rm \
  --mount type=volume,source=shipit-pg,target=/data,readonly \
  --mount type=bind,source="$PWD/backups",target=/backup \
  alpine tar czf /backup/shipit-pg-$(date +%Y%m%d).tar.gz -C /data .
docker start shipit-db
```

```bash
# Restore into a new (empty) volume
docker volume create shipit-pg-restored
docker run --rm \
  --mount type=volume,source=shipit-pg-restored,target=/data \
  --mount type=bind,source="$PWD/backups",target=/backup,readonly \
  alpine sh -c 'tar xzf /backup/shipit-pg-*.tar.gz -C /data'
```

`tar` preserves numeric ownership and permissions when run as root, which matters: Postgres refuses to start if its data directory isn't owned by its own user with mode `0700`.

`--volumes-from <container>` is an older shortcut that mounts all of another container's volumes at the same paths. It still works and you'll see it in older docs and scripts.

For a database, prefer a logical dump while it runs:

```bash
docker exec shipit-db pg_dump -U shipit -Fc shipit > backups/shipit.dump
docker exec -i shipit-db pg_restore -U shipit -d shipit --clean < backups/shipit.dump
```

:::deep How a volume is really just a directory (and what `docker volume prune` deletes)
With the `local` driver, a named volume is literally `/var/lib/docker/volumes/<name>/_data` on the Docker host. When a container starts, the daemon asks the driver for a mountpoint and bind-mounts that path into the container's mount namespace at the target. That's why volume performance equals the host filesystem's performance, and why you can see the files from the host (on Linux, as root).

On a Mac that directory is inside the VM. You can peek with a privileged container that shares the VM's PID namespace, e.g. `docker run --rm -it --privileged --pid=host debian nsenter -t 1 -m -- ls /var/lib/docker/volumes` (works on Docker Desktop; paths differ slightly on OrbStack and Colima). That's also why `rm -rf` in the Docker Desktop VM or a "Reset to factory defaults" wipes all volumes.

Volumes have a reference count: a volume used by any container (running *or stopped*) can't be removed. `docker volume prune` removes unused volumes, and since Engine 23 it **only removes anonymous volumes by default**; add `--all` (`-a`) to include unused named volumes. `docker system prune --volumes` follows the same rule. `docker compose down -v` removes the named volumes declared in that Compose project, which is the command that most often deletes someone's local database.
:::

## Production best practices

- Keep containers **stateless** wherever possible: state lives in managed services (RDS, ElastiCache, S3) or in clearly named volumes.
- **Name every volume** that matters. Anonymous volumes are invisible debt.
- Mount configuration and secrets **read-only**. Run with a **read-only root filesystem** plus `tmpfs` for `/tmp` (module 08).
- **Set ownership in the image**, not with `chmod 777` at runtime.
- **Don't bind-mount source code in production.** Bake the code into the image; that's the point of an immutable artifact.
- **Back up with the tool that understands the data** (`pg_dump`, `redis-cli --rdb`, `BGSAVE`), and test restores regularly.
- Label volumes (`docker volume create --label project=shipit`) so you can filter and clean them up: `docker volume ls -f label=project=shipit`.

:::try Inspect what's mounted where
Start any container with a mix of mounts, then:
```bash
docker inspect -f '{{range .Mounts}}{{.Type}}  {{.Name}}  {{.Source}} -> {{.Destination}}  rw={{.RW}}{{"\n"}}{{end}}' <container>
```
This one-liner is the fastest way to answer "is my data on the volume I think it is?".
:::

## Summary

- The writable layer is per-container, slow for heavy writes, and deleted with the container.
- **Named volumes** for data you keep, **bind mounts** for dev code and single config files, **tmpfs** for scratch and secrets.
- Prefer `--mount`: it fails loudly on missing bind paths and supports driver options.
- Permission errors are about numeric UIDs; fix ownership in the image or run with the right `--user`.
- On a Mac, bind mounts cross the VM boundary; keep `node_modules` in the container and consider sync-based approaches.
- For Postgres 18+, mount at `/var/lib/postgresql`, verify with `docker inspect`, and back up with `pg_dump`.
