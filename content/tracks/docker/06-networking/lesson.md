Most "Docker is broken" tickets are really networking misunderstandings: the API can't reach Postgres, `localhost` means something unexpected, a port is published but unreachable, or DNS resolves to the wrong thing. This module builds the model you need to reason about all of them, from Linux primitives up to Compose-style service discovery.

## The mental model: every container gets its own network stack

From the internals module: a container is a set of processes in their own **network namespace**. A network namespace has its own interfaces, IP addresses, routing table, firewall rules and port space. That's why two containers can both listen on port 3000 without conflict, and why `localhost` inside a container means *that container*, not your Mac.

To connect a namespace to anything, Docker uses **virtual Ethernet pairs** (veth): a virtual cable with one end (`eth0`) inside the container and the other end plugged into a **Linux bridge** (a virtual switch) on the host.

```text
                  Docker host (Linux, or the VM on your Mac)
 ┌───────────────────────────────────────────────────────────────────┐
 │                                                                   │
 │   ┌──────────────┐      ┌──────────────┐                          │
 │   │ container api│      │ container db │     network namespaces   │
 │   │  eth0        │      │  eth0        │                          │
 │   │  172.18.0.2  │      │  172.18.0.3  │                          │
 │   └──────┬───────┘      └──────┬───────┘                          │
 │      veth│pair             veth│pair                              │
 │   ┌──────┴─────────────────────┴───────┐                          │
 │   │  bridge br-3f2a…  (172.18.0.1/16)  │  <- virtual switch       │
 │   └─────────────────┬──────────────────┘                          │
 │                     │  routing + NAT (iptables / nftables)        │
 │               ┌─────┴─────┐                                       │
 │               │ eth0 host │ ──────────────▶  LAN / internet        │
 │               └───────────┘                                       │
 └───────────────────────────────────────────────────────────────────┘
```

Outbound traffic from a container is **masqueraded** (source NAT) to the host's IP, which is why containers can reach the internet by default. Inbound traffic needs an explicit **port publish** (`-p`), which installs destination NAT rules.

## Network drivers

`docker network ls` on a fresh install shows three networks: `bridge`, `host` and `none`. Each uses a driver.

| Driver | What it does | Use it for |
| --- | --- | --- |
| `bridge` | Private subnet on a Linux bridge on one host; NAT to the outside | The default for single-host apps, dev, Compose |
| `host` | No network namespace: the container shares the host's stack | Max network performance, apps that need many ports, tools that inspect host networking |
| `none` | Only a loopback interface | Batch jobs that must have no network, security sandboxing |
| `overlay` | A virtual L2 network spanning multiple Docker hosts (VXLAN) | Docker Swarm services; rare outside Swarm |
| `macvlan` / `ipvlan` | Gives the container its own address on the physical LAN | Legacy apps that must appear as a real device on the network |

### `host` networking

With `--network host`, the process binds directly to the host's interfaces. `-p` is ignored (there is nothing to translate). It's fast and simple on a Linux server, and it removes isolation: a container listening on `0.0.0.0:3000` is now listening on the server's public interface.

:::mac Host networking on a Mac is not what you think
On macOS, "the host" for containers is the Linux VM, not your Mac. Historically `--network host` attached to the VM's network, so `localhost:3000` on your Mac didn't reach it. Docker Desktop 4.34+ has an opt-in **Enable host networking** setting (Settings → Resources → Network, requires sign-in) that works at layer 4 (TCP/UDP) only, and OrbStack supports it too. For portable setups, use normal port publishing on Mac and keep `host` mode for Linux servers.
:::

### `overlay` and `macvlan` briefly

**Overlay** networks encapsulate container traffic in VXLAN packets between hosts so containers on different machines share a subnet. They need Swarm mode (`docker swarm init`). In Kubernetes, the CNI plugin solves the same problem, so you'll rarely create overlays by hand.

**Macvlan** assigns each container its own MAC address on a parent interface, so it gets an IP from your LAN like a physical machine. It needs promiscuous mode on the NIC, often doesn't work on Wi-Fi or in cloud VPCs, and by design the host can't talk to its own macvlan containers without extra config. Know it exists; reach for it rarely.

## Default bridge vs user-defined bridge

This is the single most important practical distinction in Docker networking.

The **default `bridge` network** (`docker0`, usually `172.17.0.0/16`) is where containers go when you don't pass `--network`. It's kept for backwards compatibility and has two big limitations:

- **No DNS between containers.** Containers can only reach each other by IP. The old fix was `--link`, which is deprecated.
- **Everything shares it.** Every container started without `--network` can talk to every other one.

A **user-defined bridge** (`docker network create shipit`) fixes both:

| | Default `bridge` | User-defined bridge |
| --- | --- | --- |
| Name resolution between containers | No (IP only, or legacy `--link`) | Yes, via Docker's embedded DNS |
| Isolation | All "default" containers share it | Only containers you attach |
| Connect/disconnect running containers | Must restart | `docker network connect/disconnect` live |
| Per-network config (subnet, MTU, internal) | Daemon-wide only | Per network |

Compose creates a user-defined bridge per project automatically (`<project>_default`), which is why `postgres://db:5432` "just works" in Compose but not with two bare `docker run` commands.

### The embedded DNS server: 127.0.0.11

On user-defined networks, Docker runs an **embedded DNS server** that each container reaches at `127.0.0.11`. Look at `/etc/resolv.conf` inside such a container:

```bash
docker network create shipit
docker run --rm --network shipit alpine cat /etc/resolv.conf
# nameserver 127.0.0.11
# options ndots:0
```

The embedded server answers for:

- **container names** (`--name db`),
- **network aliases** (`--network-alias postgres`),
- **Compose service names** (`db`, plus `<project>-db-1` container names),

and forwards everything else to the host's upstream resolvers. The address is a loopback address *inside the container's namespace*; Docker intercepts it with NAT rules and handles the queries in the daemon.

:::try Prove the DNS difference
```bash
docker run -d --name web1 nginx:alpine                      # default bridge
docker run --rm alpine wget -qO- http://web1 || echo "no DNS on default bridge"
docker network create demo
docker run -d --name web2 --network demo nginx:alpine
docker run --rm --network demo alpine wget -qO- http://web2 | head -4
docker rm -f web1 web2; docker network rm demo
```
:::

### Network aliases and round-robin DNS

An alias is an extra DNS name for a container on a specific network. Several containers can share one alias; the embedded DNS returns all their IPs (DNS round-robin).

```bash
docker network create backend
docker run -d --network backend --network-alias search --name search-1 traefik/whoami
docker run -d --network backend --network-alias search --name search-2 traefik/whoami
docker run --rm --network backend nicolaka/netshoot dig +short search
# 172.19.0.2
# 172.19.0.3
```

This is exactly how `docker compose up --scale api=3` makes `api` resolve to three containers. It's crude load balancing: clients often cache the first answer, and there's no health checking. In production you put a real load balancer or proxy in front.

### Multiple networks for isolation

A container can join several networks. Use that to model tiers:

```text
            ┌────────── frontend network ──────────┐
 internet ─▶│  proxy (nginx) ──────▶ api           │
            └──────────────────────────┬───────────┘
                         ┌─────────────┴─ backend network (internal) ─┐
                         │             api ──▶ postgres, redis         │
                         └─────────────────────────────────────────────┘
```

```bash
docker network create frontend
docker network create --internal backend      # --internal: no route to the outside world
docker run -d --name db --network backend -e POSTGRES_PASSWORD=x postgres:18
docker run -d --name api --network backend shipit-api
docker network connect frontend api           # api is now on both networks
```

The proxy can reach `api` but not `db`; `db` can't reach the internet at all. In Compose you express this with `networks:` per service (module 07).

## Port publishing: what `-p` really does

`-p 8080:3000` means: "traffic arriving at the host on port 8080 should be forwarded to this container's port 3000". Variants:

| Flag | Meaning |
| --- | --- |
| `-p 8080:3000` | Host port 8080 on **all host interfaces** → container 3000 |
| `-p 127.0.0.1:8080:3000` | Only reachable from the host itself |
| `-p 3000` | Random high host port → container 3000 (`docker port` shows which) |
| `-p 5353:53/udp` | UDP |
| `-P` | Publish every `EXPOSE`d port to random host ports |

`EXPOSE` in a Dockerfile **does not publish anything**. It's documentation (and the input for `-P`).

### Underneath on Linux: NAT rules plus docker-proxy

When you publish a port, the daemon does two things:

1. **Installs DNAT rules** in the firewall (iptables by default; nftables is supported as an alternative backend in recent Engine versions). Packets arriving for `host:8080` are rewritten to `172.18.0.2:3000` before routing, in the `nat` table's `DOCKER` chain. A `FORWARD` rule allows them through.
2. **Starts `docker-proxy`** (the *userland proxy*), a small process listening on host port 8080. It handles cases the NAT rules can't, such as connections from the host to its own `127.0.0.1` and hairpin traffic. You can see it with `ss -ltnp` or `ps aux | grep docker-proxy` on a Linux host. It can be disabled with `"userland-proxy": false` in `daemon.json`.

```text
 client ──▶ host:8080 ──[nat PREROUTING → DOCKER chain: DNAT]──▶ 172.18.0.2:3000 ──▶ container
 host process ──▶ 127.0.0.1:8080 ──▶ docker-proxy ──▶ 172.18.0.2:3000
```

:::warning Published ports bypass ufw
Because Docker rewrites packets in the `nat` table *before* they reach the `INPUT` chain, host firewalls such as **ufw** don't see them. `-p 5432:5432` on a cloud VM exposes Postgres to the internet even if `ufw deny 5432` is set. Bind to localhost (`-p 127.0.0.1:5432:5432`), don't publish internal services at all, or add rules to the `DOCKER-USER` chain, which Docker reserves for your own filtering. Cloud security groups still apply because they sit outside the VM.
:::

### On a Mac: one more hop

Your containers live inside a Linux VM. Docker Desktop (and OrbStack, Colima) run a forwarder on macOS that listens on `localhost:8080` and relays connections into the VM, where the normal NAT rules take over.

```text
 Browser on macOS ──▶ localhost:8080 (macOS) ──▶ Docker Desktop port forwarder
        ──▶ Linux VM:8080 ──▶ NAT ──▶ container:3000
```

Consequences: you can't reach containers by their `172.x` IPs from macOS (those addresses exist only inside the VM; OrbStack is an exception and routes them), and a published port binds on your Mac's interfaces, so `-p 8080:80` is reachable from other machines on your Wi-Fi unless you use `127.0.0.1:8080:80`.

## Container-to-container and container-to-host

**Container → container**: put both on the same user-defined network and use the container (or service) name and the **container port**. Published host ports are irrelevant here.

```text
 api container ──▶ postgres://db:5432        ✅ container name + container port
 api container ──▶ postgres://localhost:5432 ❌ localhost is the api container itself
 api container ──▶ postgres://db:15432       ❌ 15432 is the *host* port from -p 15432:5432
```

