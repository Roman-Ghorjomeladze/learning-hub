## Why infrastructure as code

Imagine the shipit stack in production: a VPC, a Postgres database, a Redis cluster, a load balancer, DNS records, IAM roles and a container service. If you build it by clicking through the AWS console you get:

- **No history.** Nobody knows who opened port 5432 to the world, or when.
- **No review.** Changes go live the moment someone clicks "Save".
- **No reproducibility.** Staging drifts away from production because each was clicked together on different days by different people.
- **No recovery plan.** If the account is deleted, the only "documentation" is memory.

Infrastructure as code (IaC) treats infrastructure the way you already treat application code: it lives in Git, changes go through pull requests, a tool applies them consistently, and you can recreate an environment from scratch. The same benefits you get from `package.json` plus a lock file, you get for servers, networks and DNS.

### Declarative vs imperative

There are two ways to describe infrastructure.

**Imperative** means you write the steps: "create a network, then create a container attached to it, then if the container already exists, stop it first...". A Bash script calling `docker` or `aws` CLI commands is imperative. You own every edge case: what if it half-failed last time? What if someone already created the network?

**Declarative** means you describe the desired end state: "there should be one network named `shipit` and one container named `api` attached to it". The tool compares that desired state with what exists and works out the steps itself.

```text
 Imperative (you write the HOW)          Declarative (you write the WHAT)
 ------------------------------          --------------------------------
 docker network create shipit            resource "docker_network" "shipit" {
 docker run -d --name api \                name = "shipit"
   --network shipit nginx                }
 # run twice -> "already exists" error   resource "docker_container" "api" {
                                           name  = "api"
                                           image = "nginx:1.30-alpine"
                                           networks_advanced {
                                             name = docker_network.shipit.name
                                           }
                                         }
                                         # apply twice -> "No changes"
```

The key property of declarative tools is **idempotency**: running the same configuration twice gives the same result, and the second run does nothing. You already know this model from Kubernetes manifests and Docker Compose (`docker compose up` converges to what the file says).

### Terraform compared with other tools

| Tool | Style | Language | Scope | Notes |
| --- | --- | --- | --- | --- |
| **Terraform** | Declarative | HCL | Any API with a provider (AWS, GCP, Azure, Kubernetes, GitHub, Cloudflare, Docker, Datadog...) | Explicit state file; huge provider ecosystem; Business Source License (BSL) since 2023 |
| **OpenTofu** | Declarative | HCL | Same as Terraform | Open-source (MPL) fork of Terraform 1.5, run by the Linux Foundation; mostly compatible, `tofu` CLI |
| **Pulumi** | Declarative engine, imperative languages | TypeScript, Python, Go, C#, Java | Multi-cloud | You write real code that builds a desired-state graph; state stored in Pulumi Cloud or a bucket |
| **AWS CloudFormation** | Declarative | YAML/JSON | AWS only | AWS manages the state for you; no state file to protect, but AWS-only and slower to support new features in some areas |
| **AWS CDK** | Imperative code that synthesises CloudFormation | TypeScript, Python, ... | AWS only (CDKTF existed for Terraform but is deprecated) | Great for TypeScript teams on AWS; output is still CloudFormation |
| **Ansible** | Mostly imperative/procedural (with idempotent modules) | YAML | Configuring servers (packages, files, services) | Agentless over SSH; best for *configuration management*, weaker for *provisioning* cloud resources with lifecycle tracking |

A typical split: Terraform **provisions** infrastructure (networks, clusters, databases, DNS), container images and Kubernetes manifests deploy the **application**, and Ansible (if used at all) configures long-lived VMs.

:::info Terraform and OpenTofu
In August 2023 HashiCorp moved Terraform from the open-source MPL licence to the Business Source License. The community forked the last MPL version (1.5.x) as **OpenTofu**, now a Linux Foundation project. IBM completed its acquisition of HashiCorp in 2025. For day-to-day work the two are very similar: same HCL, same providers (OpenTofu runs its own registry mirror), and most of this track applies to both. OpenTofu has added some features of its own (for example built-in state encryption), and Terraform has features OpenTofu lacks, so they are slowly diverging. Interviewers mostly care that you know it exists and why.
:::

## How Terraform works underneath

Terraform itself (the "core") knows nothing about AWS or Docker. It knows how to parse HCL, build a dependency graph, compare desired state with recorded state, and call plugins. All knowledge of a particular API lives in **providers**.

