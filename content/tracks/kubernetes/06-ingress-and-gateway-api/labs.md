These labs run on kind on your Mac. You need `docker` (Docker Desktop, OrbStack or Colima), `kind`, `kubectl`, `helm`, `curl`, `openssl` and optionally `jq` (`brew install jq`).

Lab 1 uses its own throwaway cluster for the legacy Ingress API. Labs 2 to 6 share one cluster called `gw-lab` with Envoy Gateway installed. Keep it until you finish Lab 6.

Versions move fast. Wherever a command needs a version, the lab shows how to look up the current one instead of hard-coding it.

:::tip Test apps used here
`hashicorp/http-echo` returns a fixed text (`-text=...`) on port 5678, so you can see at a glance which backend answered. Both it and `traefik/whoami` are multi-arch images that run natively on Apple Silicon.
:::

## Lab 1: The legacy Ingress API with Traefik

:::meta
difficulty: easy
time: 20 min
:::

Goal: see the classic Ingress flow end to end (IngressClass, Ingress, host/path rules) with a maintained controller, so you can read the Ingress manifests you will meet in existing Helm charts and clusters.

### Steps

1. Create a throwaway cluster and install Traefik as an Ingress controller:

```bash
kind create cluster --name ingress-lab
helm repo add traefik https://traefik.github.io/charts
helm repo update
helm install traefik traefik/traefik -n traefik --create-namespace
kubectl -n traefik rollout status deploy/traefik
kubectl get ingressclass
```

2. Deploy two tiny apps:

```bash
kubectl create deployment web --image=hashicorp/http-echo:1.0 -- /http-echo -text="hello from web"
kubectl create deployment api --image=hashicorp/http-echo:1.0 -- /http-echo -text="hello from api"
kubectl expose deployment web --port=80 --target-port=5678
kubectl expose deployment api --port=3000 --target-port=5678
```

3. Create an Ingress that sends `/api` to `api` and everything else to `web` for host `shipit.localhost`:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shipit
spec:
  ingressClassName: traefik
  rules:
    - host: shipit.localhost
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 3000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
EOF
```

4. Port-forward to the Traefik Service (it is `type: LoadBalancer` and stays `<pending>` on kind, which is fine):

```bash
kubectl -n traefik port-forward svc/traefik 8080:80
```

### Verify

In a second terminal:

```bash
curl http://shipit.localhost:8080/          # hello from web
curl http://shipit.localhost:8080/api/items # hello from api
curl -i http://other.localhost:8080/        # 404, no rule for this host
```

:::hint
If `curl` cannot resolve `shipit.localhost`, your curl is old. Use `curl -H 'Host: shipit.localhost' http://127.0.0.1:8080/` instead.
:::

:::solution
The manifests above are the full solution. Points worth noticing:

- `kubectl get ingressclass` shows `traefik`, created by the Helm chart. `ingressClassName: traefik` binds the Ingress to that controller.
- `kubectl describe ingress shipit` lists the backends with the pod IPs they resolve to.
- Per the spec, `Prefix` matches whole path segments: `/api` matches `/api` and `/api/...` but not `/apiv2`. Try `curl http://shipit.localhost:8080/apiv2`; controllers have historically differed on edge cases like this, which is one more portability problem Gateway API's conformance tests address.
- Anything beyond host/path (timeouts, rewrites, auth) would need Traefik-specific annotations or CRDs. That lack of portability is why Gateway API exists.
:::

### Clean up

Stop the port-forward (Ctrl+C), then:

```bash
kind delete cluster --name ingress-lab
```

## Lab 2: Install Envoy Gateway and route by host

:::meta
difficulty: easy
time: 25 min
:::

Goal: install a Gateway API implementation on kind, create a GatewayClass and Gateway in an `infra` namespace, and route two hostnames to two apps.

### Steps

1. Create the cluster you will use for Labs 2 to 6:

```bash
kind create cluster --name gw-lab
```

