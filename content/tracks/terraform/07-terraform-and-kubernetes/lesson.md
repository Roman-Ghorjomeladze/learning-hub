You already know two declarative systems: Terraform (desired state in HCL, reconciled when you run `apply`) and Kubernetes (desired state in YAML, reconciled continuously by controllers). This module connects them. Terraform is excellent at creating clusters and the "platform" around them; it is a mediocre tool for shipping application releases ten times a day. Knowing where to draw that line is what separates a working setup from a painful one, and it is a favourite senior interview topic.

Everything runs locally on kind, so it is free. EKS appears at the end as a reading exercise with an optional, clearly-priced lab.

## The mental model: three layers, three lifecycles

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 3: Applications        shipit-api, workers, cron jobs         │  changes: many times a day
│   owner: product teams       tool: Argo CD / Flux (GitOps), Helm     │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2: Platform add-ons    gateway controller, cert-manager,       │  changes: weekly / monthly
│   owner: platform team       external-dns, metrics, Argo CD itself   │
│                              tool: Terraform (helm provider) or GitOps│
├─────────────────────────────────────────────────────────────────────┤
│ Layer 1: Cluster + cloud     VPC, EKS/kind, node groups, IAM, DNS    │  changes: rarely
│   owner: platform team       tool: Terraform                          │
└─────────────────────────────────────────────────────────────────────┘
```

Each layer changes at a different speed and is owned by different people. Putting all three in one Terraform state means a typo in an app's replica count requires a plan that also touches your cluster. Worse, as you will see, it often does not even work.

## Providers involved

| Provider | Source | What it manages |
| --- | --- | --- |
| kind | `tehcyx/kind` | Local kind clusters (Docker containers acting as nodes) |
| kubernetes | `hashicorp/kubernetes` | Any Kubernetes object: typed `*_v1` resources and `kubernetes_manifest` |
| helm | `hashicorp/helm` | Helm releases (`helm install/upgrade/uninstall` under the hood) |
| aws + eks module | `hashicorp/aws`, `terraform-aws-modules/eks/aws` | Managed clusters on AWS |

`tehcyx/kind` is a community provider, not a HashiCorp one. It is actively maintained and widely used for local labs, but check its GitHub releases before depending on it. It creates and deletes clusters; it **does not modify** an existing cluster, so any change to the cluster definition means destroy-and-recreate.

## Provisioning a kind cluster

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.11"
    }
  }
}

provider "kind" {}

variable "cluster_name" {
  type    = string
  default = "tf-lab"
}

variable "http_host_port" {
  type    = number
  default = 8080
}

resource "kind_cluster" "this" {
  name            = var.cluster_name
  wait_for_ready  = true
  kubeconfig_path = pathexpand("~/.kube/kind-${var.cluster_name}")

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"

      # Host port 8080 -> node port 30080, where the gateway will listen
      extra_port_mappings {
        container_port = 30080
        host_port      = var.http_host_port
      }
    }
  }
}

output "endpoint" {
  value = kind_cluster.this.endpoint
}

output "cluster_ca_certificate" {
  value = kind_cluster.this.cluster_ca_certificate
}

output "client_certificate" {
  value     = kind_cluster.this.client_certificate
  sensitive = true
}

output "client_key" {
  value     = kind_cluster.this.client_key
  sensitive = true
}

output "kubeconfig_path" {
  value = kind_cluster.this.kubeconfig_path
}
```

Writing the kubeconfig to its own file (`kubeconfig_path`) keeps your main `~/.kube/config` untouched. Use it with `export KUBECONFIG=~/.kube/kind-tf-lab` or `kubectl --kubeconfig ...`.

:::mac kind on Apple Silicon
kind runs each node as a container in your Docker VM (Docker Desktop, OrbStack or Colima). The node image `kindest/node` is multi-arch, so you get native arm64 nodes. Give the Docker VM at least 4 CPUs and 6–8 GB of RAM for the labs in this module, especially when Argo CD is installed. The kind provider uses the same Docker socket as the CLI; see module 01 for `DOCKER_HOST` tips if you use Colima.
:::

