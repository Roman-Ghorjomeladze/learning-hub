Questions are grouped from junior to senior. Answer out loud first, then open the model answer. Strong answers explain **why**, mention trade-offs, and connect to real experience ("on our NestJS service we..."). Interviewers for senior roles care less about flags and more about how you reason about failure, security and operations.

## Fundamentals

### What problem does Kubernetes solve, and when would you not use it?

:::details Model answer
Kubernetes is a control plane for running containers on a fleet of machines: it schedules workloads onto nodes, restarts and replaces them when they fail, gives them stable networking and service discovery, rolls out new versions, scales them, and exposes all of this through a declarative API that you can drive from Git. Its core value is **desired-state reconciliation**: you describe what should run and controllers keep making reality match.

You might not use it for a single small service with modest traffic (a PaaS like App Runner, Cloud Run, ECS Fargate or a VM is simpler and cheaper), for a team without capacity to operate it, or when the operational overhead (upgrades, add-ons, security) outweighs the benefits of a shared platform. Managed Kubernetes reduces but does not remove that overhead.
:::

### Describe the main components of a Kubernetes cluster.

:::details Model answer
**Control plane:** `kube-apiserver` (the only component that talks to etcd; authn, authz, admission, REST API), `etcd` (consistent key-value store holding all cluster state), `kube-scheduler` (assigns pending pods to nodes based on requests, affinity, taints, topology), `kube-controller-manager` (runs the built-in controllers: Deployment, ReplicaSet, Node, Job, EndpointSlice...), and on cloud providers the `cloud-controller-manager` (load balancers, node lifecycle, routes).

**Nodes:** `kubelet` (registers the node, starts containers through the CRI runtime, runs probes, reports status), a container runtime such as containerd, `kube-proxy` (programs Service virtual IPs with iptables/IPVS/nftables; some CNIs replace it), and the CNI plugin for pod networking. Add-ons such as CoreDNS and metrics-server run as normal workloads.

Everything communicates through the API server; components watch the API rather than calling each other.
:::

### What happens, step by step, when you run `kubectl apply -f deployment.yaml`?

:::details Model answer
1. kubectl sends the object to the API server, which **authenticates** the client, **authorizes** the request with RBAC, runs **mutating admission**, validates the schema, runs **validating admission** (Pod Security, policies), and stores it in etcd.
2. The **Deployment controller** sees the new Deployment via a watch and creates a ReplicaSet.
3. The **ReplicaSet controller** creates Pod objects to match `replicas` (each also passes admission).
4. The **scheduler** sees unscheduled pods, filters and scores nodes, and binds each pod to a node.
5. The **kubelet** on that node sees the pod, pulls the image, sets up the sandbox with the CNI (pod IP), mounts volumes, starts containers, and runs probes.
6. When readiness passes, the **EndpointSlice controller** adds the pod IP to matching Services, and kube-proxy/the dataplane starts routing traffic to it.

Each step is an independent control loop reacting to state in the API, which is why the system tolerates component restarts.
:::

### What is a Pod and why isn't the container the smallest unit?

:::details Model answer
A Pod is one or more containers that share a network namespace (one IP, `localhost` between them), can share volumes, and are scheduled together on the same node. The pod is the unit of scheduling, scaling and lifecycle. This allows patterns like sidecars (log shippers, proxies; native sidecars are init containers with `restartPolicy: Always`), init containers (run-to-completion setup), and adapters, without baking them into the app image. Most pods run a single app container; multiple containers belong in one pod only when they must be co-located and share fate.
:::

### Deployment vs StatefulSet vs DaemonSet vs Job: when do you use each?

