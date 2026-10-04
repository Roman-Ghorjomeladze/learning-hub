These labs take pods apart: you will provoke every common status, build init and sidecar setups, use the shared network and the downward API, fix a slow shutdown, diagnose broken pods and debug a container that has no shell.

**Prerequisites:** the `lab` kind cluster from module 02. If you deleted it:

```bash
cd ~/k8s-labs/02 && kind create cluster --config kind-lab.yaml
```

(Any kind cluster works for this module; `kind create cluster --name lab` is enough if you skipped module 02.)

Create a namespace and make it the default for these labs:

```bash
mkdir -p ~/k8s-labs/03 && cd ~/k8s-labs/03
kubectl create namespace pods-lab
kubectl config set-context --current --namespace=pods-lab
```

## Lab 1: Phases, container states and restart policies

:::meta
difficulty: easy
time: 25 min
:::

Goal: produce `Completed`, `Error`, `CrashLoopBackOff` and `OOMKilled` on purpose, and read phase, state, exit code and restart count for each.

### Steps

1. Create five pods with different commands and restart policies:

```bash
cat > statuses.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: ok-never }
spec:
  restartPolicy: Never
  containers:
    - { name: main, image: busybox:1.37, command: ["sh", "-c", "echo done; exit 0"] }
---
apiVersion: v1
kind: Pod
metadata: { name: fail-never }
spec:
  restartPolicy: Never
  containers:
    - { name: main, image: busybox:1.37, command: ["sh", "-c", "echo oops >&2; exit 3"] }
---
apiVersion: v1
kind: Pod
metadata: { name: fail-always }
spec:
  restartPolicy: Always
  containers:
    - { name: main, image: busybox:1.37, command: ["sh", "-c", "echo crashing; sleep 2; exit 1"] }
---
apiVersion: v1
kind: Pod
metadata: { name: ok-onfailure }
spec:
  restartPolicy: OnFailure
  containers:
    - { name: main, image: busybox:1.37, command: ["sh", "-c", "echo finished; exit 0"] }
---
apiVersion: v1
kind: Pod
metadata: { name: memory-hog }
spec:
  restartPolicy: Always
  containers:
    - name: main
      image: busybox:1.37
      command: ["sh", "-c", "echo eating memory; tail /dev/zero"]
      resources:
        requests: { memory: 32Mi }
        limits: { memory: 32Mi }
EOF
kubectl apply -f statuses.yaml
```

2. Watch for about a minute:

```bash
kubectl get pods -w
```

3. Print phase, restart count and the last termination for every pod:

```bash
kubectl get pods -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount,STATE:.status.containerStatuses[0].state,LAST_EXIT:.status.containerStatuses[0].lastState.terminated.exitCode,LAST_REASON:.status.containerStatuses[0].lastState.terminated.reason'
```

4. Look closer at two of them:

```bash
kubectl describe pod memory-hog | sed -n '/State:/,/Restart Count/p'
kubectl describe pod fail-always | sed -n '/Events:/,$p'
kubectl logs fail-always --previous
```

### Verify

Fill in this table from your own output before reading the solution:

| Pod | STATUS column | Phase | Exit code | Restarts |
| --- | --- | --- | --- | --- |
| ok-never | ? | ? | ? | ? |
| fail-never | ? | ? | ? | ? |
| fail-always | ? | ? | ? | ? |
| ok-onfailure | ? | ? | ? | ? |
| memory-hog | ? | ? | ? | ? |

:::hint
`tail /dev/zero` keeps buffering because `/dev/zero` never produces a newline, so its memory grows until the kernel OOM killer stops it. For pods that keep restarting, the exit code is in `lastState`, not `state`.
:::

:::solution
| Pod | STATUS column | Phase | Exit code | Restarts |
| --- | --- | --- | --- | --- |
| ok-never | `Completed` | `Succeeded` | 0 | 0 |
| fail-never | `Error` | `Failed` | 3 | 0 |
| fail-always | `CrashLoopBackOff` / `Error` / `Running` (cycling) | `Running` | 1 (in lastState) | growing |
| ok-onfailure | `Completed` | `Succeeded` | 0 | 0 |
| memory-hog | `OOMKilled` / `CrashLoopBackOff` | `Running` | 137, reason `OOMKilled` | growing |