:::tip Pin the Kubernetes version when it matters
Without `node_image`, the provider uses the default node image of the kind version it embeds. For reproducible clusters, set `node_image = "kindest/node:v1.xx.y"` using an image listed in the release notes of the kind version you use (kind publishes the exact digests per release).
:::

## Configuring the kubernetes and helm providers

Both providers need to know how to reach the API server. You have three options:

| Option | Example | When |
| --- | --- | --- |
| kubeconfig file + context | `config_path = "~/.kube/config"`, `config_context = "kind-tf-lab"` | Quick local work |
| Explicit credentials from outputs | `host`, `client_certificate`, `client_key`, `cluster_ca_certificate` | Stacks that consume another stack's cluster |
| `exec` plugin | `exec { command = "aws", args = ["eks", "get-token", ...] }` | Cloud clusters with short-lived tokens (EKS, GKE, AKS) |

A stack that deploys **into** the cluster typically reads the cluster stack's outputs through `terraform_remote_state` (or a data source like `aws_eks_cluster`):

```hcl
data "terraform_remote_state" "cluster" {
  backend = "local"
  config = {
    path = "../cluster/terraform.tfstate"
  }
}

locals {
  k8s = data.terraform_remote_state.cluster.outputs
}

provider "kubernetes" {
  host                   = local.k8s.endpoint
  cluster_ca_certificate = local.k8s.cluster_ca_certificate
  client_certificate     = local.k8s.client_certificate
  client_key             = local.k8s.client_key
}
```

### Helm provider v3: the syntax changed

Helm provider 3.0 (2025) moved to the Terraform Plugin Framework, which turned several **blocks** into **nested attributes**. Most blog posts and Stack Overflow answers still show v2 syntax, and with `~> 3.0` they fail with errors like `Blocks of type "kubernetes" are not expected here`.

```hcl
# helm provider v2 (old)                 # helm provider v3 (current)
provider "helm" {                         provider "helm" {
  kubernetes {                              kubernetes = {
    host = local.k8s.endpoint                 host                   = local.k8s.endpoint
    # ...                                     cluster_ca_certificate = local.k8s.cluster_ca_certificate
  }                                           client_certificate     = local.k8s.client_certificate
}                                             client_key             = local.k8s.client_key
                                            }
                                          }
```

Inside `helm_release`, the repeated `set {}` blocks became a list of objects:

```hcl
# v2 (old)
set {
  name  = "service.type"
  value = "NodePort"
}

# v3 (current)
set = [
  { name = "service.spec.type", value = "NodePort" },
  { name = "ports.web.nodePort", value = "30080" },
]
```

The same applies to `set_list`, `set_sensitive`, `registry` (now `registries = [...]`), `experiments = { ... }` and the `exec` configuration inside `kubernetes = { ... }`. If you see `set {` in a config pinned to helm `~> 3.0`, it is a v2 leftover.

:::tip Prefer `values` over many `set` entries
`values = [yamlencode({ ... })]` lets you write chart values as an HCL object, gets type checking for free, and keeps the diff readable. Use `set_sensitive` only for secrets you do not want shown in plan output (they still land in state).
:::

## Deploying objects with the kubernetes provider

The kubernetes provider has two styles.

**Typed resources** (`kubernetes_namespace_v1`, `kubernetes_deployment_v1`, `kubernetes_service_v1`, ...) mirror the API in HCL blocks. Provider v3 deprecated the unversioned names (`kubernetes_deployment` → `kubernetes_deployment_v1`), so always use the `_v1` forms.

