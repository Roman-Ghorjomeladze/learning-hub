Pods come and go, and every new pod gets a new IP. Your shipit-api needs a stable way to reach Postgres and Redis, your frontend needs a stable way to reach the API, and users need a way in from outside. This module explains the networking model underneath, how Services turn a moving set of pods into one stable address, and how DNS ties it together. It ends with a debugging method you will use for the rest of your career.

## The Kubernetes network model

Kubernetes requires a flat network with three rules:

1. **Every pod gets its own IP address.** Containers in a pod share it.
2. **Pods can reach every other pod's IP directly, on any node, without NAT.** The IP a pod sees for itself is the IP others use to reach it.
3. **Node agents (like the kubelet) can reach all pods on their node.**

Kubernetes does not implement this itself. A **CNI (Container Network Interface) plugin** does: when the kubelet creates a pod sandbox, the runtime calls the CNI plugin to create a network interface in the pod's namespace, assign an IP from the node's pod range, and set up routes so other nodes can reach it.

```text
  node lab-worker  (pod CIDR 10.244.1.0/24)      node lab-worker2 (pod CIDR 10.244.2.0/24)
 +-----------------------------------+          +-----------------------------------+
 |  pod A 10.244.1.5   pod B 10.244.1.6|          |  pod C 10.244.2.9                 |
 |      |                 |          |          |      |                            |
 |   veth              veth          |          |   veth                            |
 |      +------- node routing -------+--------- +------+  routes / overlay / VPC     |
 |   eth0 172.18.0.3                 |          |   eth0 172.18.0.4                 |
 +-----------------------------------+          +-----------------------------------+
          A -> C: 10.244.1.5 -> 10.244.2.9, no NAT; the CNI makes the route work
```

CNI plugins differ in *how* they connect nodes:

| Plugin | Approach | Where you meet it |
| --- | --- | --- |
| kindnet | Simple routes between nodes | kind (default) |
| Amazon VPC CNI | Pods get real VPC IPs from the node's ENIs | EKS (default) |
| Calico | BGP routes or overlay; strong NetworkPolicy | Self-managed, many platforms |
| Cilium | eBPF datapath; can replace kube-proxy; L7 policy, observability (Hubble) | GKE Dataplane V2, increasingly everywhere |
| Flannel | VXLAN overlay | Simple self-managed clusters |

:::info Why pod IPs are not enough
You could connect to pod IPs directly; the network allows it. But pods are replaced on every deploy, reschedule and crash, and there are usually several replicas. Clients need a **stable name and address** and **load balancing** across whichever replicas are healthy right now. That is a Service.
:::

## Service anatomy

```yaml
apiVersion: v1
kind: Service
metadata:
  name: shipit-api
  namespace: shipit
spec:
  type: ClusterIP                      # default
  selector:                            # which pods are backends
    app.kubernetes.io/name: shipit-api
  ports:
    - name: http                       # required when there are multiple ports
      protocol: TCP
      port: 80                         # the port clients use on the Service IP
      targetPort: http                 # the container port: a number or a named port
```

When you create it:

1. The API server allocates a **ClusterIP** from the service CIDR (on kind, `10.96.0.0/16`). This IP is **virtual**: no interface owns it, and it does not answer ping.
2. The **EndpointSlice controller** finds pods matching the selector and writes their IPs and ports into EndpointSlice objects, marking each as ready or not.
3. **kube-proxy** on every node watches Services and EndpointSlices and programs kernel rules: "traffic to 10.96.45.12:80 → DNAT to one of 10.244.1.5:3000, 10.244.2.9:3000".
4. **CoreDNS** answers `shipit-api.shipit.svc.cluster.local` with the ClusterIP.

```text
client pod                     node kernel (rules from kube-proxy)            backend pods
curl shipit-api   --DNS-->  10.96.45.12:80  --DNAT (random pick)-->   10.244.1.5:3000  (Ready)
                                                                   \-> 10.244.2.9:3000  (Ready)
                                                                       10.244.2.7:3000  (NOT ready: excluded)
```

### port, targetPort, nodePort and named ports

```text
 outside            node IP:nodePort (30080)  --+
                                                 |
 inside cluster     ClusterIP:port (80) ---------+--> podIP:targetPort (3000 / "http")
```

- `port`: what clients connect to on the Service.
- `targetPort`: where the app listens in the pod. Defaults to `port` if omitted.
- `nodePort`: for NodePort/LoadBalancer types, the port opened on **every** node (30000–32767 by default).
- **Named ports** (`targetPort: http` matching `ports[].name: http` in the container) decouple the Service from the number. During a migration, old pods can listen on 3000 and new pods on 8080 under the same name, and the Service routes correctly to each.

### EndpointSlices

```bash
kubectl get endpointslices -n shipit -l kubernetes.io/service-name=shipit-api
kubectl describe endpointslice -n shipit <name>
```

