In module 05 you exposed pods with Services. A Service gives you a stable virtual IP and load-balances TCP/UDP connections, but it knows nothing about HTTP. It cannot route `/api` to one app and `/` to another, cannot pick a backend by `Host` header, cannot terminate TLS, and every `type: LoadBalancer` Service costs you a separate cloud load balancer. This module covers the layer that solves that: an **L7 (HTTP) proxy** that sits at the edge of the cluster and is configured through Kubernetes resources.

## The problem: one entry point, many HTTP apps

Picture a typical setup for your own products: `shipit.example.com` serves the React frontend, `shipit.example.com/api` goes to the NestJS API, `admin.example.com` goes to an internal tool, and everything must be HTTPS. With plain Services you would need three LoadBalancers and TLS inside every app. Instead you run one proxy fleet behind one load balancer:

```text
                     Internet
                        |
              Cloud LB (one IP / DNS name)
                        |
            +-----------v------------+
            |  L7 proxy pods         |   <- data plane (Envoy, NGINX, Traefik, HAProxy...)
            |  TLS termination,      |
            |  host/path routing     |
            +--+---------+--------+--+
               |         |        |
        Service:web  Service:api  Service:admin   <- ClusterIP Services
               |         |        |
             pods       pods     pods
```

Two pieces make this work:

- A **data plane**: the proxy pods that actually handle requests.
- A **controller**: a pod that watches Kubernetes resources (Ingress or Gateway API objects, Services, EndpointSlices, Secrets) and continuously rewrites the proxy configuration. This is the same reconcile loop you learned in module 01, applied to HTTP routing.

Kubernetes ships the **APIs** (Ingress, Gateway API CRDs) but **no implementation**. Applying an Ingress or HTTPRoute to a cluster without a controller does nothing at all, which is the first thing to check when "my route is ignored".

:::info Proxies route to pods, not to the Service IP
Most controllers read the Service only to find its EndpointSlices, then send traffic straight to pod IPs. That skips kube-proxy, enables real L7 load balancing (per request, not per connection) and allows features like retries and session affinity. It is also why readiness probes matter so much at the edge: an unready pod disappears from EndpointSlices and the proxy stops sending it requests.
:::

## Ingress: the API you will meet everywhere

Ingress (`networking.k8s.io/v1`) has been GA since Kubernetes 1.19 and is in almost every existing cluster and Helm chart. It is simple:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shipit
  annotations:
    # Controller-specific behaviour lives in annotations. This is the main weakness.
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
spec:
  ingressClassName: nginx          # which controller should handle this
  tls:
    - hosts: [shipit.example.com]
      secretName: shipit-tls       # kubernetes.io/tls Secret in the same namespace
  rules:
    - host: shipit.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: shipit-api
                port:
                  number: 3000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: shipit-web
                port:
                  number: 80