2. Find the current Envoy Gateway version on the [install page](https://gateway.envoyproxy.io/docs/install/install-helm/) (it looks like `v1.x.y`) and install it. The chart also installs the Gateway API CRDs:

```bash
export EG_VERSION=v1.9.2   # replace with the current version from the docs
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version "$EG_VERSION" -n envoy-gateway-system --create-namespace
kubectl wait --timeout=5m -n envoy-gateway-system \
  deployment/envoy-gateway --for=condition=Available
kubectl api-resources --api-group=gateway.networking.k8s.io
```

3. Create the GatewayClass and a Gateway owned by the "platform team" in `infra`:

```bash
kubectl create namespace infra
cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: edge
  namespace: infra
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: All
EOF
kubectl get gatewayclass eg
kubectl -n infra get gateway edge
```

4. Deploy two apps in an `apps` namespace and route `shipit.localhost` and `admin.localhost` to them:

```bash
kubectl create namespace apps
kubectl -n apps create deployment shipit --image=hashicorp/http-echo:1.0 -- /http-echo -text="shipit"
kubectl -n apps create deployment admin  --image=hashicorp/http-echo:1.0 -- /http-echo -text="admin"
kubectl -n apps expose deployment shipit --port=80 --target-port=5678
kubectl -n apps expose deployment admin  --port=80 --target-port=5678

cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shipit
  namespace: apps
spec:
  parentRefs:
    - name: edge
      namespace: infra
  hostnames: ["shipit.localhost"]
  rules:
    - backendRefs:
        - name: shipit
          port: 80
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: admin
  namespace: apps
spec:
  parentRefs:
    - name: edge
      namespace: infra
  hostnames: ["admin.localhost"]
  rules:
    - backendRefs:
        - name: admin
          port: 80
EOF
```

5. Envoy Gateway created an Envoy Deployment and Service for your Gateway. Find the Service and port-forward to it:

```bash
kubectl get deploy,svc -n envoy-gateway-system
export ENVOY_SVC=$(kubectl get svc -n envoy-gateway-system \
  -l gateway.envoyproxy.io/owning-gateway-namespace=infra,gateway.envoyproxy.io/owning-gateway-name=edge \
  -o jsonpath='{.items[0].metadata.name}')
echo "$ENVOY_SVC"
kubectl -n envoy-gateway-system port-forward "svc/$ENVOY_SVC" 8080:80
```

### Verify

In another terminal:

```bash
curl http://shipit.localhost:8080/       # shipit
curl http://admin.localhost:8080/        # admin
curl -i http://nope.localhost:8080/      # 404 from Envoy
curl http://shipit.127.0.0.1.nip.io:8080/  # 404: hostname does not match the route
kubectl get gatewayclass eg -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}'; echo
kubectl -n infra get gateway edge -o jsonpath='{.status.conditions[?(@.type=="Programmed")].status}'; echo
```

The GatewayClass should be `Accepted=True` and the Gateway `Programmed=True`. On kind the Gateway has no external address, which is expected; Envoy Gateway still programs the proxy.

:::hint
If the Gateway is not `Programmed`, check `kubectl -n envoy-gateway-system get pods` and the controller logs with `kubectl -n envoy-gateway-system logs deploy/envoy-gateway`. If the label selector finds no Service, run `kubectl get svc -n envoy-gateway-system --show-labels` and look for the one whose name starts with `envoy-infra-edge-`.
:::

:::solution
All manifests are in the steps. To make the nip.io name work as well, add it to the route's hostnames: `hostnames: ["shipit.localhost", "shipit.127.0.0.1.nip.io"]`. nip.io needs real DNS, so it only works with internet access.

The object chain you built:

```text
GatewayClass eg  --controllerName-->  envoy-gateway controller
Gateway infra/edge  --gatewayClassName: eg-->  Envoy Deployment + Service in envoy-gateway-system
HTTPRoute apps/shipit, apps/admin  --parentRefs-->  infra/edge (allowed by from: All)
```
:::

### Clean up

Keep the cluster, the Gateway and the port-forward for the next labs. If the port-forward dies (it does when the Envoy pod restarts), re-run the last command of step 5.

## Lab 3: Path and header matching, rewrites and a weighted canary

:::meta
difficulty: medium
time: 30 min
:::

Goal: route `/api` to an API service, let testers force a canary with a header, send 10% of normal traffic to the canary, and rewrite a legacy path.

### Steps

1. Deploy a "web" frontend and two API versions in `apps`:

```bash
kubectl -n apps create deployment web    --image=hashicorp/http-echo:1.0 -- /http-echo -text="web"
kubectl -n apps create deployment api-v1 --image=hashicorp/http-echo:1.0 -- /http-echo -text="api v1"
kubectl -n apps create deployment api-v2 --image=hashicorp/http-echo:1.0 -- /http-echo -text="api v2 (canary)"
for d in web api-v1 api-v2; do kubectl -n apps expose deployment $d --port=80 --target-port=5678; done
```

2. Replace the `shipit` route with this one:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shipit
  namespace: apps
spec:
  parentRefs:
    - name: edge
      namespace: infra
  hostnames: ["shipit.localhost"]
  rules:
    # 1. Testers force the canary with a header
    - matches:
        - path: { type: PathPrefix, value: /api }
          headers:
            - name: x-canary
              value: "true"
      backendRefs:
        - name: api-v2
          port: 80
    # 2. Everyone else on /api: 90/10 split
    - matches:
        - path: { type: PathPrefix, value: /api }
      backendRefs:
        - name: api-v1
          port: 80
          weight: 90
        - name: api-v2
          port: 80
          weight: 10
    # 3. Legacy prefix rewritten to /api, then same split
    - matches:
        - path: { type: PathPrefix, value: /v0 }
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /api
      backendRefs:
        - name: api-v1
          port: 80
    # 4. Everything else
    - backendRefs:
        - name: web
          port: 80
EOF
```

### Verify

```bash
curl http://shipit.localhost:8080/                               # web
curl -H 'x-canary: true' http://shipit.localhost:8080/api/items  # api v2 (canary)
curl http://shipit.localhost:8080/v0/items                       # api v1
for i in $(seq 1 200); do curl -s http://shipit.localhost:8080/api; done | sort | uniq -c
```

The loop should show roughly 180 `api v1` and 20 `api v2 (canary)`. Exact numbers vary.

Now promote the canary to 50/50 and then 100% by editing the weights:

```bash
kubectl -n apps patch httproute shipit --type=json -p='[
  {"op":"replace","path":"/spec/rules/1/backendRefs/0/weight","value":50},
  {"op":"replace","path":"/spec/rules/1/backendRefs/1/weight","value":50}]'
