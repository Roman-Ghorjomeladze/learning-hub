You need Docker and a terminal. The labs pull `nginx:alpine`, `traefik/whoami`, `nicolaka/netshoot`, `curlimages/curl`, `redis:8-alpine` and `postgres:18`, all of which have arm64 builds.

```bash
mkdir -p ~/docker-labs/06-net && cd ~/docker-labs/06-net
```

Clean up everything from this module with: `docker rm -f $(docker ps -aq --filter label=lab=06) 2>/dev/null; docker network prune -f`.

## Lab 1: Default bridge vs user-defined bridge

:::meta
difficulty: easy
time: 15 min
:::

Goal: see with your own eyes that name resolution only works on user-defined networks, and find the embedded DNS server.

### Steps

1. Two containers on the default bridge:

   ```bash
   docker run -d --name a1 --label lab=06 traefik/whoami
   docker run --rm --label lab=06 nicolaka/netshoot curl -s --max-time 3 http://a1 || echo "FAILED by name"
   A1_IP=$(docker inspect -f '{{.NetworkSettings.IPAddress}}' a1)
   docker run --rm nicolaka/netshoot curl -s http://$A1_IP | head -3
   docker run --rm nicolaka/netshoot cat /etc/resolv.conf
   ```

2. The same on a user-defined network:

   ```bash
   docker network create labnet
   docker run -d --name b1 --label lab=06 --network labnet traefik/whoami
   docker run --rm --network labnet nicolaka/netshoot curl -s http://b1 | head -3
   docker run --rm --network labnet nicolaka/netshoot cat /etc/resolv.conf
   docker run --rm --network labnet nicolaka/netshoot dig @127.0.0.11 b1 +short
   ```

3. Connect `a1` to `labnet` **without restarting it**, then resolve it by name from `labnet`.

4. Inspect the network:

   ```bash
   docker network inspect labnet -f '{{.IPAM.Config}} {{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}'
   ```

### Verify

- Step 1: by-name fails, by-IP works, and `resolv.conf` shows your host's (or the VM's) upstream resolver.
- Step 2: by-name works and `resolv.conf` shows `nameserver 127.0.0.11`.
- Step 3: `curl http://a1` works from a container on `labnet`.

:::hint
`docker network connect <network> <container>` attaches a running container to an additional network.
:::

:::solution
```bash
docker network connect labnet a1
docker run --rm --network labnet nicolaka/netshoot curl -s http://a1 | head -3
docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' a1
# bridge=172.17.0.2 labnet=172.20.0.3
```
`a1` now has two interfaces, one per network, and the embedded DNS on `labnet` knows its name.
:::

### Clean up

```bash
docker rm -f a1 b1; docker network rm labnet
```

## Lab 2: Port publishing, bind addresses and the Mac hop

:::meta
difficulty: easy
time: 20 min
:::

Goal: understand the forms of `-p` and what's reachable from where.

### Steps

1. Publish on all interfaces, on localhost only, and on a random port:

   ```bash
   docker run -d --name p-all   --label lab=06 -p 8081:80           nginx:alpine
   docker run -d --name p-local --label lab=06 -p 127.0.0.1:8082:80 nginx:alpine
   docker run -d --name p-rand  --label lab=06 -p 80                nginx:alpine
   docker port p-rand
   docker ps --filter label=lab=06 --format 'table {{.Names}}\t{{.Ports}}'
   ```

2. From your Mac, curl all three (`curl -sI localhost:<port> | head -1`).

3. Find your Mac's LAN IP (`ipconfig getifaddr en0`) and curl `p-all` and `p-local` on that IP. If you have a phone on the same Wi-Fi, try the URL there too.

4. Try to reach a container by its internal IP from macOS:

   ```bash
   curl -s --max-time 3 http://$(docker inspect -f '{{.NetworkSettings.IPAddress}}' p-all) || echo "not routable from macOS"
   ```

5. Prove `EXPOSE` doesn't publish anything: `docker run -d --name p-none --label lab=06 nginx:alpine` and check its `PORTS` column.

### Verify

- All three ports answer on `localhost`.
- On the LAN IP, `p-all` (8081) answers and `p-local` (8082) does not.
- Step 4 fails on Docker Desktop and Colima (it may succeed on OrbStack, which routes container IPs to macOS).
- `p-none` shows `80/tcp` with no `->` mapping.

:::hint
The `PORTS` column format is `hostIP:hostPort->containerPort/proto`. `0.0.0.0` (and `[::]`) means all interfaces.
:::

:::solution
Reasoning:
- `-p 8081:80` binds the forwarder to all interfaces on your Mac, so anyone on your network can reach it. On a laptop in a café, that's how you accidentally expose a dev database.
- `-p 127.0.0.1:8082:80` binds only loopback. Use this for dev databases and admin UIs.
- `-p 80` picks a free ephemeral host port; `docker port` tells you which.
- Container IPs like `172.17.0.x` live inside the VM; macOS has no route to them (OrbStack adds one). Always go through published ports from the Mac.
- `EXPOSE 80` in the nginx image is metadata only.
:::