:::details Model answer
- **Deployment**: stateless, interchangeable replicas (APIs, web front ends). Manages ReplicaSets for rolling updates and rollbacks.
- **StatefulSet**: replicas that need stable identity and per-replica storage (databases, Kafka, Zookeeper): ordered names (`db-0`), stable DNS through a headless Service, `volumeClaimTemplates`, ordered rollout.
- **DaemonSet**: one pod per (matching) node: log agents, node exporters, CNI and CSI node plugins.
- **Job / CronJob**: run to completion (migrations, batch processing, reports), with retries (`backoffLimit`), parallelism and schedules.

A common mistake is running a database as a Deployment with a shared PVC; another is using a StatefulSet for a stateless app "just in case", which only slows rollouts.
:::

### How do Services work, and what are the Service types?

:::details Model answer
A Service gives a stable virtual IP and DNS name to a changing set of pods selected by labels. The EndpointSlice controller keeps the list of **ready** pod IPs; kube-proxy (or an eBPF dataplane) programs the node so connections to the ClusterIP are load-balanced to those endpoints.

Types: **ClusterIP** (internal only, default), **NodePort** (opens a port on every node, forwarded to the Service), **LoadBalancer** (asks the cloud controller or LB controller for an external load balancer, built on NodePort or direct pod IP targets), **ExternalName** (DNS CNAME to an external name). A **headless** Service (`clusterIP: None`) has no virtual IP; DNS returns pod IPs directly, used by StatefulSets and clients that do their own balancing.
:::

### How does service discovery work inside the cluster?

:::details Model answer
CoreDNS watches Services and EndpointSlices and serves records: `my-svc.my-ns.svc.cluster.local` resolves to the ClusterIP (or pod IPs for headless Services), and StatefulSet pods get `pod-0.my-svc.my-ns.svc.cluster.local`. Pods' `/etc/resolv.conf` points at CoreDNS with search domains for their namespace, so the short name `postgres` works within the namespace. Note the `ndots: 5` default: external names with few dots first try the search domains, which multiplies DNS queries; use FQDNs with a trailing dot or tune `dnsConfig` for chatty clients.
:::

### ConfigMap vs Secret: what is the actual difference?

:::details Model answer
Both hold key-value data consumed as environment variables or mounted files. Secrets are intended for sensitive data: they are base64-encoded (not encrypted), can be encrypted at rest in etcd (with a KMS provider on managed clusters), are only sent to nodes that run pods using them, are stored in tmpfs when mounted, and can be protected separately with RBAC. Base64 is not security; the real controls are etcd encryption, tight RBAC (listing Secrets reveals them), and ideally an external store (AWS Secrets Manager via External Secrets Operator). Env vars are read at start (changes need a restart); mounted files update eventually (not with `subPath`).
:::

## Workloads and configuration

### Explain requests and limits. What happens when a container exceeds them?

:::details Model answer
**Requests** are what the scheduler reserves on a node; they decide placement and the pod's QoS class. **Limits** are enforced at runtime by cgroups. Exceeding the **CPU limit** causes throttling (the process is slowed, not killed). Exceeding the **memory limit** gets the container OOMKilled (exit 137) and restarted. Under node memory pressure, the kubelet evicts pods, starting with BestEffort and Burstable pods using more than their requests.

QoS: **Guaranteed** (requests = limits for all resources), **Burstable** (some requests/limits), **BestEffort** (none). Practical defaults for a Node.js API: set CPU and memory requests from measured usage, a memory limit with headroom (and `--max-old-space-size` below it), and often no CPU limit to avoid latency from throttling.
:::

### Liveness, readiness and startup probes: what does each do, and what mistakes do you see?

:::details Model answer
- **Readiness**: is the pod able to serve now? Failing removes it from Service endpoints without restarting it.
- **Liveness**: is the process stuck? Failing restarts the container.
- **Startup**: gives slow-booting apps time; liveness and readiness are disabled until it succeeds.

Mistakes: liveness checking dependencies (a database blip restarts every pod at once), liveness and readiness pointing at the same heavy endpoint, timeouts shorter than GC pauses, no startup probe for slow JVM or large Node apps so liveness kills them during boot, and readiness including optional dependencies like a cache, which turns a cache outage into a full outage.
:::