```text
            your *.tf files                 terraform.tfstate
                  |                                ^
                  v                                |
        +--------------------+   reads/writes      |
        |   Terraform core   |---------------------+
        |  - parse HCL       |
        |  - build graph     |
        |  - diff & plan     |
        +---------+----------+
                  | gRPC (plugin protocol v5/v6), one process per provider
      +-----------+-----------+-------------------+
      v                       v                   v
 +-----------+         +--------------+     +------------+
 | provider  |         | provider     |     | provider   |
 | docker    |         | aws          |     | local      |
 +-----+-----+         +------+-------+     +-----+------+
       | Docker API           | AWS APIs          | local filesystem
       v                      v                   v
  Docker Engine          your AWS account       files on disk
```

- A **provider** is a separate executable (written in Go, usually with the Terraform Plugin Framework) that Terraform downloads during `terraform init` and launches as a child process. Core talks to it over gRPC. The provider tells core which resource types it offers and their schemas, and it does the real create/read/update/delete calls.
- The **Terraform Registry** (`registry.terraform.io`) is where providers and public modules are published. A provider address like `kreuzwerker/docker` is shorthand for `registry.terraform.io/kreuzwerker/docker`: hostname, namespace, type.
- **Official** providers are maintained by HashiCorp (`hashicorp/aws`, `hashicorp/local`), **partner** providers by the vendor (`cloudflare/cloudflare`), and **community** providers by anyone (`kreuzwerker/docker` is a long-standing community provider).
- The **state file** records which real objects belong to which resource in your config, plus their last known attributes. Module 03 covers it in depth.

