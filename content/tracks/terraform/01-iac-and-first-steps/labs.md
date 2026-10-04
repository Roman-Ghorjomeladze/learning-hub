These labs run entirely on your Mac. No cloud account, no cost.

**Prerequisites**

- Terraform 1.10 or newer: `terraform version` (install with `brew tap hashicorp/tap && brew install hashicorp/tap/terraform`).
- A running Docker engine (Docker Desktop, OrbStack or Colima): `docker info` must succeed.
- `curl` (built in). Optional: `jq` and `graphviz` (`brew install jq graphviz`).

Create a workspace for the track:

```bash
mkdir -p ~/tf-labs/m01 && cd ~/tf-labs/m01
```

If you use Colima, export the socket once per shell: `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.

## Lab 1: Your first resource with the local provider

:::meta
difficulty: easy
time: 15 min
:::

Goal: run the full workflow on the simplest possible provider and see what `init` creates.

### Steps

1. Create the folder and config:

```bash
mkdir -p ~/tf-labs/m01/lab1 && cd ~/tf-labs/m01/lab1
cat > main.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}

resource "local_file" "hello" {
  filename = "${path.module}/hello.txt"
  content  = "Hello from Terraform\n"
}
EOF
```

2. Initialise and look at what appeared:

```bash
terraform init
ls -la
cat .terraform.lock.hcl
find .terraform -maxdepth 6 -type f | head
```

3. Format, validate, plan, apply:

```bash
terraform fmt
terraform validate
terraform plan
terraform apply      # type "yes"
cat hello.txt
```

4. Inspect state:

```bash
terraform state list
terraform state show local_file.hello
terraform show
```

5. Change `content` to `"Hello again\n"`, then run `terraform plan`. Note the symbol and the `# forces replacement` marker. Apply it.

6. Run `terraform apply` once more without changing anything.

### Verify

- `.terraform/providers/registry.terraform.io/hashicorp/local/<version>/darwin_arm64/` contains the provider binary.
- After step 5 the plan said `-/+` with `content ... # forces replacement` and `Plan: 1 to add, 0 to change, 1 to destroy.`
- Step 6 printed `No changes. Your infrastructure matches the configuration.`

:::hint
The local provider can't edit a file "in place" in its model: every argument of `local_file` forces a new resource. That's a provider design choice, not a Terraform rule. Docker containers behave the same way for most attributes.
:::

:::solution
Expected plan for step 5:

```text
  # local_file.hello must be replaced
-/+ resource "local_file" "hello" {
      ~ content              = <<-EOT # forces replacement
          - Hello from Terraform
          + Hello again
        EOT
      ~ id                   = "4b6c..." -> (known after apply)
        # (3 unchanged attributes hidden)
    }

Plan: 1 to add, 0 to change, 1 to destroy.
```

The second apply shows no changes because the desired state (config) equals the recorded state and the real file. That is idempotency.
:::

### Clean up

```bash
terraform destroy   # type "yes"; hello.txt is deleted
```

## Lab 2: Run nginx with the Docker provider

:::meta
difficulty: easy
time: 20 min
:::

Goal: manage a Docker image and container with Terraform, then change it and read the plan.

### Steps

1. Create the config:

```bash
mkdir -p ~/tf-labs/m01/lab2 && cd ~/tf-labs/m01/lab2
cat > versions.tf <<'EOF'
terraform {
  required_version = ">= 1.10"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

provider "docker" {}
EOF

cat > main.tf <<'EOF'
resource "docker_image" "nginx" {
  name         = "nginx:1.30-alpine"
  keep_locally = true
}

resource "docker_container" "web" {
  name  = "tf-web"
  image = docker_image.nginx.image_id

  ports {
    internal = 80
    external = 8080
  }
}
EOF
```

2. Run the workflow:

```bash
terraform init
terraform plan
terraform apply
```

3. Check it from outside Terraform:

```bash
docker ps --filter name=tf-web
curl -sI http://localhost:8080 | head -3
```