Key points:

- A crash-looping pod is in phase `Running`: the pod is alive, its container keeps being restarted in place (same pod name, same IP).
- The back-off between restarts grows (watch the `AGE` of restarts in events: `Back-off restarting failed container`).
- Exit 137 = 128 + SIGKILL(9). With `reason: OOMKilled` it means the memory limit was hit. The same code without OOMKilled usually means the container did not exit within the termination grace period.
- `OnFailure` with exit 0 behaves like `Never`: the pod completes.
:::

### Clean up

```bash
kubectl delete -f statuses.yaml
```

## Lab 2: Init containers and native sidecars

:::meta
difficulty: medium
time: 30 min
:::

Goal: gate a pod on a dependency with an init container, ship its logs with a native sidecar through a shared `emptyDir`, and prove that native sidecars do not block Job completion.

### Steps

1. Create a pod whose init container waits for a Service called `config-api` to exist in DNS:

```bash
cat > app-with-sidecar.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: app
  labels: { app: demo }
spec:
  initContainers:
    - name: wait-for-config-api
      image: busybox:1.37
      command: ["sh", "-c", "until nslookup -type=a config-api.pods-lab.svc.cluster.local 2>&1 | grep -q '^Name:'; do echo waiting for config-api; sleep 3; done"]
    - name: log-shipper
      image: busybox:1.37
      restartPolicy: Always
      command: ["sh", "-c", "touch /logs/app.log; tail -n+1 -F /logs/app.log | sed 's/^/[shipped] /'"]
      volumeMounts:
        - { name: logs, mountPath: /logs }
  containers:
    - name: app
      image: busybox:1.37
      command: ["sh", "-c", "i=0; while true; do i=$((i+1)); echo \"$(date -Iseconds) request $i handled\" >> /logs/app.log; sleep 2; done"]
      volumeMounts:
        - { name: logs, mountPath: /logs }
  volumes:
    - name: logs
      emptyDir: {}
EOF
kubectl apply -f app-with-sidecar.yaml
sleep 10
kubectl get pod app
kubectl logs app -c wait-for-config-api --tail=3
```

2. Satisfy the dependency by creating the Service, then watch the pod progress:

```bash
kubectl create service clusterip config-api --tcp=80:8080
kubectl get pod app -w      # Ctrl+C once it is Running with 2/2
```

3. Read the sidecar's output and check container order:

```bash
kubectl logs app -c log-shipper --tail=5
kubectl get pod app -o jsonpath='{range .status.initContainerStatuses[*]}{.name}{" ready="}{.ready}{" started="}{.started}{"\n"}{end}'
```

4. Now a Job with a native sidecar: the main container finishes after 10 seconds.

```bash
cat > job-with-sidecar.yaml <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: report
spec:
  template:
    spec:
      restartPolicy: Never
      initContainers:
        - name: proxy
          image: busybox:1.37
          restartPolicy: Always
          command: ["sh", "-c", "trap 'echo proxy stopping; exit 0' TERM; echo proxy up; while true; do sleep 1; done"]
      containers:
        - name: main
          image: busybox:1.37
          command: ["sh", "-c", "echo generating report; sleep 10; echo report done"]
EOF
kubectl apply -f job-with-sidecar.yaml
kubectl wait --for=condition=Complete job/report --timeout=90s
kubectl logs job/report -c proxy
```

### Verify

- Before the Service existed, STATUS was `Init:0/2` and the init container logged `waiting for config-api`.
- After it was created, the pod reached `2/2 Running` (READY counts the app and the sidecar).
- `kubectl logs app -c log-shipper` shows `[shipped] ... request N handled` lines.
- The Job reached `Complete`, and the proxy logged `proxy stopping`.

