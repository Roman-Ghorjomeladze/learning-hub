Until now every lab ran on your laptop and cost nothing. This module moves to a real cloud, where a forgotten resource can bill you every hour. The Terraform language does not change: you still write resources, wire them with references, plan and apply. What changes is that you need **safe credentials**, a **habit of checking cost before apply**, and enough AWS networking knowledge to know what you are asking for.

You hold the Cloud Practitioner certificate and are studying for the Solutions Architect Associate, so you know the services on paper. Here you build them with code, and that is the fastest way to understand why a VPC needs route tables or why a Fargate task in a private subnet cannot pull its image.

## Cost first: the rules for every AWS lab

Read this section before creating anything. It is short on purpose.

:::warning Things that bill by the hour even when idle
Approximate on-demand prices in `us-east-1` at the time of writing (Frankfurt `eu-central-1` is roughly 10–20% higher). Always confirm in the [AWS Pricing Calculator](https://calculator.aws/).

| Resource | Rough cost | Notes |
| --- | --- | --- |
| NAT gateway | ~$0.045/hour + ~$0.045 per GB processed | ~$33/month **per gateway**, even with zero traffic. The classic surprise bill. |
| Public IPv4 address | ~$0.005/hour each | Charged since February 2024 for every public IPv4 (EIPs, Fargate tasks with public IPs, EC2). |
| Application Load Balancer | ~$0.0225/hour + capacity units | ~$16+/month idle. |
| EKS control plane | ~$0.10/hour | ~$73/month before any nodes. |
| ECS Fargate task (0.25 vCPU, 0.5 GB, ARM64) | ~$0.01/hour | Cheap, but it runs until you destroy it. |
| VPC, subnets, route tables, IGW, security groups, IAM | free | Safe to experiment with. |
| S3 | cents for lab-sized data | Storage and requests are billed; tiny for labs. |
:::

The rules for this track:

1. **Budget alert first.** Lab 1 creates an AWS Budget that emails you before you spend $10. Do not skip it.
2. **Plan before apply, read the plan.** Count the `+` lines and ask "which of these bills hourly?"
3. **Destroy at the end of every session.** `terraform destroy` is part of the lab, not an optional extra. If you stop halfway, destroy anyway and re-apply tomorrow; that is what IaC is for.
4. **No NAT gateway unless a lab says so**, and then only for minutes.
5. **One region.** Pick one (this module uses a `region` variable, default `eu-central-1`) and stay in it, so you never forget resources in another region.

:::info The AWS Free Tier changed in July 2025
Accounts created **after 15 July 2025** get the new Free Tier: a "free plan" with up to $200 in credits (part granted at sign-up, part earned by trying services) that lasts **6 months or until the credits run out**, plus a set of always-free services. Older accounts keep the legacy 12-month offers. Either way, NAT gateways, load balancers and EKS are not free. Check *Billing and Cost Management > Free Tier* in the console to see what your account has.
:::

## Authentication: never hard-code keys

The AWS provider uses the same credential chain as the AWS CLI and SDKs. In order, it looks at provider arguments, environment variables (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, ...), the shared config and credentials files (`~/.aws/config`, `~/.aws/credentials`), container credentials, and finally instance metadata (on EC2). You almost never put credentials in the provider block.

```text
Terraform AWS provider
        |
        v
  credential chain ──> env vars ──> AWS_PROFILE / profile ──> ~/.aws/config (SSO) ──> IMDS / ECS role
                                                    |
                                                    v
                                     short-lived STS credentials (1–12 h)
```

The modern way for a human is **IAM Identity Center** (formerly AWS SSO): you log in through a browser, and the CLI caches short-lived credentials. No long-lived access key ever exists on your laptop.

### One-time setup

1. In the AWS console, enable **IAM Identity Center** in your chosen region, create a user for yourself, and assign it to your account with a permission set (for a personal learning account, `AdministratorAccess` is acceptable; at work you would use something narrower).
2. On your Mac, run:

```bash
aws configure sso
# SSO session name (Recommended): roma
# SSO start URL: https://<your-id>.awsapps.com/start
# SSO region: eu-central-1
# SSO registration scopes [sso:account:access]:   (press Enter)
# ... browser opens, approve ...
# CLI default client Region: eu-central-1
# CLI default output format: json
# Profile name: learn-admin
```

This writes two sections to `~/.aws/config`:

```ini
[profile learn-admin]
sso_session = roma
sso_account_id = 123456789012
sso_role_name = AdministratorAccess
region = eu-central-1

[sso-session roma]
sso_start_url = https://d-1234567890.awsapps.com/start
sso_region = eu-central-1
sso_registration_scopes = sso:account:access
```

3. Each working session:

```bash
aws sso login --profile learn-admin
export AWS_PROFILE=learn-admin
aws sts get-caller-identity     # confirm account and role before any apply
```

Terraform then picks up `AWS_PROFILE` automatically. When the session expires, plans fail with an expired-token error; run `aws sso login` again.

:::warning Never commit credentials
- Do not write `access_key`/`secret_key` in `.tf` files or `terraform.tfvars`.
- Do not create IAM users with access keys for yourself. If an old key exists, deactivate it.
- Secrets passed into resources end up in **state** in plain text. Treat state as sensitive (encrypted S3 backend, restricted access), and prefer write-only arguments (`*_wo`, Terraform 1.11+) or services like Secrets Manager where the provider supports it.
- CI uses **OIDC federation** to assume a role (module 08). Still no static keys.
:::

:::tip `profile` in the provider block
You *can* write `profile = "learn-admin"` in the provider, but then everyone on the team needs a profile with that exact name. Prefer `AWS_PROFILE` in your shell and keep the code identity-agnostic. The exception is multi-account setups, where per-provider `assume_role` blocks are common.
:::

## Configuring the provider

```hcl
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "terraform-learning"
      ManagedBy   = "terraform"
      Owner       = "roma"
      Environment = "lab"
    }
  }
}
```

`default_tags` are merged into every taggable resource the provider creates. Tags are how you later answer "what is this and who made it?" in Cost Explorer, and how you find leftovers: *Resource Groups & Tag Editor* can list every resource with `ManagedBy = terraform` across all regions.

:::info AWS provider v6
Version 6.0 (June 2025) is the current major line. Notable changes for you: **enhanced region support** (most resources accept a `region` argument, so one provider can manage several regions), removal of some long-deprecated arguments, and the S3 backend/provider defaults you will meet in examples. If a blog post uses `~> 4.0` or `~> 5.0`, expect small differences. Run `terraform init -upgrade` and read the upgrade guide before bumping majors.
:::

### Multiple regions: aliases and the `region` argument

Some things must live in a specific region. Billing metrics only exist in `us-east-1`; ACM certificates for CloudFront must be in `us-east-1`. The classic solution is a provider **alias**:

```hcl
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
  # default_tags are per provider block; repeat them here if you want them
}

resource "aws_sns_topic" "billing_alerts" {
  provider = aws.use1
  name     = "billing-alerts"
}
```

With provider v6 you can often skip the alias and set the region on the resource:

```hcl
resource "aws_sns_topic" "billing_alerts" {
  region = "us-east-1"
  name   = "billing-alerts"
}
```

Aliases are still the tool when you need **different credentials** (another account via `assume_role`) or need to pass a provider into a module (`providers = { aws = aws.use1 }`).

:::try Find your identity from Terraform
In an empty folder with the provider config above, add `data "aws_caller_identity" "me" {}` and `output "account" { value = data.aws_caller_identity.me.account_id }`, then run `terraform init && terraform apply`. It creates nothing (data sources are read-only) and proves your SSO profile works. Also try `terraform console` and evaluate `data.aws_caller_identity.me.arn`.
:::

## Networking: a VPC from first principles

Most AWS architectures start with a VPC. Here is the shape you will build:

```text
VPC 10.0.0.0/16  (eu-central-1)
│
├── Internet Gateway ───────────────── internet
│
├── AZ a                               AZ b
│   ├── public  10.0.0.0/24            ├── public  10.0.1.0/24
│   │     route 0.0.0.0/0 -> IGW       │     route 0.0.0.0/0 -> IGW
│   └── private 10.0.10.0/24           └── private 10.0.11.0/24
│         local routes only                  local routes only
│         (+ 0.0.0.0/0 -> NAT GW if enabled — costs money)
```

A subnet is "public" only because its route table sends `0.0.0.0/0` to an internet gateway. A resource there also needs a public IP to be reachable. A "private" subnet has no route to the IGW; instances there reach the internet only through a NAT gateway (paid) or not at all. VPC endpoints (gateway endpoints for S3/DynamoDB are free; interface endpoints cost per hour) let private resources reach AWS services without NAT.

### Calculating subnets with `cidrsubnet`

`cidrsubnet(prefix, newbits, netnum)` carves a smaller network out of a bigger one. From a `/16`, adding 8 bits gives `/24` networks, and `netnum` picks which one.

```hcl
cidrsubnet("10.0.0.0/16", 8, 0)   # "10.0.0.0/24"
cidrsubnet("10.0.0.0/16", 8, 1)   # "10.0.1.0/24"
cidrsubnet("10.0.0.0/16", 8, 10)  # "10.0.10.0/24"
cidrsubnet("10.0.0.0/16", 4, 1)   # "10.0.16.0/20"
```

:::try Explore in the console
Run `terraform console` anywhere and evaluate `[for i in range(3) : cidrsubnet("10.0.0.0/16", 8, i)]`, then `cidrhost("10.0.1.0/24", 5)`. AWS reserves the first four and the last address of every subnet, so a `/24` gives 251 usable IPs.
:::

### The code

```hcl
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  vpc_cidr = "10.0.0.0/16"
  azs      = slice(data.aws_availability_zones.available.names, 0, 2)
  # map: "eu-central-1a" => 0, "eu-central-1b" => 1
  az_index = { for i, az in local.azs : az => i }
}

resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "learn-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "learn-igw" }
}

resource "aws_subnet" "public" {
  for_each = local.az_index

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(local.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = true
  tags                    = { Name = "learn-public-${each.key}", Tier = "public" }
}

resource "aws_subnet" "private" {
  for_each = local.az_index

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(local.vpc_cidr, 8, each.value + 10)
  tags              = { Name = "learn-private-${each.key}", Tier = "private" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "learn-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "learn-private" }
}

resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}
```

Notice the `for_each` keyed by AZ name. If you later add a third AZ, existing subnets keep their addresses in state. With `count`, inserting an AZ in the middle of the list would shift indexes and replace subnets (module 04).

### NAT gateway: the opt-in

```hcl
variable "enable_nat_gateway" {
  description = "Costs ~$0.045/hour + data processing. Leave false for labs."
  type        = bool
  default     = false
}

resource "aws_eip" "nat" {
  count  = var.enable_nat_gateway ? 1 : 0
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  count         = var.enable_nat_gateway ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[local.azs[0]].id
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route" "private_nat" {
  count                  = var.enable_nat_gateway ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}
```

:::warning NAT gateway cost and design
One NAT gateway per AZ is the high-availability production pattern, and it is also three times the cost. For dev environments, teams use a single NAT gateway, VPC endpoints, or public subnets with tight security groups. For labs, keep `enable_nat_gateway = false`, and if you turn it on, destroy within the hour. Data processed through NAT (e.g. pulling container images) adds per-GB charges on top.
:::

:::deep Why public subnets for the Fargate lab?
A Fargate task needs outbound internet (or VPC endpoints) to pull its image and send logs. In a private subnet without NAT, the task fails with `CannotPullContainerError`. The production answer is private subnets + NAT or private subnets + interface endpoints for ECR (`ecr.api`, `ecr.dkr`), a gateway endpoint for S3 (ECR stores layers in S3) and an endpoint for CloudWatch Logs. Interface endpoints cost roughly $0.01/hour per AZ each, so four endpoints in two AZs is about the price of a NAT gateway. For a lab, a task in a public subnet with `assign_public_ip = true` and a security group that only allows *your* IP is cheap (one public IPv4, ~$0.005/hour) and safe enough. You will break this on purpose in the labs.
:::

## Security groups

Security groups are stateful firewalls attached to network interfaces. Use the separate rule resources (`aws_vpc_security_group_ingress_rule` / `_egress_rule`); they are the current recommendation because each rule is its own resource with its own ID and tags, and they avoid the conflicts you get when mixing inline `ingress {}` blocks with standalone rules.

```hcl
data "http" "my_ip" {
  url = "https://checkip.amazonaws.com"
}

locals {
  my_cidr = "${chomp(data.http.my_ip.response_body)}/32"
}

resource "aws_security_group" "web" {
  name        = "learn-web"
  description = "HTTP from my IP only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "http_from_me" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = local.my_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "all_out" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
```

(`data "http"` comes from the `hashicorp/http` provider; add it to `required_providers`.) Between tiers, reference security groups instead of CIDRs: the database SG allows port 5432 from `referenced_security_group_id = aws_security_group.api.id`. That rule survives IP changes and documents intent.

:::warning Terraform removes the default egress rule
AWS creates an "allow all outbound" rule on every new security group, but the Terraform `aws_security_group` resource **deletes it**. If you forget an egress rule, your task cannot pull images or call APIs, and the error looks like a networking timeout.
:::

## IAM with `aws_iam_policy_document`

IAM policies are JSON. You could write them with `jsonencode()`, but the `aws_iam_policy_document` data source gives you HCL syntax, validation, and easy interpolation. It renders JSON locally; it does not call AWS.

An ECS service needs two roles, and mixing them up is a classic interview question:

| Role | Who assumes it | Used for |
| --- | --- | --- |
| **Task execution role** | the ECS agent | Pull images from ECR, write logs to CloudWatch, read secrets for env vars |
| **Task role** | your application code | Whatever your app calls: S3, SQS, DynamoDB... |

```hcl
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "learn-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The app's own permissions: read objects from one bucket
data "aws_iam_policy_document" "app_s3_read" {
  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.assets.arn]
  }
  statement {
    sid       = "ReadObjects"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]
  }
}

resource "aws_iam_role" "task" {
  name               = "learn-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "task_s3_read" {
  name   = "s3-read-assets"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.app_s3_read.json
}
```

Note the two resource ARNs: `s3:ListBucket` acts on the bucket (`arn:aws:s3:::name`), `s3:GetObject` on objects (`arn:aws:s3:::name/*`). Getting this wrong produces `AccessDenied` that looks mysterious until you remember it.

:::tip Inline vs managed policies
`aws_iam_role_policy` (inline) lives and dies with the role, which is ideal for app-specific permissions. `aws_iam_policy` + `aws_iam_role_policy_attachment` creates a reusable managed policy. Avoid `aws_iam_policy_attachment` (no "role"): it is *exclusive* and will detach the policy from every other role in the account that Terraform does not know about.
:::

## S3 with best-practice settings

New buckets already block public access, disable ACLs and encrypt with SSE-S3 by default (AWS changed these defaults in 2023). Declare them anyway: explicit settings show intent, survive policy changes, and make scanners (Trivy, Checkov in module 08) happy.

```hcl
resource "aws_s3_bucket" "assets" {
  bucket_prefix = "roma-learn-assets-"   # AWS appends a unique suffix; names are global
  force_destroy = true                   # lab only: lets destroy delete a non-empty bucket
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    object_ownership = "BucketOwnerEnforced"   # ACLs disabled
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"   # or "aws:kms" with kms_master_key_id
    }
  }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    id     = "cleanup"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "assets_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.assets.arn,
      "${aws_s3_bucket.assets.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "assets" {
  bucket     = aws_s3_bucket.assets.id
  policy     = data.aws_iam_policy_document.assets_tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.assets]
}
```

Since AWS provider v4, bucket settings are **separate resources** rather than nested blocks in `aws_s3_bucket`. Older tutorials with `versioning {}` inside the bucket are outdated.

:::warning Versioning and `force_destroy`
With versioning on, deleting an object only adds a delete marker; old versions still cost money until the lifecycle rule expires them. `force_destroy = true` deletes all versions on destroy, which is great in a lab and dangerous in production (never set it on a state bucket or anything holding data you care about).
:::

## Running a container: ECS on Fargate

Fargate runs containers without servers to manage. For a backend engineer it is the most natural first "real" deployment target: you give it an image, CPU/memory, networking and a role.

```text
aws_ecs_cluster ──┐
                  ├── aws_ecs_service (desired_count = 1, FARGATE, public subnet, SG)
aws_ecs_task_definition ──> container: image, port 80, logs -> CloudWatch
        │
        └── execution_role_arn (pull image, write logs)   task_role_arn (app permissions)
```

```hcl
resource "aws_ecs_cluster" "main" {
  name = "learn"
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/learn-web"
  retention_in_days = 1
}

resource "aws_ecs_task_definition" "web" {
  family                   = "learn-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"   # Graviton: cheaper; image must have an arm64 variant
  }

  container_definitions = jsonencode([
    {
      name         = "web"
      image        = "public.ecr.aws/nginx/nginx:stable"
      essential    = true
      portMappings = [{ containerPort = 80, protocol = "tcp" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.web.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "web"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "web" {
  name            = "learn-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for s in aws_subnet.public : s.id]
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = true
  }
}
```

### Where images come from

- **Public registries** (ECR Public, Docker Hub, public GHCR packages) work with no credentials. Docker Hub rate-limits anonymous pulls, which is why the example uses ECR Public.
- **Private ECR** in the same account is the default for real services: the execution role's managed policy already allows pulling.

```hcl
resource "aws_ecr_repository" "shipit_api" {
  name                 = "shipit-api"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true   # lab only
  image_scanning_configuration {
    scan_on_push = true
  }
}
```

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-central-1
REPO=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/shipit-api
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker buildx build --platform linux/arm64 -t $REPO:0.1.0 --push .
```

- **Private GHCR** needs `repositoryCredentials` pointing at a Secrets Manager secret with a GitHub token, plus `secretsmanager:GetSecretValue` on the execution role.

:::mac Match the CPU architecture
Your Mac builds `linux/arm64` images by default. If the task definition says `X86_64` and the image is arm64-only, the task stops with `exec format error`. Either set `cpu_architecture = "ARM64"` (cheaper Graviton pricing) or build multi-arch with `docker buildx build --platform linux/amd64,linux/arm64`.
:::

:::deep How Terraform knows the service is "done"
`aws_ecs_service` returns as soon as the API accepts the service; it does not wait for tasks to be healthy unless you set `wait_for_steady_state = true`. Without it, `apply` can succeed while tasks crash-loop. In CI pipelines, turn it on (it makes applies slower but honest). For rolling deploys, ECS also supports `deployment_circuit_breaker { enable = true, rollback = true }`, which rolls back automatically when new tasks keep failing. Also note that changing the container image creates a **new task definition revision** (task definitions are immutable), and the service updates to point at it.
:::

## terraform-aws-modules vs writing your own

The networking above is about 15 resources. The community module [`terraform-aws-modules/vpc/aws`](https://github.com/terraform-aws-modules/terraform-aws-vpc) does the same plus flow logs, IPv6, database subnets, endpoints and more:

```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"   # check the registry for the current major; v6 requires AWS provider v6

  name = "learn"
  cidr = "10.0.0.0/16"

  azs             = ["eu-central-1a", "eu-central-1b"]
  public_subnets  = ["10.0.0.0/24", "10.0.1.0/24"]
  private_subnets = ["10.0.10.0/24", "10.0.11.0/24"]

  enable_nat_gateway = false   # true + single_nat_gateway = true is the cheap dev option
}

