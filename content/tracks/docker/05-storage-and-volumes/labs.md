These labs need only Docker (Docker Desktop, OrbStack or Colima) and a terminal. Work in a scratch folder:

```bash
mkdir -p ~/docker-labs/05-storage && cd ~/docker-labs/05-storage
```

Every lab ends with a clean-up step. To nuke everything from this module at once: `docker rm -f $(docker ps -aq --filter label=lab=05) 2>/dev/null; docker volume rm $(docker volume ls -q --filter label=lab=05) 2>/dev/null`.

## Lab 1: Watch data disappear, then make it stay

:::meta
difficulty: easy
time: 15 min
:::

Goal: see the difference between the writable layer and a named volume with your own eyes.

### Steps

1. Write a file into the writable layer, remove the container, and look for the file:

   ```bash
   docker run --name w1 --label lab=05 alpine sh -c 'date > /stamp.txt'
   docker start -a w1 >/dev/null; docker cp w1:/stamp.txt - | tar xO   # still there after stop/start
   docker rm w1
   docker run --rm alpine cat /stamp.txt                                # gone
   ```

2. Now use a named volume:

   ```bash
   docker volume create --label lab=05 stamps
   docker run --rm --mount type=volume,source=stamps,target=/data alpine sh -c 'date >> /data/stamp.txt'
   docker run --rm --mount type=volume,source=stamps,target=/data alpine sh -c 'date >> /data/stamp.txt'
   docker run --rm --mount type=volume,source=stamps,target=/data alpine cat /data/stamp.txt
   ```

3. Find where the volume lives and who owns it:

   ```bash
   docker volume inspect stamps --format '{{ .Mountpoint }}'
   docker run --rm -v stamps:/data alpine ls -ln /data
   ```

4. Try volume pre-population. Mount an empty volume over a directory that already has content in the image:

   ```bash
   docker volume create --label lab=05 nginx-html
   docker run --rm -v nginx-html:/usr/share/nginx/html nginx:alpine ls /usr/share/nginx/html
   docker run --rm -v nginx-html:/srv alpine ls /srv    # the files were copied INTO the volume
   ```

### Verify

