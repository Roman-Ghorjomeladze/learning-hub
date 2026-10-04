Everything so far ran on kind, where you are the cluster administrator, nothing costs money, and losing the cluster is a `kind delete` away. Production adds a cloud provider, other teams, upgrades every few months, bills, auditors and 3 a.m. pages. This module covers the decisions you will face there, then shows how Kubernetes itself is extended with custom resources and operators, and ends with the certification path.

## Managed Kubernetes

Running a control plane yourself means operating etcd (backups, quorum, defragmentation), API server high availability, certificates and upgrades. Almost everyone in the cloud uses a managed service instead:

```text
                    ┌──────────── provider manages ────────────┐
                    │ API servers (multi-AZ), etcd, scheduler, │
                    │ controller-manager, control-plane        │
                    │ upgrades, cert rotation, SLA             │
                    └───────────────────┬──────────────────────┘
                                        │
   ┌──────────────────────── you still own ─────────────────────────────┐
   │ nodes (unless serverless mode), node OS patching, add-on versions, │
   │ networking design (VPC, subnets, IPs), IAM and RBAC, workloads,    │
   │ upgrades (you trigger them), observability, backups, cost, security│
   └────────────────────────────────────────────────────────────────────┘
```

| | Amazon EKS | Google GKE | Azure AKS |
| --- | --- | --- | --- |
| Control plane | Managed, hourly fee per cluster | Managed (one free zonal/Autopilot cluster per billing account) | Managed (free tier, paid tier with SLA) |
| Hands-off mode | EKS Auto Mode (AWS manages nodes, core add-ons, LB and storage controllers) | GKE Autopilot | AKS Automatic |
| Pod networking | VPC CNI: pods get VPC IPs | VPC-native (alias IPs), Dataplane V2 (Cilium) | Azure CNI (overlay or VNet IPs) |
| Workload identity | Pod Identity / IRSA | Workload Identity Federation | Microsoft Entra Workload ID |

GKE is generally considered the most polished and opinionated; EKS is the most common in AWS-centric companies (and likely where you will work, given your AWS background); AKS integrates with Entra ID. The Kubernetes you learned is the same on all three.

## EKS specifics

```text
                          AWS account / VPC (3 AZs)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  EKS control plane (AWS-owned VPC) ◄── kubectl via IAM (access entries)  │
 │            │ ENIs in your subnets                                        │
 │  private subnets                                public subnets           │
 │  ┌──────────────────────────────┐   ┌──────────────────────────────────┐ │
 │  │ nodes: managed node groups / │   │ ALB / NLB created by AWS Load    │ │
 │  │ Karpenter / Fargate          │◄──│ Balancer Controller              │ │
 │  │ pods get VPC IPs (VPC CNI)   │   └──────────────────────────────────┘ │
 │  │ EBS volumes via EBS CSI      │                                        │
 │  │ IAM per pod via Pod Identity │──► S3, SQS, RDS, Secrets Manager ...   │
 │  └──────────────────────────────┘                                        │
 └──────────────────────────────────────────────────────────────────────────┘
```

### Networking: the VPC CNI

