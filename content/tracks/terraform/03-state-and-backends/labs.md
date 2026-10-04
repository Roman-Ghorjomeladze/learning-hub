These labs use the local backend first, then an S3-compatible server running in Docker so you can practise remote state, locking and recovery for free. You need Terraform 1.11+ (for GA `use_lockfile`), a running Docker engine and `jq` (`brew install jq`).

```bash
mkdir -p ~/tf-labs/m03 && cd ~/tf-labs/m03
```

:::warning State files from these labs contain secrets
They're throwaway lab values, but build the habit: never commit `*.tfstate` and delete lab folders when done.
:::

## Lab 1: Inspect state and handle drift

:::meta
difficulty: easy
time: 25 min
:::

Goal: read a state file, watch the serial change, and practise both ways of handling drift.

### Steps

1. Create and apply a small config:

```bash
mkdir -p ~/tf-labs/m03/lab1 && cd ~/tf-labs/m03/lab1
cat > main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

resource "random_pet" "suffix" {}

resource "docker_image" "whoami" {
  name         = "traefik/whoami:latest"
  keep_locally = true
}

resource "docker_container" "whoami" {
  name    = "whoami-${random_pet.suffix.id}"
  image   = docker_image.whoami.image_id
  restart = "no"

  ports {
    internal = 80
    external = 8091
  }
}

output "container_name" {
  value = docker_container.whoami.name
}
EOF
terraform init && terraform apply -auto-approve
```

2. Explore the state:

```bash
jq '{version, terraform_version, serial, lineage}' terraform.tfstate
jq -r '.resources[] | "\(.mode) \(.type).\(.name) deps=\(.instances[0].dependencies // [])"' terraform.tfstate
terraform state list
terraform state show docker_container.whoami | head -20
ls -la terraform.tfstate*
```

3. Apply again with no changes and check whether `serial` changed. Then change `restart` to `"on-failure"`, apply, and check `serial` and the `.backup` file.

4. Create drift by hand and **revert** it:

```bash
docker update --restart=always "$(terraform output -raw container_name)"
terraform plan
terraform apply -auto-approve
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$(terraform output -raw container_name)"
```

5. Create drift again and **accept** it:

```bash
docker update --restart=unless-stopped "$(terraform output -raw container_name)"
terraform plan -refresh-only
terraform apply -refresh-only -auto-approve
terraform plan
```

Read the last plan. Then update `main.tf` so the final `terraform plan` shows no changes.

### Verify

- In step 4 the plan shows `~ restart = "always" -> "on-failure"` and after apply Docker reports `on-failure`.
- In step 5, the plan after `apply -refresh-only` still wants to change `restart` back until you set `restart = "unless-stopped"` in `main.tf`.

:::hint
A no-op apply doesn't write state when nothing changed, so `serial` stays the same. Any apply that changes something increments it and the local backend copies the previous state to `terraform.tfstate.backup`.
:::

:::solution
- `dependencies` for the container lists `docker_image.whoami` and `random_pet.suffix`: the recorded edges Terraform will use to destroy in the right order even if you delete all three blocks.
- Step 4 is "revert drift": the config is the source of truth and apply puts it back.
- Step 5 is "accept drift": `-refresh-only` updates state to `unless-stopped`, but config still says `on-failure`, so a normal plan proposes `~ restart = "unless-stopped" -> "on-failure"`. Change the config to `restart = "unless-stopped"` and the plan shows `No changes`. Accepting drift always means changing code too.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 2: Refactor safely with moved and state mv

:::meta
difficulty: medium
time: 25 min
:::

Goal: rename resources without destroying them, first with a `moved` block, then with `terraform state mv`.

### Steps

1. Set up:

```bash
mkdir -p ~/tf-labs/m03/lab2 && cd ~/tf-labs/m03/lab2
cat > main.tf <<'EOF'
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

resource "docker_image" "nginx" {
  name         = "nginx:1.30-alpine"
  keep_locally = true
}

resource "docker_container" "web" {
  name  = "tf-refactor-web"
  image = docker_image.nginx.image_id
  ports {
    internal = 80
    external = 8092
  }
}
EOF
terraform init && terraform apply -auto-approve
docker inspect -f '{{.Id}}' tf-refactor-web | cut -c1-12   # note this ID
```

2. Rename the resource label `web` to `frontend` **only** (keep `name = "tf-refactor-web"`). Run `terraform plan` and read it. Don't apply.

