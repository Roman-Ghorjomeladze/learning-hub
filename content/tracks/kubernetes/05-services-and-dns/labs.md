These labs make Kubernetes networking tangible: you will reach pods across nodes by IP, dissect DNS, wire up every Service type including a real LoadBalancer on kind, watch EndpointSlices react to readiness, fix three broken Services, and route to things outside the cluster.

**Prerequisites:** the `lab` kind cluster from module 02 (three nodes, NodePorts 30080 and 30081 mapped to localhost). Recreate it if needed:

```bash
cd ~/k8s-labs/02 && kind create cluster --config kind-lab.yaml
```

Set up a namespace:

```bash
mkdir -p ~/k8s-labs/05 && cd ~/k8s-labs/05
kubectl create namespace net
kubectl config set-context --current --namespace=net
```

The debug image used throughout is `nicolaka/netshoot` (multi-arch, includes `dig`, `curl`, `nc`, `tcpdump`, `ss`). The first pull takes a little while; later pods on the same node start instantly.

## Lab 1: The flat network and cluster DNS

:::meta
difficulty: easy
time: 30 min
:::

Goal: confirm pods reach each other directly across nodes, then see how a ClusterIP Service and DNS names work, including search domains, SRV records and the cost of `ndots:5`.

### Steps

1. Look at the pod CIDR of each node and deploy three `whoami` replicas:

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,INTERNAL_IP:.status.addresses[0].address,POD_CIDR:.spec.podCIDR
kubectl create deployment whoami --image=traefik/whoami --replicas=3
kubectl rollout status deploy/whoami
kubectl get pods -l app=whoami -o wide
```

2. Start a long-lived netshoot pod and curl a pod on **another** node by IP:

```bash
kubectl run netshoot --image=nicolaka/netshoot --command -- sleep infinity
kubectl wait --for=condition=Ready pod/netshoot
kubectl get pod netshoot -o wide
POD_IP=$(kubectl get pods -l app=whoami -o jsonpath='{.items[0].status.podIP}')
kubectl exec netshoot -- curl -s "$POD_IP" | head -6
```

3. Expose the Deployment with a ClusterIP Service using a **named** port:

```bash
cat > whoami-svc.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata: { name: whoami }
spec:
  selector: { app: whoami }
  ports:
    - name: http
      port: 80
      targetPort: 80