### How does a rolling update work, and how do you make deployments zero-downtime?

:::details Model answer
The Deployment controller creates a new ReplicaSet and shifts replicas according to `maxSurge` (extra pods allowed) and `maxUnavailable` (pods allowed to be down). New pods count as available only after readiness (plus `minReadySeconds`).

For zero downtime: correct readiness probes; graceful shutdown in the app (handle SIGTERM, stop accepting, drain in-flight requests); a `preStop` sleep of a few seconds because endpoint removal propagates asynchronously to kube-proxy and load balancers; `terminationGracePeriodSeconds` longer than your longest request; enough replicas and `maxUnavailable: 0` for small deployments; backwards-compatible database migrations (expand/contract) since old and new versions run side by side.
:::

### What are taints, tolerations, node affinity and topology spread constraints used for?

:::details Model answer
- **Taints** on nodes repel pods; **tolerations** on pods allow them onto tainted nodes. Used for dedicated node pools (GPU, databases) and system conditions (`node.kubernetes.io/not-ready`).
- **Node affinity** attracts pods to nodes with certain labels (required or preferred), e.g. arm64 or a specific instance family.
- **Pod affinity/anti-affinity** places pods near or away from other pods.
- **Topology spread constraints** distribute replicas evenly across zones or nodes with a `maxSkew`, the modern way to get HA spreading.

Tolerations alone do not attract pods; dedicated pools need taint + toleration + affinity together.
:::

### How does the Horizontal Pod Autoscaler work? What are its limitations?

:::details Model answer
The HPA controller periodically reads metrics (resource metrics from metrics-server, or custom/external metrics through an adapter such as Prometheus Adapter or KEDA) and computes `desired = ceil(current * currentMetric / target)`, within min/max and with stabilisation windows (slow scale-down by default). CPU utilisation is relative to **requests**, so missing requests break it.

Limitations: reacts after load arrives (pods need startup time; pair with headroom or scheduled scaling), CPU is a poor signal for I/O-bound Node.js services (prefer request rate, latency or queue depth via KEDA), it needs node capacity (Cluster Autoscaler/Karpenter), and it fights with anything else that sets `replicas` (omit it from manifests). VPA adjusts requests instead and should not be combined with HPA on the same resource metric.
:::

## Networking and traffic

### How does pod-to-pod networking work?

:::details Model answer
The Kubernetes network model requires every pod to have its own IP and to reach every other pod without NAT. The CNI plugin implements this: overlay networks (VXLAN/Geneve, e.g. Flannel, Calico in overlay mode), routed networks (BGP with Calico), or cloud-native IPs (AWS VPC CNI gives pods real VPC addresses). On the node, each pod has a veth pair into the host network namespace; routes or eBPF programs forward traffic. Services are a layer on top implemented by kube-proxy or eBPF (Cilium). NetworkPolicies are enforced by the CNI, if it supports them.
:::

### Ingress vs Gateway API: why is the ecosystem moving to Gateway API?

:::details Model answer
Ingress is a minimal API (host and path routing to Services, TLS) where everything else (rewrites, header matching, timeouts, canaries) lived in controller-specific annotations, so configurations were not portable, and one resource mixed infrastructure and application concerns. The popular community Ingress-NGINX controller has been retired (maintenance ended March 2026), accelerating migration.

Gateway API splits roles: `GatewayClass` (infrastructure provider), `Gateway` (listeners, ports, TLS, owned by the platform team), and routes (`HTTPRoute`, `GRPCRoute`, `TLSRoute`) owned by app teams, with explicit cross-namespace attachment and `ReferenceGrant`. It has typed features in the spec (header matching, weighted backends for canaries, redirects, rewrites, mirroring), rich status conditions, and conformance tests across implementations (Envoy Gateway, Istio, Cilium, NGINX Gateway Fabric, cloud controllers).
:::

