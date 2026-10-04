This is where the track comes together. You will take **shipit** (the Node.js/TypeScript API with Postgres and Redis, plus a small web front end) and ship it to a multi-node kind cluster the way you would ship it to a real cluster: packaged as your own Helm chart, exposed over HTTPS through Gateway API, hardened, observable enough to debug, and tested by breaking it on purpose.

The labs are the milestones, each with a full reference solution. Try each milestone yourself first, using this page as the spec, and open the solution only to compare or when stuck. Budget a weekend or several evenings.

## The brief

> The shipit team wants to move from `docker compose` on a VM to Kubernetes. You own the migration. Deliver a Helm chart and a runbook that let anyone on the team stand up the full stack on a fresh cluster in under 15 minutes, with production-grade defaults. The platform team requires Pod Security `restricted`, default-deny networking and no long-lived credentials in Git. Prove resilience with a game day before sign-off.

Scope:

| Component | Implementation |
| --- | --- |
| `shipit-api` | Your Node.js 22 + TypeScript image (port 3000, `/healthz`, `/readyz`, `/items`), built locally and loaded into kind |
| `shipit-web` | `nginxinc/nginx-unprivileged` serving a static `index.html` from a ConfigMap; calls the API at `/api/...` |
| `postgres` | Official `postgres:17` image as a StatefulSet with a PVC |
| `redis` | Official `redis:7-alpine` as a cache (no persistence) |
| Edge | Envoy Gateway implementing Gateway API, HTTPS with a local certificate, HTTP redirected to HTTPS |
| Delivery | Your Helm chart (`charts/shipit`), installed with Helm; optionally reconciled by Argo CD |

Out of scope: managed databases, cert-manager with a public CA, cloud load balancers. The lesson notes where production would differ.

## Architecture

```text
 Mac browser / curl
   https://shipit.localtest.me:8443        (localtest.me resolves to 127.0.0.1)
        │  kubectl port-forward 8443:443 / 8080:80
        ▼
 ┌──────────────── namespace envoy-gateway-system ────────────────┐
 │  Envoy Gateway controller      Envoy proxy pods (data plane)   │
 └───────────────────────────────────────┬────────────────────────┘
                                         │ (NetworkPolicy: allowed from this namespace only)
 ┌──────────────── namespace shipit (PSA: restricted) ────────────▼────────────────────────┐
 │  Gateway "shipit"  listeners: http:80 (→ 301 to https) , https:443 (TLS: shipit-tls)    │
 │  HTTPRoute "shipit":   /api/*  ── rewrite prefix to / ──►  Service shipit-api:80          │
 │                        /*      ────────────────────────►  Service shipit-web:80          │
 │                                                                                         │
 │  Deployment shipit-web (2)            Deployment shipit-api (HPA 2–5, PDB maxUnavail 1)  │
 │   nginx-unprivileged :8080             node:22 :3000, SA without token                  │
 │   index.html from ConfigMap            config from ConfigMap, DATABASE_URL from Secret  │
 │                                              │                    │                     │
 │                                              ▼                    ▼                     │
 │                        StatefulSet postgres (1) + headless Svc    Deployment redis (1)  │
 │                        PVC data-postgres-0 (local-path)           emptyDir, no persistence│
 │                                                                                         │
 │  NetworkPolicies: default deny (in+out), DNS egress, gateway→web/api, api→postgres/redis│
 │  ServiceAccounts: shipit-api (no token, no RBAC), shipit-deployer (namespaced Role)      │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
 kube-system: metrics-server (for HPA)        local-path-provisioner (kind default StorageClass)
```

Request flow for `GET https://shipit.localtest.me:8443/api/items`: port-forward delivers the connection to an Envoy pod, Envoy terminates TLS using the `shipit-tls` Secret, matches the HTTPRoute rule for `/api`, rewrites the path to `/items`, picks a **ready** endpoint of `shipit-api` and forwards to pod port 3000. The API answers from Redis if cached, otherwise from Postgres.

:::info Why port-forward?
On macOS, kind nodes live inside Docker's Linux VM, so LoadBalancer IPs are not directly reachable from your Mac without extra tooling. Port-forwarding to the Envoy Service is the most reliable local option. Alternatives are `cloud-provider-kind` (gives LoadBalancer Services an address; check its docs for macOS port-mapping support) or kind `extraPortMappings` with a NodePort-based Envoy Service. In a cloud cluster the Envoy Service would be a cloud load balancer and you would drop the `:8443`.
:::