3. Add a `moved` block, run `terraform plan`, then apply. Check the container ID again.

4. Now rename `docker_image.nginx` to `docker_image.web` using the CLI instead:

```bash
# edit main.tf: change the label "nginx" to "web" and update the reference in the container
terraform plan                       # what does it propose?
terraform state mv docker_image.nginx docker_image.web
terraform plan
```

5. Remove the `moved` block and plan again.

### Verify

- Step 2 plan: `Plan: 1 to add, 0 to change, 1 to destroy.`
- Step 3 plan: `docker_container.web has moved to docker_container.frontend` and `0 to add, 0 to change, 0 to destroy`; the container ID is unchanged after apply.
- Step 4: after `state mv`, the plan shows no changes.
- Step 5: still no changes, because state already uses the new address.

:::hint
The `moved` block goes at the top level of any `.tf` file in the module, not inside the resource:

```hcl
moved {
  from = docker_container.web
  to   = docker_container.frontend
}
```
:::

:::solution
Final `main.tf`:

```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

resource "docker_image" "web" {
  name         = "nginx:1.30-alpine"
  keep_locally = true
}

resource "docker_container" "frontend" {
  name  = "tf-refactor-web"
  image = docker_image.web.image_id
  ports {
    internal = 80
    external = 8092
  }
}
```

**`moved` vs `state mv`**: both change only the address in state. `moved` is code: it's reviewed in a PR, applied through the normal plan in every environment, and shown in the plan. `state mv` changes state immediately, must be repeated by hand for every environment/state, and isn't visible in code review. In a team, prefer `moved`. Removing the `moved` block in step 5 was safe only because this is the single state that uses this code; in a shared module, keep it.
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 3: Import a hand-made container, then stop managing it

:::meta
difficulty: medium
time: 35 min
:::

Goal: adopt an existing object with an `import` block and generated config, then release it with a `removed` block.

### Steps

1. Create a "legacy" container by hand, as if someone did it during an incident:

```bash
docker pull redis:8-alpine
docker run -d --name legacy-redis --restart unless-stopped -p 6380:6379 redis:8-alpine
docker inspect -f '{{.Id}}' legacy-redis
```

2. Write only the provider setup, a data source for the image, and an `import` block:

```bash
mkdir -p ~/tf-labs/m03/lab3 && cd ~/tf-labs/m03/lab3
cat > main.tf <<'EOF'
terraform {
  required_version = ">= 1.11"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6"
    }
  }
}

data "docker_image" "redis" {
  name = "redis:8-alpine"
}
EOF

cat > imports.tf <<EOF
import {
  to = docker_container.legacy_redis
  id = "$(docker inspect -f '{{.Id}}' legacy-redis)"
}
EOF
cat imports.tf
terraform init
```

3. Generate a draft config:

```bash
terraform plan -generate-config-out=generated.tf
less generated.tf
```

4. Clean up `generated.tf` into a small, readable resource block in `main.tf` (and delete `generated.tf`). Keep only what matters: `name`, `image` (use `data.docker_image.redis.id`), `restart`, `ports`. Re-run `terraform plan` until it says `1 to import, 0 to add, 0 to change, 0 to destroy` (or only harmless in-place updates). Then apply.

5. Prove Terraform now manages it: change `restart` to `"always"` in code and apply. Check with `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' legacy-redis`.

6. Hand the container back: replace the resource block (and the import block) with a `removed` block that keeps the container. Plan, apply, then confirm the container is still running and `terraform state list` no longer shows it.

### Verify

- After step 4 apply, `terraform state list` shows `docker_container.legacy_redis` and the container ID is unchanged (`docker ps`).
- After step 6, `docker ps --filter name=legacy-redis` still shows it running and state no longer contains it.