### Clean up

```bash
docker rm -f p-all p-local p-rand p-none
```

## Lab 3: Aliases, round-robin DNS and tiered networks

:::meta
difficulty: medium
time: 25 min
:::

Goal: use network aliases to give several containers one name, and build a frontend/backend split where the database is unreachable from the proxy tier and has no internet access.

### Steps

1. Two "api" replicas behind one alias:

   ```bash
   docker network create frontend
   docker network create --internal backend
   for i in 1 2; do
     docker run -d --name api-$i --label lab=06 --network backend --network-alias api traefik/whoami
     docker network connect frontend api-$i
   done
   docker run --rm --network backend nicolaka/netshoot dig +short api
   for i in 1 2 3 4; do docker run --rm --network backend curlimages/curl -s http://api | grep Hostname; done
   ```

2. Add a "database" on the backend only and a "proxy" on the frontend only:

   ```bash
   docker run -d --name cache --label lab=06 --network backend redis:8-alpine
   docker run -d --name proxy --label lab=06 --network frontend nginx:alpine
   ```

3. Test reachability matrix:

   Each command runs netshoot **inside the network namespace** of the container under test (`--network container:<name>`), so it sees exactly what that container sees:

   ```bash
   # proxy -> api ?
   docker run --rm --network container:proxy nicolaka/netshoot curl -s --max-time 3 http://api-1 | grep Hostname
   # proxy -> cache ?
   docker run --rm --network container:proxy nicolaka/netshoot nc -zv -w 3 cache 6379
   # cache -> internet ?
   docker run --rm --network container:cache nicolaka/netshoot curl -sI --max-time 3 https://example.com
   # proxy -> internet ?
   docker run --rm --network container:proxy nicolaka/netshoot curl -sI --max-time 3 https://example.com | head -1
   ```

### Verify