### A Service is not reachable. Walk me through your debugging.

:::details Model answer
Follow the path: (1) DNS: `nslookup svc.ns` from a pod in the client's namespace. (2) Service exists with the expected port: `kubectl get svc -o wide`. (3) Endpoints: `kubectl get endpointslices -l kubernetes.io/service-name=svc`. Empty means selector mismatch or pods not ready; check `--show-labels` and readiness events. (4) Bypass the Service: curl a pod IP and container port directly. If that works, `targetPort` is wrong. If not, the app may listen on 127.0.0.1 or another port. (5) NetworkPolicies in both namespaces (egress of client, ingress of server). (6) For external traffic: Gateway/HTTPRoute status conditions, listener hostnames, TLS Secret, then the cloud load balancer and security groups.

I distinguish timeouts (dropped: policy, firewall) from fast connection refused (nothing listening).
:::

### What are NetworkPolicies and how would you roll them out safely?

:::details Model answer
NetworkPolicies select pods and allow ingress/egress by pod labels, namespace labels, IP blocks and ports. Once a pod is selected for a direction, everything not allowed is denied; policies are additive; enforcement depends on the CNI.

Rollout: start with visibility (CNI flow logs, Cilium Hubble, or simply mapping dependencies), then per namespace add allows for known flows and DNS, then a default deny for ingress, test, then default deny for egress (which breaks more things: DNS, external APIs, metadata endpoints). Template the baseline per namespace (Helm/Kyverno generate). Always test with real connections, and remember both sides need rules when both namespaces are locked down.
:::

## Storage and state

### Explain PV, PVC and StorageClass, and dynamic provisioning.

:::details Model answer
A **PersistentVolume** represents actual storage (an EBS volume, NFS share). A **PersistentVolumeClaim** is a request for storage by a workload (size, access mode, class). A **StorageClass** describes how to provision volumes dynamically (CSI driver, parameters like gp3 and IOPS, reclaim policy, binding mode). When a PVC references a class, the CSI provisioner creates a PV and binds it.

Key details: access modes (RWO, ROX, RWX, RWOP), `reclaimPolicy` (Delete vs Retain: decide before you lose data), `volumeBindingMode: WaitForFirstConsumer` so zonal volumes are created in the zone where the pod is scheduled, and volume expansion (`allowVolumeExpansion`).
:::

### Would you run Postgres in Kubernetes?

:::details Model answer
It depends on the team and requirements. Managed databases (RDS/Aurora, Cloud SQL) give backups, point-in-time recovery, Multi-AZ failover, patching and monitoring with little effort, which is usually the right default for a product team. Running databases in Kubernetes is reasonable with a mature operator (CloudNativePG, Crunchy PGO) that handles replication, failover, backups to object storage and upgrades, and with a team that understands storage, PDBs, anti-affinity across zones and restore drills. A hand-rolled single-replica StatefulSet is fine for dev and CI, not for production: every restart or node drain is downtime, and zonal volumes pin the pod.
:::

## Security

### How do authentication and authorization work in Kubernetes?

:::details Model answer
Kubernetes has no user database. Authenticators assert identities: client certificates (CN/O), OIDC tokens from an IdP, cloud IAM (EKS access entries mapping IAM principals), ServiceAccount tokens for workloads, webhook token authenticators. The result is a username and groups.

Authorization is usually RBAC: Roles/ClusterRoles define verbs on resources; RoleBindings/ClusterRoleBindings grant them to users, groups or ServiceAccounts. RBAC is additive with no deny. I test with `kubectl auth can-i ... --as`. Then admission controllers can still reject or modify requests (Pod Security Admission, ValidatingAdmissionPolicy, webhooks).
:::

### How would you secure a workload's pod spec?