:::hint
If the Job never completes, check whether `restartPolicy: Always` is on the *init container* (sidecar) and not missing. A classic sidecar in `containers` would keep the pod running forever. If the pod shows `Init:0/2` forever after you created the Service, check its namespace: the init container looks up `config-api.pods-lab.svc.cluster.local`.
:::

:::solution
- Init containers run sequentially: `wait-for-config-api` must **exit 0** before `log-shipper` starts. Because `log-shipper` has `restartPolicy: Always`, it is a sidecar: the kubelet starts it and, once started, moves on to the app container without waiting for it to exit.
- READY `2/2` includes the sidecar. Sidecars can also have readiness probes, and their readiness counts towards the pod's.
- In the Job, when `main` exits 0 the kubelet sends SIGTERM to the sidecar (the trap prints `proxy stopping`), the pod reaches `Succeeded`, and the Job completes. Before native sidecars, people needed hacks such as the main container writing a "done" file that the sidecar polled.
:::

### Clean up

```bash
kubectl delete -f app-with-sidecar.yaml -f job-with-sidecar.yaml
kubectl delete service config-api
```

## Lab 3: Shared network namespace and the downward API

:::meta
difficulty: medium
time: 25 min
:::

Goal: see that containers in a pod share `localhost` and a port space, and expose pod metadata as env vars and live-updating files.

### Steps

1. A pod with nginx and a helper container that talks to it over localhost, plus downward API env vars and a volume:

```bash
cat > shared.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: shared
  labels:
    app: shared
    app.kubernetes.io/version: "1.0.0"
spec:
  containers:
    - name: web
      image: nginx:1.27-alpine
      resources:
        limits: { memory: 64Mi, cpu: 200m }
    - name: helper
      image: busybox:1.37
      command: ["sh", "-c", "sleep infinity"]
      env:
        - name: POD_NAME
          valueFrom: { fieldRef: { fieldPath: metadata.name } }
        - name: POD_IP
          valueFrom: { fieldRef: { fieldPath: status.podIP } }
        - name: NODE_NAME
          valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
        - name: APP_VERSION
          valueFrom: { fieldRef: { fieldPath: "metadata.labels['app.kubernetes.io/version']" } }
        - name: WEB_MEMORY_LIMIT_MB
          valueFrom: { resourceFieldRef: { containerName: web, resource: limits.memory, divisor: 1Mi } }
      volumeMounts:
        - { name: podinfo, mountPath: /etc/podinfo }
  volumes:
    - name: podinfo
      downwardAPI:
        items:
          - { path: labels, fieldRef: { fieldPath: metadata.labels } }
          - { path: annotations, fieldRef: { fieldPath: metadata.annotations } }
EOF
kubectl apply -f shared.yaml
kubectl wait --for=condition=Ready pod/shared --timeout=60s
```

2. From the helper, call nginx on localhost and print the env:

```bash
kubectl exec shared -c helper -- wget -qO- localhost:80 | head -4
kubectl exec shared -c helper -- sh -c 'env | grep -E "POD_|NODE_|APP_|WEB_"'
kubectl get pod shared -o wide
```

3. Change a label and an annotation, then re-read the files and the env var:

```bash
kubectl label pod shared app.kubernetes.io/version=1.1.0 --overwrite
kubectl annotate pod shared owner=roma
sleep 60   # the kubelet refreshes downwardAPI volumes periodically
kubectl exec shared -c helper -- cat /etc/podinfo/labels /etc/podinfo/annotations
kubectl exec shared -c helper -- printenv APP_VERSION
```

4. Try to run a second web server on the same port in the same pod:

```bash
cat > clash.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: clash }
spec:
  containers:
    - { name: web1, image: nginx:1.27-alpine }
    - { name: web2, image: nginx:1.27-alpine }
EOF
kubectl apply -f clash.yaml
sleep 20
kubectl get pod clash
kubectl logs clash -c web2 --tail=5
```

### Verify