EOF
kubectl apply -f whoami-svc.yaml
kubectl get svc whoami
kubectl get endpointslices -l kubernetes.io/service-name=whoami
```

4. Call the Service several times and check the load balancing:

```bash
for i in $(seq 9); do kubectl exec netshoot -- curl -s whoami | grep Hostname; done | sort | uniq -c
```

5. Explore DNS from netshoot:

```bash
kubectl exec netshoot -- cat /etc/resolv.conf
kubectl exec netshoot -- dig +short whoami.net.svc.cluster.local
kubectl exec netshoot -- dig +short whoami
kubectl exec netshoot -- dig +search +short whoami
kubectl exec netshoot -- dig +short SRV _http._tcp.whoami.net.svc.cluster.local
kubectl exec netshoot -- dig +short kube-dns.kube-system.svc.cluster.local
kubectl -n kube-system get svc kube-dns
```

6. Cross-namespace names: create the same Service name in another namespace and resolve both:

```bash
kubectl create namespace other
kubectl -n other create deployment whoami --image=traefik/whoami
kubectl -n other expose deployment whoami --port=80
kubectl exec netshoot -- dig +search +short whoami
kubectl exec netshoot -- dig +search +short whoami.other
kubectl -n other get svc whoami
```

7. Measure the `ndots` effect for an external name:

```bash
kubectl exec netshoot -- dig +search +showsearch example.com | grep -A1 'QUESTION SECTION' | grep -v -- '--'
kubectl exec netshoot -- dig +search +showsearch example.com | grep -c 'QUESTION SECTION'
kubectl exec netshoot -- dig +search +showsearch example.com. | grep -c 'QUESTION SECTION'
```

### Verify

- Step 2 returns a whoami response from a pod on a different node: pod-to-pod across nodes needs no Service and no NAT.
- The Service's ClusterIP is in `10.96.0.0/16` and the EndpointSlice lists 3 pod IPs.
- Step 4 shows all three hostnames.
- `dig whoami` without `+search` returns nothing; with `+search` it returns the ClusterIP.
- `whoami` and `whoami.other` resolve to two different ClusterIPs.
- The SRV record shows port `80` and target `whoami.net.svc.cluster.local.`.
- Step 7: `example.com` triggers several search-domain queries; `example.com.` triggers one.

:::hint
`dig` ignores the search list unless you pass `+search`; most applications (via `getaddrinfo`) use it automatically. In the `+showsearch` output, every block that starts with `;; QUESTION SECTION` is one query.
:::

:::solution
- Each node owns a `/24` from `10.244.0.0/16` (`spec.podCIDR`), and kindnet installs routes so every node can reach every other node's pod range. That is the "flat network" rule: pod IPs are routable cluster-wide.
- The ClusterIP is virtual. kube-proxy's rules on the netshoot pod's node DNAT connections to a random backend, so repeated curls (new connection each time) spread across pods.
- `/etc/resolv.conf` contains `search net.svc.cluster.local svc.cluster.local cluster.local`, `nameserver 10.96.0.10` and `options ndots:5`. `whoami` expands to `whoami.net.svc.cluster.local` (same namespace first); `whoami.other` expands via the second search domain to `whoami.other.svc.cluster.local`.
- SRV records exist only for **named** ports: `_<port-name>._<protocol>.<svc>.<ns>.svc.cluster.local`.
- With `ndots:5`, `example.com` (1 dot) is first tried as `example.com.net.svc.cluster.local`, `example.com.svc.cluster.local`, `example.com.cluster.local` (all NXDOMAIN) and then as `example.com`. A trailing dot marks the name as fully qualified and skips the search list.
:::

### Clean up

Keep `whoami`, its Service and the `netshoot` pod for the next labs.

```bash
kubectl delete namespace other
```

## Lab 2: NodePort, traffic policies and session affinity

:::meta
difficulty: medium
time: 30 min
:::

Goal: expose `whoami` on your Mac through a NodePort, understand `port`/`targetPort`/`nodePort`, see `externalTrafficPolicy: Local` drop traffic on nodes without a local pod, and make connections sticky with `sessionAffinity`.

### Steps

1. Pin the whoami pods to the worker nodes and create a NodePort Service:

```bash
kubectl patch deploy whoami -p '{"spec":{"template":{"spec":{"nodeSelector":{"tier":"apps"}}}}}'
kubectl rollout status deploy/whoami
cat > whoami-nodeport.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata: { name: whoami-np }
spec:
  type: NodePort
  selector: { app: whoami }
  ports:
    - name: http
      port: 8080          # ClusterIP port inside the cluster
      targetPort: 80      # whoami listens on 80
      nodePort: 30080     # opened on every node; kind maps it to localhost:30080
EOF
kubectl apply -f whoami-nodeport.yaml
kubectl get svc whoami-np
```

2. Reach it three ways:

```bash
curl -s localhost:30080 | grep -E 'Hostname|RemoteAddr'
kubectl exec netshoot -- curl -s whoami-np:8080 | grep Hostname
NODE_IP=$(kubectl get node lab-worker -o jsonpath='{.status.addresses[0].address}')
kubectl exec netshoot -- curl -s "$NODE_IP:30080" | grep Hostname
```

3. Switch to `externalTrafficPolicy: Local` and try again from your Mac:

```bash
kubectl patch svc whoami-np -p '{"spec":{"externalTrafficPolicy":"Local"}}'
curl -s -m 3 localhost:30080 || echo "no response"
kubectl exec netshoot -- curl -s -m 3 "$NODE_IP:30080" | grep -E 'Hostname|RemoteAddr'
```

4. Put one whoami pod on the control-plane node (where kind's port mapping lands) and retry:

```bash
cat > whoami-cp.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: whoami-cp
  labels: { app: whoami }