:::details Model answer
Run as non-root with a numeric UID, `allowPrivilegeEscalation: false`, drop all capabilities, `seccompProfile: RuntimeDefault`, read-only root filesystem with emptyDirs for writable paths, no host namespaces or hostPath, a dedicated ServiceAccount with `automountServiceAccountToken: false` unless it needs the API, resource limits, and minimal, scanned, pinned images. Enforce it with Pod Security Admission `restricted` on the namespace so it is not optional, and add NetworkPolicies so a compromised pod cannot reach everything.
:::

### What are ServiceAccount tokens today, and how do pods get cloud credentials?

:::details Model answer
Since 1.24, pods get **bound, projected tokens** from the TokenRequest API: short-lived, audience-scoped, bound to the pod, rotated by the kubelet; long-lived token Secrets are no longer generated automatically. For cloud access you map a ServiceAccount to a cloud identity: on EKS, Pod Identity (association between namespace/SA and an IAM role, agent on the node) or IRSA (projected token with audience `sts.amazonaws.com`, trust policy on the cluster's OIDC provider). The AWS SDK picks up credentials automatically. Never use static access keys in Secrets or broad node roles.
:::

### What does a policy engine add beyond RBAC and Pod Security? Kyverno vs Gatekeeper vs ValidatingAdmissionPolicy?

:::details Model answer
RBAC controls who may call which API; Pod Security covers a fixed set of pod settings. Organisations need more: allowed registries, required labels and limits, no `:latest`, no public LoadBalancers, image signature verification, generating default resources per namespace.

**ValidatingAdmissionPolicy** (GA 1.30) runs CEL rules inside the API server: no webhook, no availability risk, ideal for simple validation. **Kyverno** is Kubernetes-native YAML (now also CEL-based policy types) with validate, mutate, generate, image verification and reports. **Gatekeeper** uses OPA/Rego, strong if Rego is already used elsewhere. For webhooks I always consider failure policy, timeouts, HA and excluding system namespaces so the policy engine cannot block its own recovery.
:::

## Packaging and delivery

### Helm vs Kustomize: how do you choose?

:::details Model answer
Helm templates plus values, with releases, revisions, rollback, hooks, tests and OCI distribution. It is the standard for distributing software to others and for installing third-party components. Kustomize patches plain YAML with overlays, generators and image overrides, no templating, built into kubectl; it shines for your own apps across a few environments. Many teams use both: upstream Helm charts for platform components, Kustomize or a simple in-house chart for services, sometimes Kustomize on top of Helm output. I value consistency in a team over the choice itself, and keep charts boring: stable selector labels, `toYaml` passthroughs, minimal conditionals.
:::

### What is GitOps, and what problems does it solve compared with CI running `helm upgrade`?

:::details Model answer
GitOps: the desired state is declarative and versioned in Git, and an agent in the cluster (Argo CD, Flux) pulls and continuously reconciles it. Benefits over push-based CI: no cluster credentials in CI, drift detection and self-heal (manual `kubectl edit` gets reverted or at least flagged), Git history as the audit log, rollbacks via `git revert`, easy multi-cluster with ApplicationSets, and promotion between environments as reviewed pull requests.

Challenges: secrets (External Secrets, Sealed Secrets, SOPS), fields owned by other controllers (HPA replicas: `ignoreDifferences` or omit them), ordering (sync waves), and image tag bumps (CI commits to the config repo or an image updater).
:::

### How would you structure CI/CD for a NestJS service deployed to EKS?

:::details Model answer
CI on every PR: lint, unit and integration tests (Testcontainers for Postgres/Redis), build a multi-arch image with BuildKit cache, scan it (Trivy), render manifests (`helm template`/`kustomize build`) and validate them (kubeconform, policy tests). On merge: push the image to ECR tagged with the commit SHA (and sign it with cosign), then update the image tag in the GitOps config repo for `dev` (commit or PR). Argo CD syncs dev; automated smoke tests run. Promotion to staging/prod is a PR changing the tag in that environment's overlay, with approvals. Rollback is a revert. Database migrations run as a pre-sync Job (Argo CD sync wave / Helm hook) with expand/contract migrations so old and new pods can coexist. No CI job holds cluster-admin credentials.
:::

## Operations and troubleshooting

### A pod is in CrashLoopBackOff. What do you do?

:::details Model answer
`kubectl describe pod` for Last State (reason, exit code) and events; `kubectl logs --previous` for the crashed instance's output. Then branch: exit 137 + OOMKilled → memory limit too low or leak; exit 1 with an error → configuration (missing env var, bad DATABASE_URL, failed migration) or a code bug; exit 0 → the process finished (wrong command, not running in the foreground); 127 → command not found; restarts with "Liveness probe failed" events → the probe is wrong, not the app. If the image has no shell, I use `kubectl debug --copy-to` with a shell command to reproduce startup. I never just delete the pod; the replacement crashes the same way and I lose the previous logs.
:::

### A pod has been Pending for 10 minutes. Possible causes?

:::details Model answer
The scheduler's events say why: insufficient CPU/memory for the **requests** (cluster full; check node autoscaler logs), node selector/affinity matching no nodes, taints without tolerations, topology spread `DoNotSchedule` constraints that cannot be satisfied, a PVC that is unbound or bound to a volume in another zone, too many pods per node (on EKS, IP limits with the VPC CNI), or a ResourceQuota (though quotas usually reject pod creation, showing up on the ReplicaSet). If there are no events at all, check whether the scheduler is running or whether a custom `schedulerName` is set.
:::

### How do you monitor a Kubernetes cluster and the applications on it?

:::details Model answer
Metrics with Prometheus (kube-prometheus-stack: Prometheus Operator, kube-state-metrics, node-exporter, Alertmanager, Grafana) or a managed equivalent (Amazon Managed Prometheus/Grafana, Datadog). Applications expose RED metrics (prom-client in Node.js) scraped via ServiceMonitors. Logs: structured JSON to stdout, collected by a DaemonSet (Fluent Bit, Alloy, OTel Collector) into Loki, OpenSearch or CloudWatch. Traces: OpenTelemetry SDK with auto-instrumentation, Collector, Tempo/Jaeger/X-Ray, with trace IDs in logs. Alerts on user-facing symptoms and SLO burn rates with runbooks, plus platform alerts (node not ready, PVC filling up, certificate expiry, crash loops). metrics-server separately for `kubectl top` and HPA.
:::

### What is a PodDisruptionBudget, and what problems can it cause?

:::details Model answer
A PDB limits **voluntary** disruptions (evictions from drains, node upgrades, Karpenter consolidation) so that at least `minAvailable` pods remain or at most `maxUnavailable` are down. It does not protect against involuntary failures (node crashes, OOM). Problems: a PDB that allows zero disruptions (single replica with `minAvailable: 1`, or `maxUnavailable: 0`) blocks drains forever and stalls cluster upgrades; PDBs counting only ready pods mean an already-unhealthy app cannot be drained. Best practice: at least two replicas spread across nodes or zones, `maxUnavailable: 1`, and readiness probes so replacements count.
:::

## Senior and architecture

### How do you upgrade a production cluster safely?

:::details Model answer
Read release notes and provider guides; detect deprecated API usage (`apiserver_requested_deprecated_apis`, pluto/kubent on Git and Helm releases) and fix it in source; check add-on compatibility (CNI, CoreDNS, CSI, LB controller, Gateway implementation, cert-manager, Argo CD, operators); upgrade staging first and run smoke tests; upgrade the control plane one minor version at a time; replace nodes (managed node group rolling update, blue/green node groups, or Karpenter drift), relying on PDBs, replica counts and graceful shutdown; then upgrade add-ons. Respect version skew: kubelets never newer than the API server and at most three minors older. Keep the cadence regular (every 4–6 months) to avoid forced or extended-support upgrades.
:::

### How would you design multi-tenancy for 10 product teams?

:::details Model answer
Separate clusters per environment (prod isolated, often separate AWS accounts), and within each cluster a namespace per team or per service, created from a template: RBAC binding the team's SSO group to a namespaced role, ResourceQuota and LimitRange, Pod Security `restricted`, default-deny NetworkPolicies plus shared allows (DNS, gateway, monitoring), and policy-engine rules (registries, labels, no public LoadBalancers). Platform components (Gateway, Argo CD, monitoring, External Secrets) are owned by a platform team. Argo CD AppProjects restrict which namespaces and repos each team can deploy to. For stronger isolation needs (untrusted code, compliance), dedicated node pools with taints, separate clusters, or virtual clusters. Cost allocation by namespace labels.
:::

### How do you think about cost on Kubernetes?

:::details Model answer
Cost follows requests, because nodes are packed and autoscaled by requests. So: right-size requests from real usage (VPA recommendations, Prometheus data), consolidate with Karpenter, use Spot for interruption-tolerant workloads with PDBs and diversification, Graviton (arm64) with multi-arch images, scale non-prod down off-hours, avoid one load balancer per service (shared Gateway), watch cross-AZ traffic and NAT Gateway charges (VPC endpoints for ECR/S3), and control observability volume (log levels, metric cardinality). Make cost visible per team with OpenCost/Kubecost and labels so owners act on it.
:::

### What is the operator pattern, and when would you build one?

:::details Model answer
An operator is a custom resource plus a controller that encodes operational knowledge: the CR declares desired state (`kind: PostgresCluster`), and the controller reconciles it level-triggered and idempotently, creating and updating child objects with owner references, using finalizers for external cleanup, and reporting status conditions. Examples: CloudNativePG, cert-manager, Prometheus Operator, Argo CD.

I would build one only when there is real operational logic to automate across many instances (provisioning tenants with cloud resources, failover, backups, coordinated upgrades) and no existing operator fits, using Kubebuilder/controller-runtime. For templating YAML, Helm or Kustomize is enough; an operator is software with its own upgrades, RBAC and failure modes.
:::

### Tell me about the trade-offs of EKS networking with the VPC CNI.

:::details Model answer
Pros: pods get native VPC IPs, so they are directly reachable from other VPC resources and on-prem networks, with no overlay overhead, and can use security groups for pods; it integrates with ALB/NLB `ip` targets. Cons: IP address consumption (each pod uses a subnet IP, and instance types have ENI/IP limits capping pods per node). Mitigations: large subnets or secondary CIDRs (100.64.0.0/10) with custom networking, prefix delegation for higher density, IPv6 clusters. Network policies can be enforced by the VPC CNI itself or by Calico/Cilium. Alternatives like Cilium in overlay or ENI mode trade some native integration for features (eBPF dataplane, L7 policies, Hubble visibility).
:::

### Design question: how would you make shipit (API, Postgres, Redis) highly available on EKS?

:::details Model answer
Cluster across three AZs with Karpenter or managed node groups in each. API: at least three replicas with topology spread across zones, PDB `maxUnavailable: 1`, HPA on CPU or request rate, correct probes (readiness without the optional cache), graceful shutdown with preStop delay, and resource requests sized from data. Edge: Gateway API via the AWS Load Balancer Controller or Envoy Gateway behind an NLB, TLS from ACM or cert-manager, WAF if public. Data: Amazon RDS/Aurora Postgres Multi-AZ (or CloudNativePG with replicas per zone), ElastiCache Redis with replication; the API degrades gracefully if Redis is down. Identity via Pod Identity, secrets via External Secrets from Secrets Manager. Delivery through Argo CD with progressive rollout (Argo Rollouts canary on error rate). Observability: RED dashboards, SLO-based alerts, traces. Then validate with a game day: kill pods, drain nodes, fail over the database, take Redis away.
:::