- `wget localhost:80` from the helper returns the nginx welcome page.
- `POD_IP` equals the IP shown by `kubectl get pod -o wide`, and `WEB_MEMORY_LIMIT_MB=64`.
- After the label change, `/etc/podinfo/labels` shows `1.1.0`, but `APP_VERSION` still prints `1.0.0`.
- `clash` shows `1/2` ready and `web2` logs `Address in use` (or similar bind error).

:::hint
Env vars are captured once when the container starts; volume files are refreshed by the kubelet. For the clash, remember there is only one network namespace per pod.
:::

:::solution
- Both containers share the pod's network namespace (owned by the pause container), so `localhost:80` in the helper is nginx.
- The downward API env vars are resolved at container start and never change; restart the container to pick up new values. The `downwardAPI` volume is updated in place (eventually consistent, typically within a minute), which is why tools that react to label changes read files.
- In `clash`, `web2` fails with `bind() to 0.0.0.0:80 failed (98: Address in use)` and goes into CrashLoopBackOff. Containers in a pod must use distinct ports.
:::

### Clean up

```bash
kubectl delete -f shared.yaml -f clash.yaml
```

## Lab 4: Break & fix — the pod that takes 30 seconds to die

:::meta
difficulty: medium
time: 30 min
:::

Goal: diagnose why deleting a Node.js pod hangs, then implement a correct graceful shutdown.

### Steps

1. Deploy a tiny Node.js HTTP server (the code is inline so you do not need to build an image):

```bash
cat > slow-stop.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: slow-stop
spec:
  containers:
    - name: api
      image: node:22-alpine
      command: ["node", "-e"]
      args:
        - |
          const http = require('node:http');
          const server = http.createServer((req, res) => res.end('hello\n'));
          server.listen(3000, () => console.log('listening on 3000, pid', process.pid));
EOF
kubectl apply -f slow-stop.yaml
kubectl wait --for=condition=Ready pod/slow-stop --timeout=90s
```

2. Measure how long a delete takes:

```bash
time kubectl delete pod slow-stop
```

3. Diagnose. Why does it take that long? Recreate the pod and gather evidence (PID, signals, events, exit code).

4. Fix it so that delete completes in a couple of seconds, the server stops accepting new connections and logs a shutdown message, and a 3-second preStop delay protects against the endpoint race. Measure again.

### Verify

- Before the fix: delete takes about 30 seconds.
- After the fix: delete takes roughly 3–5 seconds (the preStop sleep plus shutdown), and `kubectl logs -f slow-stop` (started before the delete) shows your shutdown message.

:::hint
Exec into the running pod and check which PID the Node process has: `kubectl exec slow-stop -- ps`. What does Linux do with a signal sent to PID 1 when the process has not installed a handler? 30 seconds is a very specific number: which pod field defaults to 30?
:::

:::solution
Evidence:

```bash
kubectl apply -f slow-stop.yaml && kubectl wait --for=condition=Ready pod/slow-stop
kubectl exec slow-stop -- ps -o pid,args
# PID 1 is: node -e ...
kubectl get pod slow-stop -o jsonpath='{.spec.terminationGracePeriodSeconds}{"\n"}'
# 30
```

Cause: the Node process is PID 1 in its container. The kernel does not apply default signal actions to PID 1, so SIGTERM is simply ignored because the script installs no handler. The kubelet waits the full `terminationGracePeriodSeconds` (30 s) and then sends SIGKILL (exit code 137). In a Deployment, this makes every rollout slow and kills in-flight requests abruptly.

Fixed manifest:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: slow-stop
spec:
  terminationGracePeriodSeconds: 20
  containers:
    - name: api
      image: node:22-alpine
      command: ["node", "-e"]
      args:
        - |
          const http = require('node:http');
          const server = http.createServer((req, res) => res.end('hello\n'));
          server.listen(3000, () => console.log('listening on 3000, pid', process.pid));
          process.on('SIGTERM', () => {
            console.log('SIGTERM received, closing server');
            server.close(() => { console.log('closed, bye'); process.exit(0); });
            setTimeout(() => process.exit(1), 10000).unref();
          });
      lifecycle:
        preStop:
          sleep:
            seconds: 3