- Step 1's last command prints `cat: can't open '/stamp.txt'`.
- Step 2 prints two timestamps, written by two different containers.
- Step 4's second command lists `50x.html  index.html` even though it ran in `alpine`.

:::hint
If step 4 shows an empty directory, the volume already existed with content or you used a bind mount (a path starting with `/` or `.`). Pre-population only happens for an **empty named volume**.
:::

:::solution
The commands above are the full solution. Key takeaways:
- `docker stop`/`start` keeps the writable layer; `docker rm` deletes it.
- The volume's `Mountpoint` is `/var/lib/docker/volumes/stamps/_data` on the Docker host (inside the VM on a Mac).
- Docker copied nginx's `/usr/share/nginx/html` into the empty volume the first time it was mounted. Bind mounts never do this.
:::

### Clean up

```bash
docker volume rm stamps nginx-html
```

## Lab 2: Bind mounts, read-only mounts and the `-v` directory trap

:::meta
difficulty: easy
time: 20 min
:::

Goal: serve a local site with nginx through a read-only bind mount, then reproduce and fix the classic "my file became a directory" bug.

### Steps

1. Create a tiny site and serve it read-only:

   ```bash
   mkdir -p site && echo '<h1>shipit docs v1</h1>' > site/index.html
   docker run -d --name web --label lab=05 -p 8080:80 \
     --mount type=bind,source="$PWD/site",target=/usr/share/nginx/html,readonly \
     nginx:alpine
   curl -s localhost:8080
   ```

2. Edit the file on your Mac and curl again. Then try writing from inside the container:

   ```bash
   echo '<h1>shipit docs v2</h1>' > site/index.html
   curl -s localhost:8080
   docker exec web sh -c 'echo hacked > /usr/share/nginx/html/index.html'
   ```

3. Reproduce the trap. Mount a config file that doesn't exist using `-v`:

   ```bash
   docker run --rm -v "$PWD/nginx-custom.conf":/etc/nginx/conf.d/custom.conf nginx:alpine \
     sh -c 'ls -ld /etc/nginx/conf.d/custom.conf'
   ls -ld nginx-custom.conf
   ```

4. Do the same with `--mount`:

   ```bash
   rmdir nginx-custom.conf 2>/dev/null
   docker run --rm --mount type=bind,source="$PWD/nginx-custom.conf",target=/etc/nginx/conf.d/custom.conf nginx:alpine true
   ```

### Verify

- Step 2: the second curl returns `v2` without restarting; the `docker exec` write fails with `Read-only file system`.
- Step 3: both `ls` commands show a **directory** (`d` in the first column). Docker created it on your host.
- Step 4 fails immediately with `bind source path does not exist`.

:::hint
On some Mac setups the host directory in step 3 is created inside the VM rather than on macOS, so `ls -ld nginx-custom.conf` on the Mac may report "No such file". Either way, the container saw a directory instead of a file. That's the bug.
:::

:::solution
- Bind mounts are live in both directions; `readonly` makes the container side read-only while you keep editing on the host.
- `-v` with a non-existent host path creates an empty directory and mounts it, so nginx would fail with a confusing error (`could not open ... Is a directory`) when you meant to give it a file.
- `--mount type=bind` refuses to start if the source is missing, which surfaces the real mistake (wrong working directory, typo) right away. Use `--mount` in scripts.
:::

### Clean up

```bash
docker rm -f web; rm -rf site nginx-custom.conf
```

## Lab 3: Break & fix: the non-root app that can't write

:::meta
difficulty: medium
time: 25 min
:::

Goal: diagnose a permission error with a non-root container and fix it properly in the Dockerfile, not with `chmod 777`.

### Steps

1. Create a small Node app that appends to a log file in `/app/data`:

   ```bash
   mkdir -p perm-app && cd perm-app
   cat > server.mjs <<'EOF'
   import { appendFileSync, readFileSync } from 'node:fs';
   import http from 'node:http';
   const file = '/app/data/visits.log';
   http.createServer((req, res) => {
     appendFileSync(file, `${new Date().toISOString()} ${req.url}\n`);
     res.end(readFileSync(file));
   }).listen(3000, () => console.log('listening on 3000'));
   EOF
   cat > Dockerfile <<'EOF'
   FROM node:22-alpine
   WORKDIR /app
   COPY server.mjs .
   USER node
   CMD ["node", "server.mjs"]
   EOF
   docker build -t perm-app:broken .
   ```

2. Run it with a named volume and hit it:

   ```bash
   docker run -d --name perm --label lab=05 -p 3001:3000 -v permdata:/app/data perm-app:broken
   curl -s localhost:3001/hello
   docker logs perm
   ```

3. Diagnose. The uncaught error crashed the process, so `docker ps -a` shows the container as `Exited (1)` and you can't `exec` into it. Start a one-off container from the same image with the same volume to see which UID the process runs as and who owns the mount point:

   ```bash
   docker ps -a --filter name=perm
   docker run --rm -v permdata:/app/data perm-app:broken sh -c 'id; ls -ldn /app/data'
   ```

4. Fix it **in the Dockerfile** so a fresh volume gets the right owner, rebuild, and rerun with a *new* volume.

### Verify

- Before the fix: the request fails and `docker logs perm` shows `EACCES: permission denied, open '/app/data/visits.log'`.
- After the fix: repeated `curl -s localhost:3001/x` calls return a growing list of visits, and `docker exec perm ls -ln /app/data` shows the file owned by `1000 1000`.

:::hint
The image never created `/app/data`, so Docker created the mount point owned by root (`0 0`). An empty named volume copies the *image's* directory, including its ownership. What if the image already had `/app/data` owned by `node`?
:::

:::solution
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "server.mjs"]
```

