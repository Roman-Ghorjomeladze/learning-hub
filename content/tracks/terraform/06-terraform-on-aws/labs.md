These labs use a real AWS account. Most resources here are free (VPC, subnets, IAM, security groups, budgets); the Fargate labs cost a few cents per hour. Nothing in these labs creates a NAT gateway, load balancer or EKS cluster.

**Prerequisites**

- An AWS account you control (a personal learning account, not your employer's production account).
- AWS CLI v2 (`brew install awscli`), Terraform 1.10+, Docker.
- IAM Identity Center configured as in the lesson, with a profile named `learn-admin`.

**Every session starts with**

```bash
aws sso login --profile learn-admin
export AWS_PROFILE=learn-admin
aws sts get-caller-identity
```

**Every session ends with** `terraform destroy` in each lab folder you applied (except the guard-rails folder from Lab 1, which costs nothing and should stay).

:::warning Budget before anything else
Do Lab 1 first. If an email from AWS Budgets ever arrives unexpectedly, stop, run `terraform destroy` in every lab folder, and check *Billing and Cost Management > Bills* for the service that is charging.
:::

## Lab 1: Guard rails — SSO check and a budget alert

:::meta
difficulty: easy
time: 20 min
:::

Goal: prove Terraform authenticates through your SSO profile, and create a monthly cost budget that emails you at 50% actual and 100% forecasted spend. This folder stays applied permanently.

### Steps

1. Create the folder and files:

```bash
mkdir -p ~/tf-labs/aws-guardrails && cd ~/tf-labs/aws-guardrails
```

`versions.tf`:

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

provider "aws" {
  region = "eu-central-1"
  default_tags {
    tags = {
      Project   = "terraform-learning"
      ManagedBy = "terraform"
      Owner     = "roma"
    }
  }
}
```

`main.tf`:

```hcl
variable "alert_email" {
  type        = string
  description = "Where budget alerts go"
}

variable "monthly_limit_usd" {
  type    = number
  default = 10
}

data "aws_caller_identity" "me" {}

resource "aws_budgets_budget" "monthly" {
  name         = "learning-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

output "account_id" {
  value = data.aws_caller_identity.me.account_id
}

output "caller_arn" {
  value = data.aws_caller_identity.me.arn
}
```

2. Put your email in `terraform.tfvars` (this file is fine to keep local; it holds no secret):

```hcl
alert_email = "you@example.com"
```

3. Run:

```bash
terraform init
terraform plan
terraform apply
```

### Verify

- `caller_arn` contains `AWSReservedSSO_AdministratorAccess_...`: you are using short-lived SSO credentials, not an IAM user.
- `aws budgets describe-budgets --account-id $(terraform output -raw account_id) --query 'Budgets[].BudgetName'` lists `learning-monthly`.
- In the console, *Billing and Cost Management > Budgets* shows the budget.

Also enable these one-time console settings (not managed by Terraform here): *Billing preferences > Free Tier usage alerts* and *Cost Anomaly Detection* with a default monitor.

:::hint
If `apply` fails with `AccessDeniedException` for budgets, your permission set lacks `budgets:*`, or (for older accounts) IAM access to billing is disabled. Enable *Account > IAM user and role access to Billing information* as the root user.
:::

:::solution
The files above are the full solution. Expected output looks like:

```text
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

Outputs:
account_id = "123456789012"
caller_arn = "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AdministratorAccess_abc123/roma"
```

Cost budgets with email notifications (no automated budget actions) are free, so this folder can stay applied.
:::

### Clean up

Do not destroy this one. It is your safety net for the rest of the track.

## Lab 2: A hardened S3 bucket and a least-privilege IAM role

:::meta
difficulty: easy
time: 30 min
:::

Goal: create an S3 bucket with all best-practice settings, plus an IAM role that can only read from it, and prove the TLS-only policy works. Cost: effectively zero.

### Steps

1. Create the main lab folder. Labs 2–5 add files to it.

```bash
mkdir -p ~/tf-labs/aws-lab && cd ~/tf-labs/aws-lab
```

`versions.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
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

2. Copy the whole S3 block from the lesson (bucket, public access block, ownership controls, encryption, versioning, lifecycle, TLS-only policy) into `s3.tf`.

3. Add `iam.tf` with the `ecs_tasks_assume` policy document, the `task` role and the `app_s3_read` inline policy from the lesson (you will add the execution role in Lab 4).

4. Add `outputs.tf`:

```hcl
output "bucket" {
  value = aws_s3_bucket.assets.bucket
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}
```

5. Apply:

```bash
terraform init
terraform apply
```

### Verify

```bash
BUCKET=$(terraform output -raw bucket)
echo "hello" > hello.txt
aws s3 cp hello.txt s3://$BUCKET/hello.txt
aws s3api get-bucket-encryption --bucket $BUCKET
aws s3api get-public-access-block --bucket $BUCKET
aws s3api get-bucket-versioning --bucket $BUCKET

# The TLS-only policy: plain HTTP must be denied
aws s3api head-object --bucket $BUCKET --key hello.txt \
  --endpoint-url http://s3.$(terraform console <<< 'var.region' | tr -d '"').amazonaws.com
```

The last command should fail with `403 Forbidden`, while the same command without `--endpoint-url` (HTTPS) succeeds.

Then look at the rendered policy JSON:

```bash
terraform console <<< 'data.aws_iam_policy_document.app_s3_read.json'
```

:::hint
If the bucket policy fails with `AccessDenied` on `PutBucketPolicy`, it is usually the public access block being applied at the same moment. The `depends_on` on `aws_s3_bucket_policy` in the lesson code exists for this reason.
:::

:::solution
`s3.tf` is exactly the lesson's S3 section. `iam.tf`:

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

The plan should show 9 resources to add: the bucket, 5 bucket configuration resources (public access block, ownership, encryption, versioning, lifecycle), the bucket policy, the role and its inline policy.
:::

### Optional: the same lab on LocalStack

If you want to repeat this lab without an AWS account (non-commercial use, free Hobby plan; account and auth token required since March 2026):

```bash
export LOCALSTACK_AUTH_TOKEN=ls-...      # from app.localstack.cloud
docker run -d --name localstack -p 4566:4566 -e LOCALSTACK_AUTH_TOKEN localstack/localstack
```

Copy `s3.tf` and `iam.tf` to a new folder, use the LocalStack provider block from the lesson (S3, IAM, STS endpoints), run `terraform apply`, then `aws --endpoint-url http://localhost:4566 s3 ls`. Remember that the free plan does not enforce IAM policies, so the role is created but never checked. Stop it with `docker rm -f localstack`.

### Clean up

Keep this folder applied if you continue to Lab 3 in the same session. Otherwise run `terraform destroy`.

## Lab 3: Build the VPC yourself

:::meta
difficulty: medium
time: 40 min
:::

Goal: build a two-AZ VPC with public and private subnets, an internet gateway and route tables, using `cidrsubnet` and `for_each`. Cost: free (no NAT gateway).

### Steps

1. In `~/tf-labs/aws-lab`, create `network.tf` with the lesson's VPC code: availability zones data source, locals, VPC, IGW, public and private subnets, both route tables, the public default route and the associations. Include the `enable_nat_gateway` variable and the three NAT resources, but keep the default `false`.

2. Add outputs:

```hcl
output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnets" {
  value = { for az, s in aws_subnet.public : az => s.cidr_block }
}

output "private_subnets" {
  value = { for az, s in aws_subnet.private : az => s.cidr_block }
}
```

3. Before applying, predict the plan: how many resources? Which are free? Then:

```bash
terraform plan
terraform apply
```

4. Check what the NAT toggle *would* do without paying for it:

```bash
terraform plan -var enable_nat_gateway=true
```

Read it and do **not** apply.

### Verify

```bash
terraform output public_subnets
aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$(terraform output -raw vpc_id)" \
  --query 'RouteTables[].{Name:Tags[?Key==`Name`]|[0].Value,Routes:Routes[].DestinationCidrBlock}'
```

You should see `learn-public` with `10.0.0.0/16` and `0.0.0.0/0`, and `learn-private` with only `10.0.0.0/16`.

:::hint
`aws_subnet.public[local.azs[0]]` addresses one instance of a `for_each` resource by key. If you see `Invalid index`, print `local.azs` in `terraform console` and compare with the keys of `aws_subnet.public`.
:::

:::solution
`network.tf` is the lesson's VPC section verbatim. Expected counts with `enable_nat_gateway = false`:

```text
aws_vpc.main                                   1
aws_internet_gateway.main                      1
aws_subnet.public / private                    2 + 2
aws_route_table.public / private               1 + 1
aws_route.public_internet                      1
aws_route_table_association.public / private   2 + 2
                                               --
                                               13 to add (all free)
```

With `-var enable_nat_gateway=true` the plan adds `aws_eip.nat[0]`, `aws_nat_gateway.main[0]` and `aws_route.private_nat[0]`: 3 more resources, about $33/month plus data and the EIP's public IPv4 charge.
:::

### Clean up

Keep it for Lab 4 if you continue now; otherwise `terraform destroy`.

## Lab 4: Run a container on ECS Fargate

:::meta
difficulty: medium
time: 45 min
:::

Goal: run nginx on Fargate (ARM64) in a public subnet, reachable on port 80 only from your IP, with logs in CloudWatch. Cost: about $0.015/hour (task + one public IPv4). Destroy when done.

### Steps

1. Add the security group code from the lesson (`data "http" "my_ip"`, `aws_security_group.web`, ingress and egress rules) to `security.tf`.
2. Add the task execution role and its policy attachment from the lesson to `iam.tf`.
3. Create `ecs.tf` with the cluster, log group, task definition and service from the lesson.
4. Apply and wait about a minute:

```bash
terraform apply
```

5. Find the task's public IP:

```bash
TASK=$(aws ecs list-tasks --cluster learn --service-name learn-web --query 'taskArns[0]' --output text)
ENI=$(aws ecs describe-tasks --cluster learn --tasks "$TASK" \
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text)
IP=$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI" \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text)
echo $IP
curl -I http://$IP
```

### Verify

- `curl -I` returns `HTTP/1.1 200 OK` with `Server: nginx`.
- `aws logs tail /ecs/learn-web --since 10m` shows your request in the nginx access log.
- From another network (phone hotspot, for example) the IP does not answer: the security group only allows your `/32`.

:::hint
If `TASK` is `None`, the task has not started or keeps stopping. Run `aws ecs describe-services --cluster learn --services learn-web --query 'services[0].events[:5].message'` to see what ECS is doing.
:::

:::solution
`security.tf`, the execution role and `ecs.tf` are the lesson's code. A `terraform plan` for this lab adds 9 resources: data source reads, the SG and 2 rules, the execution role and attachment, the cluster, log group, task definition and service. A typical first output from `describe-services` events is:

```text
(service learn-web) has started 1 tasks: (task 3f2c...).
(service learn-web) has reached a steady state.
```

Optional: to run your own image instead, add the `aws_ecr_repository` from the lesson, push an arm64 image with `docker buildx build --platform linux/arm64 ... --push`, and change `image` to `"${aws_ecr_repository.shipit_api.repository_url}:0.1.0"`. The image changes, so Terraform creates a new task definition revision and updates the service.
:::

### Clean up

```bash
terraform destroy
```

Confirm that `aws ecs list-clusters` no longer shows `learn` and that the plan says everything is destroyed.

## Lab 5: Break and fix — the task that never starts

:::meta
difficulty: medium
time: 30 min
:::

Goal: diagnose two realistic Fargate failures from AWS's own error messages, the way you would in production.

### Steps

1. Re-apply Lab 4 if you destroyed it (`terraform apply`).
2. Introduce the "move it to private subnets" change a well-meaning colleague might make. In `ecs.tf`, change the service's network configuration to:

```hcl
  network_configuration {
    subnets          = [for s in aws_subnet.private : s.id]
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }
```

3. In `security.tf`, change the ingress rule's `from_port` and `to_port` to `8080` ("we standardised on 8080").
4. `terraform apply`, wait two minutes, and try to curl the service. There is no public IP any more, so you cannot. Now act as the on-call engineer: find out **why tasks keep stopping**.

### Verify

You have diagnosed it when you can quote the `stoppedReason` and explain both problems. Then revert, apply, and `curl -I http://$IP` returns 200 again.

:::hint
Stopped tasks disappear from `list-tasks` unless you ask for them:

```bash
aws ecs list-tasks --cluster learn --desired-status STOPPED --query 'taskArns[0]' --output text
aws ecs describe-tasks --cluster learn --tasks <arn> --query 'tasks[0].{reason:stoppedReason,containers:containers[].reason}'
```

Then ask: what route does a private subnet have to `public.ecr.aws`?
:::

:::solution
Diagnosis:

```text
stoppedReason: "ResourceInitializationError: unable to pull secrets or registry auth:
  ... dial tcp ...: i/o timeout"     (or CannotPullContainerError ... context deadline exceeded)
```

1. **Private subnets without NAT or VPC endpoints have no path to any registry.** The private route table only has the `local` route, so the image pull times out. Fixes: move back to public subnets with `assign_public_ip = true` (lab), or add a NAT gateway, or add interface endpoints for ECR (`com.amazonaws.<region>.ecr.api`, `ecr.dkr`), a gateway endpoint for S3 and an endpoint for CloudWatch Logs (production). Note that `public.ecr.aws` (ECR Public) is not reachable through private ECR endpoints, so for private subnets you would mirror the image into private ECR.
2. **The security group allows 8080 while nginx listens on 80.** Even with a public IP the request would time out. A security group mismatch never shows in ECS events; you find it by comparing `containerPort` with the SG rules. Fix: allow port 80, or make the container listen on 8080 and update `portMappings` to match.

Revert both changes:

```bash
terraform apply
```

Lesson: when a Fargate task is stuck in `PENDING` → `STOPPED`, read `stoppedReason` first; when it is `RUNNING` but unreachable, check security groups, the public IP and the port mapping.
:::

### Clean up

```bash
terraform destroy
```

## Lab 6: Challenge — swap in the community VPC module and deploy your own image

:::meta
difficulty: hard
time: 60–90 min
:::

Goal: rebuild the same environment in a **new** root module using `terraform-aws-modules/vpc/aws` for networking and a private ECR repository for the image. No step-by-step: you have all the pieces.

### Requirements

1. New folder `~/tf-labs/aws-modules-lab`. Your own Lab 3/4 environment must be destroyed first.
2. Networking via `module "vpc"` from `terraform-aws-modules/vpc/aws`, pinned with `~>` to the current major version (look it up on the registry). Two AZs, public and private subnets, **no NAT gateway**.
3. A private ECR repository `shipit-api` with immutable tags, scan on push, `force_delete = true`, and a lifecycle policy keeping only the last 5 images.
4. Build a tiny arm64 image and push it with tag `0.1.0`. Use this app (save as `server.mjs`):

```javascript
import http from "node:http";
const port = process.env.PORT ?? 3000;
http.createServer((req, res) => {
  if (req.url === "/healthz") return res.end("ok");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ app: "shipit-api", path: req.url }));
}).listen(port, () => console.log(`listening on ${port}`));
```

and this `Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
```

5. An ECS Fargate service running that image on port 3000 in the module's **public** subnets, with a security group allowing only your IP on 3000, and `wait_for_steady_state = true`.
6. Outputs: VPC ID, ECR repository URL, ECS cluster name.
7. Answer in a comment in `main.tf`: how many resources does `terraform state list | wc -l` report vs your hand-written version, and what would `single_nat_gateway = true` cost per month?

### Verify

- `curl http://<task-ip>:3000/items` returns `{"app":"shipit-api","path":"/items"}`.
- `terraform plan` right after apply shows no changes.
- `terraform destroy` removes everything, including the ECR repository with images.

:::hint
- The module's outputs you need are `module.vpc.vpc_id` and `module.vpc.public_subnets` (a list of IDs).
- The ECS service cannot start before the image exists. Apply the ECR repository first (`terraform apply -target=aws_ecr_repository.shipit_api` is acceptable here as a one-off bootstrap), push the image, then apply everything. In real projects the image is built by CI and the tag is passed as a variable.
- ECR lifecycle policies are JSON; write them with `jsonencode`.
:::

:::solution
`main.tf` (plus `versions.tf` from Lab 2, unchanged):

```hcl
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name            = "learn-mod"
  cidr            = "10.1.0.0/16"
  azs             = local.azs
  public_subnets  = [for i in range(2) : cidrsubnet("10.1.0.0/16", 8, i)]
  private_subnets = [for i in range(2) : cidrsubnet("10.1.0.0/16", 8, i + 10)]

  enable_nat_gateway = false
  # single_nat_gateway = true would add 1 NAT GW + 1 EIP: ~$33/month + data + ~$3.6/month IPv4
}

resource "aws_ecr_repository" "shipit_api" {
  name                 = "shipit-api"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "shipit_api" {
  repository = aws_ecr_repository.shipit_api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

variable "image_tag" {
  type    = string
  default = "0.1.0"
}

data "http" "my_ip" {
  url = "https://checkip.amazonaws.com"
}

resource "aws_security_group" "api" {
  name   = "learn-mod-api"
  vpc_id = module.vpc.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_me" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "${chomp(data.http.my_ip.response_body)}/32"
  ip_protocol       = "tcp"
  from_port         = 3000
  to_port           = 3000
}

resource "aws_vpc_security_group_egress_rule" "all_out" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "exec" {
  name               = "learn-mod-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/learn-mod-api"
  retention_in_days = 1
}

resource "aws_ecs_cluster" "main" {
  name = "learn-mod"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "learn-mod-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.exec.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name         = "api"
    image        = "${aws_ecr_repository.shipit_api.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment  = [{ name = "PORT", value = "3000" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name                  = "learn-mod-api"
  cluster               = aws_ecs_cluster.main.id
  task_definition       = aws_ecs_task_definition.api.arn
  desired_count         = 1
  launch_type           = "FARGATE"
  wait_for_steady_state = true

  network_configuration {
    subnets          = module.vpc.public_subnets
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }

  depends_on = [aws_iam_role_policy_attachment.exec]
}

output "vpc_id" {
  value = module.vpc.vpc_id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.shipit_api.repository_url
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}
```

Bootstrap order:

```bash
terraform init
terraform apply -target=aws_ecr_repository.shipit_api
REPO=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password | docker login --username AWS --password-stdin ${REPO%%/*}
docker buildx build --platform linux/arm64 -t $REPO:0.1.0 --push .
terraform apply
```

Then find the IP with the Lab 4 commands (cluster `learn-mod`, service `learn-mod-api`) and `curl http://$IP:3000/items`.

The module creates a few more resources than the hand-written version (for example a default security group, default NACL and default route table it takes under management), so the count is a little higher even with fewer features enabled.
:::

### Clean up

```bash
terraform destroy
docker logout ${REPO%%/*}
```

Check *Tag Editor* (all regions, tag `ManagedBy = terraform`) the next day: only the budget from Lab 1 should remain.