## Repository layout

Keep everything in one Git repository (it becomes your GitOps repo in milestone 7):

```text
shipit-k8s/
  app/shipit-api/           # Node.js source + Dockerfile (milestone 1)
  charts/shipit/
    Chart.yaml
    values.yaml
    files/index.html
    templates/
      _helpers.tpl
      postgres.yaml  redis.yaml                         # milestone 3
      api.yaml  api-hpa-pdb.yaml  web.yaml              # milestone 4
      gateway.yaml                                      # milestone 5
      networkpolicies.yaml  rbac.yaml                   # milestone 6
      tests/smoke.yaml
  platform/kind.yaml        # cluster config (milestone 2)
  argocd/shipit-app.yaml    # milestone 7 (optional)
  RUNBOOK.md                # how to stand it up, game day notes
```

Not in Git: `tls.key`, the database password. You create those Secrets with `kubectl` (production: External Secrets Operator + a secret store, and cert-manager for certificates).

## Requirements

### Functional

1. `https://shipit.localtest.me:8443/` serves the web page, which lists items and can add new ones.
2. `https://shipit.localtest.me:8443/api/items` returns JSON; `POST /api/items` creates an item; repeated GETs show `x-cache: hit`.
3. `http://shipit.localtest.me:8080/...` redirects (301) to the HTTPS URL.
4. Items survive deleting the Postgres pod and survive `helm upgrade`.

### Chart

5. One chart, `charts/shipit`, installs everything except cluster-wide platform components (Envoy Gateway, metrics-server) and the two Secrets.
6. Everything environment-specific is a value: image tags, replica counts, resources, hostname, storage size, gateway class, TLS Secret name.
7. Common labels (`app.kubernetes.io/name`, `instance`, `part-of`, `managed-by`, `helm.sh/chart`) on all objects; selector labels stable across versions.
8. `helm lint` passes; `helm test` runs a smoke test that calls `/readyz` through the Service.
9. A config change rolls the affected pods automatically (checksum annotation).

### Reliability

10. API: liveness `/healthz`, readiness `/readyz`; startup does not crash when dependencies are late.
11. Every container has CPU and memory requests and a memory limit.
12. API autoscales 2–5 replicas on CPU; replicas spread across nodes; PDB `maxUnavailable: 1` for API and web.
13. Graceful shutdown: the API handles SIGTERM; a short `preStop` delay lets endpoints update before shutdown.
14. Postgres: StatefulSet, headless Service, `volumeClaimTemplates`, readiness via `pg_isready`.

### Security

15. Namespace `shipit` enforces Pod Security `restricted`; all containers have read-only root filesystems.
16. Each workload has its own ServiceAccount; no pod mounts an API token; the API's SA has no RBAC permissions.
17. A `shipit-deployer` ServiceAccount can manage the app's resources in `shipit` only (verified with `kubectl auth can-i`).
18. NetworkPolicies: default deny ingress and egress; explicit allows only for DNS, gateway → web/api, api → postgres/redis, smoke tests → api.
19. No secrets in the chart or in Git.

### Operations

20. A `RUNBOOK.md` with: prerequisites, install steps, how to verify, how to roll back, and game day findings.

## Acceptance tests

Run these at the end. They are the definition of done.

```bash
# 1. Everything healthy
kubectl -n shipit get pods                       # all Running and READY
kubectl -n shipit get pvc                        # data-postgres-0 Bound
kubectl -n shipit get gateway,httproute          # Gateway PROGRAMMED True; routes Accepted
helm -n shipit test shipit                       # Succeeded

# 2. HTTPS + routing + redirect (with the Envoy port-forward running)
curl -s --cacert tls.crt https://shipit.localtest.me:8443/ | grep -i '<title>'
curl -s --cacert tls.crt -X POST https://shipit.localtest.me:8443/api/items -H 'content-type: application/json' -d '{"name":"acceptance"}'
curl -si --cacert tls.crt https://shipit.localtest.me:8443/api/items | grep -iE 'HTTP/|x-cache'
curl -sI http://shipit.localtest.me:8080/api/items | grep -iE 'HTTP/|location'

# 3. Persistence
kubectl -n shipit delete pod postgres-0 && kubectl -n shipit wait --for=condition=Ready pod/postgres-0 --timeout=120s
curl -s --cacert tls.crt https://shipit.localtest.me:8443/api/items | grep acceptance

# 4. Security
kubectl get ns shipit --show-labels | grep 'enforce=restricted'
kubectl -n shipit get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.automountServiceAccountToken}{"\n"}{end}'
kubectl auth can-i list secrets -n shipit --as system:serviceaccount:shipit:shipit-api            # no
kubectl auth can-i patch deployments -n shipit --as system:serviceaccount:shipit:shipit-deployer  # yes
kubectl auth can-i patch deployments -n default --as system:serviceaccount:shipit:shipit-deployer # no
kubectl run np-test --rm -i --restart=Never --image=nicolaka/netshoot -- nc -zv -w 3 postgres.shipit 5432 || echo BLOCKED

# 5. Resilience
kubectl -n shipit get hpa,pdb
kubectl -n shipit get pods -l app.kubernetes.io/name=shipit-api -o wide   # on different nodes
```