spec:
  nodeSelector: { kubernetes.io/hostname: lab-control-plane }
  tolerations:
    - { key: node-role.kubernetes.io/control-plane, operator: Exists, effect: NoSchedule }
  containers:
    - { name: whoami, image: traefik/whoami }
EOF
kubectl apply -f whoami-cp.yaml
kubectl wait --for=condition=Ready pod/whoami-cp
for i in $(seq 5); do curl -s localhost:30080 | grep -E 'Hostname|RemoteAddr'; done
```

5. Restore `Cluster` and add session affinity:

```bash
kubectl patch svc whoami-np -p '{"spec":{"externalTrafficPolicy":"Cluster"}}'
for i in $(seq 8); do curl -s localhost:30080 | grep Hostname; done | sort | uniq -c
kubectl patch svc whoami-np -p '{"spec":{"sessionAffinity":"ClientIP","sessionAffinityConfig":{"clientIP":{"timeoutSeconds":300}}}}'
for i in $(seq 8); do curl -s localhost:30080 | grep Hostname; done | sort | uniq -c
```

### Verify

- Step 2: all three paths work. `localhost:30080` and `<node-ip>:30080` hit the NodePort; `whoami-np:8080` hits the ClusterIP port.
- Step 3: `localhost:30080` gets no response, but the worker node IP still works.
- Step 4: `localhost:30080` works again and always answers from `whoami-cp`.
- Step 5: without affinity, several hostnames; with `ClientIP`, a single hostname for all 8 requests.

:::hint
kind publishes `localhost:30080` to port 30080 of the **control-plane** container only. With `externalTrafficPolicy: Local`, a node only forwards NodePort traffic to pods running on that same node. Which node receives your Mac's traffic, and which pods run there?
:::

:::solution
- `port` (8080) is the ClusterIP port, `targetPort` (80) the container port, `nodePort` (30080) the port on every node. Clients inside the cluster use `whoami-np:8080`; outside clients use `<node>:30080`.
- With the default `Cluster` policy, the control-plane node accepts the NodePort connection and forwards it to a pod on a worker, SNATing the source so the reply comes back through it. That is why `RemoteAddr` shows a node-side address rather than your real client.
- With `Local`, the control-plane node has no local whoami pod, so it drops the traffic. Workers still answer for their own pods. Cloud load balancers handle this by health-checking `healthCheckNodePort` and only sending traffic to nodes that have local endpoints. The benefit is a preserved client source IP and no extra hop.
- After adding `whoami-cp`, the control-plane node has a local endpoint and serves the traffic itself; `RemoteAddr` now shows the address the packet really came from (the Docker network gateway, since Docker on your Mac forwards it).
- `sessionAffinity: ClientIP` makes kube-proxy remember client IP → backend for `timeoutSeconds`. All your requests come from the same IP, so they stick to one pod.
:::

### Clean up

```bash
kubectl delete -f whoami-nodeport.yaml -f whoami-cp.yaml
kubectl patch deploy whoami --type json -p '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'
```

## Lab 3: Headless Services, EndpointSlices and readiness

:::meta
difficulty: medium
time: 30 min
:::

Goal: watch EndpointSlices react to readiness and termination, and compare what DNS returns for normal and headless Services.

### Steps

1. Deploy nginx with a readiness probe you can toggle by deleting a file, plus a normal and a headless Service:

```bash
cat > ready.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: toggler }
spec:
  replicas: 3
  selector: { matchLabels: { app: toggler } }
  template:
    metadata: { labels: { app: toggler } }
    spec:
      terminationGracePeriodSeconds: 40
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          command: ["sh", "-c", "hostname > /usr/share/nginx/html/index.html; touch /usr/share/nginx/html/ready; exec nginx -g 'daemon off;'"]
          readinessProbe:
            exec: { command: ["cat", "/usr/share/nginx/html/ready"] }
            periodSeconds: 2
            failureThreshold: 1
          lifecycle:
            preStop:
              sleep: { seconds: 30 }