```

(If your cluster is older than v1.32 and rejects `sleep`, use `exec: { command: ["sleep", "3"] }`; `node:22-alpine` has `sleep` via busybox.)

```bash
kubectl delete pod slow-stop --ignore-not-found
kubectl apply -f slow-stop.yaml && kubectl wait --for=condition=Ready pod/slow-stop
kubectl logs -f slow-stop &
time kubectl delete pod slow-stop
```

Order of events: preStop sleeps 3 s (during which the pod is already removed from Service endpoints), then SIGTERM, then `server.close()` stops accepting connections and waits for in-flight requests, then exit 0.

Alternatives: `tini` as PID 1 (`command: ["/sbin/tini", "--", "node", ...]` in images that include it), or `shareProcessNamespace: true` so the pause container is PID 1. But handling SIGTERM in the app is still needed to drain properly. In NestJS use `app.enableShutdownHooks()`.
:::

### Clean up

```bash
kubectl delete pod slow-stop --ignore-not-found
```

## Lab 5: Break & fix — three broken pods

:::meta
difficulty: medium
time: 30 min
:::

Goal: diagnose three pods that fail for three different reasons, using only `get`, `describe`, `logs` and `events`.

### Steps

1. Apply the broken manifests (do not read them too closely; diagnose from the cluster):

```bash
cat > broken.yaml <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: broken-a }
spec:
  containers:
    - name: api
      image: nginx:1.27-alpine
      env:
        - name: DATABASE_URL
          valueFrom: { secretKeyRef: { name: shipit-db, key: url } }
---
apiVersion: v1
kind: Pod
metadata: { name: broken-b }
spec:
  containers:
    - name: api
      image: node:22-alpine
      command: ["nodejs", "-e", "console.log('hi'); setInterval(() => {}, 1000)"]
---
apiVersion: v1
kind: Pod
metadata: { name: broken-c }
spec:
  containers:
    - name: web
      image: nginx:1.27-alpine
      livenessProbe:
        httpGet: { path: /, port: 8080 }
        initialDelaySeconds: 2
        periodSeconds: 3
        failureThreshold: 2
EOF
kubectl apply -f broken.yaml
sleep 45
kubectl get pods
```

2. For each pod, find the root cause and fix it.

### Verify

All three pods are `Running` with `1/1` ready and 0 new restarts over two minutes.

:::hint
- `broken-a`: STATUS `CreateContainerConfigError`. Look at the events: what is missing?
- `broken-b`: STATUS `RunContainerError` or `CrashLoopBackOff`. Read the `Last State` message in describe.
- `broken-c`: STATUS flips between `Running` and `CrashLoopBackOff` while the restart count grows, yet nginx logs look healthy. Read the events.
:::

:::solution
```bash
kubectl describe pod broken-a | sed -n '/Events:/,$p'
# Error: secret "shipit-db" not found
kubectl create secret generic shipit-db --from-literal=url=postgres://shipit:pw@postgres:5432/shipit
# the kubelet retries automatically; broken-a starts within seconds

kubectl describe pod broken-b | grep -A4 'Last State'
# exec: "nodejs": executable file not found in $PATH   (reason StartError, exit code 128 on containerd)
# command is immutable on a running pod: fix the manifest (nodejs -> node) and recreate
kubectl delete pod broken-b
# edit broken.yaml: command: ["node", "-e", ...]

kubectl describe pod broken-c | sed -n '/Events:/,$p'
# Liveness probe failed: Get "http://10.244.x.y:8080/": connection refused
# Container web failed liveness probe, will be restarted
# nginx listens on 80, the probe checks 8080. Fix the port (pod probes are immutable, so recreate)
kubectl delete pod broken-c
# edit broken.yaml: port: 80