Each endpoint has conditions: `ready` (receives traffic), `serving` (passing readiness, even while terminating) and `terminating`. A pod whose readiness probe fails stays in the slice with `ready: false` and receives no new traffic. Slices hold up to 100 endpoints each, which keeps updates cheap for large Services. The older `Endpoints` API is deprecated (since v1.33) in favour of EndpointSlices; you will still see it in older tooling and `kubectl get endpoints` prints a deprecation warning.

:::tip Empty EndpointSlice = your first clue
If a Service "does not work", check its endpoints before anything else. No endpoints means the selector matches no pods, or none of the matching pods are Ready. Either way, DNS and kube-proxy are innocent.
:::

## Service types

### ClusterIP (default)

Reachable only inside the cluster. This is what you use for service-to-service traffic: shipit-api → `postgres`, `redis`.

### NodePort

A ClusterIP Service **plus** a port opened on every node's IP. Traffic to `<any-node-ip>:30080` is forwarded to a backend pod, which may be on another node.

```yaml
spec:
  type: NodePort
  ports:
    - port: 80
      targetPort: http
      nodePort: 30080     # omit to get a random one from the range
```

Use it for kind/local access (with kind's `extraPortMappings`), for bare-metal setups behind an external load balancer, or as the building block that cloud load balancers target. Exposing NodePorts directly to the internet is rarely a good idea.

### LoadBalancer

A NodePort Service **plus** an external load balancer provisioned by a cloud controller. The Service's `status.loadBalancer.ingress` gets the external IP or hostname.

- On **EKS**, the AWS Load Balancer Controller creates an NLB (annotate with `service.beta.kubernetes.io/aws-load-balancer-type: external` and choose IP or instance targets). The legacy in-tree controller created Classic LBs.
- On **GKE/AKS**, the cloud controller manager creates a cloud LB.
- On **kind**, nothing happens (EXTERNAL-IP stays `<pending>`) until you run **cloud-provider-kind**, which creates a small load-balancer container per Service.
- On bare metal: MetalLB or Cilium's LB IPAM.

Each LoadBalancer Service usually costs a cloud load balancer (money and limits). For HTTP traffic you typically run **one** load balancer in front of a Gateway (Gateway API, the next networking topic in this track) and route many hostnames and paths through it.

### ExternalName

A DNS alias, nothing more:

```yaml
apiVersion: v1
kind: Service
metadata: { name: payments-db, namespace: shipit }
spec:
  type: ExternalName
  externalName: shipit-prod.abc123.eu-central-1.rds.amazonaws.com
```

`payments-db.shipit.svc.cluster.local` becomes a CNAME to the RDS hostname. No ClusterIP, no proxying, no port mapping. Useful for giving in-cluster code a stable name for an external dependency. Caveat: HTTP clients send the original name in the `Host` header and TLS SNI, so HTTPS to an ExternalName often fails certificate validation unless the server accepts that name.

### Headless Services

`clusterIP: None` means no virtual IP and no kube-proxy rules. DNS returns the **pod IPs** directly (one A record per Ready pod), and for StatefulSets each pod gets its own name (`postgres-0.postgres.shipit.svc.cluster.local`). Use headless Services when clients need to reach specific pods or do their own load balancing (database drivers with replica awareness, Kafka, gRPC client-side balancing).

### Services without a selector

Omit `selector` and Kubernetes creates no EndpointSlices. You create them yourself, pointing at any IPs, for example a legacy VM or a database outside the cluster, while clients use a normal Service name:

```yaml
apiVersion: v1
kind: Service
metadata: { name: legacy-billing }
spec:
  ports: [{ name: http, port: 80, targetPort: 8080 }]
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: legacy-billing-1
  labels:
    kubernetes.io/service-name: legacy-billing     # links the slice to the Service
addressType: IPv4
ports: [{ name: http, port: 8080, protocol: TCP }]
endpoints:
  - addresses: ["10.0.12.34"]
```

## How kube-proxy implements Services

kube-proxy watches Services and EndpointSlices and programs the node's packet filtering. It has three modes on Linux:

| Mode | How | Notes |
| --- | --- | --- |
| `iptables` | NAT chains per Service with random-probability rules per endpoint | Default for years; rule updates get slow with tens of thousands of Services/endpoints |
| `ipvs` | Kernel IPVS virtual servers with real load-balancing algorithms | Scales better than iptables, but deprecated since v1.35; plan to move off it |
| `nftables` | nftables sets and maps, the successor to iptables | Stable since v1.33; better performance and faster updates; the recommended direction for new clusters |

Some CNIs (Cilium, Calico eBPF) replace kube-proxy entirely with eBPF programs. On EKS, kube-proxy is an add-on you can configure; on GKE Dataplane V2, Cilium handles Services.

:::deep Inside iptables mode
For each Service, kube-proxy creates a chain that picks an endpoint at random with decreasing probabilities, then a per-endpoint chain that DNATs to the pod:

```text
-A KUBE-SERVICES -d 10.96.45.12/32 -p tcp --dport 80 -j KUBE-SVC-ABCDEF
-A KUBE-SVC-ABCDEF -m statistic --mode random --probability 0.33333 -j KUBE-SEP-111
-A KUBE-SVC-ABCDEF -m statistic --mode random --probability 0.50000 -j KUBE-SEP-222
-A KUBE-SVC-ABCDEF -j KUBE-SEP-333
-A KUBE-SEP-111 -p tcp -j DNAT --to-destination 10.244.1.5:3000
```

With 3 endpoints: the first rule matches 1/3 of the time; of the remaining 2/3, the second matches half (another 1/3); the rest fall through to the third. The choice is made **once per connection** (conntrack remembers it), not per request. That has a big practical consequence: long-lived connections (HTTP keep-alive pools, gRPC/HTTP2, database connections, WebSockets from Socket.io) stick to one pod. If you scale from 2 to 10 pods, existing connections do not rebalance. Use client-side balancing, connection max-age, or an L7 proxy/mesh for gRPC. You can see these rules on a kind node with `docker exec lab-worker iptables-save -t nat | grep shipit`.
:::

### Session affinity

```yaml
spec:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP: { timeoutSeconds: 3600 }
```

All connections from the same client IP go to the same pod for the timeout window. It is coarse (all users behind one NAT hit one pod) and breaks when the pod goes away. Prefer stateless apps with shared state in Redis; for Socket.io, use the Redis adapter, and if you need sticky sessions for long-polling, do it at the L7 layer (Gateway/Ingress cookie affinity).

### Traffic policies

- `externalTrafficPolicy: Cluster` (default): NodePort/LB traffic can be forwarded to pods on any node. Even load, but an extra hop and the client source IP is SNATed away.
- `externalTrafficPolicy: Local`: only pods on the receiving node serve; nodes without a local pod drop the traffic (cloud LBs health-check nodes to avoid them). Preserves the client source IP.
- `internalTrafficPolicy: Local`: in-cluster traffic only goes to pods on the same node (for node-local agents).
- `trafficDistribution: PreferClose`: a hint to prefer endpoints in the same zone, cutting cross-AZ data transfer costs on AWS.

## Cluster DNS

CoreDNS runs as a Deployment in `kube-system` behind a Service named `kube-dns` (on kind, at `10.96.0.10`). The kubelet writes each pod's `/etc/resolv.conf` to point at it:

```text
search shipit.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

### Record types

| Name | Answer |
| --- | --- |
| `shipit-api.shipit.svc.cluster.local` | A/AAAA: the ClusterIP |
| `postgres.shipit.svc.cluster.local` (headless) | A records for every Ready pod IP |
| `postgres-0.postgres.shipit.svc.cluster.local` | A: that StatefulSet pod's IP |
| `_http._tcp.shipit-api.shipit.svc.cluster.local` | SRV: port number and target for the named port `http` |
| `payments-db.shipit.svc.cluster.local` (ExternalName) | CNAME to the external name |
| `10-244-1-5.shipit.pod.cluster.local` | A: pod IP (rarely used) |

Thanks to the search list, from a pod in namespace `shipit`:

- `redis` → tries `redis.shipit.svc.cluster.local` first. Same-namespace short names work.
- `redis.cache` → `redis.cache.svc.cluster.local` (Service `redis` in namespace `cache`) via the second search entry.
- Use the full name in config that crosses namespaces, to be explicit.

### ndots and why your external calls might be slow

`ndots:5` means: if a name has fewer than 5 dots, try it with each search domain **before** trying it as-is. So `api.stripe.com` (2 dots) from a pod becomes:

```text
api.stripe.com.shipit.svc.cluster.local   -> NXDOMAIN
api.stripe.com.svc.cluster.local          -> NXDOMAIN
api.stripe.com.cluster.local              -> NXDOMAIN
api.stripe.com                            -> answer
(each for A and AAAA)
```

That is up to 8 queries for one lookup. In a busy Node.js service making lots of outbound calls, this adds latency and load on CoreDNS. Mitigations:

- Use a fully qualified name with a trailing dot (`api.stripe.com.`) where your client allows it.
- Lower `ndots` for that workload:

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
```

- Run NodeLocal DNSCache (a DaemonSet caching resolver) on large clusters.
- Reuse connections (keep-alive agents) so you resolve less often. Node.js does not cache DNS results itself; each new connection calls `getaddrinfo` through libuv's thread pool.

`dnsPolicy` controls all of this: `ClusterFirst` (default: cluster DNS, external names forwarded upstream), `Default` (inherit the node's resolver), `None` (only your `dnsConfig`), `ClusterFirstWithHostNet` (for `hostNetwork` pods).

:::info Environment-variable discovery (legacy)
The kubelet also injects env vars for every Service that existed in the namespace when the pod started, e.g. `SHIPIT_API_SERVICE_HOST` and `SHIPIT_API_SERVICE_PORT`. It predates DNS, depends on creation order, and clutters the environment in namespaces with many Services. Prefer DNS; set `enableServiceLinks: false` in the pod spec to disable it.
:::

:::try Look at DNS from inside a pod
```bash
kubectl run dnsdemo --image=nicolaka/netshoot --rm -it --restart=Never -- bash -c '
  cat /etc/resolv.conf;
  dig +short kubernetes.default.svc.cluster.local;
  dig +short kube-dns.kube-system.svc.cluster.local;
  dig +search +showsearch example.com | grep -E "^;|ANSWER" | head -20'
```
The `+showsearch` output shows every search-domain attempt that `ndots:5` causes.
:::

## Debugging connectivity

When "the API cannot reach Redis" or "the Service does not respond", work through the path in order instead of guessing:

```text
1. Is the backend pod Running and Ready?        kubectl get pods -l <selector> -o wide
2. Does the Service select it? (endpoints)      kubectl get endpointslices -l kubernetes.io/service-name=<svc>
3. Is the port mapping right?                   Service targetPort == port the process listens on?
4. Does the app listen on 0.0.0.0, not 127.0.0.1?  kubectl exec <pod> -- netstat -tlnp  (or ss)
5. Does the pod IP answer directly?             curl <podIP>:<targetPort> from a debug pod
6. Does the ClusterIP answer?                   curl <clusterIP>:<port>
7. Does DNS resolve?                            nslookup <svc>.<ns>.svc.cluster.local
8. Is something blocking?                       NetworkPolicies, wrong namespace, kube-proxy/CNI health
```

Your toolbox:

```bash
# a throwaway debug pod with every network tool
kubectl run netshoot --image=nicolaka/netshoot --rm -it --restart=Never -- bash
#   inside: dig, nslookup, curl -v, nc -zv host port, tcpdump, ss, mtr, iperf3

# attach the same tools to an existing pod's network namespace
kubectl debug -it pod/shipit-api-7d9f-x2k --image=nicolaka/netshoot --target=api

# compare selector and pod labels side by side
kubectl get svc shipit-api -o jsonpath='{.spec.selector}{"\n"}'
kubectl get pods --show-labels

# CoreDNS health and logs
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=50
```

:::warning Classic Service bugs
- **Selector typo or label drift**: `app: shipit-api` vs `app.kubernetes.io/name: shipit-api`. Endpoints are empty.
- **targetPort mismatch**: Service targets 8080, app listens on 3000. Endpoints exist, connections are refused.
- **App bound to localhost**: a dev config with `HOST=127.0.0.1` (common in Node frameworks) works with `kubectl exec ... curl localhost` but refuses connections from other pods. Bind to `0.0.0.0`.
- **Readiness failing**: pods Running but not Ready, so endpoints are `ready: false`.
- **Wrong namespace**: short names only resolve within the caller's namespace.
- **Using `port-forward` success as proof**: port-forward goes to a pod directly and bypasses the Service, kube-proxy and DNS.
:::

## Production best practices

- Use ClusterIP for everything internal; expose HTTP through a single Gateway (or Ingress) rather than many LoadBalancers.
- Always name ports, and reference names in `targetPort`.
- Keep selectors minimal and stable (`app.kubernetes.io/name` + `app.kubernetes.io/instance`), never including the version.
- Make readiness probes meaningful so endpoints reflect real health, and add a preStop delay so endpoint removal propagates before shutdown.
- Watch for long-lived connections that do not rebalance (DB pools, gRPC, WebSockets).
- Be aware of DNS amplification from `ndots:5` in chatty services; measure CoreDNS load.
- On AWS, consider `trafficDistribution: PreferClose` to reduce cross-AZ costs, and `externalTrafficPolicy: Local` when you need client IPs.

## Summary

- Every pod gets a routable IP from the CNI; pod IPs are ephemeral, so you use Services.
- A Service = stable virtual IP + DNS name + selector → EndpointSlices of Ready pods; kube-proxy turns that into kernel DNAT rules (iptables, nftables; IPVS is deprecated).
- ClusterIP for internal, NodePort for node-level access, LoadBalancer for cloud LBs (cloud-provider-kind locally), ExternalName for DNS aliases, headless for direct pod addressing.
- DNS names follow `<svc>.<ns>.svc.cluster.local`; search domains and `ndots:5` make short names work and external names slower.
- Debug in order: pods Ready → endpoints → ports → bind address → pod IP → ClusterIP → DNS → policies.