# module.vpc.vpc_id, module.vpc.public_subnets, module.vpc.private_subnets
```

| | Your own resources | Community module |
| --- | --- | --- |
| Learning | You understand every piece | Hides details |
| Speed | Slow to build | Minutes |
| Features | Only what you wrote | Dozens of tested options |
| Upgrades | You control everything | Major versions can rename inputs; read changelogs |
| Review | Small, readable plans | Large plans, many conditional resources |

A sensible path: write it yourself once (this module), then use the community module (or your company's wrapper around it) in real projects. Always pin `version`, and read the module's plan the first time; you are responsible for what it creates.

## LocalStack: a free alternative, with caveats

[LocalStack](https://docs.localstack.cloud/) emulates AWS APIs in a container on your Mac. Point the AWS provider at it and Terraform cannot tell the difference for supported services.

:::warning LocalStack changed in March 2026
On 23 March 2026 LocalStack stopped shipping the separate open-source Community image and archived the community repository. There is now one `localstack/localstack` image that **requires a free account and an auth token** (`LOCALSTACK_AUTH_TOKEN`). The free **Hobby** plan is for **non-commercial** use only and covers a subset of services (S3, IAM, Lambda, SQS, SNS, DynamoDB and others). At the time of writing, ECS, ECR and RDS are **paid-plan only**, and IAM policies are not enforced on the free plan, so a permission bug will not show up locally. Check the current feature matrix on localstack.cloud before relying on a service.
:::

```bash
export LOCALSTACK_AUTH_TOKEN=ls-...   # from app.localstack.cloud
docker run -d --name localstack -p 4566:4566 -e LOCALSTACK_AUTH_TOKEN localstack/localstack
```

```hcl
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"   # dummy values LocalStack accepts; fine because this is not AWS
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    s3  = "http://localhost:4566"
    iam = "http://localhost:4566"
    sts = "http://localhost:4566"
    ec2 = "http://localhost:4566"
  }
}
```

LocalStack is great for fast feedback on S3/IAM/messaging logic and for CI. It is not proof that something works on AWS: behaviour, validation and IAM enforcement differ. Use it for the inner loop, then do a real apply-and-destroy on AWS.

## Pitfalls and production habits

- **Eventual consistency.** Creating an IAM role and immediately using it sometimes fails with "role cannot be assumed". Re-running `apply` usually fixes it; providers retry most cases.
- **Global names.** S3 bucket names are global across all AWS accounts. Use `bucket_prefix` or a random suffix.
- **Hidden dependencies.** A NAT gateway needs the IGW to exist first, but nothing references it. Add `depends_on`.
- **Implicit replacements.** Changing a subnet CIDR, a security group `name`, or an RDS identifier replaces the resource. Read the plan for `-/+` and `forces replacement`.
- **Tag everything** via `default_tags`; add a `Name` tag per resource for the console.
- **Separate state per component** (network, data, services) so a mistake in a service stack cannot destroy the VPC (module 08).
- **Least privilege** for task roles; one role per service.
- **Destroy, then verify.** After `terraform destroy`, check the console's *Billing > Bills* the next day and *Tag Editor* for leftovers.

:::try Find every resource you created
After any apply, open *Resource Groups & Tag Editor*, choose "All regions" and "All supported resource types", and search for tag `ManagedBy = terraform`. After `destroy`, run the same search: it should be empty (a few minutes of lag is normal).
:::

## Summary

- Set a budget alert before anything else; know that NAT gateways, ALBs, EKS and public IPv4 bill hourly.
- Authenticate with IAM Identity Center profiles (`aws configure sso`, `aws sso login`, `AWS_PROFILE`); never put keys in code.
- `default_tags` tags everything; aliases or the v6 `region` argument handle multi-region needs.
- A public subnet = route to an IGW; a private subnet needs NAT or VPC endpoints for outbound traffic.
- `cidrsubnet` plus `for_each` keyed by AZ gives stable, readable subnet layouts.
- Use `aws_iam_policy_document` for policies; know execution role vs task role.
- Declare S3 hardening explicitly: public access block, ownership, encryption, versioning, lifecycle, TLS-only policy.
- Fargate in a public subnet with a locked-down SG is a cheap lab pattern; private subnets + NAT/endpoints is the production one.
- Write networking yourself once, then prefer pinned community modules.