kubectl apply -f broken.yaml
kubectl get pods -w
```

Lessons:

- `CreateContainerConfigError` means the kubelet could not build the container config: missing Secret/ConfigMap or key. It resolves itself once the object exists.
- `StartError` / "executable file not found" means a wrong `command` (if the command runs through a shell, the same mistake shows up as exit code 127 instead). Remember `command` overrides the image ENTRYPOINT.
- A wrong liveness probe produces a healthy-looking app that is restarted forever. Logs show nothing wrong; events show the probe failures. Always check events.
- Most pod spec fields are immutable. You fix the template (in a real setup: the Deployment) and let new pods be created.
:::

### Clean up

```bash
kubectl delete -f broken.yaml
kubectl delete secret shipit-db
```

## Lab 6: Challenge — debug a container with no shell

:::meta
difficulty: hard
time: 35 min
:::

Goal: use ephemeral containers and pod copies to investigate a minimal image. No step-by-step.

### Setup

```bash
kubectl run mystery --image=hashicorp/http-echo --port=5678 -- -text="the answer is 42" -listen=:5678
kubectl wait --for=condition=Ready pod/mystery --timeout=60s
kubectl exec mystery -- sh    # fails: there is no shell in this image
```

### Requirements

1. Using an ephemeral container, find the full command line of the running process in the `mystery` container and the port it listens on.
2. From the ephemeral container, fetch the HTTP response from the app over `localhost`.
3. List the files at the root of the **mystery container's** filesystem (not the debug container's).
4. Show that the ephemeral container is now part of the pod spec, and explain why you cannot remove it.
5. Create a debug **copy** of the pod named `mystery-debug` in which you can run a shell with busybox alongside the original container, without touching the original pod.

### Verify

- You printed `/http-echo -text=the answer is 42 -listen=:5678` (or equivalent) from `ps`.
- You got `the answer is 42` from `localhost:5678`.
- `kubectl get pod mystery -o jsonpath='{.spec.ephemeralContainers[*].name}'` prints a name.
- `kubectl get pods` shows both `mystery` and `mystery-debug`.

:::hint
`kubectl debug -it mystery --image=busybox:1.37 --target=mystery` shares the target's process namespace. The target process's filesystem is reachable at `/proc/<pid>/root`. If access is denied, the debug container lacks the `SYS_PTRACE` capability: try `--profile=general`. For the copy, look at `--copy-to` and `--share-processes`.
:::

:::solution
```bash
# 1 + 2 + 3
kubectl debug -it mystery --image=busybox:1.37 --target=mystery --profile=general -- sh
# inside the debug container:
ps -o pid,user,args            # PID 1: /http-echo -text=the answer is 42 -listen=:5678
netstat -tlnp 2>/dev/null || cat /proc/net/tcp6   # :5678 listening (port 0x162E in /proc/net)
wget -qO- localhost:5678       # the answer is 42
ls /proc/1/root/               # the mystery container's root: http-echo binary, minimal dirs
exit

# 4
kubectl get pod mystery -o jsonpath='{range .spec.ephemeralContainers[*]}{.name}{" "}{.image}{"\n"}{end}'
kubectl describe pod mystery | sed -n '/Ephemeral Containers:/,/Conditions:/p'
```

Ephemeral containers are added through the pod's `ephemeralcontainers` subresource. Once added they are part of the pod's spec for its lifetime: you cannot remove or restart them, only delete the whole pod. That is one reason they are a debugging tool and why their use is usually restricted by RBAC in production (`pods/ephemeralcontainers` permission).

```bash
# 5
kubectl debug mystery -it --copy-to=mystery-debug --image=busybox:1.37 --share-processes -- sh
# inside: ps shows /http-echo too; wget -qO- localhost:5678 works
exit
kubectl get pods
```

`--copy-to` creates a new, unmanaged pod from the original's spec with the extra container added; the original keeps running untouched. It is the right tool when the original container crashes immediately, because in the copy you can also swap the image and command of the app container itself:

```bash
kubectl debug mystery -it --copy-to=mystery-debug2 --set-image=mystery=busybox:1.37 --container=mystery -- sh
```
:::

### Clean up

```bash
kubectl delete pod mystery mystery-debug --ignore-not-found
kubectl delete namespace pods-lab
kubectl config set-context --current --namespace=default
```