---
apiVersion: v1
kind: Service
metadata: { name: toggler }
spec:
  selector: { app: toggler }
  ports: [{ name: http, port: 80, targetPort: 80 }]
---
apiVersion: v1
kind: Service
metadata: { name: toggler-headless }
spec:
  clusterIP: None
  selector: { app: toggler }
  ports: [{ name: http, port: 80, targetPort: 80 }]
EOF
kubectl apply -f ready.yaml
kubectl rollout status deploy/toggler
```

2. Compare DNS answers:

```bash
kubectl get svc toggler toggler-headless
kubectl exec netshoot -- dig +search +short toggler
kubectl exec netshoot -- dig +search +short toggler-headless
kubectl get pods -l app=toggler -o wide
```

3. In a second terminal, watch the EndpointSlice of the normal Service:

```bash
kubectl -n net get endpointslices -l kubernetes.io/service-name=toggler -o wide -w
```

4. Make one pod unready and observe:

```bash
POD=$(kubectl get pods -l app=toggler -o jsonpath='{.items[0].metadata.name}')
kubectl exec "$POD" -- rm /usr/share/nginx/html/ready
sleep 5
kubectl get pods -l app=toggler
kubectl get endpointslices -l kubernetes.io/service-name=toggler -o jsonpath='{range .items[*].endpoints[*]}{.targetRef.name}{"  ready="}{.conditions.ready}{" serving="}{.conditions.serving}{"\n"}{end}'
for i in $(seq 9); do kubectl exec netshoot -- curl -s toggler; done | sort | uniq -c
kubectl exec netshoot -- dig +search +short toggler-headless
```

5. Make it ready again, then delete another pod and look at the terminating endpoint during its 30 s preStop:

```bash
kubectl exec "$POD" -- touch /usr/share/nginx/html/ready
POD2=$(kubectl get pods -l app=toggler -o jsonpath='{.items[1].metadata.name}')
kubectl delete pod "$POD2" --wait=false
sleep 3
kubectl get endpointslices -l kubernetes.io/service-name=toggler -o jsonpath='{range .items[*].endpoints[*]}{.targetRef.name}{"  ready="}{.conditions.ready}{" serving="}{.conditions.serving}{" terminating="}{.conditions.terminating}{"\n"}{end}'
```

### Verify

- The normal Service resolves to one ClusterIP; the headless one resolves to 3 pod IPs.
- After removing the file, the pod shows `0/1` READY, its endpoint has `ready: false`, curl never reaches it, and the headless DNS answer drops to 2 IPs.
- During deletion, the terminating pod's endpoint shows `ready=false serving=true terminating=true` for about 30 seconds, while a replacement pod appears.

:::hint
The pod is not restarted when readiness fails; only its endpoint condition changes. `serving` reflects the readiness probe regardless of termination, while `ready` is always false for terminating pods.
:::

:::solution
- Headless Services skip the virtual IP; CoreDNS returns an A record for each Ready endpoint. Clients that resolve once and cache (many database drivers, some HTTP clients) may keep using a stale IP; that is one reason ClusterIP Services are the default.
- Readiness is the only signal the EndpointSlice controller uses (plus termination). A failing readiness probe removes the pod from load balancing and from headless DNS without restarting it. Use this during warm-up, during dependency outages (shipit's `/readyz`), or to drain a pod manually.
- During graceful termination, the endpoint stays in the slice with `ready=false, serving=true, terminating=true`. kube-proxy stops sending **new** connections to it (unless no other endpoints exist, in which case it may use serving-terminating endpoints as a fallback), while existing connections finish during the preStop sleep and shutdown.
:::

### Clean up

Stop the watch.

```bash
kubectl delete -f ready.yaml
```

## Lab 4: Break & fix — three Services, three bugs

:::meta
difficulty: medium
time: 35 min
:::

Goal: diagnose broken Services systematically using the debugging checklist from the lesson.

### Steps

1. Deploy three small "microservices" and their Services:

```bash
cat > broken-svcs.yaml <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: { name: orders }
spec:
  replicas: 2
  selector: { matchLabels: { app.kubernetes.io/name: orders } }
  template:
    metadata: { labels: { app.kubernetes.io/name: orders } }
    spec:
      containers:
        - name: app
          image: hashicorp/http-echo
          args: ["-text=orders ok", "-listen=:8080"]