for i in $(seq 1 100); do curl -s http://shipit.localhost:8080/api; done | sort | uniq -c
```

:::hint
Rule order in the YAML does not decide precedence; the spec does. The header rule wins over the plain `/api` rule because both have the same path match and it has more header matches. Use `kubectl explain httproute.spec.rules.backendRefs.weight` to read how weights work.
:::

:::solution
The route above is the solution. To finish the rollout, set weight `0` on `api-v1` and `1` (or 100) on `api-v2`:

```bash
kubectl -n apps patch httproute shipit --type=json -p='[
  {"op":"replace","path":"/spec/rules/1/backendRefs/0/weight","value":0},
  {"op":"replace","path":"/spec/rules/1/backendRefs/1/weight","value":100}]'
```

A weight of 0 keeps the backend in the spec but sends it nothing, which makes rollback a one-line change. Progressive delivery tools (Argo Rollouts, Flagger) automate exactly this patching and watch error rates between steps.
:::

### Clean up

Keep everything for Lab 4.

## Lab 4: HTTPS with cert-manager and a local CA

:::meta
difficulty: medium
time: 35 min
:::

Goal: install cert-manager, build a local CA, issue a certificate for `shipit.localhost`, terminate TLS at the Gateway and redirect HTTP to HTTPS.

### Steps

1. Install cert-manager. Get the current version from the [cert-manager Helm install page](https://cert-manager.io/docs/installation/helm/):

```bash
export CM_VERSION=v1.21.2   # replace with the current version from the docs
helm install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --version "$CM_VERSION" --namespace cert-manager --create-namespace \
  --set crds.enabled=true
kubectl -n cert-manager rollout status deploy/cert-manager-webhook
```

2. Create the self-signed bootstrap issuer, the CA certificate and the CA issuer:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
---
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
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: local-ca
spec:
  ca:
    secretName: local-ca
EOF
kubectl get clusterissuer
kubectl -n cert-manager get certificate local-ca
```

3. Issue a leaf certificate in `infra`, where the Gateway lives:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: shipit-localhost
  namespace: infra
spec:
  secretName: shipit-localhost-tls
  dnsNames: ["shipit.localhost", "admin.localhost"]
  issuerRef:
    name: local-ca
    kind: ClusterIssuer
