All labs except the last run locally on kind and cost nothing. You build three separate Terraform stacks, exactly like the layered model in the lesson:

```text
~/tf-labs/k8s/
  cluster/     kind cluster            (Lab 1)
  workloads/   namespace, app, route   (Labs 2, 3)
  platform/    Gateway API + Traefik   (Lab 3), Argo CD (Lab 5)
```

**Prerequisites**: Terraform 1.10+ (1.8+ is required for provider functions), Docker running with at least 4 CPUs / 6 GB RAM, `kubectl`, `helm`, `kind` (only for `kind get clusters` checks) and `jq`.

**Clean up everything** at the end with `terraform destroy` in `workloads`, then `platform`, then `cluster` (reverse order of creation). If state gets lost, `kind delete cluster --name tf-lab` removes the cluster directly.

## Lab 1: A kind cluster from Terraform

:::meta
difficulty: easy
time: 15 min
:::

Goal: create a single-node kind cluster with a host port mapping, and expose its connection details as outputs for other stacks.

### Steps

1. Create the stack:

```bash
mkdir -p ~/tf-labs/k8s/cluster && cd ~/tf-labs/k8s/cluster
```

2. Put the full kind configuration from the lesson (terraform block, provider, two variables, `kind_cluster.this`, five outputs) into `main.tf`.

3. Apply:

```bash
terraform init
terraform apply
```

4. Use the cluster:

```bash
export KUBECONFIG=$(terraform output -raw kubeconfig_path)
kubectl get nodes -o wide
kubectl cluster-info
```

### Verify

- `kind get clusters` lists `tf-lab`.
- `kubectl get nodes` shows one `Ready` control-plane node with architecture `arm64` (on Apple Silicon): check with `kubectl get node -o jsonpath='{.items[0].status.nodeInfo.architecture}'`.
- `terraform output client_key` prints `<sensitive>`; `terraform output -raw endpoint` prints `https://127.0.0.1:<port>`.
- `docker ps --filter name=tf-lab` shows `0.0.0.0:8080->30080/tcp`.

:::hint
If apply fails with `failed to create cluster: node(s) already exist`, a cluster with that name exists outside Terraform state. The kind provider cannot import existing clusters, so delete it with `kind delete cluster --name tf-lab` and apply again. If port 8080 is busy on your Mac, apply with `-var http_host_port=8085` and use that port in later labs.
:::

:::solution
`main.tf` is exactly the lesson's "Provisioning a kind cluster" code. Expected output:

```text
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

Outputs:
client_certificate = <sensitive>
client_key = <sensitive>
cluster_ca_certificate = <<EOT
-----BEGIN CERTIFICATE-----
...
endpoint = "https://127.0.0.1:52341"
kubeconfig_path = "/Users/roma/.kube/kind-tf-lab"
```

Try `terraform plan -var cluster_name=other`: the plan shows `-/+ ... forces replacement`, because the kind provider cannot modify clusters.
:::

### Clean up

Keep the cluster for the next labs.

## Lab 2: Deploy a workload from a separate stack

:::meta
difficulty: easy
time: 20 min
:::

Goal: a second stack that configures the `kubernetes` provider from the cluster stack's outputs and deploys a namespace, a Deployment and a Service.

### Steps

1. Create the stack:

```bash
mkdir -p ~/tf-labs/k8s/workloads && cd ~/tf-labs/k8s/workloads
```