---
apiVersion: v1
kind: Service
metadata: { name: orders }
spec:
  selector: { app: orders }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: payments }
spec:
  replicas: 2
  selector: { matchLabels: { app: payments } }
  template:
    metadata: { labels: { app: payments } }
    spec:
      containers:
        - name: app
          image: hashicorp/http-echo
          args: ["-text=payments ok", "-listen=:5678"]
          ports: [{ name: http, containerPort: 5678 }]
---
apiVersion: v1
kind: Service
metadata: { name: payments }
spec:
  selector: { app: payments }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: catalog }
spec:
  replicas: 2
  selector: { matchLabels: { app: catalog } }
  template:
    metadata: { labels: { app: catalog } }
    spec:
      containers:
        - name: app
          image: hashicorp/http-echo
          args: ["-text=catalog ok", "-listen=127.0.0.1:8080"]
---
apiVersion: v1
kind: Service
metadata: { name: catalog }
spec:
  selector: { app: catalog }
  ports: [{ port: 80, targetPort: 8080 }]
EOF
kubectl apply -f broken-svcs.yaml
kubectl wait --for=condition=Available deploy/orders deploy/payments deploy/catalog --timeout=90s
```

2. Confirm all three are broken from a client's point of view:

```bash
for s in orders payments catalog; do echo "== $s"; kubectl exec netshoot -- curl -s -m 3 "$s" || echo "FAILED (exit $?)"; done
```

3. Diagnose each one. For every Service, write down which step of the checklist fails and what evidence shows it. Then fix all three.

### Verify

```bash
for s in orders payments catalog; do kubectl exec netshoot -- curl -s -m 3 "$s"; done
```

prints `orders ok`, `payments ok`, `catalog ok`.

:::hint
Checklist: pods Ready? → EndpointSlice has addresses? → targetPort equals the port the process listens on? → process listens on `0.0.0.0` (check from inside the pod network with `kubectl debug ... --target=app` and `ss -tlnp`)? → curl the pod IP directly. Note the different error types: a timeout or "connection refused" tells you different things.
:::

:::solution
**orders: selector does not match (no endpoints).**

```bash
kubectl get endpointslices -l kubernetes.io/service-name=orders
# ENDPOINTS: <unset>
kubectl get svc orders -o jsonpath='{.spec.selector}{"\n"}'     # {"app":"orders"}
kubectl get pods -l app.kubernetes.io/name=orders --show-labels  # pods use app.kubernetes.io/name
kubectl patch svc orders --type merge -p '{"spec":{"selector":{"app":null,"app.kubernetes.io/name":"orders"}}}'
```

curl to a ClusterIP without endpoints typically fails immediately (kube-proxy rejects it) rather than hanging.

**payments: targetPort mismatch (endpoints exist, connection refused).**

```bash
kubectl get endpointslices -l kubernetes.io/service-name=payments -o wide   # 2 addresses, port 8080
kubectl get deploy payments -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}'   # listens on :5678
kubectl patch svc payments --type json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":"http"}]'
```

Using the named port `http` makes the Service follow the container's declared port.

**catalog: app bound to 127.0.0.1 (endpoints exist, port right, still refused).**

```bash
CAT_POD=$(kubectl get pods -l app=catalog -o jsonpath='{.items[0].metadata.name}')
CAT_IP=$(kubectl get pod "$CAT_POD" -o jsonpath='{.status.podIP}')
kubectl exec netshoot -- curl -s -m 3 "$CAT_IP:8080" || echo refused      # refused from outside the pod
kubectl debug -it "$CAT_POD" --image=nicolaka/netshoot --target=app -- ss -tlnp
# LISTEN 127.0.0.1:8080   <- only loopback
kubectl patch deploy catalog --type json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args/1","value":"-listen=:8080"}]'
kubectl rollout status deploy/catalog
```

From inside the pod (`localhost`), it works, which is why "it works when I exec into the container" is not proof. Other pods connect to the pod IP, which only works when the process binds to `0.0.0.0` (or `::`). In Node.js: `server.listen(3000)` or `server.listen(3000, '0.0.0.0')`, never `'127.0.0.1'` or `'localhost'` in containers.

Summary of evidence:

| Service | Endpoints | Pod IP direct | Root cause |
| --- | --- | --- | --- |
| orders | none | works | selector mismatch |
| payments | yes, port 8080 | refused on 8080, works on 5678 | wrong targetPort |
| catalog | yes, port 8080 | refused | bound to loopback |
:::

### Clean up

```bash
kubectl delete -f broken-svcs.yaml
```

## Lab 5: A real LoadBalancer on kind with cloud-provider-kind

:::meta
difficulty: medium
time: 25 min
:::

Goal: see how a `type: LoadBalancer` Service gets an external address when a cloud controller exists, using cloud-provider-kind as the local "cloud".

### Steps

1. Install cloud-provider-kind:

```bash
brew install cloud-provider-kind
# or: go install sigs.k8s.io/cloud-provider-kind@latest
```

2. Create a LoadBalancer Service **before** starting the controller and look at its status:

```bash
cat > whoami-lb.yaml <<'EOF'
apiVersion: v1
kind: Service
metadata: { name: whoami-lb }
spec:
  type: LoadBalancer
  selector: { app: whoami }
  ports:
    - name: http
      port: 80
      targetPort: 80