The Amazon VPC CNI gives every pod a real IP address from your VPC subnets (secondary IPs on the node's ENIs). Pods are directly routable from RDS, other VPCs and on-premises networks, and security groups can apply to pods. The catch is **IP consumption**: a /24 subnet has ~250 addresses shared by nodes and pods, and each instance type has a limit on ENIs and IPs, which caps pods per node. Mitigations: large subnets (or a secondary CIDR such as 100.64.0.0/16 with custom networking), **prefix delegation** (assigns /28 prefixes instead of single IPs, raising pod density), and IPv6 clusters. The VPC CNI can also enforce NetworkPolicies once you enable that option.

### Compute options

| Option | What it is | Good for | Watch out |
| --- | --- | --- | --- |
| Managed node groups | EC2 Auto Scaling groups AWS creates and upgrades for you | Default, predictable fleets | One instance type family per group; scaling via Cluster Autoscaler |
| Self-managed nodes | Your own ASGs/AMIs | Special AMIs, full control | You patch and upgrade everything |
| Fargate | One pod per micro-VM, no nodes to manage | Small, spiky or isolated workloads | No DaemonSets, no privileged pods, no EBS volumes, per-pod pricing, slower start |
| Karpenter | Open-source autoscaler that launches right-sized instances directly for pending pods | Mixed workloads, Spot, cost efficiency, fast scaling | You define NodePools/EC2NodeClasses; consolidation moves pods (PDBs matter) |
| EKS Auto Mode | AWS runs Karpenter-based compute plus core add-ons for you | Teams that want minimal ops | Less control over node configuration, extra fee per node |

Karpenter has largely replaced the Cluster Autoscaler on EKS: instead of scaling predefined groups, it looks at pending pods' requests, affinities and topology constraints and buys exactly the capacity needed (including Spot), then **consolidates** by replacing underused nodes with cheaper ones.

:::mac Your arm64 laptop and Graviton nodes
Images you build on an Apple Silicon Mac are `linux/arm64` by default. That is great for Graviton (arm64) EKS nodes, which are typically cheaper per unit of performance, but an arm64-only image fails on amd64 nodes with `exec format error`. Build multi-arch images in CI with `docker buildx build --platform linux/amd64,linux/arm64 --push ...`, and if you mix architectures, let Karpenter pick either by keeping images multi-arch.
:::

### Identity and access

- **Humans and CI → cluster**: IAM principals are mapped to Kubernetes permissions through **access entries** (EKS API), with AWS-managed access policies (`AmazonEKSClusterAdminPolicy`, `AmazonEKSAdminPolicy`, `AmazonEKSViewPolicy`...) or Kubernetes groups you bind with RBAC. The older `aws-auth` ConfigMap still works but is deprecated: one typo in it could lock everyone out.
- **Pods → AWS**: EKS Pod Identity (preferred) or IRSA, as covered in module 11.
- **Nodes → AWS**: the node IAM role (pull from ECR, attach volumes via CSI). Keep it minimal; never use it for application permissions.

### Load balancing and storage

The **AWS Load Balancer Controller** watches Kubernetes objects and provisions AWS load balancers: a `Service` of type `LoadBalancer` becomes an NLB, an `Ingress` becomes an ALB, and recent versions also implement Gateway API resources. Use `target-type: ip` so the load balancer sends traffic straight to pod IPs. Each LoadBalancer Service costs money, so one shared Gateway/ALB in front of many routes is the norm.

Storage uses the **EBS CSI driver** (add-on) with a `gp3` StorageClass. EBS volumes live in one Availability Zone, so a pod with an EBS-backed PVC can only be scheduled in that AZ; use `volumeBindingMode: WaitForFirstConsumer` (module 08) and run stateful systems with one replica per AZ. For shared filesystems there is the EFS CSI driver.

:::tip Provisioning EKS
Create clusters with infrastructure as code: Terraform (the `terraform-aws-modules/eks` module is the de facto standard; see the Terraform track) or `eksctl` for quick experiments. Never click a production cluster together in the console. Install add-ons (VPC CNI, CoreDNS, kube-proxy, EBS CSI, Pod Identity agent) as **EKS managed add-ons** so their versions are tracked alongside the cluster version.
:::

## Upgrades and version skew

Kubernetes ships three minor releases per year, and each is maintained upstream for roughly 14 months. Managed providers follow a similar window (EKS: about 14 months of standard support, then paid extended support for about 12 more months). In practice you upgrade **every 4–6 months** or you fall behind and pay for it.

The **version skew policy** says which components may differ during an upgrade:

| Component | Allowed skew relative to kube-apiserver |
| --- | --- |
| kube-apiserver (HA instances) | Within 1 minor of each other |
| controller-manager, scheduler | Same or 1 minor older, never newer |
| kubelet, kube-proxy | Same or up to 3 minors older, never newer |
| kubectl | 1 minor older or newer |

Hence the order: **control plane first, one minor version at a time, then nodes**. You cannot jump from 1.31 to 1.34 on the control plane; you go 1.32, 1.33, 1.34. Nodes may lag, which lets you upgrade node groups afterwards.

:::try Read your cluster's versions
Run `kubectl version` (client and server), then `kubectl get nodes -o custom-columns=NAME:.metadata.name,KUBELET:.status.nodeInfo.kubeletVersion,RUNTIME:.status.nodeInfo.containerRuntimeVersion`. On kind every node matches the control plane. On a real cluster mid-upgrade you would see older kubelets, which is allowed as long as they are within the skew window.
:::

A safe upgrade runbook:

1. **Read the release notes and the provider's upgrade notes.** Look for removed APIs and changed defaults.
2. **Find deprecated API usage** before it breaks: the API server exposes `apiserver_requested_deprecated_apis` (`kubectl get --raw /metrics | grep apiserver_requested_deprecated_apis`), and tools like `pluto` or `kubent` scan manifests and Helm releases. Fix manifests in Git, not in the cluster.
3. **Check add-on and controller compatibility**: CNI, CoreDNS, CSI drivers, the Load Balancer Controller, Argo CD, cert-manager, your Gateway implementation and operators each support a range of Kubernetes versions.
4. **Upgrade a staging cluster first** and run your smoke tests.
5. **Upgrade the control plane** (managed: one API call).
6. **Upgrade nodes** by replacement, not in place: managed node group rolling update, a new (blue/green) node group, or Karpenter drift replacing nodes with the new AMI. Each node is cordoned and drained, so **PodDisruptionBudgets** and enough replicas decide whether this is invisible or an outage.
7. **Upgrade add-ons** to the versions recommended for the new minor.

```bash
kubectl cordon ip-10-0-1-23.eu-central-1.compute.internal
kubectl drain ip-10-0-1-23.eu-central-1.compute.internal --ignore-daemonsets --delete-emptydir-data --timeout=10m
# ...replace/upgrade the node...
kubectl uncordon <node>
```

:::warning PDBs that block every drain
A PDB with `minAvailable: 1` on a Deployment with **one** replica (or `maxUnavailable: 0`) can never be satisfied during a drain: eviction is refused forever and your node upgrade hangs. Run at least two replicas spread across nodes for anything with a PDB, and prefer `maxUnavailable: 1`. Lab 4 reproduces this.
:::

:::info Ecosystem churn is part of upgrades
Not only Kubernetes APIs change. The community Ingress-NGINX controller was retired (maintenance ended in March 2026), PodSecurityPolicy was removed in 1.25, dockershim in 1.24, and in-tree cloud volume plugins moved to CSI drivers. Budget time each quarter for platform component lifecycle, not just the cluster version.
:::

## Multi-tenancy and namespace strategy

"Multi-tenancy" ranges from several teams sharing a cluster (soft tenancy: they trust each other somewhat) to running untrusted customer code (hard tenancy: strong isolation needed, often separate clusters or sandboxed runtimes like gVisor/Kata).

Common patterns:

| Pattern | Pros | Cons |
| --- | --- | --- |
| Cluster per environment (dev, staging, prod), namespaces per team/app inside | Prod isolated from experiments; standard practice | More clusters to upgrade |
| Namespace per app per environment in one cluster | Cheap | Blast radius: a cluster-wide incident hits all envs |
| Cluster per team | Strong isolation, team autonomy | Expensive, duplicated platform work |
| Virtual clusters (vCluster) or tenancy operators (Capsule) | Tenants get their own API "view" | Extra component to operate |

At minimum, **production has its own cluster** (often its own AWS account). Within a shared cluster, every tenant namespace gets the same kit, ideally created from a template (Helm chart, Kustomize component, or Kyverno generate policy):

```text
namespace "team-payments"
  ├─ labels: team=payments, PSA enforce=restricted
  ├─ ResourceQuota       caps total requests/limits, pods, Services of type LoadBalancer, PVC storage
  ├─ LimitRange          default requests/limits for containers that omit them, max sizes
  ├─ RoleBinding         group payments-devs → edit (or a custom role) in this namespace only
  ├─ NetworkPolicy       default deny + allow DNS + allow from the gateway namespace
  └─ (policy engine)     registries, labels, no :latest
```

```yaml
apiVersion: v1
kind: ResourceQuota
metadata: { name: team-quota, namespace: team-payments }
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.memory: 32Gi
    pods: "60"
    services.loadbalancers: "0"
    requests.storage: 200Gi
---
apiVersion: v1
kind: LimitRange
metadata: { name: defaults, namespace: team-payments }
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 128Mi }
      default: { memory: 256Mi }          # default limit
      max: { memory: 4Gi }
```

Shared-cluster caveats: cluster-scoped resources (CRDs, ClusterRoles, StorageClasses, webhooks) cannot be delegated per namespace, so a platform team owns them; noisy neighbours are limited by requests/quotas but not eliminated (shared kernel, disk I/O, network); and node-level isolation for sensitive workloads uses dedicated node pools with taints and tolerations.

## Cost basics

Kubernetes cost is mostly **nodes**, and nodes are sized by **requests**, not by actual usage. A pod requesting 2 CPU and using 0.1 still blocks 2 CPU of a node you pay for.

Main levers:

- **Right-size requests** from real usage (Prometheus data, VPA in recommendation mode, Goldilocks). Over-requesting is the most common waste.
- **Bin-pack and consolidate**: Karpenter consolidation or Cluster Autoscaler scale-down; avoid anti-affinity rules that force one pod per node unless needed.
- **Spot instances** for stateless, interruption-tolerant workloads (with PDBs and multiple replicas), on-demand or Savings Plans for the baseline.
- **Scale down non-production** at night and weekends; scale dev to zero.
- **Fewer load balancers**: one Gateway with many routes instead of a LoadBalancer Service per app.
- **Network costs**: cross-AZ traffic and NAT Gateway data processing add up silently (chatty services across AZs, pulling images through NAT; use VPC endpoints for ECR/S3).
- **Observability costs**: log and metric volume can rival compute. Drop debug logs in prod, limit high-cardinality labels.
- **Visibility**: OpenCost/Kubecost allocate cost per namespace/label so teams see what they spend. Label everything with `team` and `app`.

## Backups and disaster recovery

What needs protecting, and how:

| What | How |
| --- | --- |
| Manifests, Helm values, policies | Git (GitOps): the cluster can be rebuilt from the repo. This is your primary "backup" of configuration. |
| Cluster state not in Git (Secrets created by operators, CRs created at runtime) | Velero backups of API objects to object storage |
| Persistent volumes | CSI volume snapshots (via Velero or a snapshot schedule), or Velero file-system backup (Kopia) |
| Databases | Database-native backups: RDS automated backups and snapshots, or an operator such as CloudNativePG with WAL archiving to S3. Volume snapshots of a running database are crash-consistent at best. |
| etcd | Managed clusters: the provider's job. Self-managed: regular `etcdctl snapshot save`. |

```bash
velero install --provider aws --bucket shipit-velero --backup-location-config region=eu-central-1 ...
velero backup create shipit-nightly --include-namespaces shipit --snapshot-volumes
velero schedule create shipit-daily --schedule "0 2 * * *" --include-namespaces shipit --ttl 720h
velero restore create --from-backup shipit-nightly
```

A backup you have never restored is a hope, not a backup. Schedule restore drills into a scratch cluster and measure how long they take (that is your real RTO).

## Extending Kubernetes: CRDs, controllers and operators

You have used many extensions already: Gateway API resources, Argo CD `Application`, Prometheus `ServiceMonitor`, Kyverno policies. They all follow one pattern:

```text
  CustomResourceDefinition            custom resources                   controller (a pod)
  "the API now has kind StaticSite"   kind: StaticSite                   watch StaticSites + owned objects
  (schema, versions, scope)           spec: { message, replicas }  ──►   reconcile: desired (spec) vs actual
                                      status: { readyReplicas }    ◄──   create/update Deployments, Services
                                                                         write status, conditions, events
```

A **CRD** teaches the API server a new resource type: it gets REST endpoints, is stored in etcd, works with `kubectl`, RBAC, `kubectl explain`, watch, and admission. A CRD alone does nothing; a **controller** gives it behaviour. An **operator** is a controller that encodes operational knowledge for a specific piece of software: CloudNativePG knows how to fail over Postgres, cert-manager knows how to renew certificates, Prometheus Operator turns `ServiceMonitor` objects into scrape configs.

### Anatomy of a CRD

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: staticsites.web.shipit.dev        # <plural>.<group>
spec:
  group: web.shipit.dev
  scope: Namespaced
  names:
    kind: StaticSite
    plural: staticsites
    singular: staticsite
    shortNames: ["site"]
  versions:
    - name: v1alpha1
      served: true
      storage: true                        # exactly one version is the storage version
      subresources:
        status: {}                         # spec and status updated via separate endpoints
      additionalPrinterColumns:
        - { name: Replicas, type: integer, jsonPath: .spec.replicas }
        - { name: Ready, type: integer, jsonPath: .status.readyReplicas }
        - { name: Age, type: date, jsonPath: .metadata.creationTimestamp }
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: ["message"]
              properties:
                message: { type: string, maxLength: 200 }
                replicas: { type: integer, minimum: 1, maximum: 5, default: 1 }
              x-kubernetes-validations:
                - rule: "!self.message.contains('password')"
                  message: "do not put secrets in a StaticSite"
            status:
              type: object
              properties:
                readyReplicas: { type: integer }
```

Key ideas: the schema is **structural** (every field typed), and the API server validates, defaults and prunes unknown fields for you; CEL rules (`x-kubernetes-validations`) express cross-field checks without a webhook; the **status subresource** separates "what the user wants" (spec, written by users) from "what the controller observed" (status, written by the controller).

### How controllers work

A controller runs a **reconcile loop** that is:

- **Level-triggered, not edge-triggered**: it does not ask "what event happened?" but "given the current spec, what should exist, and what exists?" Missed events do not matter because the next reconcile fixes everything.
- **Idempotent**: running reconcile ten times has the same effect as once (this is why `kubectl apply`-style create-or-update is the core operation).
- **Watch-driven with a resync**: it watches its custom resources and the objects it creates (via informers and a local cache) and also re-reconciles periodically.
- **Owner-aware**: created objects carry `ownerReferences` to the custom resource, so the garbage collector deletes them when the CR is deleted. **Finalizers** are used when cleanup involves things outside the cluster (DNS records, S3 buckets).
- **Status-reporting**: writes `status.conditions` (e.g. `Ready=True`, `reason`, `message`, `observedGeneration`) and events so `kubectl describe` explains what is going on.

```text
          ┌──────── watch events (add/update/delete) ────────┐
          ▼                                                  │
   work queue (keys: ns/name)  ──►  reconcile(ns/name):       │
                                      get CR (from cache)     │
                                      compute desired objects │
                                      create/update/delete ───┘ (changes generate new events)
                                      update status
                                      return / requeue after N seconds
```

Tools: **Kubebuilder** (Go, controller-runtime; the upstream standard), **Operator SDK** (builds on Kubebuilder, adds Helm- and Ansible-based operators and OLM packaging), plus frameworks in other languages: kopf (Python), Java Operator SDK, and `@kubernetes/client-node` for TypeScript if you want to stay in your ecosystem. For a real operator, start with Kubebuilder's book; Lab 3 builds a toy controller in bash so you see the moving parts without any framework.

:::deep When not to write an operator
CRDs and operators are powerful but they are software you must maintain, upgrade (CRD version conversions, webhooks), secure (they often have broad RBAC) and monitor. Before writing one, check whether a Helm chart, a Kustomize component, a Kyverno generate policy, or an existing operator does the job. Write an operator when you have genuine **operational logic** to automate (failover, backups, scaling decisions, multi-step upgrades) that is repeated across many instances. "Template these five YAML files" is not that.
:::

:::try Explore installed CRDs
On any cluster with Argo CD or kube-prometheus-stack installed, run `kubectl get crd`, pick one, and run `kubectl explain <plural>.spec` (for example `kubectl explain applications.spec.syncPolicy`). Then `kubectl get crd <name> -o jsonpath='{.spec.versions[*].name}'` to see which versions it serves. Everything you can do with built-in resources works on these too.
:::

## Production readiness checklist

Use this as a review list for every service and cluster.

**Workload**

- [ ] Image pinned (tag + ideally digest), scanned, from an approved registry; multi-arch if you run arm64 (Graviton) nodes.
- [ ] Requests set from measured usage; memory limit set; CPU limit only if you understand throttling.
- [ ] Liveness (process alive), readiness (can serve), startup probe for slow boots; liveness never checks dependencies.
- [ ] Graceful shutdown: handles SIGTERM, `terminationGracePeriodSeconds` long enough, `preStop` sleep of a few seconds so endpoints are removed before the process stops accepting.
- [ ] At least 2 replicas (3 for critical), spread across zones/nodes (`topologySpreadConstraints`), PDB with `maxUnavailable: 1`.
- [ ] HPA (or KEDA for queue-driven workers) with sensible min/max.
- [ ] securityContext restricted-compliant, read-only root FS, dedicated ServiceAccount without token unless needed.
- [ ] Config in ConfigMaps, secrets from an external store, no secrets in images or Git.
- [ ] NetworkPolicies: default deny plus explicit allows.
- [ ] Structured logs to stdout, metrics endpoint, traces; dashboards and alerts on RED metrics; runbooks.

**Cluster and platform**

- [ ] Clusters and add-ons defined as code (Terraform + GitOps); prod separate from non-prod.
- [ ] Upgrade cadence planned; deprecated API checks in CI.
- [ ] Node autoscaling (Karpenter/Cluster Autoscaler); multiple AZs.
- [ ] Access via SSO/IAM, least-privilege RBAC, audit logs shipped and retained.
- [ ] Pod Security Admission and a policy engine enforcing org rules.
- [ ] Backups: Git for config, database-native backups, Velero for the rest; restore drills scheduled.
- [ ] Cost visibility per team; requests reviewed regularly.
- [ ] Incident process: on-call, alert routing, status page, post-mortems.

## The certification path

The Linux Foundation / CNCF Kubernetes certifications are **hands-on**: you solve tasks on real clusters in a browser-based remote desktop, under time pressure, with only the official docs allowed. They are respected in hiring precisely because they cannot be passed by memorising answers.

| Exam | Focus | Who it suits |
| --- | --- | --- |
| **KCNA / KCSA** | Multiple-choice associate exams (cloud native basics / security basics) | Optional; skip them with your experience |
| **CKAD** (Application Developer) | Designing, building, deploying and configuring apps: pods, Deployments, Jobs/CronJobs, probes, ConfigMaps/Secrets, resources, Services, NetworkPolicies, Helm/Kustomize basics, troubleshooting apps | Backend engineers; the natural first one for you |
| **CKA** (Administrator) | Cluster architecture, installation and upgrades with kubeadm, etcd backup/restore, RBAC, scheduling, storage, networking (Services, Gateway API, CoreDNS, CNI), and a large troubleshooting share (nodes, control plane, networking) | Anyone running clusters; most valued by employers for platform/DevOps roles |
| **CKS** (Security Specialist) | Cluster setup and hardening, system hardening, minimising microservice vulnerabilities (PSA, securityContext, secrets, sandboxing), supply chain (image scanning, signing, admission), runtime security and audit logging (Falco) | After CKA (a passed CKA is a prerequisite) |

Format facts (check the official FAQ before booking, they change): each exam is 2 hours, remotely proctored, roughly 15–20 performance-based tasks; passing score is 66% (CKS 67%); certifications are valid for 2 years; registration includes one free retake and two sessions of the killer.sh simulator, which is harder than the real exam on purpose. Curricula are published in the `cncf/curriculum` GitHub repository and track recent Kubernetes versions; the CKA was updated in 2025 to include Helm, Kustomize, Gateway API and CRDs.

How to prepare:

1. **Be fast with imperative kubectl.** Generate YAML instead of typing it: `kubectl create deployment web --image=nginx --replicas=3 --dry-run=client -o yaml > web.yaml`, `kubectl run`, `kubectl expose`, `kubectl create configmap/secret/role/rolebinding/job/cronjob ... --dry-run=client -o yaml`.
2. **Know `kubectl explain` and the docs layout.** `kubectl explain pod.spec.containers.livenessProbe` is faster than searching. Bookmark nothing (you cannot), but know where pages live on kubernetes.io.
3. **Set up your shell in the first minute**: `alias k=kubectl`, `export do="--dry-run=client -o yaml"`, and check that completion works. Use `vim` basics confidently (`:set paste`, indentation).
4. **Always switch context** at the start of each task (the exam gives you the `kubectl config use-context` command per question). Doing a task on the wrong cluster scores zero.
5. **Triage by points and time.** Skip long tasks, come back later. Partial credit exists per task step.
6. **Practise on kind and the simulator** until each task type takes minutes: for CKA especially kubeadm upgrades, etcd snapshot/restore, broken kubelet and control-plane troubleshooting, which kind does not cover well. Use VMs (Multipass, Lima) with kubeadm for those.

The labs in this track (especially the break & fix ones) map closely to CKAD and much of CKA. A realistic plan for you: CKAD in 3–4 weeks of focused practice, then CKA, then CKS if security interests you.