EOF
kubectl -n infra get certificate shipit-localhost -w   # wait for READY=True, then Ctrl+C
```

4. Add an HTTPS listener to the Gateway and a redirect route on the HTTP listener. Restrict the app routes to the HTTPS listener:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: edge
  namespace: infra
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Same
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: shipit-localhost-tls
      allowedRoutes:
        namespaces:
          from: All
---
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
EOF
kubectl -n apps patch httproute shipit --type=merge -p \
  '{"spec":{"parentRefs":[{"name":"edge","namespace":"infra","sectionName":"https"}]}}'
kubectl -n apps patch httproute admin --type=merge -p \
  '{"spec":{"parentRefs":[{"name":"edge","namespace":"infra","sectionName":"https"}]}}'
```

5. The Envoy Service now has port 443 too. Restart the port-forward with both ports and export the CA certificate:

```bash
# Ctrl+C the old port-forward, then:
kubectl -n envoy-gateway-system port-forward "svc/$ENVOY_SVC" 8080:80 8443:443
```

```bash
# In another terminal
kubectl -n cert-manager get secret local-ca -o jsonpath='{.data.ca\.crt}' | base64 -d > /tmp/local-ca.crt
openssl x509 -in /tmp/local-ca.crt -noout -subject
```

### Verify

```bash
curl --cacert /tmp/local-ca.crt https://shipit.localhost:8443/        # web
curl --cacert /tmp/local-ca.crt https://admin.localhost:8443/         # admin
curl -i http://shipit.localhost:8080/                                 # 301, Location: https://shipit.localhost/
curl -v --cacert /tmp/local-ca.crt https://shipit.localhost:8443/ 2>&1 | grep -E 'subject|issuer|SSL connection'
curl https://shipit.localhost:8443/                                   # fails: CA not trusted
```

The redirect points to port 443 because the proxy does not know about your port-forward. On a real LB it would be correct.

:::hint
If the HTTPS listener shows `ResolvedRefs=False`, the Secret does not exist yet or is in another namespace. Check `kubectl -n infra get secret shipit-localhost-tls` and `kubectl -n infra describe gateway edge`. If the Certificate is not Ready, `kubectl -n infra describe certificaterequest` usually explains why.
:::

:::solution
The steps contain the full solution. A few things to inspect:

```bash
kubectl -n infra get secret shipit-localhost-tls -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -noout -subject -issuer -ext subjectAltName -dates
kubectl -n infra describe gateway edge | sed -n '/Listeners:/,$p'
```

To trust the CA system-wide on macOS (optional, only for local dev): `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/local-ca.crt`. Remove it later from Keychain Access. Chrome and Safari then accept `https://shipit.localhost:8443`.
:::

### Clean up

Keep the cluster for Lab 5.

## Lab 5: Break and fix: the route that will not work

:::meta
difficulty: medium
time: 30 min
:::

Goal: diagnose a cross-team setup where requests fail, using only status conditions and `kubectl`. There are **three** separate problems.

### Setup

A "shop" team owns a route in namespace `shop`. It should send `/payments` to a Service owned by the "payments" team in namespace `payments`, and everything else to its own `storefront` Service. Apply this broken setup:

```bash
kubectl create namespace shop
kubectl create namespace payments
kubectl -n shop create deployment storefront --image=hashicorp/http-echo:1.0 -- /http-echo -text="storefront"
kubectl -n shop expose deployment storefront --port=80 --target-port=5678
kubectl -n payments create deployment payments-api --image=hashicorp/http-echo:1.0 -- /http-echo -text="payments"
kubectl -n payments expose deployment payments-api --port=8080 --target-port=5678

cat <<'EOF' | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shop-gw
  namespace: infra
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      hostname: "*.example.com"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop
  namespace: shop
spec:
  parentRefs:
    - name: shop-gw
      namespace: infra
  hostnames: ["shop.example.com"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /payments }
      backendRefs:
        - name: payments-api
          namespace: payments
          port: 5678
    - backendRefs:
        - name: storefront
          port: 80
EOF
```

Port-forward to the new Gateway's Envoy Service:

```bash
export SHOP_SVC=$(kubectl get svc -n envoy-gateway-system \
  -l gateway.envoyproxy.io/owning-gateway-namespace=infra,gateway.envoyproxy.io/owning-gateway-name=shop-gw \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n envoy-gateway-system port-forward "svc/$SHOP_SVC" 9080:80
```

Test (in another terminal):

```bash
curl -i --resolve shop.example.com:9080:127.0.0.1 http://shop.example.com:9080/
curl -i --resolve shop.example.com:9080:127.0.0.1 http://shop.example.com:9080/payments
```