:::hint
- If the plan says the container "must be replaced", look for the attribute marked `# forces replacement` and make your config match the real value (`terraform state show` isn't available yet, but the generated file and `docker inspect legacy-redis` are).
- A common culprit is `image`: the real container stores the image **ID** (`sha256:...`). `data.docker_image.redis.id` gives you that ID at plan time.
- Generated config is experimental and verbose; it may also include attributes that conflict with each other. Delete anything you didn't set when you ran `docker run`.
:::

:::solution
A cleaned-up resource for step 4 (your generated file will contain many more attributes; the exact set depends on the provider version):

```hcl
resource "docker_container" "legacy_redis" {
  name    = "legacy-redis"
  image   = data.docker_image.redis.id
  restart = "unless-stopped"

  ports {
    internal = 6379
    external = 6380
    ip       = "0.0.0.0"
    protocol = "tcp"
  }
}
```

If the plan still proposes a replacement because of an attribute you didn't set yourself (for example something the image provides by default, like `command` or `env`), copy the real value from `generated.tf` into your block: the goal of an import is "no destructive change". Only in-place updates (`~`) are acceptable, and only if you understand them.

Step 6, replacing the resource and import blocks:

```hcl
removed {
  from = docker_container.legacy_redis

  lifecycle {
    destroy = false
  }
}
```

The plan says `docker_container.legacy_redis will no longer be managed by Terraform` with `0 to destroy`. The CLI equivalent would have been `terraform state rm docker_container.legacy_redis`.
:::

### Clean up

```bash
docker rm -f legacy-redis
cd ~/tf-labs/m03 && rm -rf lab3
```

## Lab 4: Remote state on an S3-compatible server with locking

:::meta
difficulty: hard
time: 40 min
:::

Goal: run an S3-compatible server locally, migrate state to it, and watch native lockfile locking work.

### Steps

1. Start Silo (a maintained MinIO fork; same commands and env vars as MinIO). Pin the tag; check `hub.docker.com/r/pgsty/silo/tags` if it has moved on:

```bash
docker volume create tf-s3-data
docker run -d --name tf-s3 \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=tfadmin \
  -e MINIO_ROOT_PASSWORD=tfadmin-secret \
  -v tf-s3-data:/data \
  pgsty/silo:RELEASE.2026-09-16T00-00-00Z server /data --console-address :9001

sleep 3
docker exec tf-s3 mc alias set local http://127.0.0.1:9000 tfadmin tfadmin-secret
docker exec tf-s3 mc mb local/tfstate
docker exec tf-s3 mc version enable local/tfstate
```

The web console is at http://localhost:9001 (log in with the credentials above).

2. Create a config with **local** state first:

```bash
mkdir -p ~/tf-labs/m03/lab4 && cd ~/tf-labs/m03/lab4
cat > main.tf <<'EOF'
terraform {
  required_version = ">= 1.11"
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

resource "random_pet" "name" {
  length = 3
}

resource "terraform_data" "slow" {
  triggers_replace = timestamp() # changes on every run, so every apply replaces it

  provisioner "local-exec" {
    command = "echo 'deploying ${random_pet.name.id}...'; sleep 40"
  }
}

output "pet" {
  value = random_pet.name.id
}
EOF
terraform init && terraform apply -auto-approve   # takes ~40s
ls terraform.tfstate
```

3. Add a backend with **partial configuration** and migrate:

```bash
cat > backend.tf <<'EOF'
terraform {
  backend "s3" {}
}
EOF

cat > local.s3.tfbackend <<'EOF'
bucket       = "tfstate"
key          = "labs/m03/terraform.tfstate"
region       = "us-east-1"
use_lockfile = true

endpoints = {
  s3 = "http://localhost:9000"
}
use_path_style              = true
skip_credentials_validation = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_region_validation      = true
EOF

export AWS_ACCESS_KEY_ID=tfadmin
export AWS_SECRET_ACCESS_KEY=tfadmin-secret

terraform init -backend-config=local.s3.tfbackend -migrate-state
docker exec tf-s3 mc ls --recursive local/tfstate
```

Answer `yes` when asked to copy existing state. Then delete the local copy: `rm terraform.tfstate terraform.tfstate.backup`.

4. Watch locking. In **terminal A** (same folder, same env vars):

```bash
terraform apply -auto-approve
```

While it sleeps, in **terminal B**:

```bash
cd ~/tf-labs/m03/lab4
export AWS_ACCESS_KEY_ID=tfadmin AWS_SECRET_ACCESS_KEY=tfadmin-secret
terraform plan
docker exec tf-s3 mc ls --recursive local/tfstate
docker exec tf-s3 mc cat local/tfstate/labs/m03/terraform.tfstate.tflock; echo
terraform plan -lock-timeout=60s
```

5. Check the bucket's version history of the state object:

```bash
docker exec tf-s3 mc ls --versions local/tfstate/labs/m03/terraform.tfstate
```

### Verify

- After step 3, `mc ls` shows `labs/m03/terraform.tfstate` and `terraform state list` still lists both resources.
- In step 4, the first plan in terminal B fails with `Error acquiring the state lock` and shows lock info (who, operation, ID). The `.tflock` object exists while the apply runs and disappears afterwards. The plan with `-lock-timeout=60s` waits and then succeeds.
- Step 5 lists several versions of the state object.

:::hint
- `NoCredentialProviders` or `InvalidAccessKeyId`: the `AWS_*` env vars aren't exported in that terminal.
- `bucket does not exist`: the `mc mb` step failed. If the `mc` command isn't present in the image you pulled, create the bucket with curl's built-in SigV4 signing: `curl --aws-sigv4 "aws:amz:us-east-1:s3" --user "tfadmin:tfadmin-secret" -X PUT http://localhost:9000/tfstate`.
- Errors mentioning checksums on upload: add `skip_s3_checksum = true` to the `.tfbackend` file and re-run `terraform init -backend-config=local.s3.tfbackend -reconfigure`.
- Don't set `encrypt = true` here: server-side encryption needs a KMS configured on the server. On real AWS, always set it.
:::

:::solution
Expected lock error in terminal B:

```text
Error: Error acquiring the state lock

Error message: operation error S3: PutObject, https response error StatusCode: 412, ...
PreconditionFailed: At least one of the pre-conditions you specified did not hold
Lock Info:
  ID:        0b9e1f6a-...
  Path:      tfstate/labs/m03/terraform.tfstate
  Operation: OperationTypeApply
  Who:       roma@MacBook-Pro.local
  Version:   1.16.5
```

The `.tflock` object contains the same lock info as JSON. Terraform created it with a conditional `PutObject` (`If-None-Match: *`), so the second writer's conditional put fails with HTTP 412. That's the whole locking mechanism, no DynamoDB involved.

Why partial configuration: the backend block can't use variables, so environment-specific settings live in `.tfbackend` files you pass at init. The same code can point at `dev.s3.tfbackend` or `prod.s3.tfbackend`.
:::

### Clean up

Keep `tf-s3` and this folder running if you're continuing with Labs 5 and 6. Otherwise:

```bash
terraform destroy -auto-approve
docker rm -f tf-s3 && docker volume rm tf-s3-data
```

## Lab 5: Break & fix: the Monday morning state incident

:::meta
difficulty: hard
time: 30 min
:::

Goal: diagnose and fix two classic state problems: a stale lock and a resource that fell out of state. Requires Lab 4's server and bucket.

### Steps

1. Create a new config with a container, using the remote backend:

```bash
mkdir -p ~/tf-labs/m03/lab5 && cd ~/tf-labs/m03/lab5
export AWS_ACCESS_KEY_ID=tfadmin AWS_SECRET_ACCESS_KEY=tfadmin-secret
cp ../lab4/local.s3.tfbackend . && sed -i '' 's#labs/m03/terraform.tfstate#labs/m03-incident/terraform.tfstate#' local.s3.tfbackend

cat > main.tf <<'EOF'
terraform {
  required_version = ">= 1.11"
  backend "s3" {}
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
  name    = "incident-echo"
  image   = docker_image.echo.image_id
  command = ["-text=all good"]
  ports {
    internal = 5678
    external = 8093
  }
}

resource "terraform_data" "deploy_marker" {
  triggers_replace = timestamp()
  provisioner "local-exec" {
    command = "sleep 30"
  }
}
EOF
terraform init -backend-config=local.s3.tfbackend
terraform apply -auto-approve
```

(On Linux, use `sed -i` without `''`.)

2. **Sabotage** (run this exactly; it's the "what happened over the weekend" part):

```bash
terraform state rm docker_container.echo
terraform apply -auto-approve &
sleep 8 && pkill -9 -f "terraform apply"; sleep 1
echo "sabotage complete"
```

3. Now, as the on-call engineer, run `terraform plan` and make it succeed with **no destructive changes** and the existing `incident-echo` container (check its ID before and after) still serving traffic.

### Verify

```bash
docker inspect -f '{{.Id}}' incident-echo | cut -c1-12   # same ID as before the fix
terraform plan                                           # only terraform_data replacement, nothing for the container
curl -s localhost:8093                                   # all good
```

:::hint
1. The first error is about a lock. Who holds it? Is that process still alive (`pgrep -fl terraform`)? Only then use `force-unlock`.
2. The second problem appears as a plan that wants to **create** `docker_container.echo`. If you applied that, Docker would refuse because a container named `incident-echo` already exists. The object exists; Terraform just forgot about it.
:::

:::solution
**Problem 1: stale lock.** `terraform plan` fails with `Error acquiring the state lock`. The holder was the `kill -9`'d apply, which never released it. Confirm nothing is running (`pgrep -fl "terraform apply"` prints nothing), then:

```bash
terraform force-unlock <ID-from-the-error>
```

Type `yes`. (You could also see the lock object with `docker exec tf-s3 mc ls -r local/tfstate`.)

**Problem 2: resource missing from state.** The plan says `docker_container.echo will be created`. Re-adopt it with an import block:

```bash
cat > imports.tf <<EOF
import {
  to = docker_container.echo
  id = "$(docker inspect -f '{{.Id}}' incident-echo)"
}
EOF
terraform plan    # docker_container.echo will be imported; no replacement
terraform apply -auto-approve
rm imports.tf
```

Only apply once the plan shows `will be imported` without `must be replaced` next to the container. If a replacement shows up, find the `# forces replacement` attribute and make the config match the real container (as in Lab 3).

**Lessons:** never `kill -9` Terraform (Ctrl+C once lets it stop gracefully and release the lock); `state rm` is silent and dangerous, prefer a reviewed `removed` block; and any "plan wants to create something that already exists" means "import it".
:::

### Clean up

```bash
terraform destroy -auto-approve
```

## Lab 6: Challenge: restore a previous state version

:::meta
difficulty: hard
time: 35 min
:::

Goal: recover from a bad state write using bucket versioning, without touching infrastructure.

### Scenario

In the Lab 4 folder (`~/tf-labs/m03/lab4`, versioned bucket), a teammate "cleaned up" state by running:

```bash
terraform state rm random_pet.name
```

Now `terraform plan` wants to create a brand new `random_pet`, which would change the name of everything downstream.

### Requirements

1. Run the sabotage command above, and confirm the plan wants to create `random_pet.name`.
2. Using the bucket's version history, find the state version **before** the `state rm`.
3. Download it and inspect it with `jq` to confirm it contains `random_pet.name` with the old pet name.
4. Restore it with `terraform state push`. Explain why a plain push may be rejected and what that check protects you from.
5. `terraform plan` must no longer propose creating `random_pet.name`, and `terraform output pet` must show the original name.
6. Do not use `terraform import` for this one (random_pet does support import, but the point is restoring from history).

:::hint
`mc ls --versions` lists version IDs, newest first. `mc cp --version-id <ID> local/tfstate/<key> /tmp/restore.tfstate` inside the container, then `docker cp tf-s3:/tmp/restore.tfstate .`. Compare the `serial` in the file with `terraform state pull | jq .serial`.
:::

:::solution
```bash
cd ~/tf-labs/m03/lab4
export AWS_ACCESS_KEY_ID=tfadmin AWS_SECRET_ACCESS_KEY=tfadmin-secret
terraform output pet                      # note the original name
terraform state rm random_pet.name
terraform plan                            # + random_pet.name will be created

KEY=labs/m03/terraform.tfstate
docker exec tf-s3 mc ls --versions local/tfstate/$KEY
# pick the second-newest version ID (the one before the state rm)
docker exec tf-s3 mc cp --version-id <VERSION_ID> local/tfstate/$KEY /tmp/restore.tfstate
docker cp tf-s3:/tmp/restore.tfstate ./restore.tfstate

jq '.serial, .lineage, [.resources[] | "\(.type).\(.name)"]' restore.tfstate
terraform state pull | jq '.serial, .lineage'

terraform state push restore.tfstate
```

`state push` refuses if the file's **lineage** differs (it's a different state entirely) or its **serial** is lower than the current remote serial (you'd be overwriting newer changes). Here the restored file has a lower serial than the current state, so the push is rejected. Since you've verified that this older version is exactly what you want, you have two options:

- Edit the file's `serial` to be higher than the current one (`jq '.serial = <current+1>' restore.tfstate > restore2.tfstate`) and push that. This keeps the safety check meaningful.
- Or `terraform state push -force restore.tfstate`, which skips the checks. Use only after double-checking lineage matches.

Then:

```bash
terraform plan            # random_pet.name no longer created (only terraform_data, which always replaces)
terraform output pet      # original name is back
rm restore*.tfstate       # contains secrets in real life
```

This is why the state bucket must have versioning enabled: it turns "we lost state" into a five-minute restore.
:::

### Clean up

```bash
cd ~/tf-labs/m03/lab4 && terraform destroy -auto-approve
docker rm -f tf-s3 && docker volume rm tf-s3-data
cd ~ && rm -rf ~/tf-labs/m03
```