```

Key points:

- **`ingressClassName`** selects the controller via an `IngressClass` object. An IngressClass can be marked default with the annotation `ingressclass.kubernetes.io/is-default-class: "true"`.
- **`pathType`** is `Exact`, `Prefix` (matches on path *segments*: `/api` matches `/api` and `/api/items` but not `/apiv2`) or `ImplementationSpecific` (whatever the controller decides; avoid it).
- **TLS** references a Secret of type `kubernetes.io/tls` in the same namespace as the Ingress.
- Anything beyond host + path + TLS (rewrites, timeouts, CORS, rate limits, canaries, auth) is done with **controller-specific annotations**, so an Ingress written for one controller rarely works on another.

### The ingress-nginx retirement

The most popular controller was the community **ingress-nginx** project (`kubernetes/ingress-nginx`). In November 2025 Kubernetes SIG Network and the Security Response Committee announced its retirement: best-effort maintenance continued until **March 2026**, and after that there are **no more releases, bug fixes or security patches**. The GitHub repositories were made read-only; existing installs keep running and the published images and Helm charts remain downloadable, but running an internet-facing proxy that will never get another CVE fix is a real risk. The Kubernetes Steering Committee followed up in January 2026 urging everyone to migrate immediately, noting that roughly half of cloud native environments relied on it.

Be precise about what was retired:

| Retired | Not retired |
| --- | --- |
| The community `kubernetes/ingress-nginx` controller | The **Ingress API** itself (still GA and supported) |
| Its `nginx.ingress.kubernetes.io/*` annotations as a living feature set | F5's separate **NGINX Ingress Controller** (`nginx/kubernetes-ingress`), a different product |
| | Other Ingress controllers (Traefik, HAProxy, Kong, cloud ones like AWS Load Balancer Controller) |

To check whether a cluster uses it:

```bash
kubectl get pods --all-namespaces --selector app.kubernetes.io/name=ingress-nginx
```

The recommended path is **Gateway API**. The `ingress2gateway` tool converts Ingress manifests, including many ingress-nginx annotations, into Gateway API resources and is a good starting point for a migration.

:::warning Interview trap
"Ingress is deprecated" is wrong. The Ingress *API* is frozen (no new features) but fully supported. What was retired is one controller implementation. Gateway API is the recommended direction for new work.
:::

## Gateway API: the modern standard

Gateway API (`gateway.networking.k8s.io`) is an official Kubernetes project (SIG Network), shipped as CRDs you install separately. Its core resources went GA (v1) in October 2023 and it keeps releasing; check the current version on the [Gateway API site](https://gateway-api.sigs.k8s.io/) rather than trusting a number in a tutorial. It fixes Ingress's three big problems:

1. **Expressiveness in the spec, not annotations.** Header matching, query matching, weighted traffic splitting, redirects, rewrites, header modification, request mirroring and timeouts are typed fields that every conformant implementation understands.
2. **Role-oriented design.** Infrastructure, cluster operators and app developers own different objects, with RBAC and explicit trust boundaries between them.
3. **Portability with conformance tests.** Implementations publish conformance reports, so "supports HTTPRoute" means the same thing everywhere.

### The resource model

```text
 Infrastructure provider        Cluster operator            App developers
 -----------------------        ----------------            --------------
   GatewayClass  <---------------  Gateway  <----------------  HTTPRoute / GRPCRoute
   "which controller"             "listeners: ports,          "match host/path/header,
   (cluster-scoped)                hostnames, TLS,             send to these Services"
                                   who may attach"             (namespace of the app)
                                  (infra namespace)
                                                               ReferenceGrant
                                                               "namespace X may reference
                                                                my Services/Secrets"
```

| Resource | Scope | Owned by | Purpose |
| --- | --- | --- | --- |
| `GatewayClass` | cluster | platform / infra provider | Names a controller (`spec.controllerName`), like StorageClass for storage |
| `Gateway` | namespace | cluster operator | Requests a proxy with **listeners** (port, protocol, optional hostname, TLS) and declares which namespaces' routes may attach |
| `HTTPRoute` | namespace | app team | Matches requests and forwards them to backends (usually Services) |
| `GRPCRoute` | namespace | app team | Same for gRPC (match on service/method) |
| `ReferenceGrant` | namespace | owner of the target | Allows objects in *another* namespace to reference objects in *this* namespace |
| `TLSRoute`, `TCPRoute`, `UDPRoute` | namespace | app team | L4 routing; experimental channel at the time of writing |

Gateway API ships in two **release channels**: *standard* (GA and beta resources such as GatewayClass, Gateway, HTTPRoute, GRPCRoute, ReferenceGrant) and *experimental* (everything in standard plus alpha resources and fields). Some implementations, including Envoy Gateway's Helm chart, install the experimental channel CRDs by default.

### A Gateway and a route

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: edge
  namespace: infra
spec:
  gatewayClassName: eg               # an Envoy Gateway GatewayClass
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Selector             # Same (default) | All | Selector
          selector:
            matchLabels:
              gateway-access: "true"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shipit
  namespace: shipit                  # labelled gateway-access=true
spec:
  parentRefs:
    - name: edge
      namespace: infra
      sectionName: http              # optional: attach to one listener only
  hostnames: ["shipit.localhost"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /api }
      backendRefs:
        - name: shipit-api
          port: 3000
    - backendRefs:                   # no matches = everything else ("/")
        - name: shipit-web
          port: 80
```

Notice the **two-way handshake** for attachment: the route points at the Gateway (`parentRefs`), *and* the Gateway must allow routes from that namespace (`allowedRoutes`). An app team cannot hijack a Gateway it was not invited to, and the operator cannot be surprised by random routes.

### Matching rules

Within a rule, all conditions in one `matches` entry are ANDed; multiple `matches` entries are ORed.

```yaml
rules:
  - matches:
      - path: { type: PathPrefix, value: /api }
        headers:
          - name: x-canary
            value: "true"
        queryParams:
          - name: debug
            value: "1"
        method: GET
    backendRefs:
      - name: shipit-api-canary
        port: 3000
```

Path match types: `Exact`, `PathPrefix` (segment-aware like Ingress `Prefix`) and `RegularExpression` (implementation-specific). Header and query matches support `Exact` and `RegularExpression`.

When several rules could match, the spec defines precedence so behaviour is portable: an exact path beats a prefix, a longer prefix beats a shorter one, then more header matches win, then more query matches, then the oldest route. You do not need to order rules carefully like in an NGINX config.

### Filters

Filters modify requests or responses on the way through:

```yaml
rules:
  - matches:
      - path: { type: PathPrefix, value: /old-api }
    filters:
      - type: URLRewrite
        urlRewrite:
          path:
            type: ReplacePrefixMatch
            replacePrefixMatch: /api
      - type: RequestHeaderModifier
        requestHeaderModifier:
          add:
            - name: x-forwarded-by
              value: edge
    backendRefs:
      - name: shipit-api
        port: 3000
```

Other core filters: `RequestRedirect` (for example HTTP to HTTPS with `scheme: https` and `statusCode: 301`), `ResponseHeaderModifier`, and `RequestMirror` (copy traffic to a shadow backend, useful when testing a rewrite of a service against real traffic).

### Traffic splitting for canaries

Each `backendRef` can have a `weight`. Weights are relative (they do not need to sum to 100):

```yaml
rules:
  - backendRefs:
      - name: shipit-api-v1
        port: 3000
        weight: 90
      - name: shipit-api-v2
        port: 3000
        weight: 10
```

A canary rollout is just editing these numbers over time: 90/10, then 50/50, then 0/100. Tools like Argo Rollouts and Flagger automate the progression and roll back on bad metrics by patching exactly these fields. Combine with a header match to let your QA team force the canary (`x-canary: true`) while everyone else gets the weighted split.

:::try Read the CRDs from your cluster
After Lab 2 you will have Gateway API installed. Run `kubectl explain httproute.spec.rules.matches` and `kubectl explain gateway.spec.listeners.allowedRoutes`. `kubectl explain` works on CRDs and is often faster than searching docs. Also try `kubectl api-resources --api-group=gateway.networking.k8s.io` to see which kinds and versions your cluster serves.
:::

## Status conditions: how you debug Gateway API

Gateway API resources report detailed status, which is a huge improvement over Ingress where you mostly had to read controller logs. Learn to read three conditions:

| Object | Condition | Meaning when `False` |
| --- | --- | --- |
| GatewayClass | `Accepted` | No controller claimed this class (wrong `controllerName`, controller not running) |
| Gateway | `Accepted`, `Programmed` | Listener config invalid, or the proxy has not been deployed/configured yet (often no LB address) |
| HTTPRoute (per parent) | `Accepted` | Route not allowed to attach: namespace not allowed, hostname does not intersect listener hostname, wrong `sectionName` |
| HTTPRoute (per parent) | `ResolvedRefs` | A backend is missing (`BackendNotFound`) or cross-namespace reference is not permitted (`RefNotPermitted`) |

```bash
kubectl get gatewayclass,gateway -A
kubectl get httproute -A
kubectl describe httproute shipit -n shipit        # read Status > Parents > Conditions
kubectl get httproute shipit -n shipit -o jsonpath='{.status.parents[*].conditions}' | jq
```

:::tip Hostname intersection
If a listener has `hostname: "*.example.com"` and your route has `hostnames: ["shipit.localhost"]`, they do not intersect and the route is not accepted on that listener. A listener without a hostname accepts any route hostname. In Gateway API a leading `*.` is a suffix match: `*.example.com` matches `api.example.com` and also `a.b.example.com`, but not `example.com`. TLS certificates are stricter: a `*.example.com` certificate covers exactly one label.
:::

## Cross-namespace references and ReferenceGrant

Namespaces are a security boundary. By default an HTTPRoute may only send traffic to Services in **its own namespace**, and a Gateway may only use TLS Secrets in **its own namespace**. To cross that boundary, the *owner of the target* creates a ReferenceGrant in the target namespace:

```yaml
# In namespace "payments": allow HTTPRoutes from namespace "shop"
# to reference Services in "payments".
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-shop-routes
  namespace: payments
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: shop
  to:
    - group: ""               # core API group
      kind: Service
      # name: payments-api    # optional: restrict to one object
```

The direction is the important idea: **the referenced side consents**. Without the grant, the route shows `ResolvedRefs=False` with reason `RefNotPermitted` and requests to that backend fail (typically with a 500). The most common real use is a central Gateway in `infra` that uses a wildcard certificate Secret stored elsewhere, or a shared service owned by another team.

:::deep Why Ingress could not do this safely
With Ingress, everything lived in one object in the app's namespace: the TLS Secret, the hostnames and the backends. If two teams created Ingresses for the same host, controllers resolved the conflict in implementation-specific ways, and some controllers allowed referencing Services in other namespaces through annotations with no consent from the target. Multi-tenant clusters ended up with admission webhooks and conventions to stop teams stepping on each other.

Gateway API splits the concerns along ownership lines. The Gateway (owned by the platform team) decides which ports, hostnames and certificates exist and which namespaces may attach. Routes (owned by app teams) can only claim hostnames the listener allows. ReferenceGrant makes every cross-namespace edge explicit and consented. Status conditions report conflicts instead of silently picking a winner. This maps directly onto RBAC: give developers `create/update` on HTTPRoute in their namespace, and only the platform team rights on Gateway and GatewayClass.

A newer resource, **ListenerSet**, extends this idea by letting app teams add their own listeners (for example their own hostname plus TLS certificate) to a shared Gateway without edit rights on it. Check the Gateway API docs for its current maturity.
:::

## Implementations and running one on kind

Popular conformant implementations include **Envoy Gateway** (CNCF Envoy project, used in the labs), **Istio**, **Cilium**, **Traefik**, **Kong**, **NGINX Gateway Fabric** (F5), **kgateway**, and cloud-managed ones such as the **AWS Load Balancer Controller** (Gateway API support for ALB/NLB), GKE Gateway and Azure Application Gateway for Containers. The Gateway API site lists implementations with their conformance reports.

Envoy Gateway works like this:

```text
  envoy-gateway-system namespace
  +--------------------------------+
  | envoy-gateway (controller)     |   watches GatewayClass/Gateway/HTTPRoute...
  +---------------+----------------+
                  | creates one Envoy Deployment + Service per Gateway
                  v
  +--------------------------------+
  | envoy-<ns>-<gateway>-<hash>    |   Service type LoadBalancer by default
  | (Envoy proxy pods)             |   -> pods of your apps
  +--------------------------------+
```

Install with Helm (the chart is published as an OCI artifact; pick the current version from the Envoy Gateway install docs):

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version <current-version> \
  -n envoy-gateway-system --create-namespace

kubectl wait --timeout=5m -n envoy-gateway-system \
  deployment/envoy-gateway --for=condition=Available
```

The chart installs both the Gateway API CRDs and Envoy Gateway's own CRDs (such as `EnvoyProxy`, `ClientTrafficPolicy`, `BackendTrafficPolicy`, `SecurityPolicy` for implementation-specific features like rate limiting and JWT auth). Then you create a GatewayClass that points at the controller:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
```

### Reaching the Gateway from your Mac

On a cloud cluster the Gateway's Service of type LoadBalancer gets an external address. kind has no cloud, so the Service stays `<pending>`. Options, from simplest to most realistic:

1. **`kubectl port-forward`** to the Envoy Service (used in the labs). Reliable on every Mac setup.
2. **cloud-provider-kind**, a small binary from the kind project that runs on your host and gives LoadBalancer Services real addresses. See the kind docs page "LoadBalancer".
3. **NodePort + kind `extraPortMappings`**, configuring Envoy's Service as NodePort through an `EnvoyProxy` resource. More setup, but no long-running port-forward.

### Hostnames without editing /etc/hosts

Host-based routing needs names that resolve to your machine:

- **`*.localhost`**: names ending in `.localhost` are reserved for loopback. curl (on recent versions, including the one shipped with macOS) and Chrome/Firefox resolve `anything.localhost` to `127.0.0.1` without DNS. Example: `curl http://shipit.localhost:8080/`.
- **nip.io / sslip.io**: public wildcard DNS that maps names containing an IP back to that IP: `shipit.127.0.0.1.nip.io` and `shipit.127-0-0-1.sslip.io` both resolve to `127.0.0.1`. Useful when a tool insists on real DNS. Needs internet access.
- **`curl --resolve`** or the `Host` header, when you just want to test: `curl -H 'Host: shipit.example.com' http://localhost:8080/` or `curl --resolve shipit.example.com:8443:127.0.0.1 https://shipit.example.com:8443/`. `--resolve` is better for HTTPS because it also sets SNI correctly.

:::mac Port numbers on macOS
Binding ports below 1024 on macOS works for normal users on recent versions, but port 80/443 are often taken (AirPlay Receiver uses 5000/7000, local dev servers grab 80/8080). Port-forwarding to 8080/8443 avoids conflicts. If something already listens, `lsof -nP -iTCP:8080 -sTCP:LISTEN` tells you what.
:::

## TLS termination and cert-manager

A Gateway terminates TLS on a listener with `protocol: HTTPS` and a reference to a `kubernetes.io/tls` Secret:

```yaml
listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: "shipit.localhost"
    tls:
      mode: Terminate            # Passthrough is for TLSRoute (TLS ends at the app)
      certificateRefs:
        - kind: Secret
          name: shipit-localhost-tls
```

You do not want to create those Secrets by hand. **cert-manager** (a CNCF graduated project) is the standard controller for certificates in Kubernetes:

```text
  Issuer / ClusterIssuer        "how to get certs": ACME (Let's Encrypt), CA, self-signed, Vault, AWS PCA...
          ^
          | issuerRef
  Certificate                   "I want a cert for these DNS names, store it in Secret X"
          |
          v
  Secret (kubernetes.io/tls)    tls.crt, tls.key, ca.crt  <- referenced by Gateway listener
```

cert-manager renews certificates before they expire (by default when two thirds of the lifetime has passed) and updates the Secret; Envoy Gateway picks up the new Secret automatically.

For local development there is no public ACME, so you build a tiny private CA:

```yaml
# 1. A self-signed issuer, used only to bootstrap a CA certificate
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
---
# 2. The CA certificate itself (isCA: true), stored in a Secret in cert-manager's namespace
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: local-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: local-dev-ca
  secretName: local-ca
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: selfsigned
    kind: ClusterIssuer
---
# 3. A CA issuer that signs leaf certificates with that CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: local-ca
spec:
  ca:
    secretName: local-ca      # for a ClusterIssuer, looked up in the cert-manager namespace
```

Then request a leaf certificate next to your Gateway:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: shipit-localhost
  namespace: infra
spec:
  secretName: shipit-localhost-tls
  dnsNames: ["shipit.localhost", "api.shipit.localhost"]
  issuerRef:
    name: local-ca
    kind: ClusterIssuer
```

Why not just a self-signed leaf? With a CA you can trust **one** certificate (the CA) on your Mac or in curl (`--cacert`), and every cert it issues is trusted. That mirrors how production works with a public CA.

### Gateway annotations instead of Certificate objects

cert-manager can also watch Gateways directly: annotate the Gateway with `cert-manager.io/cluster-issuer: local-ca` and it creates a Certificate for every HTTPS listener that has a `hostname` and a `certificateRefs` Secret name. This must be enabled in cert-manager (Helm value `config.gatewayAPI.enabled=true` in current releases; older releases used a different flag, so check the docs for your version), and the Gateway API CRDs must exist before cert-manager starts, or you restart it afterwards. The explicit Certificate approach used in the labs works on every version.

In production on AWS you would typically use an ACME `ClusterIssuer` for Let's Encrypt with DNS-01 validation through Route 53, or terminate TLS at an ALB with an ACM certificate via the AWS Load Balancer Controller.

:::try Look inside a cert-manager Secret
After Lab 4, run `kubectl get secret shipit-localhost-tls -n infra -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject -issuer -ext subjectAltName -dates`. You will see the SANs you requested, the issuer (your local CA) and the validity window cert-manager chose (90 days by default).
:::

## Redirecting HTTP to HTTPS

A common pattern: two listeners on one Gateway, and a route on the HTTP listener that only redirects:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: https-redirect
  namespace: infra
spec:
  parentRefs:
    - name: edge
      sectionName: http
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
```

App routes then attach only to the `https` listener via `sectionName: https`.

## Pitfalls and production practice

:::warning Common mistakes
- **No controller / wrong class.** Applying an Ingress or Gateway with an `ingressClassName`/`gatewayClassName` nobody serves silently does nothing. Check `kubectl get ingressclass` / `kubectl get gatewayclass` and the `Accepted` condition.
- **Port confusion.** `backendRefs.port` is the **Service** port, not the container port.
- **Route not attached.** The Gateway's `allowedRoutes` defaults to `from: Same` (same namespace only). Routes in other namespaces show `Accepted=False` with reason `NotAllowedByListeners`.
- **Cross-namespace backends without ReferenceGrant** give `RefNotPermitted` and 500s.
- **Expecting the proxy to retry.** Retries and timeouts differ per implementation unless you set them explicitly (HTTPRoute `timeouts`, implementation policies). Long-running requests (SSE, WebSockets for Socket.io) may need longer timeouts on the proxy.
- **Ignoring the client IP.** Behind a cloud LB, your Node app sees the proxy's IP. Configure the proxy to set `X-Forwarded-For` correctly and set `app.set('trust proxy', ...)` in Express / NestJS so rate limiting and logging use the real client IP.
:::

Production practice:

- **Run the proxy highly available**: at least two replicas spread across zones, a PodDisruptionBudget, and resource requests (modules 09 and 10).
- **One shared Gateway per environment/trust zone** owned by the platform team; app teams own HTTPRoutes. Use labels with `allowedRoutes.namespaces.from: Selector` to control who can attach.
- **Manage certificates with cert-manager** (or the cloud's certificate service), never by hand. Alert on certificate expiry anyway.
- **Keep implementation-specific policies small and explicit**, so a future migration (like the one ingress-nginx users went through in 2026) is a mechanical conversion.
- **WebSockets and gRPC**: HTTPRoute handles WebSocket upgrades on conformant implementations; use GRPCRoute for gRPC services.
- **Migrating from Ingress**: run Gateway API alongside the old controller, convert with `ingress2gateway`, compare behaviour per host, then move DNS host by host.