### Your task

Make both requests succeed (`storefront` and `payments`) without changing the namespaces of any object. Use `kubectl describe` and the status conditions to find each problem.

### Verify

```bash
curl --resolve shop.example.com:9080:127.0.0.1 http://shop.example.com:9080/          # storefront
curl --resolve shop.example.com:9080:127.0.0.1 http://shop.example.com:9080/payments  # payments
kubectl -n shop get httproute shop -o jsonpath='{range .status.parents[*].conditions[*]}{.type}={.status} ({.reason}){"\n"}{end}'
```

Both conditions should be `True` (`Accepted`, `ResolvedRefs`).

:::hint
Start with `kubectl -n shop describe httproute shop` and read `Status > Parents > Conditions`. First problem: what does `allowedRoutes` default to when it is omitted? After fixing that, look at `ResolvedRefs`. Two different things are wrong with the payments backend: one is about permission, one is about numbers.
:::

:::solution
**Problem 1: the route is not allowed to attach.** The listener has no `allowedRoutes`, so it defaults to `from: Same` (only routes in `infra`). The route shows `Accepted=False`, reason `NotAllowedByListeners`. The platform team fixes the Gateway:

```bash
kubectl -n infra patch gateway shop-gw --type=json -p='[
  {"op":"add","path":"/spec/listeners/0/allowedRoutes","value":{"namespaces":{"from":"Selector","selector":{"matchLabels":{"kubernetes.io/metadata.name":"shop"}}}}}]'
```

(`kubernetes.io/metadata.name` is a label every namespace gets automatically, handy for selecting a single namespace.) The hostname `shop.example.com` intersects `*.example.com`, so that part is fine. Now `/` returns `storefront`.

**Problem 2: cross-namespace reference not permitted.** `ResolvedRefs=False`, reason `RefNotPermitted`. The payments team must consent with a ReferenceGrant in **their** namespace:

```bash
cat <<'EOF' | kubectl apply -f -
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
    - group: ""
      kind: Service
      name: payments-api
EOF
```

**Problem 3: wrong port.** `backendRefs.port` must be the **Service** port (8080), not the container port (5678). The status shows the backend cannot be resolved (or Envoy returns 500/503):

```bash
kubectl -n shop patch httproute shop --type=json -p='[
  {"op":"replace","path":"/spec/rules/0/backendRefs/0/port","value":8080}]'
```

Both curls now succeed and both conditions are `True`. The diagnostic habit to keep: `describe` the route, read conditions per parent, then fix the owner's object (Gateway for attachment, ReferenceGrant in the target namespace for permission, route for ports and names).
:::

### Clean up

```bash
kubectl delete namespace shop payments
kubectl -n infra delete gateway shop-gw
```

Stop the `9080` port-forward. Keep the cluster for Lab 6.

## Lab 6: Challenge: a multi-team edge for shipit

:::meta
difficulty: hard
time: 45 min
:::

Goal: design and build the edge for a small platform on your own. No step-by-step; the solution is below if you get stuck.

### Requirements

1. A namespace `platform` holds one Gateway `public` with an HTTP listener on 80 and an HTTPS listener on 443 for `*.shipit.localhost`, using a **wildcard** certificate from your `local-ca` issuer.
2. Only namespaces labelled `shipit.io/expose: "true"` may attach routes, and only to the HTTPS listener. The HTTP listener only redirects to HTTPS.
3. Namespace `team-web` (labelled) serves `www.shipit.localhost` from a `web` app.
4. Namespace `team-api` (labelled) serves `api.shipit.localhost`: `/v1` goes 80/20 to `api-v1`/`api-v2`, and requests with header `x-version: 2` always go to `api-v2`. The response must carry a header `x-served-by: gateway`.
5. Namespace `team-rogue` (**not** labelled) tries to attach a route for `www.shipit.localhost`. It must be rejected, and you must be able to show where the rejection is reported.

### Verify

You can show, with curl against a port-forward on 8443/8080 and `--cacert`:

- `https://www.shipit.localhost:8443/` returns the web app, and the certificate SAN is `*.shipit.localhost`.
- `https://api.shipit.localhost:8443/v1` splits roughly 80/20; `-H 'x-version: 2'` always hits v2; `curl -i` shows `x-served-by: gateway`.
- `http://www.shipit.localhost:8080/` returns 301.
- The rogue route's status shows `Accepted=False`.