:::deep What actually happens during plan and apply
1. Core parses every `*.tf` file in the current directory (the root module). File names do not matter to Terraform; all files are merged.
2. It builds a **graph**: each resource, data source, variable, local and output is a node; a reference such as `docker_image.web.image_id` creates an edge.
3. During `plan` it **refreshes**: for each resource in state, it asks the provider to read the real object (so it notices manual changes).
4. For each resource it asks the provider to **plan** the change: given prior state and the new config, what will the object look like, and does any changed attribute force replacement? The provider schema marks some attributes as "ForceNew" (for example a container's image).
5. Core prints the diff. On `apply` it walks the graph in dependency order, running independent nodes in parallel (default `-parallelism=10`), calling the provider's apply for each change and saving new state after each one.

This is why the plan is trustworthy: apply executes exactly the actions computed in the plan (if you pass a saved plan file), and refuses if the state changed underneath it.
:::

## HCL syntax basics

Terraform configuration is written in **HCL** (HashiCorp Configuration Language). It has two building blocks: **arguments** and **blocks**.

```hcl
# A block has a type, zero or more labels, and a body in braces
resource "docker_container" "web" {   # type = resource, labels = "docker_container", "web"
  name  = "shipit-web"                # argument: name = expression
  image = docker_image.nginx.image_id # expression referencing another resource

  ports {                             # nested block (no labels)
    internal = 80
    external = 8080
  }

  env = ["NODE_ENV=production", "PORT=3000"] # list
  labels {
    label = "team"
    value = "platform"
  }
}
```

Things to know from day one:

- **Comments**: `#` or `//` for single line, `/* ... */` for multi-line. `terraform fmt` normalises to `#`.
- **Types of values**: strings `"..."`, numbers `8080`, booleans `true`, lists `["a", "b"]`, maps/objects `{ key = "value" }`, and `null`.
- **Interpolation**: `"shipit-${var.env}"` inserts an expression into a string.
- **References** use dots: `<resource_type>.<name>.<attribute>`, `var.<name>`, `local.<name>`, `data.<type>.<name>.<attribute>`, `module.<name>.<output>`.
- The **top-level block types** you will meet: `terraform`, `provider`, `resource`, `data`, `variable`, `output`, `locals`, `module`, plus `import`, `moved`, `removed` and `check`.
- Files ending in `.tf` (or `.tf.json`) in one directory form a **module**. The directory you run Terraform in is the **root module**.

The conventional file layout for a small root module:

```text
shipit-local/
  versions.tf      # terraform block: required_version, required_providers
  providers.tf     # provider configuration (sometimes merged into versions.tf)
  main.tf          # resources
  variables.tf     # input variables (module 02)
  outputs.tf       # outputs (module 02)
  .terraform.lock.hcl   # generated, COMMIT it
  .terraform/           # generated, do NOT commit
  terraform.tfstate     # generated, do NOT commit (module 03)
```

## The terraform block, providers and version constraints

Every configuration should pin which Terraform version and which providers it expects:

```hcl
terraform {
  required_version = ">= 1.10, < 2.0"

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

provider "docker" {
  # Optional. Defaults to the DOCKER_HOST env var, then unix:///var/run/docker.sock
  # host = "unix:///var/run/docker.sock"
}
```

- `required_version` constrains the **Terraform CLI**. If someone runs an older binary they get a clear error instead of a corrupted state.
- `required_providers` maps a **local name** (`docker`) to a **source address** (`kreuzwerker/docker`) and a **version constraint**. Resource types are prefixed with the local name: `docker_container`, `docker_image`.
- `provider "docker" { ... }` **configures** the provider (credentials, region, host). Without a provider block, Terraform uses an empty configuration, which works for `local`, `random` and usually `docker`.

### Version constraint operators

| Constraint | Meaning |
| --- | --- |
| `= 4.6.0` or `4.6.0` | Exactly this version |
| `!= 4.5.0` | Anything except this version |
| `>= 4.0`, `< 5.0` | Comparison; combine with commas |
| `~> 4.6` | "Pessimistic": `>= 4.6, < 5.0` (only the rightmost part may increase) |
| `~> 4.6.0` | `>= 4.6.0, < 4.7.0` (patch updates only) |

Good practice: in **root modules** use `~> MAJOR.MINOR` for providers so you get bug fixes but not breaking changes; in **reusable modules** use a minimum (`>= 4.0`) so the module does not fight with whoever uses it.

:::tip Checking current versions
Don't trust version numbers in blog posts. Check the provider's page on registry.terraform.io (the version selector at the top), or run `terraform init -upgrade` and read the "Installing ... v4.x.y" lines. At the time of writing (Oct 2026) Terraform is on 1.16.x, `kreuzwerker/docker` on 4.6.x and `hashicorp/local` on 2.9.x.
:::

### The dependency lock file

`terraform init` writes `.terraform.lock.hcl`. It records the **exact provider version selected** and **checksums** of the provider packages:

```hcl
provider "registry.terraform.io/kreuzwerker/docker" {
  version     = "4.6.0"
  constraints = "~> 4.6"
  hashes = [
    "h1:abc...",
    "zh:123...",
  ]
}
```

It works like `package-lock.json`: commit it, and everyone (and CI) gets exactly the same provider builds. To move to newer versions within your constraints, run `terraform init -upgrade` and commit the changed lock file.

:::mac Lock file hashes and Apple Silicon
By default `init` records hashes only for the platform you ran it on (`darwin_arm64` on an M-series Mac). When CI runs on `linux_amd64` it may complain that the lock file lacks a matching checksum. Fix it once by pre-recording all platforms you use:

```bash
terraform providers lock -platform=darwin_arm64 -platform=darwin_amd64 -platform=linux_amd64 -platform=linux_arm64
```
:::

The lock file covers **providers only**, not modules. Modules are pinned by their `version` argument or Git ref (module 05).

## The core workflow

```text
  write .tf  -->  init  -->  fmt / validate  -->  plan  -->  apply  -->  ...  -->  destroy
                   |                               |          |
          downloads providers               shows the diff   executes it,
          & modules, sets up backend        (no changes)     updates state
```

| Command | What it does | When |
| --- | --- | --- |
| `terraform init` | Downloads providers and modules into `.terraform/`, writes the lock file, configures the backend | First time, after adding a provider/module, after changing the backend. Safe to re-run |
| `terraform fmt` | Rewrites files into canonical style (`-recursive`, `-check` for CI, `-diff`) | Before every commit |
| `terraform validate` | Checks syntax, references and types without contacting any API | Before plan; in CI |
| `terraform plan` | Refreshes state, computes and prints the changes (`-out=tfplan` saves them) | Before every apply, in PRs |
| `terraform apply` | Plans, asks for confirmation, executes; `terraform apply tfplan` executes a saved plan without asking | To make changes |
| `terraform destroy` | Plans and executes deletion of everything in state (same as `apply -destroy`) | Tearing down dev/test environments |

Other commands you will use constantly:

- `terraform show` prints the current state (or a saved plan) in readable form.
- `terraform output` prints outputs.
- `terraform state list` lists resource addresses in state.
- `terraform providers` shows which providers each module requires.
- `terraform console` gives you a REPL for expressions (module 02).

:::warning `-auto-approve` is for automation, not for your laptop
`terraform apply -auto-approve` skips the confirmation. It is fine in a CI pipeline that applies a plan someone already reviewed. On your laptop, read the plan every time; the one time you don't is the time it says `1 to destroy` on the production database.
:::

## Reading a plan

A plan is the most important output Terraform produces. Learn to read it fast.

```text
Terraform will perform the following actions:

  # docker_container.web must be replaced
-/+ resource "docker_container" "web" {
      ~ id      = "3f1c9a..." -> (known after apply)
      ~ image   = "sha256:aa11..." -> "sha256:bb22..." # forces replacement
        name    = "shipit-web"
        # (12 unchanged attributes hidden)
    }

  # docker_container.worker will be updated in-place
  ~ resource "docker_container" "worker" {
        id      = "9be2d0..."
      ~ restart = "no" -> "unless-stopped"
        # (20 unchanged attributes hidden)
    }

  # local_file.readme will be created
  + resource "local_file" "readme" {
      + content  = "hello"
      + filename = "./README.txt"
      + id       = (known after apply)
    }

  # local_file.old will be destroyed
  - resource "local_file" "old" { ... }

Plan: 2 to add, 1 to change, 2 to destroy.
```

| Symbol | Meaning | Risk |
| --- | --- | --- |
| `+` | Create | Low |
| `-` | Destroy | High: data may be lost |
| `~` | Update in place | Usually low; the object keeps its identity |
| `-/+` | Destroy, then create a replacement | High: new ID, downtime, data loss for stateful things |
| `+/-` | Create replacement first, then destroy (with `create_before_destroy`) | Medium |
| `<=` | Read a data source during apply | Informational |

Key phrases:

- **`# forces replacement`** marks the attribute that caused a replace. Changing a container's image, a database's engine or an EC2 instance's AMI usually forces replacement.
- **`(known after apply)`** means the value is computed by the provider (IDs, IPs) and can't be known yet.
- **`Plan: X to add, Y to change, Z to destroy.`** Read this line first. A "small" change that destroys 30 things is not small.

:::tip Make plans readable in reviews
Save a plan and render it: `terraform plan -out=tfplan` then `terraform show tfplan` (human) or `terraform show -json tfplan | jq` (machine). In CI, tools post this as a PR comment so reviewers see the diff next to the code.
:::

:::try Predict before you run
After Lab 2 you will have a running nginx container. Before changing its external port from 8080 to 8081, write down what you expect: `~` or `-/+`? Then run `terraform plan`. (Docker can't change port bindings on a running container, so the provider marks `ports` as forcing replacement.)
:::

## Resource addresses

Every resource has an **address** that identifies it in plans, state and CLI commands:

```text
docker_container.web                       resource type + name in the root module
docker_container.web[0]                    instance with count
docker_container.web["api"]                instance with for_each
module.app.docker_container.web            resource inside a child module
module.app["blue"].docker_container.web    resource in a for_each'd module
data.docker_network.bridge                 a data source
```

You use addresses with `terraform state show docker_container.web`, `terraform apply -replace=docker_container.web`, `terraform plan -target=docker_container.web`, and in `moved`/`import` blocks.

:::warning `-target` is an escape hatch
`-target` limits a plan to some resources and their dependencies. It's useful when recovering from a broken apply, but Terraform warns you every time for a reason: routine use leaves state and config out of sync and hides real changes. If you keep needing `-target`, your configuration should probably be split into separate root modules.
:::

## The implicit dependency graph

You almost never tell Terraform in which order to create things. When one resource **references** another, Terraform infers a dependency:

```hcl
resource "docker_image" "nginx" {
  name = "nginx:1.30-alpine"
}

resource "docker_network" "shipit" {
  name = "shipit"
}

resource "docker_container" "web" {
  name  = "shipit-web"
  image = docker_image.nginx.image_id        # edge: web -> nginx image

  networks_advanced {
    name = docker_network.shipit.id          # edge: web -> network
  }
}
```

```text
   docker_image.nginx      docker_network.shipit
            \                    /
             \                  /
              v                v
           docker_container.web
```

Terraform creates the image and the network **in parallel** (they are independent), then the container. On destroy it walks the graph backwards: container first, then image and network.

`terraform graph` prints the graph in DOT format; recent versions also support Mermaid output:

```bash
terraform graph | dot -Tsvg > graph.svg     # needs graphviz: brew install graphviz
terraform graph -type=plan                   # graph of the planned operations
terraform graph -format=mermaid              # Terraform 1.16+: paste into a Markdown file or GitHub comment
```

You only need explicit `depends_on` when a dependency is **hidden**: for example, a container that needs a network to exist but only refers to it by a hard-coded string name. Module 04 covers this. Prefer references; they are self-documenting and Terraform can't get them wrong.

:::try Spot the missing edge
In the example above, change `name = docker_network.shipit.id` to `name = "shipit"`. Run `terraform graph`. The edge from the container to the network disappears, so on a fresh apply Terraform may try to start the container before the network exists. This is the classic reason to reference attributes rather than repeat strings.
:::

## Running Terraform against Docker on a Mac

The labs use the `kreuzwerker/docker` provider so that you can practise the whole lifecycle for free. The provider talks to the Docker Engine API, exactly like the `docker` CLI.

:::mac Which Docker socket?
- **Docker Desktop**: `/var/run/docker.sock` exists when "Allow the default Docker socket to be used" is enabled (Settings > Advanced; on by default). Otherwise use `unix://$HOME/.docker/run/docker.sock`.
- **OrbStack**: also links `/var/run/docker.sock`.
- **Colima**: the socket is `unix://$HOME/.colima/default/docker.sock`.

The provider reads `DOCKER_HOST` if set, so `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` works, or set `host` in the provider block. Quick check: `docker context inspect --format '{{.Endpoints.docker.Host}}'` prints the socket the CLI is using.
:::

:::mac Image architecture
On Apple Silicon, Docker pulls the `linux/arm64` variant of multi-arch images like `nginx`, `redis` and `postgres`. Single-arch amd64 images still run via emulation (Rosetta/QEMU) but slower. The provider's `docker_container` accepts a `platform` argument (provider 4.1+) if you need to force one.
:::

A minimal working configuration:

```hcl
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

resource "docker_image" "nginx" {
  name         = "nginx:1.30-alpine"
  keep_locally = true # don't delete the image from your machine on destroy
}

resource "docker_container" "web" {
  name  = "tf-web"
  image = docker_image.nginx.image_id

  ports {
    internal = 80
    external = 8080
  }
}
```

`docker_image.nginx.image_id` is the image's `sha256:` ID. Using it (instead of the string `"nginx:1.30-alpine"`) gives you the dependency edge and makes the container replace itself when the image changes.

:::warning Terraform vs. hand edits
If you `docker stop tf-web` by hand, the next `terraform plan` notices (refresh) and plans to fix it. If you `docker rm -f tf-web`, Terraform plans to create it again. Terraform owns what is in its state; manual changes are "drift" and get reverted. In real teams, the rule is: **once a resource is managed by Terraform, change it only through Terraform.**
:::

## Pitfalls and production habits

- **Commit** `*.tf` and `.terraform.lock.hcl`. **Ignore** `.terraform/`, `*.tfstate`, `*.tfstate.*`, `*.tfplan`, and any `*.tfvars` holding secrets. A starter `.gitignore`:

  ```text
  .terraform/
  *.tfstate
  *.tfstate.*
  *.tfplan
  crash.log
  override.tf
  override.tf.json
  *_override.tf
  *_override.tf.json
  ```

- **Always read the plan summary line.** Look for `-/+` on anything stateful.
- **Pin versions** of Terraform and providers; upgrade deliberately with `init -upgrade` in its own PR.
- **Run `fmt -check` and `validate` in CI.** They're cheap and catch most silly mistakes.
- **Don't edit `terraform.tfstate` by hand.** Use `terraform state` subcommands (module 03).
- **One root module per blast radius.** Don't put networking, databases and every service in one giant config; a mistake in one plan should not be able to destroy everything.
- **Prefer references over hard-coded names** so the graph is correct.

:::try Explore a provider's schema
Run `terraform providers schema -json | jq '.provider_schemas["registry.terraform.io/kreuzwerker/docker"].resource_schemas.docker_container.block.attributes | keys'` inside a lab folder after `init`. This is the same schema the docs are generated from, and a handy way to discover attributes.
:::

## Summary

- IaC gives infrastructure history, review, reproducibility and recovery. Declarative tools converge to a desired state and are idempotent.
- Terraform core parses HCL, builds a graph and plans; providers (separate gRPC plugins from the registry) talk to real APIs.
- Pin `required_version` and `required_providers`; commit `.terraform.lock.hcl`.
- Workflow: `init` -> `fmt` -> `validate` -> `plan` -> `apply` -> `destroy`.
- In a plan, `+` create, `-` destroy, `~` update in place, `-/+` replace. Read the summary line and look for `# forces replacement`.
- References between resources create the dependency graph; `terraform graph` shows it.