- `dig +short api` returns two IPs; the curl loop shows both hostnames (order may vary; caching can make it sticky).
- proxy → api works; proxy → cache fails with a name-resolution error (the name doesn't even resolve on `frontend`).
- cache → internet fails (internal network); proxy → internet returns `HTTP/2 200` or similar.

:::hint
`--network-alias` only applies to the network named in `--network` at run time. The alias `api` exists on `backend`, not on `frontend`; that's why the proxy uses `api-1` in step 3. To add an alias on another network, use `docker network connect --alias api frontend api-1`.
:::

:::solution
To make the proxy also reach the replicas by the shared name, re-attach them to `frontend` with the alias:

```bash
for i in 1 2; do
  docker network disconnect frontend api-$i
  docker network connect --alias api frontend api-$i
done
docker exec proxy wget -qO- http://api | grep Hostname
```

Why each result:
- `cache` is only on `backend`; the embedded DNS on `frontend` has no record for it, so the proxy can't resolve it.
- `backend` is `--internal`: Docker gives it no gateway to the outside, so `cache` can't reach the internet. `api-*` can still reach the internet via `frontend`.
- DNS round-robin is client-side: curl picks one address per run, nothing checks health. This is what `docker compose --scale` relies on.
:::

### Clean up

```bash
docker rm -f api-1 api-2 cache proxy; docker network rm frontend backend
```

## Lab 4: Break & fix: "connection refused" from a published port

:::meta
difficulty: medium
time: 25 min
:::

Goal: use the debugging checklist and netshoot (sharing the container's network namespace) to find why a published port doesn't work.

### Steps

1. Build this deliberately broken service:

   ```bash
   mkdir -p broken && cd broken
   cat > server.mjs <<'EOF'
   import http from 'node:http';
   const host = process.env.HOST ?? '127.0.0.1';
   const port = Number(process.env.PORT ?? 3000);
   http.createServer((req, res) => {
     res.setHeader('content-type', 'application/json');
     res.end(JSON.stringify({ ok: true, path: req.url }));
   }).listen(port, host, () => console.log(`listening on ${host}:${port}`));
   EOF
   cat > Dockerfile <<'EOF'
   FROM node:22-alpine
   WORKDIR /app
   COPY server.mjs .
   ENV PORT=3000
   EXPOSE 3000
   CMD ["node", "server.mjs"]
   EOF
   docker build -t broken-api .
   docker run -d --name broken --label lab=06 -p 3000:8080 broken-api
   curl -sv localhost:3000/healthz
   ```

2. There are **two** bugs. Diagnose them without editing the code first: use `docker logs`, `docker port`, and netshoot sharing the container's network namespace (`ss -ltnp`, `curl`).

3. Fix both with `docker run` flags only (no rebuild).

### Verify

`curl -s localhost:3000/healthz` returns `{"ok":true,"path":"/healthz"}`.

:::hint
Start with `docker run --rm -it --network container:broken nicolaka/netshoot ss -ltn`. Compare the listening address and port with what `docker port broken` says is published.
:::

:::solution
```bash
docker logs broken                     # listening on 127.0.0.1:3000
docker port broken                     # 8080/tcp -> 0.0.0.0:3000
docker run --rm --network container:broken nicolaka/netshoot ss -ltn
# LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*
docker run --rm --network container:broken nicolaka/netshoot curl -s localhost:3000/x   # works *inside*
```

Bug 1: the mapping `-p 3000:8080` forwards to container port **8080**, but the app listens on **3000**. Bug 2: the app binds `127.0.0.1`, the container's own loopback, so even with the right port, NAT'd traffic arriving on `eth0` gets "connection refused".

```bash
docker rm -f broken
docker run -d --name broken --label lab=06 -p 3000:3000 -e HOST=0.0.0.0 broken-api
curl -s localhost:3000/healthz
```

The permanent fix is to default `HOST` to `0.0.0.0` in the code or image (`ENV HOST=0.0.0.0`). Note how sharing the namespace let you test from "inside" the container even though the image has no curl.
:::

### Clean up

```bash
docker rm -f broken; docker rmi broken-api; cd .. && rm -rf broken
```

## Lab 5: Challenge: wire shipit's dependencies by hand (no Compose)

:::meta
difficulty: hard
time: 40 min
:::

Goal: build with plain `docker` commands the network topology Compose will later give you for free, and debug DNS from a client container.

### Requirements

- Networks: `shipit-edge` (normal) and `shipit-data` (`--internal`).
- `postgres:18` named `pg` with alias `db`, and `redis:8-alpine` named `redis` with alias `cache`, both **only** on `shipit-data`, neither publishing ports to the host... except Postgres, which must be reachable from your Mac on **localhost only**, port `15432`, for a GUI client.

  (Hint: an internal network can't publish ports. Think about which network a container needs to be on for publishing to work.)
- A client container `toolbox` (netshoot) on both networks that can: resolve `db` and `cache`, connect to `db:5432` and `cache:6379`, and reach the internet.
- From your Mac: `psql` or `nc -zv 127.0.0.1 15432` works; from your LAN IP it does not.
- From `toolbox`, use `dig` to show that `db` and `pg` return the same IP, and that `dig db` against a public resolver (`@1.1.1.1`) does not.

:::hint
Publishing requires the container to be attached to a non-internal bridge network. Attach `pg` to an extra normal network (e.g. `shipit-edge` or a dedicated `pg-publish` network) only for the publish, and bind it to `127.0.0.1`.
:::

:::solution
```bash
docker network create shipit-edge
docker network create --internal shipit-data
docker network create pg-publish          # normal bridge used only so pg can publish a port

docker run -d --name redis --label lab=06 \
  --network shipit-data --network-alias cache redis:8-alpine

# Ports are fixed at creation time, so create pg on the publishable network with -p,
# then attach the internal network (with the alias) afterwards.
docker run -d --name pg --label lab=06 \
  --network pg-publish -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=shipit -e POSTGRES_PASSWORD=shipit -e POSTGRES_DB=shipit \
  postgres:18
docker network connect --alias db shipit-data pg

docker run -d --name toolbox --label lab=06 --network shipit-edge nicolaka/netshoot sleep infinity
docker network connect shipit-data toolbox

docker exec toolbox dig +short db
docker exec toolbox dig +short pg
docker exec toolbox dig +short cache
docker exec toolbox nc -zv db 5432
docker exec toolbox nc -zv cache 6379
docker exec toolbox curl -sI https://example.com | head -1
docker exec toolbox dig @1.1.1.1 db +short        # empty: only Docker's DNS knows 'db'

nc -zv 127.0.0.1 15432                              # from macOS: succeeds
nc -zv -G 2 "$(ipconfig getifaddr en0)" 15432       # from macOS via LAN IP: refused
```

Notes:
- Port publishing is decided when the container is created, and an `--internal` network has no path to the host's external interfaces, so a container attached only to `shipit-data` can't usefully publish anything. Creating `pg` on `pg-publish` with `-p` solves that.
- `pg` is on `pg-publish` (so the publish works) and `shipit-data` (so the app tier finds it as `db`). Nothing else is on `pg-publish`.
- The alias `db` is resolved by Docker's embedded DNS at 127.0.0.11; public resolvers know nothing about it.
- In module 07 you'll see Compose express all of this in about 25 lines of YAML.
:::

### Clean up

```bash
docker rm -f pg redis toolbox
docker network rm shipit-edge shipit-data pg-publish
```