2. `providers.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

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

3. `app.tf`: copy `kubernetes_namespace_v1.demo`, `kubernetes_deployment_v1.whoami` and `kubernetes_service_v1.whoami` from the lesson.

4. Apply and test:

```bash
terraform init
terraform apply
export KUBECONFIG=~/.kube/kind-tf-lab
kubectl -n demo get deploy,pods,svc
kubectl -n demo port-forward svc/whoami 9000:80 &
curl -s localhost:9000 | head -5
kill %1
```

5. Simulate drift: scale by hand, then plan.

```bash
kubectl -n demo scale deploy/whoami --replicas=5
terraform plan
```

### Verify

- `curl` prints `Hostname: whoami-...` and request headers.
- After the manual scale, `terraform plan` shows `~ replicas = 5 -> 2`. Apply it to revert the drift.

:::hint
`Error: Unsupported attribute ... This object does not have an attribute named "client_key"` means the cluster stack's outputs were not applied or the path in `terraform_remote_state` is wrong. Run `terraform output` in `../cluster`.
:::

:::solution
`app.tf` is the lesson's typed-resource code. The drift plan looks like:

```text
  # kubernetes_deployment_v1.whoami will be updated in-place
  ~ resource "kubernetes_deployment_v1" "whoami" {
      ~ spec {
          ~ replicas = "5" -> "2"
```

The stack plans cleanly even on a fresh state because the cluster already exists when this stack runs: the provider's arguments are known at plan time.
:::

### Clean up

Keep it for Lab 3.

## Lab 3: Platform stack — Gateway API CRDs and Traefik via the helm provider

:::meta
difficulty: medium
time: 35 min
:::

Goal: install the Gateway API CRDs with `kubernetes_manifest` and Traefik with `helm_release` (helm provider v3 syntax) in a platform stack, then route `localhost:8080` to whoami with an `HTTPRoute` from the workloads stack.

### Steps

1. Create the stack:

```bash
mkdir -p ~/tf-labs/k8s/platform && cd ~/tf-labs/k8s/platform
```

2. `providers.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

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

provider "helm" {
  kubernetes = {
    host                   = local.k8s.endpoint
    cluster_ca_certificate = local.k8s.cluster_ca_certificate
    client_certificate     = local.k8s.client_certificate
    client_key             = local.k8s.client_key
  }
}
```

3. `gateway.tf`:

```hcl
variable "gateway_api_version" {
  type    = string
  default = "v1.6.2" # check https://github.com/kubernetes-sigs/gateway-api/releases
}

data "http" "gateway_api" {
  url = "https://github.com/kubernetes-sigs/gateway-api/releases/download/${var.gateway_api_version}/standard-install.yaml"
}

locals {
  gateway_api_docs = provider::kubernetes::manifest_decode_multi(data.http.gateway_api.response_body)
}

resource "kubernetes_manifest" "gateway_api" {
  for_each = { for m in local.gateway_api_docs : "${m.kind}/${m.metadata.name}" => m }

  # strip server-populated fields that kubernetes_manifest refuses to manage
  manifest = { for k, v in each.value : k => v if k != "status" }
}

resource "helm_release" "traefik" {
  name             = "traefik"
  namespace        = "traefik"
  create_namespace = true
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "41.5.0"

  values = [yamlencode({
    providers = { kubernetesGateway = { enabled = true } }
    gateway   = { listeners = { web = { namespacePolicy = { from = "All" } } } }
    service   = { spec = { type = "NodePort" } }
    ports     = { web = { nodePort = 30080 } }
  })]

  depends_on = [kubernetes_manifest.gateway_api]
}
```

4. Apply the platform:

```bash
terraform init
terraform apply
kubectl get crd | grep gateway.networking.k8s.io
kubectl -n traefik get pods,svc,gateway
```

5. Back in `~/tf-labs/k8s/workloads`, add `route.tf` with `kubernetes_manifest.whoami_route` from the lesson and apply.

6. Test from your Mac:

```bash
curl -s localhost:8080 | head -3
```

### Verify

- `kubectl get gatewayclass` shows `traefik` with `ACCEPTED True`.
- `kubectl -n traefik get gateway traefik-gateway` shows `PROGRAMMED True`.
- `kubectl -n demo get httproute whoami -o jsonpath='{.status.parents[0].conditions[*].type}'` includes `Accepted` and `ResolvedRefs`.
- `curl localhost:8080` returns whoami output. The path is: Mac :8080 → kind node :30080 (NodePort) → Traefik :8000 (web entrypoint, Gateway listener) → HTTPRoute → Service `whoami` → pod.

:::hint
- `curl: (52) Empty reply` or `connection refused`: check the NodePort with `kubectl -n traefik get svc traefik -o yaml | grep -B2 -A2 nodePort`. It must be `30080` for the `web` port.
- HTTPRoute not accepted: check `parentRefs` name and namespace match `kubectl get gateway -A`.
- If planning the CRDs is very slow or hits a gRPC message size error on your machine, replace the `kubernetes_manifest` with `resource "terraform_data" "gateway_api" { provisioner "local-exec" { command = "kubectl apply --server-side -f <url>" } }` (with `KUBECONFIG` set) and note the trade-off: Terraform no longer tracks the CRDs.
:::

:::solution
Files are as listed. `terraform state list` in `platform`:

```text
data.http.gateway_api
data.terraform_remote_state.cluster
helm_release.traefik
kubernetes_manifest.gateway_api["CustomResourceDefinition/backendtlspolicies.gateway.networking.k8s.io"]
kubernetes_manifest.gateway_api["CustomResourceDefinition/gatewayclasses.gateway.networking.k8s.io"]
kubernetes_manifest.gateway_api["CustomResourceDefinition/gateways.gateway.networking.k8s.io"]
kubernetes_manifest.gateway_api["CustomResourceDefinition/grpcroutes.gateway.networking.k8s.io"]
kubernetes_manifest.gateway_api["CustomResourceDefinition/httproutes.gateway.networking.k8s.io"]
...
kubernetes_manifest.gateway_api["ValidatingAdmissionPolicy/..."]
kubernetes_manifest.gateway_api["ValidatingAdmissionPolicyBinding/..."]
```

(The exact CRD list depends on the Gateway API version.) Why does the HTTPRoute live in the workloads stack and not in `platform`? Because `kubernetes_manifest` for an `HTTPRoute` needs the HTTPRoute CRD to exist **at plan time**. In the same stack as the CRDs, a fresh plan fails with `no matches for kind "HTTPRoute"`. Separate stacks applied in order avoid that.
:::

### Clean up

Keep everything if you continue to Lab 5. Otherwise destroy `workloads`, then `platform`, then `cluster`.

## Lab 4: Break and fix — the all-in-one stack

:::meta
difficulty: medium
time: 30 min
:::

Goal: experience the two problems you will meet in real repositories: helm provider v2 syntax under v3, and the two-phase problem. Then fix them properly.

### Steps

1. Create a separate folder (it builds its own cluster `tf-broken` on host port 8090 so it does not clash with `tf-lab`):

```bash
mkdir -p ~/tf-labs/k8s/broken && cd ~/tf-labs/k8s/broken
```

2. `main.tf`, copied from "a blog post":

```hcl
terraform {
  required_providers {
    kind       = { source = "tehcyx/kind", version = "~> 0.11" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 3.0" }
    helm       = { source = "hashicorp/helm", version = "~> 3.0" }
  }
}

resource "kind_cluster" "this" {
  name            = "tf-broken"
  wait_for_ready  = true
  kubeconfig_path = pathexpand("~/.kube/kind-tf-broken")
  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"
    node {
      role = "control-plane"
      extra_port_mappings {
        container_port = 30080
        host_port      = 8090
      }
    }
  }
}

provider "kubernetes" {
  host                   = kind_cluster.this.endpoint
  cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
  client_certificate     = kind_cluster.this.client_certificate
  client_key             = kind_cluster.this.client_key
}

provider "helm" {
  kubernetes {
    host                   = kind_cluster.this.endpoint
    cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
    client_certificate     = kind_cluster.this.client_certificate
    client_key             = kind_cluster.this.client_key
  }
}

resource "helm_release" "traefik" {
  name             = "traefik"
  namespace        = "traefik"
  create_namespace = true
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "41.5.0"

  set {
    name  = "service.spec.type"
    value = "NodePort"
  }
  set {
    name  = "ports.web.nodePort"
    value = "30080"
  }
}

resource "kubernetes_manifest" "app_config" {
  manifest = {
    apiVersion = "v1"
    kind       = "ConfigMap"
    metadata   = { name = "app-config", namespace = "default" }
    data       = { LOG_LEVEL = "info" }
  }
}
```

3. Run `terraform init` and `terraform plan`. Read the errors. Fix the first class of error, plan again, and read the next error.

4. Fix the design so that a **fresh** clone of this repository can be applied by CI with plain `terraform apply` commands, no `-target`.

### Verify

- Your fixed version consists of two stacks, each of which plans and applies cleanly from empty state.
- `curl -s -o /dev/null -w '%{http_code}\n' localhost:8090` returns `404` (Traefik answering with no routes), and `kubectl --kubeconfig ~/.kube/kind-tf-broken get cm app-config` exists.

:::hint
First errors are syntax: in helm provider v3, `kubernetes` and `set` are attributes, not blocks. After that, read the `kubernetes_manifest` error carefully: when is the provider being asked to talk to the cluster, and does the cluster exist at that moment?
:::

:::solution
**Error 1 (syntax)**:

```text
Error: Unsupported block type
  on main.tf line 34, in provider "helm":
  34:   kubernetes {
Blocks of type "kubernetes" are not expected here. Did you mean to define argument "kubernetes"?
```

and the same for `set`. Fix:

```hcl
provider "helm" {
  kubernetes = {
    host                   = kind_cluster.this.endpoint
    cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
    client_certificate     = kind_cluster.this.client_certificate
    client_key             = kind_cluster.this.client_key
  }
}

# in helm_release.traefik
  set = [
    { name = "service.spec.type", value = "NodePort" },
    { name = "ports.web.nodePort", value = "30080" },
  ]
```

**Error 2 (two-phase)**: on a fresh state the plan fails at `kubernetes_manifest.app_config` with an error such as `Failed to construct REST client` / `cannot create REST client: no client config` or a connection error to `localhost`. The provider's `host` is `(known after apply)`, but `kubernetes_manifest` must query the API server during plan to get the object's schema.

A `terraform apply -target=kind_cluster.this` followed by `terraform apply` would work today, but it is a manual ritual and breaks again whenever the cluster is replaced. The proper fix is two stacks:

```text
broken/
  cluster/main.tf    kind provider + kind_cluster.this + outputs (endpoint, CA, cert, key)
  apps/main.tf       terraform_remote_state "../cluster/terraform.tfstate"
                     provider "kubernetes" + provider "helm" from those outputs
                     helm_release.traefik + kubernetes_manifest.app_config
```

`cluster/main.tf` is the cluster resource plus the same five outputs as Lab 1. `apps/main.tf` uses the providers block from Lab 3 (with `path = "../cluster/terraform.tfstate"`) and the fixed `helm_release` and `kubernetes_manifest`. Apply `cluster`, then `apps`; destroy in reverse.
:::

### Clean up

```bash
cd ~/tf-labs/k8s/broken/apps && terraform destroy
cd ../cluster && terraform destroy
kind get clusters   # tf-broken must be gone
```

## Lab 5: Challenge — hand over to GitOps with Argo CD

:::meta
difficulty: hard
time: 60 min
:::

Goal: Terraform installs Argo CD and one Argo CD Application; from then on, the app is deployed by pushing to Git, not by running Terraform.

### Requirements

1. In the `platform` stack, install Argo CD with `helm_release` from `https://argoproj.github.io/argo-helm` (chart `argo-cd`, pinned version), namespace `argocd`. Keep it light: disable Dex and notifications.
2. Install the Argo CD Application with the `argocd-apps` chart (same repository, pinned version) rather than `kubernetes_manifest`. Think about why this avoids a two-phase problem.
3. The Application points to **your own public Git repository** containing `apps/whoami-gitops/deployment.yaml` and `service.yaml` (a whoami Deployment with 1 replica and a Service), deploys to namespace `gitops-demo` (created automatically), and has automated sync with `prune` and `selfHeal`.
4. Demonstrate: change `replicas: 1` to `3` in Git and push; within about three minutes (or after clicking *Refresh* in the UI) there are 3 pods, with no Terraform run.
5. Demonstrate self-heal: `kubectl -n gitops-demo delete deploy whoami` and watch it come back.
6. Write down (as a comment in the platform stack) which resources Terraform owns and which Argo CD owns.

### Verify

- `kubectl -n argocd get applications` shows your app `Synced` and `Healthy`.
- `terraform plan` in `platform` shows no changes after the Git push: Terraform does not know or care about replicas.

:::hint
- Get the admin password: `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`, then `kubectl -n argocd port-forward svc/argocd-server 8443:443` and open `https://localhost:8443`.
- Chart versions: `helm repo add argo https://argoproj.github.io/argo-helm && helm search repo argo/argo-cd` and `argo/argocd-apps`.
- In current `argocd-apps` versions, `applications` is a **map** keyed by application name, not a list.
:::

:::solution
Git repository content (`apps/whoami-gitops/`):

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: whoami
spec:
  replicas: 1
  selector:
    matchLabels: { app: whoami }
  template:
    metadata:
      labels: { app: whoami }
    spec:
      containers:
        - name: whoami
          image: traefik/whoami:v1.11.0
          ports:
            - containerPort: 80
---
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: whoami
spec:
  selector: { app: whoami }
  ports:
    - port: 80
      targetPort: 80
```

`platform/argocd.tf`:

```hcl
# Ownership:
#   Terraform: Gateway API CRDs, Traefik, Argo CD, the Application object (via argocd-apps)
#   Argo CD:   everything inside apps/whoami-gitops in Git (namespace gitops-demo)

resource "helm_release" "argocd" {
  name             = "argocd"
  namespace        = "argocd"
  create_namespace = true
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = "10.9.6" # pin what `helm search repo argo/argo-cd` shows

  values = [yamlencode({
    dex           = { enabled = false }
    notifications = { enabled = false }
  })]
}

variable "gitops_repo_url" {
  type        = string
  description = "e.g. https://github.com/<you>/gitops-lab.git"
}

resource "helm_release" "argocd_apps" {
  name       = "argocd-apps"
  namespace  = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-apps"
  version    = "2.0.6" # pin what `helm search repo argo/argocd-apps` shows

  values = [yamlencode({
    applications = {
      whoami-gitops = {
        namespace = "argocd"
        project   = "default"
        source = {
          repoURL        = var.gitops_repo_url
          targetRevision = "HEAD"
          path           = "apps/whoami-gitops"
        }
        destination = {
          server    = "https://kubernetes.default.svc"
          namespace = "gitops-demo"
        }
        syncPolicy = {
          automated   = { prune = true, selfHeal = true }
          syncOptions = ["CreateNamespace=true"]
        }
      }
    }
  })]

  depends_on = [helm_release.argocd]
}
```

```bash
terraform apply -var gitops_repo_url=https://github.com/<you>/gitops-lab.git
kubectl -n argocd get applications -w
```

Why `argocd-apps` instead of `kubernetes_manifest`? An `Application` is a custom resource; `kubernetes_manifest` would need the Argo CD CRDs at **plan** time, which do not exist on the first run of this stack. `helm_release` renders and installs at apply time, after `helm_release.argocd` has created the CRDs, so one apply works from scratch.
:::

### Clean up

```bash
cd ~/tf-labs/k8s/workloads && terraform destroy
cd ../platform && terraform destroy -var gitops_repo_url=x
cd ../cluster && terraform destroy
```

If Argo CD finalizers block namespace deletion, deleting the cluster in the last step removes everything anyway.

## Lab 6: Optional — read and plan an EKS cluster (apply only if you accept the cost)

:::meta
difficulty: hard
time: 30 min (plan only) / 60 min (with apply)
:::

Goal: read an EKS configuration and its plan without spending money. Applying is optional and costs roughly $0.20–0.25 per hour (control plane, NAT gateway, one small node, IPv4), and creation plus deletion takes about 30 minutes.

### Steps

1. Log in to AWS as in the AWS module (`aws sso login`, `export AWS_PROFILE=learn-admin`) and confirm the budget from that module exists.
2. Create `~/tf-labs/eks-plan/main.tf` with the `terraform` block (`aws ~> 6.0`), a provider for `eu-central-1` with `default_tags`, and the `module "vpc"` and `module "eks"` blocks from the lesson. Replace `kubernetes_version` with a version currently in EKS standard support (`aws eks describe-cluster-versions --query 'clusterVersions[?status==\`STANDARD_SUPPORT\`].clusterVersion'`).
3. Plan and save it:

```bash
terraform init
terraform plan -out eks.tfplan
terraform show -json eks.tfplan | jq '[.resource_changes[] | select(.change.actions == ["create"])] | length'
terraform show -json eks.tfplan | jq -r '.resource_changes[] | select(.change.actions == ["create"]) | .type' | sort | uniq -c | sort -rn
```

4. Answer: how many resources would be created? Which of them bill hourly? What IAM roles does the module create and why?

### Verify

You can name the billable resources (`aws_eks_cluster`, `aws_nat_gateway`, `aws_eip`, the node group's EC2 instances via `aws_eks_node_group`, EBS volumes) and explain what the access entry created by `enable_cluster_creator_admin_permissions` does.

:::hint
Look for `aws_iam_role` resources in the plan and check their `assume_role_policy` principals: one is for the EKS service (`eks.amazonaws.com`), one for EC2 nodes (`ec2.amazonaws.com`).
:::

:::solution
A typical plan creates on the order of 50–70 resources (VPC module ~20, EKS module ~40 including IAM roles, policy attachments, security groups and rules, the cluster, KMS key and alias for secrets encryption, CloudWatch log group, access entry, node group and launch template). Hourly-billed: EKS control plane, NAT gateway, EIP (public IPv4), EC2 instances in the node group and their EBS volumes; the KMS key costs ~$1/month.

IAM roles: the **cluster role** (assumed by `eks.amazonaws.com`, lets the control plane manage ENIs and load balancers) and the **node role** (assumed by `ec2.amazonaws.com`, with worker node, CNI and ECR read policies). The access entry maps your current IAM principal (your SSO role) to cluster admin, replacing the old `aws-auth` ConfigMap approach.

If you decide to apply: `terraform apply eks.tfplan`, then `aws eks update-kubeconfig --name eks-lab --region eu-central-1 --kubeconfig ~/.kube/eks-lab`, `kubectl --kubeconfig ~/.kube/eks-lab get nodes`, and destroy within the hour.
:::

### Clean up

```bash
rm -f eks.tfplan
terraform destroy   # only if you applied; wait for it to finish completely
```