## Rubric

Score yourself honestly (100 points). 80+ means you can do this in a real job; below 60, revisit the modules noted.

| Area | Points | Full marks when... | Revisit |
| --- | --- | --- | --- |
| Chart quality | 15 | Clean values API, helpers, stable selectors, lint passes, checksum rollouts, smoke test | 12 |
| Data tier | 10 | StatefulSet + headless Service + PVC, data survives pod deletion and upgrades | 08 |
| Routing & TLS | 15 | Gateway with HTTPS listener, rewrite for `/api`, redirect, route status conditions understood | 06 |
| Config & secrets | 10 | ConfigMaps/Secrets used correctly, nothing secret in Git, config changes roll pods | 07 |
| Reliability | 15 | Probes correct (liveness ≠ readiness), resources, HPA working, PDB + spread, graceful shutdown | 09, 10 |
| Security | 20 | Restricted PSA passes, read-only FS, no tokens, least-privilege RBAC, default-deny NetworkPolicies that you have tested | 11 |
| Operations | 15 | Runbook works from scratch, game day executed with written findings and proposed fixes | 13, 14 |

Bonus (+5 each, no cap on learning): Argo CD delivery with self-heal; a ServiceMonitor and Grafana dashboard for the API (add `prom-client`); a Kyverno or VAP policy enforcing your own rules on the namespace; CloudNativePG instead of a hand-rolled StatefulSet.

## Design notes and trade-offs

- **One chart vs several.** A single chart keeps the exercise focused and makes `helm upgrade` atomic for the whole app. In production you would usually **not** ship your database in your app chart: use RDS/Aurora (or an operator like CloudNativePG with replicas, backups and failover) and pass a connection string. The single-replica Postgres here is a deliberate single point of failure that the game day exposes.
- **Fixed resource names.** Components are named `shipit-api`, `postgres` and so on rather than `<release>-...`. That keeps DNS names readable and matches the `DATABASE_URL` in the Secret, at the cost of allowing only one release per namespace. That is a normal choice for an application chart.
- **Readiness and the cache.** shipit-api's `/readyz` checks both Postgres and Redis. Is a cache outage really a reason to stop serving? The game day makes you decide.
- **CPU limits.** The reference values set CPU requests but no CPU limits for the API (to avoid throttling Node.js), and memory limits everywhere. Discuss in your runbook why.
- **`preStop` sleep.** Without it, a terminating pod can receive requests after it stops listening, because endpoint removal propagates asynchronously to Envoy. A few seconds of sleep closes the gap.

:::warning Where this differs from production
TLS from a self-signed or mkcert certificate (production: cert-manager with Let's Encrypt or ACM on the load balancer); Secrets created by hand (production: External Secrets Operator); local-path storage pinned to one node (production: EBS CSI with zone-aware scheduling, or a managed database); images loaded with `kind load` (production: a registry such as ECR, pinned by digest, pulled by nodes with IAM).
:::

:::tip How to work through the milestones
Commit after every milestone. Use `helm template` constantly while writing templates, `kubectl -n shipit get events --sort-by=.lastTimestamp` whenever something does not come up, and the troubleshooting flow from module 13. Most capstone problems are a label that does not match, a port that does not match, or a NetworkPolicy you forgot.
:::

:::try Warm-up: sketch your values.yaml
Before opening the labs, write down the values you think the chart needs (images, replicas, resources, hostname, storage, gateway class, TLS Secret name, NetworkPolicy toggle). Compare with the reference `values.yaml` in milestone 3. Designing the values API first is how good charts start.
:::