```hcl
resource "kubernetes_namespace_v1" "demo" {
  metadata {
    name = "demo"
  }
}

resource "kubernetes_deployment_v1" "whoami" {
  metadata {
    name      = "whoami"
    namespace = kubernetes_namespace_v1.demo.metadata[0].name
    labels    = { app = "whoami" }
  }

  spec {
    replicas = 2
    selector {
      match_labels = { app = "whoami" }
    }
    template {
      metadata {
        labels = { app = "whoami" }
      }
      spec {
        container {
          name  = "whoami"
          image = "traefik/whoami:v1.11.0"
          port {
            container_port = 80
          }
          readiness_probe {
            http_get {
              path = "/health"
              port = 80
            }
          }
          resources {
            requests = { cpu = "10m", memory = "16Mi" }
            limits   = { memory = "64Mi" }
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "whoami" {
  metadata {
    name      = "whoami"
    namespace = kubernetes_namespace_v1.demo.metadata[0].name
  }
  spec {
    selector = { app = "whoami" }
    port {
      port        = 80
      target_port = 80
    }
  }
}
```

**`kubernetes_manifest`** takes any object, including custom resources, as an HCL map. It uses server-side apply and is the only way to manage CRD instances (like an `HTTPRoute`) with the kubernetes provider:

```hcl
resource "kubernetes_manifest" "whoami_route" {
  manifest = {
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "HTTPRoute"
    metadata = {
      name      = "whoami"
      namespace = "demo"
    }
    spec = {
      parentRefs = [{ name = "traefik-gateway", namespace = "traefik" }]
      rules = [{
        matches     = [{ path = { type = "PathPrefix", value = "/" } }]
        backendRefs = [{ name = "whoami", port = 80 }]
      }]
    }
  }
}
```

Converting YAML by hand is tedious. Use `yamldecode(file("route.yaml"))` for one document, or the provider function `provider::kubernetes::manifest_decode_multi(...)` (Terraform 1.8+) for a multi-document file.

:::warning `kubernetes_manifest` needs a live API server at plan time
Typed resources only need the API during apply. `kubernetes_manifest` must ask the API server for the resource's schema **during plan**. If the cluster does not exist yet, or the CRD for `HTTPRoute` is not installed yet, the plan fails. This single fact drives most of the stack-splitting advice below.
:::

## Helm releases

```hcl
resource "helm_release" "traefik" {
  name             = "traefik"
  namespace        = "traefik"
  create_namespace = true
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "41.5.0"   # always pin; check with: helm search repo traefik/traefik --versions

  values = [yamlencode({
    providers = { kubernetesGateway = { enabled = true } }
    gateway   = { listeners = { web = { namespacePolicy = { from = "All" } } } }
    service   = { spec = { type = "NodePort" } }
    ports     = { web = { nodePort = 30080 } }
  })]

  wait    = true    # default: wait until resources are ready
  timeout = 300
}
```

Charts from OCI registries use the full reference in `chart` (for example `oci://ghcr.io/org/charts/app`) and no `repository`. A local chart is just a path: `chart = "${path.module}/charts/shipit"`.

:::info Chart values change between major versions
Values layouts are chart-specific and can change between majors. The Traefik chart, for example, currently sets the Service type under `service.spec.type`; older majors used `service.type`. Before pinning a version, run `helm show values <repo>/<chart> --version <v>` and check the keys you rely on.
:::

:::deep CRDs, Helm and Terraform
Helm installs CRDs from a chart's `crds/` directory on first install but **never upgrades or deletes them**. Many projects (Gateway API, cert-manager, Prometheus Operator) therefore recommend installing CRDs separately. With Terraform you have three options:

1. `kubernetes_manifest` with `for_each` over `provider::kubernetes::manifest_decode_multi(...)` of the upstream YAML. Fully managed by Terraform, upgradable by changing a version variable. Requires the cluster to exist at plan time.
2. A dedicated CRD chart (some projects ship one) installed with `helm_release` before the main chart.
3. A `terraform_data` resource with a `local-exec` `kubectl apply --server-side -f <url>` provisioner. Simple, but Terraform cannot see drift or delete them cleanly.

Whatever you choose, CRDs belong in the **platform** layer, applied before anything that creates instances of them.
:::

:::try Read what the chart will create
With the Traefik repo added (`helm repo add traefik https://traefik.github.io/charts`), run `helm template traefik traefik/traefik --version 41.5.0 --set providers.kubernetesGateway.enabled=true | grep '^kind:' | sort | uniq -c`. That is what `helm_release` will install. Terraform state only stores the release, not each object, which is why `terraform plan` will not show drift inside a release unless you change its inputs.
:::