**Container → service on your Mac** (e.g. a Postgres you run natively, or a NestJS app you're debugging outside Docker): use **`host.docker.internal`**. Docker Desktop, OrbStack and Colima resolve it to the host. On Linux Docker Engine it isn't defined by default; add it with:

```bash
docker run --add-host=host.docker.internal:host-gateway ...
```

`host-gateway` is a special value the daemon replaces with the host's IP on the bridge. In Compose: `extra_hosts: ["host.docker.internal:host-gateway"]`. Remember the host-side service must listen on an address the container can reach (not only `127.0.0.1` on Linux).

:::try Reach your Mac from a container
```bash
python3 -m http.server 9000 &           # a server on macOS
docker run --rm curlimages/curl -s http://host.docker.internal:9000 | head -3
kill %1
```
:::

## Debugging toolkit

Most images (especially slim, distroless, or production ones) have no `ping`, `curl` or `dig`. Instead of installing tools into your app container, **bring a tools container and join it to the target's network namespace**.

### nicolaka/netshoot

[netshoot](https://github.com/nicolaka/netshoot) packs `curl`, `dig`, `nslookup`, `ss`, `ip`, `tcpdump`, `iperf3`, `nmap`, `mtr`, `openssl` and more. It has arm64 builds.

```bash
# Join a user-defined network as a new peer: test DNS and connectivity like any container would
docker run --rm -it --network shipit nicolaka/netshoot

# Share an existing container's network namespace: you ARE that container, network-wise
docker run --rm -it --network container:shipit-api nicolaka/netshoot
```

The second form is the killer trick: `localhost` now means the api container, so `ss -ltnp` shows what *it* is listening on, and `tcpdump -i eth0` captures *its* traffic.

### The questions to ask, in order

```text
1. Is the process running and listening?     docker ps; docker logs; ss -ltnp (from netshoot, shared ns)
2. On which address? 0.0.0.0 or 127.0.0.1?   ss -ltn  → 127.0.0.1:3000 means unreachable from outside
3. Are both containers on the same network?   docker inspect -f '{{json .NetworkSettings.Networks}}' api
4. Does the name resolve?                     dig db  /  getent hosts db   (from a container on that network)
5. Is the port open from the client side?     nc -zv db 5432  /  curl -v http://api:3000/healthz
6. Is the port published (for host access)?   docker port api; docker ps PORTS column
7. Is something else in the way?              firewall, proxy env vars, wrong host port, app bound to IPv6 only
```

:::warning The #1 cause of "port published but connection refused"
The app listens on `127.0.0.1` inside the container. That's the container's own loopback; NAT traffic arrives on `eth0`, so nothing answers. Node's `server.listen(3000)` binds all interfaces by default, but many frameworks' dev servers (Vite, Next.js in some modes, Python `flask run`) default to localhost. Bind to `0.0.0.0` (e.g. `vite --host 0.0.0.0`).
:::

### Useful commands

```bash
docker network ls
docker network inspect shipit                                  # subnet, gateway, attached containers + IPs
docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\n"}}{{end}}' api
docker port api                                                # published mappings
docker network connect --alias cache shipit redis              # attach live with an alias
docker network disconnect shipit redis
docker network prune                                           # remove unused networks
```

Inside netshoot:

```bash
dig db                       # full answer; dig +short db for just IPs
dig @127.0.0.11 db           # ask Docker's embedded DNS explicitly
curl -sv http://api:3000/readyz
ss -ltnp                     # listening TCP sockets and processes (in shared ns)
nc -zv db 5432               # is the port open?
tcpdump -i eth0 port 5432 -nn
```

:::deep How the embedded DNS and port rules look on the host
On a Linux host (or inside the Docker Desktop VM via `docker run --rm -it --privileged --pid=host debian nsenter -t 1 -n -- sh`), you can inspect what Docker created:

```bash
ip link show type bridge            # docker0 and br-<id> bridges
ip link show type veth              # one veth per container interface
iptables -t nat -L DOCKER -n        # DNAT rules for published ports
iptables -L DOCKER-USER -n          # your custom filtering chain (empty by default)
```

For DNS, each container on a user-defined network gets NAT rules *inside its own namespace* that redirect `127.0.0.11:53` to a random port where the daemon's resolver listens. You can see them with `nsenter -t <container-pid> -n iptables -t nat -L -n`. The daemon resolves names using its in-memory view of the network (containers, aliases, service names) and forwards misses to the host's resolvers from `/etc/resolv.conf`. That's why changing the host DNS while the daemon runs sometimes needs a daemon restart, and why `--dns` overrides only the *upstream* servers, not 127.0.0.11.

Recent Engine releases moved toward nftables as an alternative firewall backend (`"firewall-backend": "nftables"` in `daemon.json`) and tightened defaults around which addresses can reach published ports directly. If you manage Linux servers, read the "Packet filtering and firewalls" page for your Engine version rather than relying on old blog posts.
:::

## Pitfalls and production practices

- **Always use user-defined networks** (Compose does this for you). Never rely on the default bridge or `--link`.
- **Don't publish ports for internal services.** Postgres and Redis only need to be reachable by the API over the Docker network. Publish them to `127.0.0.1` in dev if you want a GUI client.
- **Use container ports for container-to-container traffic**, host ports only from outside.
- **Bind apps to `0.0.0.0`** inside containers.
- **Mark backend networks `--internal`** when they don't need egress.
- **Remember DNS round-robin isn't load balancing.** Use a proxy (nginx, Traefik, Envoy) or your orchestrator's service abstraction.
- **Corporate VPNs and subnet clashes**: Docker picks private ranges like `172.17-31.x.x` and `192.168.x.x`. If those collide with your VPN or office network, set `default-address-pools` in `daemon.json` (Docker Desktop: Settings → Docker Engine).
- **Proxies**: if your company uses an HTTP proxy, containers need `HTTP_PROXY`/`NO_PROXY` too, and `NO_PROXY` must include internal service names (`db,redis,api`) or internal calls get sent to the proxy.

## Summary

- Each container has its own network namespace; `localhost` is the container itself.
- User-defined bridges give you DNS via `127.0.0.11`, aliases and isolation; the default bridge doesn't.
- `-p` installs DNAT rules plus a `docker-proxy`; on a Mac there's an extra forwarder from macOS into the VM. Published ports bypass ufw.
- Container-to-container uses names and container ports; container-to-Mac uses `host.docker.internal`.
- Debug by joining netshoot to the network or to the container's namespace and walking the checklist.