```bash
docker rm -f perm
docker build -t perm-app:fixed .
docker run -d --name perm --label lab=05 -p 3001:3000 -v permdata2:/app/data perm-app:fixed
curl -s localhost:3001/a; curl -s localhost:3001/b
```

Why a *new* volume? Pre-population (and its ownership) only happens when the volume is empty. The old `permdata` volume already exists with a root-owned root directory, so it would stay broken. To repair an existing volume instead, run a one-off root container: `docker run --rm -v permdata:/d alpine chown -R 1000:1000 /d`.

Bonus: for a **bind mount** in dev, the clean fix is `--user "$(id -u):$(id -g)"` so the container writes as you.
:::

### Clean up

```bash
docker rm -f perm; docker volume rm permdata permdata2; cd .. && rm -rf perm-app
```

## Lab 4: Persist Postgres, back it up, restore it elsewhere

:::meta
difficulty: medium
time: 30 min
:::

Goal: run PostgreSQL 18 with a named volume, prove the data survives container removal, take both a file-level and a logical backup, and restore into a second container.

### Steps

1. Start Postgres with a named volume at the correct 18+ path:

   ```bash
   docker volume create --label lab=05 shipit-pg
   docker run -d --name shipit-db --label lab=05 \
     -e POSTGRES_USER=shipit -e POSTGRES_PASSWORD=shipit -e POSTGRES_DB=shipit \
     --mount type=volume,source=shipit-pg,target=/var/lib/postgresql \
     postgres:18
   sleep 5
   docker exec shipit-db psql -U shipit -c "CREATE TABLE items(id serial primary key, name text);"
   docker exec shipit-db psql -U shipit -c "INSERT INTO items(name) VALUES ('keyboard'),('monitor');"
   ```

2. Confirm there are **no anonymous volumes** attached:

   ```bash
   docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' shipit-db
   ```

3. Delete the container and start a new one on the same volume. Query the data.

4. File-level backup (stop the DB first for consistency):

   ```bash
   mkdir -p backups
   docker stop shipit-db
   docker run --rm \
     --mount type=volume,source=shipit-pg,target=/data,readonly \
     --mount type=bind,source="$PWD/backups",target=/backup \
     alpine tar czf /backup/shipit-pg.tar.gz -C /data .
   docker start shipit-db
   ls -lh backups
   ```

5. Restore the tarball into a new volume and start a second Postgres on it (`shipit-db-copy`, port not needed). Query it.

6. Logical backup and restore with `pg_dump` into the copy:

   ```bash
   docker exec shipit-db psql -U shipit -c "INSERT INTO items(name) VALUES ('desk');"
   docker exec shipit-db pg_dump -U shipit -Fc shipit > backups/shipit.dump
   docker exec -i shipit-db-copy pg_restore -U shipit -d shipit --clean < backups/shipit.dump
   docker exec shipit-db-copy psql -U shipit -c 'SELECT * FROM items;'
   ```

### Verify

- Step 2 shows exactly one line: `volume shipit-pg -> /var/lib/postgresql`.
- Step 3 still returns `keyboard` and `monitor`.
- Step 5's copy returns the two rows; step 6's copy returns three rows including `desk`.

:::hint
For step 5, the restore container must mount the **new** volume read-write and the backups folder. Postgres checks that its data dir is owned by the `postgres` user (UID 999 in the Debian image) with mode `0700`; running `tar` as root inside alpine preserves that.
:::

:::solution
```bash
# Step 3
docker rm -f shipit-db
docker run -d --name shipit-db --label lab=05 \
  -e POSTGRES_USER=shipit -e POSTGRES_PASSWORD=shipit -e POSTGRES_DB=shipit \
  --mount type=volume,source=shipit-pg,target=/var/lib/postgresql postgres:18
sleep 3; docker exec shipit-db psql -U shipit -c 'SELECT * FROM items;'

# Step 5
docker volume create --label lab=05 shipit-pg-copy
docker run --rm \
  --mount type=volume,source=shipit-pg-copy,target=/data \
  --mount type=bind,source="$PWD/backups",target=/backup,readonly \
  alpine tar xzf /backup/shipit-pg.tar.gz -C /data
docker run -d --name shipit-db-copy --label lab=05 \
  -e POSTGRES_PASSWORD=ignored \
  --mount type=volume,source=shipit-pg-copy,target=/var/lib/postgresql postgres:18
sleep 3; docker exec shipit-db-copy psql -U shipit -c 'SELECT * FROM items;'
```