4. Change the external port to `8081`. Run `terraform plan` and read it carefully. Apply.

5. Change the image to `nginx:1.31-alpine`. Plan again: which resources change and why does the container change too? Apply.

6. Simulate drift: `docker rm -f tf-web`, then `terraform plan`.

### Verify

- Step 3: `curl` returns `HTTP/1.1 200 OK` and `Server: nginx/1.30.x`.
- Step 4: plan shows `docker_container.web must be replaced` with a `# forces replacement` on the ports block. After apply, port 8081 works and 8080 no longer answers.
- Step 5: the image resource is replaced (new `name`), and because the container references `image_id`, the container is replaced too. `curl -sI localhost:8081` shows `nginx/1.31.x`.
- Step 6: plan shows `docker_container.web will be created` (Terraform noticed during refresh that the container is gone).

:::hint
If `init` works but `plan` fails with `Cannot connect to the Docker daemon`, the provider is looking at the wrong socket. Check `docker context inspect --format '{{.Endpoints.docker.Host}}'` and set `DOCKER_HOST` or the provider's `host` to that value.
:::

:::solution
Final `main.tf` after steps 4 and 5:

```hcl
resource "docker_image" "nginx" {
  name         = "nginx:1.31-alpine"
  keep_locally = true
}

resource "docker_container" "web" {
  name  = "tf-web"
  image = docker_image.nginx.image_id

  ports {
    internal = 80
    external = 8081
  }
}
```