EOF
kubectl apply -f whoami-lb.yaml
kubectl get svc whoami-lb
```

3. In a **separate terminal**, run the controller. On macOS it needs `sudo`, and `--enable-lb-port-mapping` publishes the load balancer on a localhost port because the Docker network is inside a VM:

```bash
sudo cloud-provider-kind --enable-lb-port-mapping
```

4. Back in the first terminal:

```bash
kubectl get svc whoami-lb -w        # Ctrl+C once EXTERNAL-IP is set
docker ps --filter name=kindccm --format 'table {{.Names}}\t{{.Ports}}'
```

5. Find the localhost port mapped to the load balancer's port 80 and call it:

```bash
LB=$(docker ps --filter name=kindccm --format '{{.Names}}' | head -1)
docker port "$LB"
LB_PORT=$(docker port "$LB" 80/tcp | head -1 | awk -F: '{print $NF}')
for i in $(seq 6); do curl -s "localhost:$LB_PORT" | grep Hostname; done | sort | uniq -c
```

6. Inspect what the Service now contains:

```bash
kubectl get svc whoami-lb -o jsonpath='{.spec.ports[0].nodePort}{"  "}{.status.loadBalancer.ingress}{"\n"}'
kubectl describe svc whoami-lb | sed -n '/Events:/,$p'
```

### Verify

- Before the controller ran, EXTERNAL-IP was `<pending>`.
- After, it shows an IP from the kind Docker network, and a `kindccm-...` container exists.
- curl through the mapped localhost port reaches the whoami pods, spread across replicas.
- The Service also has a `nodePort` allocated: a LoadBalancer Service builds on NodePort.

:::hint
If EXTERNAL-IP stays `<pending>`, check the controller terminal for errors (it must reach the Docker socket and the cluster's kubeconfig; running with `sudo` uses root's environment, so if it cannot find the cluster, run `sudo -E cloud-provider-kind --enable-lb-port-mapping` or check `kind get clusters`). If `docker port` shows nothing for 80/tcp, run `docker port "$LB"` and pick the mapping for the Service port.
:::

:::solution
- `type: LoadBalancer` makes Kubernetes allocate a ClusterIP and a NodePort, then waits for **some controller** to provision an external load balancer and write its address into `status.loadBalancer.ingress`. Without one (plain kind, bare metal without MetalLB), the status stays pending forever, but the NodePort still works.
- cloud-provider-kind plays the role of a cloud-controller-manager: it watches LoadBalancer Services and starts an Envoy-based container (`kindccm-...`) on the kind Docker network that forwards to the nodes. On Linux you could curl the EXTERNAL-IP directly; on macOS the Docker network lives inside a VM, so `--enable-lb-port-mapping` publishes the LB container's ports on localhost.
- On EKS, the same Service (with the right annotations) would make the AWS Load Balancer Controller create an NLB, and the address would be an `*.elb.amazonaws.com` hostname. Every LoadBalancer Service means one cloud LB and its cost, which is why HTTP apps usually share one LB in front of a Gateway.
- cloud-provider-kind can also implement Gateway API, which you will use in the Gateway API module.
:::

### Clean up

Stop the controller with Ctrl+C (it removes its load-balancer containers on exit; if any remain, `docker rm -f $(docker ps -aq --filter name=kindccm)`).

```bash
kubectl delete -f whoami-lb.yaml
```

## Lab 6: Challenge — reaching outside the cluster and reading kube-proxy's rules

:::meta
difficulty: hard
time: 45 min
:::

Goal: route in-cluster names to things outside the cluster, and verify how kube-proxy implements a Service. No step-by-step.

### Setup

Run a "legacy" service outside Kubernetes, as a plain Docker container on the same Docker network as the kind nodes:

```bash
docker run -d --name legacy-billing --network kind hashicorp/http-echo -text="legacy billing says hi" -listen=:8080
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' legacy-billing
```

### Requirements

1. Create a Service `legacy-billing` in namespace `net` **without a selector**, on port 80, and an EndpointSlice that points it at the container's IP and port 8080. From `netshoot`, `curl legacy-billing` must return `legacy billing says hi`.
2. Create an ExternalName Service `docs` that points at `kubernetes.io`. Show the CNAME with `dig`, then `curl -sI http://docs` and explain why the response is not the Kubernetes docs page (or why it redirects/fails).
3. Find which mode kube-proxy runs in on your cluster, then on node `lab-worker` locate the rules that implement the `whoami` Service (3 replicas). Explain how traffic is spread across the three endpoints.
4. Scale `whoami` to 5 replicas and show how the rules change.