Note that `POSTGRES_PASSWORD=ignored` really is ignored: the data directory is already initialised, so the image skips initialisation and the `shipit` user and password from the original cluster apply. Env vars only matter for an empty data directory.
:::

### Clean up

```bash
docker rm -f shipit-db shipit-db-copy
docker volume rm shipit-pg shipit-pg-copy
rm -rf backups
```

## Lab 5: Challenge: a fast, correct Node dev container on macOS

:::meta
difficulty: hard
time: 40 min
:::

Goal: design the mounts for a Node dev container that has live code reload, doesn't shadow `node_modules`, writes nothing as root into your project, uses tmpfs for scratch, and measurably beats a naive full bind mount.

### Requirements

- Create a project with `package.json` that depends on a few packages (for example `express`, `typescript`, `vitest`) and a `src/` folder.
- Build a dev image that runs `npm ci` during the build.
- Run it two ways and time `npx tsc --version && npx vitest --version` (or a real test run) in each:
  1. **Naive**: bind-mount the whole project over `/app` after running `npm install` on the host.
  2. **Optimised**: bind-mount only `./src` (read-only is fine for this test) and keep `/app/node_modules` from the image via a named volume.
- In the optimised run, `/tmp` must be a 64 MB tmpfs.
- `node_modules` must not appear on your Mac in the optimised setup.
- Write one sentence explaining the timing difference you observed.

:::hint
Mount order matters only in that the more specific path wins: a volume at `/app/node_modules` "punches through" a bind mount at `/app`. But you don't even need a bind at `/app` if you mount only `/app/src`.
:::

:::solution
```bash
mkdir -p devperf/src && cd devperf
cat > package.json <<'EOF'
{ "name": "devperf", "private": true, "type": "module",
  "dependencies": { "express": "^5.1.0" },
  "devDependencies": { "typescript": "^5.9.0", "vitest": "^3.2.0" } }
EOF
echo 'export const add = (a: number, b: number) => a + b;' > src/add.ts
cat > Dockerfile <<'EOF'
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY src ./src
CMD ["sh"]
EOF
docker build -t devperf .

# Naive: host node_modules, full bind mount
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install >/dev/null
time docker run --rm -v "$PWD":/app -w /app devperf sh -c 'npx tsc --version && npx vitest --version'

# Optimised: only src is bind-mounted, node_modules from the image via a volume
rm -rf node_modules package-lock.json
time docker run --rm \
  --mount type=bind,source="$PWD/src",target=/app/src,readonly \
  --mount type=volume,source=devperf-nm,target=/app/node_modules \
  --mount type=tmpfs,target=/tmp,tmpfs-size=67108864 \
  devperf sh -c 'npx tsc --version && npx vitest --version && df -h /tmp'
ls node_modules 2>/dev/null || echo "no node_modules on host"
```

Typical result on an Apple Silicon Mac: the optimised run is noticeably faster, because module resolution walks thousands of files in `node_modules`, and in the naive run every one of those `stat`/`open` calls crosses the macOS-to-VM file-sharing layer. In the optimised run they hit the VM's native disk. (The exact gap depends on VirtioFS vs other implementations, and on OrbStack vs Docker Desktop.)

The named volume `devperf-nm` is pre-populated from the image's `/app/node_modules` on first use. Remember to delete it when `package.json` changes, or it will keep stale dependencies. That staleness is exactly the problem `docker compose watch` with a `rebuild` rule on `package.json` solves (module 07).
:::

### Clean up

```bash
docker volume rm devperf-nm; docker rmi devperf; cd .. && rm -rf devperf
```