Why the container is replaced in step 5: the image ID changes from one `sha256:` to another, the container's `image` argument refers to it, and changing a container's image forces replacement (Docker can't swap the image of an existing container). The plan shows `image = "sha256:..." -> (known after apply) # forces replacement` because the new ID is only known after the new image is pulled.

Step 6: run `terraform apply` to bring the container back. This is how Terraform corrects drift.
:::

### Clean up

```bash
terraform destroy
docker ps -a --filter name=tf-web   # should list nothing
```

## Lab 3: Read plans and the dependency graph

:::meta
difficulty: medium
time: 25 min
:::

Goal: predict plan symbols before running them, and see how references shape the graph.

### Steps

1. Create a config with a network and two containers:

```bash
mkdir -p ~/tf-labs/m01/lab3 && cd ~/tf-labs/m01/lab3
cat > main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

resource "docker_network" "shipit" {
  name = "tf-shipit"
}

resource "docker_image" "redis" {
  name         = "redis:8-alpine"
  keep_locally = true
}

resource "docker_image" "whoami" {
  name         = "traefik/whoami:latest"
  keep_locally = true
}

resource "docker_container" "redis" {
  name    = "tf-redis"
  image   = docker_image.redis.image_id
  restart = "no"

  networks_advanced {
    name = docker_network.shipit.id
  }
}

resource "docker_container" "whoami" {
  name  = "tf-whoami"
  image = docker_image.whoami.image_id

  ports {
    internal = 80
    external = 8082
  }

  networks_advanced {
    name = docker_network.shipit.id
  }
}
EOF
terraform init && terraform apply -auto-approve
```

2. Look at the graph:

```bash
terraform graph
# optional, with graphviz installed:
terraform graph | dot -Tsvg > graph.svg && open graph.svg
```

3. For each change below, **write down your prediction** (`~`, `-/+`, `+`, `-`, and the summary line), then make the change, run `terraform plan`, compare, and revert the change before the next one:

   a. Change `restart = "no"` to `restart = "unless-stopped"` on `tf-redis`.
   b. Change the whoami external port to `8083`.
   c. Rename the network to `tf-shipit2`.
   d. Delete the whole `docker_container.whoami` block.

4. Save a plan and view it as JSON:

```bash
# make change (b) again, then:
terraform plan -out=tfplan
terraform show tfplan
terraform show -json tfplan | jq '.resource_changes[] | {address, actions: .change.actions}'
```

### Verify

You can explain, for each change, why Terraform chose that action, and you can find the dependency edges `docker_container.redis -> docker_network.shipit` in the graph output.

:::hint
Changing a network's name forces a new network. What happens to every container that references `docker_network.shipit.id` when the network's ID becomes "known after apply"?
:::

:::solution
Expected results:

- **a.** `~ update in-place`: `restart` can be changed on a running container (`docker update`), so `Plan: 0 to add, 1 to change, 0 to destroy.`
- **b.** `-/+` on `docker_container.whoami` only: `Plan: 1 to add, 0 to change, 1 to destroy.`
- **c.** The network is replaced, and **both containers are replaced** because their `networks_advanced.name` refers to the network ID, which becomes unknown: `Plan: 3 to add, 0 to change, 3 to destroy.` A one-word rename caused three replacements. This is why you read the summary line.
- **d.** `- destroy` for `docker_container.whoami`: `Plan: 0 to add, 0 to change, 1 to destroy.` The image stays because it is still in the config.

JSON output for (b) looks like:

```json
{ "address": "docker_container.whoami", "actions": ["delete", "create"] }
```

`["delete","create"]` is `-/+`; `["create","delete"]` would be `+/-` (create_before_destroy).
:::

### Clean up

```bash
terraform destroy -auto-approve
rm -f tfplan graph.svg
```

## Lab 4: Break & fix a broken configuration

:::meta
difficulty: medium
time: 25 min
:::

Goal: practise reading Terraform errors. The config below has **four** problems. Fix them one at a time, re-running the failing command after each fix.

### Steps

1. Start a container that will get in the way (this is part of the scenario):

```bash
docker run -d --name squatter -p 8085:80 nginx:1.30-alpine
```

2. Create the broken config:

```bash
mkdir -p ~/tf-labs/m01/lab4 && cd ~/tf-labs/m01/lab4
cat > main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "hashicorp/docker"
      version = "~> 4.6"
    }
  }
}

resource "docker_image" "echo" {
  name         = "hashicorp/http-echo:latest"
  keep_locally = true
}

resource "docker_container" "echo" {
  name    = "tf-echo"
  image   = docker_image.ehco.image_id
  command = ["-text=hello from terraform"]

  ports {
    internal = "5678"
    external = 8085
  }
}

output "url" {
  value = "http://localhost:${docker_container.echo.ports[0].external}"
}
EOF
```

3. Run `terraform init`, then `terraform validate`, then `terraform apply`. Fix whatever breaks.

### Verify

`curl -s http://localhost:<port>` prints `hello from terraform` and `terraform output url` shows the right URL.

:::hint
1. Read the `init` error carefully: which registry address is it trying to download? Who publishes the Docker provider?
2. `validate` points at a reference to a resource that "has not been declared".
3. `apply` fails at the Docker API level, not in Terraform. What is already using that host port? (`docker ps`)
4. The fourth issue is subtle and Terraform tolerates it: `internal = "5678"` is a string. Terraform converts it to a number automatically, but `fmt`/review should catch it. Is the container actually listening on 5678? Check the image docs or `docker logs tf-echo`.
:::

:::solution
1. **Wrong provider source.** HashiCorp does not publish a current Docker provider, so `init` fails with `Failed to query available provider packages` (the detail says either that the registry has no provider by that name or that no releases match `~> 4.6`; the old Docker provider was handed over to the community years ago). Use `source = "kreuzwerker/docker"` and re-run `terraform init`. This is also what happens when you forget `required_providers` entirely: Terraform assumes `hashicorp/<name>`.
2. **Typo in a reference.** `validate` says `Reference to undeclared resource ... docker_image.ehco`. Fix to `docker_image.echo.image_id`.
3. **Port conflict.** Apply fails with something like `Bind for 0.0.0.0:8085 failed: port is already allocated`. Either `docker rm -f squatter` or change `external` to a free port such as `8086`. Note that Terraform may have left a half-created container in state as **tainted**; the next apply replaces it.
4. **Type sloppiness.** `internal = "5678"` works due to automatic conversion, but write `internal = 5678`. http-echo does listen on 5678 by default, so this one is a style fix, not a functional one.

Fixed config:

```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

resource "docker_image" "echo" {
  name         = "hashicorp/http-echo:latest"
  keep_locally = true
}

resource "docker_container" "echo" {
  name    = "tf-echo"
  image   = docker_image.echo.image_id
  command = ["-text=hello from terraform"]

  ports {
    internal = 5678
    external = 8086
  }
}

output "url" {
  value = "http://localhost:${docker_container.echo.ports[0].external}"
}
```
:::

### Clean up

```bash
terraform destroy -auto-approve
docker rm -f squatter 2>/dev/null || true
```

## Lab 5: Challenge: a small shipit sandbox

:::meta
difficulty: hard
time: 40 min
:::

Goal: build a small environment from requirements only, using what you learned.

### Requirements

In `~/tf-labs/m01/lab5`, write a configuration that:

1. Pins Terraform `>= 1.10`, `kreuzwerker/docker ~> 4.6` and `hashicorp/local ~> 2.9`, split into `versions.tf` and `main.tf`.
2. Creates a Docker network `shipit-sandbox`.
3. Runs `redis:8-alpine` as container `sandbox-redis` on that network, **without** publishing any port to the host.
4. Runs `hashicorp/http-echo` as `sandbox-echo` on the same network, published on host port `8090`, replying with the text `shipit sandbox`.
5. Writes a file `sandbox.txt` with the `local_file` resource containing the Redis container's IP on the network and the echo URL. The content must come from resource attributes, not hard-coded values.
6. `terraform fmt -check` and `terraform validate` pass, and a second `terraform apply` shows no changes.
7. Bonus: render the graph as Mermaid or SVG and confirm `local_file` depends on both containers.

### Verify

```bash
curl -s localhost:8090          # shipit sandbox
cat sandbox.txt                  # shows an IP like 172.x.x.x and the URL
docker exec sandbox-redis redis-cli ping   # PONG
terraform plan                   # No changes
```

:::hint
After apply, run `terraform state show docker_container.redis` and look for the `network_data` attribute. It is a list of objects; each has `network_name` and `ip_address`. Use a heredoc (`<<-EOT ... EOT`) for multi-line file content.
:::

:::solution
`versions.tf`:

```hcl
terraform {
  required_version = ">= 1.10"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}

provider "docker" {}
```

`main.tf`:

```hcl
resource "docker_network" "sandbox" {
  name = "shipit-sandbox"
}

resource "docker_image" "redis" {
  name         = "redis:8-alpine"
  keep_locally = true
}

resource "docker_image" "echo" {
  name         = "hashicorp/http-echo:latest"
  keep_locally = true
}

resource "docker_container" "redis" {
  name  = "sandbox-redis"
  image = docker_image.redis.image_id

  networks_advanced {
    name = docker_network.sandbox.id
  }
}

resource "docker_container" "echo" {
  name    = "sandbox-echo"
  image   = docker_image.echo.image_id
  command = ["-text=shipit sandbox"]

  ports {
    internal = 5678
    external = 8090
  }

  networks_advanced {
    name = docker_network.sandbox.id
  }
}

resource "local_file" "summary" {
  filename = "${path.module}/sandbox.txt"
  content  = <<-EOT
    redis_ip = ${docker_container.redis.network_data[0].ip_address}
    echo_url = http://localhost:${docker_container.echo.ports[0].external}
  EOT
}
```

Bonus: `terraform graph -format=mermaid` (Terraform 1.16+) or `terraform graph | dot -Tsvg > graph.svg`. You will see `local_file.summary` with edges to both containers, because its content references their attributes.

If `network_data[0]` ever points at the wrong network (for example if you attach a container to several networks), select by name instead; you'll learn `for` expressions in module 04:

```hcl
locals {
  redis_ip = [for n in docker_container.redis.network_data : n.ip_address if n.network_name == "shipit-sandbox"][0]
}
```
:::

### Clean up

```bash
terraform destroy -auto-approve
```