### Verify

- `kubectl exec netshoot -- curl -s legacy-billing` prints the legacy message.
- `dig +search docs` shows a CNAME to `kubernetes.io.`.
- You can point at the exact rules (or nftables map entries) that DNAT to whoami pod IPs and explain the probabilities.

:::hint
An EndpointSlice is linked to its Service by the label `kubernetes.io/service-name`, and its port **name** must match the Service port's name. kube-proxy's configuration lives in the `kube-proxy` ConfigMap in `kube-system` (key `config.conf`, field `mode`; empty means the default, iptables). On the node: `docker exec lab-worker iptables-save -t nat` or, in nftables mode, `docker exec lab-worker nft list table ip kube-proxy`.
:::

:::solution
1. Selector-less Service + manual EndpointSlice:

```bash
LEGACY_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' legacy-billing)
cat > legacy.yaml <<EOF
apiVersion: v1
kind: Service
metadata: { name: legacy-billing, namespace: net }
spec:
  ports: [{ name: http, port: 80, targetPort: 8080 }]
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: legacy-billing-1
  namespace: net
  labels:
    kubernetes.io/service-name: legacy-billing
    endpointslice.kubernetes.io/managed-by: roma.manual
addressType: IPv4
ports: [{ name: http, port: 8080, protocol: TCP }]
endpoints:
  - addresses: ["$LEGACY_IP"]
    conditions: { ready: true }
EOF
kubectl apply -f legacy.yaml
kubectl exec netshoot -- curl -s legacy-billing
```