:::hint
A wildcard SAN covers exactly one label: `*.shipit.localhost` matches `www.shipit.localhost` but not `shipit.localhost`. Use `ResponseHeaderModifier` for the response header. Put the Certificate in `platform` so the Gateway can use the Secret without a ReferenceGrant. Remember to restart the port-forward for the new Gateway's Envoy Service.
:::

:::solution
```bash
kubectl create namespace platform
kubectl create namespace team-web
kubectl create namespace team-api
kubectl create namespace team-rogue
kubectl label namespace team-web shipit.io/expose=true
kubectl label namespace team-api shipit.io/expose=true

kubectl -n team-web create deployment web --image=hashicorp/http-echo:1.0 -- /http-echo -text="www"
kubectl -n team-web expose deployment web --port=80 --target-port=5678
kubectl -n team-api create deployment api-v1 --image=hashicorp/http-echo:1.0 -- /http-echo -text="api v1"
kubectl -n team-api create deployment api-v2 --image=hashicorp/http-echo:1.0 -- /http-echo -text="api v2"
kubectl -n team-api expose deployment api-v1 --port=80 --target-port=5678
kubectl -n team-api expose deployment api-v2 --port=80 --target-port=5678
kubectl -n team-rogue create deployment evil --image=hashicorp/http-echo:1.0 -- /http-echo -text="evil"
kubectl -n team-rogue expose deployment evil --port=80 --target-port=5678

cat <<'EOF' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-shipit
  namespace: platform
spec:
  secretName: wildcard-shipit-tls
  dnsNames: ["*.shipit.localhost"]
  issuerRef:
    name: local-ca
    kind: ClusterIssuer
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: public
  namespace: platform
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Same
    - name: https
      protocol: HTTPS
      port: 443
      hostname: "*.shipit.localhost"
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: wildcard-shipit-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              shipit.io/expose: "true"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: redirect
  namespace: platform
spec:
  parentRefs:
    - name: public
      sectionName: http
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: www
  namespace: team-web
spec:
  parentRefs:
    - name: public
      namespace: platform
      sectionName: https
  hostnames: ["www.shipit.localhost"]
  rules:
    - backendRefs:
        - name: web
          port: 80
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api
  namespace: team-api
spec:
  parentRefs:
    - name: public
      namespace: platform
      sectionName: https
  hostnames: ["api.shipit.localhost"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /v1 }
          headers:
            - name: x-version
              value: "2"
      filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: x-served-by
                value: gateway
      backendRefs:
        - name: api-v2
          port: 80
    - matches:
        - path: { type: PathPrefix, value: /v1 }
      filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: x-served-by
                value: gateway
      backendRefs:
        - name: api-v1
          port: 80
          weight: 80
        - name: api-v2
          port: 80
          weight: 20
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: hijack
  namespace: team-rogue
spec:
  parentRefs:
    - name: public
      namespace: platform
      sectionName: https
  hostnames: ["www.shipit.localhost"]
  rules:
    - backendRefs:
        - name: evil
          port: 80
EOF

export PUB_SVC=$(kubectl get svc -n envoy-gateway-system \
  -l gateway.envoyproxy.io/owning-gateway-namespace=platform,gateway.envoyproxy.io/owning-gateway-name=public \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n envoy-gateway-system port-forward "svc/$PUB_SVC" 8080:80 8443:443
```

Stop the Lab 2 port-forward first if it still holds 8080/8443. Then:

```bash
curl --cacert /tmp/local-ca.crt https://www.shipit.localhost:8443/
for i in $(seq 1 100); do curl -s --cacert /tmp/local-ca.crt https://api.shipit.localhost:8443/v1; done | sort | uniq -c
curl -si --cacert /tmp/local-ca.crt -H 'x-version: 2' https://api.shipit.localhost:8443/v1 | grep -iE 'x-served-by|api'
curl -i http://www.shipit.localhost:8080/
kubectl -n team-rogue get httproute hijack -o jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")]}'; echo
```

The rogue route reports `Accepted=False` with reason `NotAllowedByListeners`. Note the rejection lives on the **route's** status, so the rogue team sees it, while the legitimate `www` route is untouched.
:::

### Clean up

```bash
kind delete cluster --name gw-lab
rm -f /tmp/local-ca.crt
```

If you trusted the CA in Keychain in Lab 4, remove "local-dev-ca" in Keychain Access.