## The two-phase problem

Imagine one root module that creates a kind (or EKS) cluster, configures the kubernetes and helm providers from that cluster's attributes, and installs workloads. On a **fresh** run:

```text
terraform plan
  ├── kind_cluster.this            (known after apply: endpoint, certs)
  ├── provider "kubernetes" { host = kind_cluster.this.endpoint }   <- unknown!
  ├── kubernetes_namespace_v1.demo    planned with an unconfigured provider
  └── kubernetes_manifest.route       ERROR: needs the API server now
```

Terraform configures providers before it plans resources. When provider arguments depend on resources that do not exist yet, the provider is configured with unknown values. Typed resources sometimes survive that (they only call the API during apply); `kubernetes_manifest` and data sources do not. Even when the first apply works, later changes that **replace** the cluster (any change to `kind_config`, a new EKS cluster name) leave the providers pointing at the old cluster during plan, with confusing or destructive results.

HashiCorp's own provider documentation warns against this pattern. The fix is structural:

```text
stack: cluster      ──outputs──▶  stack: platform           ──▶  stack: apps (or GitOps)
  kind_cluster / EKS               Gateway API CRDs                  Deployments, Services,
  VPC, IAM                         gateway controller (helm)         HTTPRoutes, app charts
                                   Argo CD, cert-manager
  apply 1st                        apply 2nd                          apply 3rd / continuous
```

Each stack has its own state and its own `apply`. The platform stack reads the cluster stack's outputs (remote state or a data source), so by the time it plans, the API server exists. The apps stack plans after the CRDs exist.

:::warning `-target` is not the fix
`terraform apply -target=kind_cluster.this` followed by a full apply works once and is fine for an emergency or a one-off bootstrap. As a permanent workflow it means every new environment needs a manual, ordered ritual that CI cannot reproduce. Split the stacks instead.
:::

## Where Terraform ends and GitOps begins

GitOps tools (Argo CD, Flux) run **inside** the cluster and continuously reconcile it with a Git repository. Compare with Terraform:

| | Terraform | Argo CD / Flux |
| --- | --- | --- |
| Reconciles | When someone runs `apply` | Continuously (every few minutes, or on Git webhook) |
| Drift | Detected at next plan | Detected and optionally self-healed immediately |
| Scope | Cloud + cluster + anything with a provider | Kubernetes objects only |
| Release cadence | Infrequent, reviewed plans | Many deploys per day, PR = deploy |
| Rollback | Revert code, plan, apply | Revert commit, or click "rollback" |
| Credentials | CI holds cloud credentials | Cluster pulls from Git; no cluster credentials in CI |

A pattern used by many teams:

1. **Terraform** creates the cloud network, the cluster, IAM roles for workloads (IRSA / EKS Pod Identity), DNS zones, databases.
2. **Terraform** (helm provider) installs a minimal platform: the gateway controller, and **Argo CD itself**, plus one "root" Argo CD Application pointing at a Git repository.
3. **Argo CD** takes over from there: it deploys platform add-ons that change often and every application ("app of apps" or ApplicationSets).

```text
 Terraform                                         Git repo (k8s manifests / Helm values)
 ┌──────────────────────┐                          ┌───────────────────────────┐
 │ VPC, EKS, IAM, RDS   │                          │ apps/shipit-api/values.yaml│
 │ helm: Argo CD        │──installs──▶ Argo CD ◀──pulls──│ apps/worker/...            │
 │ root Application     │              (in-cluster)       └───────────────────────────┘
 └──────────────────────┘                   │
                                            ▼ sync
                                   Deployments, Services, HTTPRoutes
```

Product teams then deploy by merging a PR that bumps an image tag. Nobody needs cluster-admin credentials in CI, and Terraform plans stay small and rare.

:::info Some teams install add-ons with Argo CD too
The boundary is a choice. Some teams install only Argo CD with Terraform and let Argo CD manage cert-manager, external-dns and the gateway controller. Others keep every add-on in Terraform because they want one plan to show the whole platform. Both work; what does not work well is Terraform and Argo CD managing **the same objects**, which makes them fight over every field.
:::