The pod's traffic to the ClusterIP is DNATed to `172.18.x.y:8080`; because that address is outside the pod CIDR, the node masquerades it, and the Docker network delivers it to the container. This is how you give in-cluster clients a stable Kubernetes name for a VM, an on-prem database or anything with a fixed IP. Setting `managed-by` to something other than the EndpointSlice controller's value tells the controller to leave the slice alone.

2. ExternalName:

```bash
kubectl create service externalname docs --external-name kubernetes.io
kubectl exec netshoot -- dig +search docs | grep -A3 'ANSWER SECTION'
kubectl exec netshoot -- curl -sI http://docs | head -5
```

DNS returns `docs.net.svc.cluster.local. CNAME kubernetes.io.` and the A records behind it. But curl sends `Host: docs`, which the kubernetes.io servers do not serve, so you get an error page, a redirect to a different place, or a TLS name mismatch over HTTPS. ExternalName only aliases DNS; it does not rewrite Host headers, SNI or ports. It works best for protocols that do not care about the hostname (Postgres, Redis) or servers configured to accept the alias.

3. kube-proxy rules:

```bash
kubectl -n kube-system get cm kube-proxy -o jsonpath='{.data.config\.conf}' | grep -E '^mode'
# mode: iptables   (or empty = iptables; "nftables" if you enabled it in the kind config)
kubectl get svc whoami -o jsonpath='{.spec.clusterIP}{"\n"}'
docker exec lab-worker iptables-save -t nat | grep 'net/whoami'
```

Typical output:

```text
-A KUBE-SERVICES -d 10.96.120.33/32 -p tcp -m comment --comment "net/whoami:http cluster IP" -m tcp --dport 80 -j KUBE-SVC-XXXX
-A KUBE-SVC-XXXX -m comment --comment "net/whoami:http -> 10.244.1.4:80" -m statistic --mode random --probability 0.33333333349 -j KUBE-SEP-AAA
-A KUBE-SVC-XXXX -m comment --comment "net/whoami:http -> 10.244.2.5:80" -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-BBB
-A KUBE-SVC-XXXX -m comment --comment "net/whoami:http -> 10.244.2.6:80" -j KUBE-SEP-CCC
-A KUBE-SEP-AAA -p tcp -m comment --comment "net/whoami:http" -m tcp -j DNAT --to-destination 10.244.1.4:80
```

Spread: rule 1 takes 1/3 of new connections; rule 2 takes 1/2 of the remaining 2/3 (another 1/3); rule 3 takes the rest (1/3). The decision is per connection and recorded in conntrack, so all packets of one TCP connection go to the same pod.

In nftables mode, look at `docker exec lab-worker nft list table ip kube-proxy | grep -A5 whoami`: the Service maps to a chain using `numgen random mod 3 vmap { 0 : goto endpoint-..., 1 : ..., 2 : ... }`, the same idea expressed as a map lookup, which scales better than a long linear list of rules.

4. Scale and compare:

```bash
kubectl scale deploy whoami --replicas=5 && kubectl rollout status deploy/whoami
docker exec lab-worker iptables-save -t nat | grep 'net/whoami' | grep probability
```

You now see probabilities 0.2, 0.25, 0.333, 0.5 and a final unconditional jump: each rule takes an equal share of what is left. kube-proxy rewrote the chain on every node within a second of the EndpointSlice changing.
:::

### Clean up

```bash
kubectl delete -f legacy.yaml --ignore-not-found
kubectl delete svc docs --ignore-not-found
docker rm -f legacy-billing
kubectl delete pod netshoot
kubectl delete deploy whoami
kubectl delete svc whoami
kubectl delete namespace net
kubectl config set-context --current --namespace=default
```