## EKS with terraform-aws-modules (overview)

On AWS, the cluster layer is usually built with [`terraform-aws-modules/eks/aws`](https://github.com/terraform-aws-modules/terraform-aws-eks). Version 21 renamed several inputs (for example `name` instead of `cluster_name`, `kubernetes_version` instead of `cluster_version`), so check the README of the version you pin.

```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name               = "eks-lab"
  cidr               = "10.20.0.0/16"
  azs                = ["eu-central-1a", "eu-central-1b"]
  private_subnets    = ["10.20.0.0/20", "10.20.16.0/20"]
  public_subnets     = ["10.20.100.0/24", "10.20.101.0/24"]
  enable_nat_gateway = true
  single_nat_gateway = true # dev only: one NAT GW instead of one per AZ
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = "eks-lab"
  kubernetes_version = "1.33" # pick a version currently in EKS standard support

  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_ARM_64_STANDARD"
      instance_types = ["t4g.medium"]
      min_size       = 1
      max_size       = 2
      desired_size   = 1
    }
  }
}
```

A second stack then configures providers with short-lived tokens via `exec`:

```hcl
data "aws_eks_cluster" "this" {
  name = "eks-lab"
}

provider "helm" {
  kubernetes = {
    host                   = data.aws_eks_cluster.this.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", "eks-lab"]
    }
  }
}
```

Note that EKS returns the CA certificate base64-encoded, while the kind provider's outputs are already PEM.

:::warning EKS costs real money
Roughly, in `us-east-1`: control plane ~$0.10/hour (~$73/month), one NAT gateway ~$0.045/hour + data, one `t4g.medium` node ~$0.034/hour, plus EBS volumes and public IPv4 addresses. A lab cluster left running for a month costs well over $100. Creation takes 10–15 minutes and destruction about as long. If you try it, set a timer, destroy the same day, and keep the Lab 1 budget from the AWS module in place. EKS Auto Mode (`compute_config`) adds a per-instance management fee on top of EC2 prices.
:::

## Pitfalls and production habits

- **Do not mix cluster creation and in-cluster resources in one state** (the two-phase problem).
- **Do not let two tools manage one object.** If Argo CD owns a Deployment, Terraform must not, and vice versa.
- **`kubectl edit` is drift.** Terraform will revert typed resources on the next apply. For Helm releases, Terraform only notices changes to the release inputs.
- **Pin chart versions** and provider versions. An unpinned `helm_release` silently upgrades on the next apply after a chart release.
- **Secrets in Helm values end up in Terraform state.** Prefer External Secrets / Secrets Manager integrations over passing passwords through `set_sensitive`.
- **Deleting a namespace deletes everything in it**, including resources Terraform does not know about. Be careful with `kubernetes_namespace_v1` in shared clusters.
- **Large `kubernetes_manifest` sets are slow** to plan because each object's schema is fetched. Keep them for CRDs and the few custom resources Terraform really needs to own.

:::try Spot the version from the syntax
Look at any `helm_release` example online. If you see `set { name = ... }` blocks, it was written for helm provider v2. If the `provider "helm"` block contains `kubernetes {` without `=`, same. Rewriting one example into v3 syntax takes two minutes and saves you from the most common error after upgrading.
:::

## Summary

- Three layers (cloud/cluster, platform, apps) change at different speeds; give them separate stacks.
- `tehcyx/kind` creates local clusters; its outputs (endpoint, certs, key) configure other stacks.
- Helm provider v3 uses nested attributes: `kubernetes = { ... }`, `set = [ { ... } ]`.
- Use `*_v1` typed resources for core objects and `kubernetes_manifest` for custom resources; the latter needs the API (and the CRD) at plan time.
- Never create a cluster and its workloads in the same apply in production; `-target` is only for one-off bootstraps.
- Terraform owns the cluster and a minimal platform (including Argo CD); GitOps owns application delivery.
- EKS via `terraform-aws-modules/eks` is a few dozen lines of HCL and roughly $100+/month if left running.
