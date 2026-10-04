Every workload in Kubernetes ends up as pods. Deployments, StatefulSets, Jobs and DaemonSets are just controllers that create pods from a template. If you understand pods deeply (how they start, what their statuses mean, how they share things and how they die) you can debug almost any workload.

## What a pod really is

A pod is **one or more containers that are always scheduled together on the same node and share some Linux namespaces**:

- **Network namespace**: one IP address, one port space, one `localhost`. Containers in a pod talk to each other on `localhost`.
- **IPC namespace** and optionally the **PID namespace** (`shareProcessNamespace: true`).
- **Volumes** declared at pod level that any container can mount.
- A shared lifecycle: scheduled, started and deleted as a unit.

Each container keeps its own filesystem (from its image), its own process tree by default, and its own resource limits.

```text
                    Pod  shipit-api-7d9f-x2k  (IP 10.244.1.17)
  +------------------------------------------------------------------+
  |  pause container  (holds the network namespace, does nothing)    |
  |                                                                  |
  |  +-----------------------+      +---------------------------+   |
  |  | container: api        |      | container: log-shipper    |   |
  |  | node dist/main.js     |      | fluent-bit                |   |
  |  | listens :3000         |      | reads /var/log/app        |   |
  |  +----------+------------+      +-------------+-------------+   |
  |             |    localhost:3000 works both ways  |               |
  |             +-------- volume: logs (emptyDir) ---+               |
  +------------------------------------------------------------------+
```

The **pause** (sandbox) container is created first by the runtime. It owns the network namespace, so app containers can crash and restart without the pod losing its IP.

:::info Why not just containers?
Some processes are tightly coupled: an app plus a proxy that must share `localhost`, or an app plus a log shipper that reads its files. Docker Compose would put them on a network and share volumes; a pod makes them a single schedulable unit that always lands on the same machine. The rule of thumb: **one main process per container, and only put containers in the same pod if they must live and die together.** Your API and Postgres are *not* one pod: they scale and fail independently.
:::

## The pod spec, field by field

Here is a realistic pod for `shipit-api`. You will rarely write a bare Pod, but this exact structure appears inside every Deployment's `spec.template`.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shipit-api
  labels:
    app.kubernetes.io/name: shipit-api
spec:
  restartPolicy: Always                    # Always | OnFailure | Never
  terminationGracePeriodSeconds: 30        # time between SIGTERM and SIGKILL
  serviceAccountName: shipit-api           # identity for API access
  securityContext:                         # pod-level defaults
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
  initContainers:
    - name: wait-for-db
      image: busybox:1.37
      command: ["sh", "-c", "until nc -z postgres 5432; do echo waiting; sleep 2; done"]
  containers:
    - name: api
      image: ghcr.io/roma/shipit-api:1.4.2
      imagePullPolicy: IfNotPresent
      command: ["node"]                    # overrides the image ENTRYPOINT
      args: ["dist/main.js"]               # overrides the image CMD
      ports:
        - name: http
          containerPort: 3000              # informational, but name it for Services/probes
      env:
        - name: PORT
          value: "3000"                    # env values are always strings
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef: { name: shipit-db, key: url }
        - name: POD_NAME
          valueFrom:
            fieldRef: { fieldPath: metadata.name }
      envFrom:
        - configMapRef: { name: shipit-config }
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits:   { memory: 256Mi }
      readinessProbe:
        httpGet: { path: /readyz, port: http }
        periodSeconds: 5
      livenessProbe:
        httpGet: { path: /healthz, port: http }
        periodSeconds: 10
        failureThreshold: 3
      lifecycle:
        preStop:
          sleep: { seconds: 5 }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir: {}
```

**command and args vs Dockerfile.** This trips up everyone once:

| Dockerfile | Pod spec | Result |
| --- | --- | --- |
| `ENTRYPOINT ["node"]` `CMD ["main.js"]` | nothing | `node main.js` |
| same | `args: ["other.js"]` | `node other.js` |
| same | `command: ["sh","-c"]` `args: ["echo hi"]` | `sh -c "echo hi"` (CMD ignored) |
| same | `command: ["npm"]` only | `npm` (CMD is **not** used when command is set) |

`command` replaces ENTRYPOINT, `args` replaces CMD, and setting `command` discards the image's CMD too.

:::try Explore the schema
```bash
kubectl explain pod.spec --recursive | less
kubectl explain pod.spec.containers.lifecycle.preStop
kubectl explain pod.spec.initContainers.restartPolicy
```
:::

## Pod lifecycle: phases, conditions and container states

Kubernetes reports pod health on three levels. Learn to tell them apart.

### Pod phase (`status.phase`)

| Phase | Meaning |
| --- | --- |
| `Pending` | Accepted, but not all containers are running yet: waiting for scheduling, image pulls or init containers |
| `Running` | Bound to a node, all containers created, at least one running or restarting |
| `Succeeded` | All containers exited 0 and will not restart (Jobs) |
| `Failed` | All containers terminated, at least one with failure, no more restarts |
| `Unknown` | The node stopped reporting (network partition, dead kubelet) |

### Pod conditions (`status.conditions`)

`PodScheduled` → `PodReadyToStartContainers` (sandbox and network ready) → `Initialized` (init containers done) → `ContainersReady` → `Ready`. Only pods with `Ready=True` receive Service traffic.

### Container states (`status.containerStatuses[].state`)

- `Waiting` with a reason: `ContainerCreating`, `PodInitializing`, `ErrImagePull`, `ImagePullBackOff`, `CrashLoopBackOff`, `CreateContainerConfigError` (e.g. a missing Secret or ConfigMap key).
- `Running` with `startedAt`.
- `Terminated` with `exitCode`, `reason` (`Completed`, `Error`, `OOMKilled`), `startedAt`, `finishedAt`.

Also check `lastState`: it holds the previous termination, which is how you find out *why* a container restarted.

:::warning The STATUS column is not the phase
`kubectl get pods` shows a computed STATUS that mixes phase, container reasons and deletion state: `CrashLoopBackOff`, `Init:0/1`, `Init:CrashLoopBackOff`, `Terminating`, `Error`, `Completed`, `OOMKilled`. A pod in `CrashLoopBackOff` has phase `Running`. Look at `kubectl describe` or `-o yaml` for the real picture.
:::

Exit codes you should recognise immediately:

| Exit code | Usual meaning |
| --- | --- |
| `0` | Success |
| `1` | Application error (uncaught exception in Node.js) |
| `126` / `127` | Command not executable / not found when run through a shell. If the binary in `command` itself does not exist, you get reason `StartError` (exit `128` on containerd) and STATUS `RunContainerError` |
| `137` | Killed by SIGKILL (128 + 9): **OOMKilled**, or did not stop within the grace period |
| `143` | Terminated by SIGTERM (128 + 15): normal shutdown when the app does not handle it |

## restartPolicy and CrashLoopBackOff

`spec.restartPolicy` applies to all regular containers in the pod:

- `Always` (default): restart on any exit. Required for Deployments, ReplicaSets, DaemonSets, StatefulSets.
- `OnFailure`: restart only on non-zero exit. Used by Jobs.
- `Never`: never restart. Used by Jobs and one-off debug pods.

Restarts happen **in place** on the same node, in the same pod (same IP, same volumes). The kubelet waits with exponential back-off between restarts: 10 s, 20 s, 40 s … capped at 5 minutes, reset after 10 minutes of successful running. While it waits, the container is `Waiting` with reason `CrashLoopBackOff`.

:::tip The CrashLoopBackOff checklist
1. `kubectl logs <pod> --previous` (the dead instance's output).
2. `kubectl describe pod <pod>`: `Last State: Terminated, Reason, Exit Code` and events.
3. Exit 137 + `OOMKilled` → raise the memory limit or fix the leak. Exit 127 → wrong command. Exit 1 → read the logs.
4. Failing liveness probe? Events say `Liveness probe failed` and `Container api failed liveness probe, will be restarted`.
5. Config errors: missing env var, unreachable database at boot without retries.
:::

## Init containers

Init containers run **before** app containers, **one at a time, in order**, and each must exit 0 before the next starts. If one fails, the kubelet retries it according to the pod's restartPolicy (with `Always`, init containers are retried as if `OnFailure`).

Use them to:

- wait for a dependency (`until nc -z postgres 5432`),
- run database migrations (careful: with many replicas they all run; a Job is often better),
- render config files or fetch secrets into a shared volume,
- fix permissions on a volume.

They can use a different image (with tools your app image does not need) and see the same volumes. STATUS shows `Init:0/2`, `Init:1/2` while they run.

## Multi-container patterns

### Sidecar

A helper that runs alongside the main container for its whole life: log shipper, service-mesh proxy (Envoy/Istio), config reloader, Cloud SQL / RDS IAM auth proxy.

Classic sidecars were just a second entry in `containers`, which had two problems: no guaranteed start order (the app might start before the proxy is ready), and in Jobs the pod never completed because the sidecar kept running.

**Native sidecar containers** fix this. A sidecar is an init container with `restartPolicy: Always`:

```yaml
spec:
  initContainers:
    - name: log-shipper
      image: busybox:1.37
      restartPolicy: Always          # <- this makes it a sidecar
      command: ["sh", "-c", "tail -n+1 -F /var/log/app/app.log"]
      volumeMounts:
        - { name: logs, mountPath: /var/log/app }
  containers:
    - name: api
      image: ghcr.io/roma/shipit-api:1.4.2
      volumeMounts:
        - { name: logs, mountPath: /var/log/app }
  volumes:
    - name: logs
      emptyDir: {}
```

Native sidecars:

- start in order with other init containers, and the next init container (or the app) starts as soon as the sidecar has *started* (and passed its startup probe, if it has one), without waiting for it to exit;
- keep running and are restarted if they crash;
- are stopped **after** the main containers during termination, so a proxy outlives the app that needs it;
- do not block Job completion: once the main containers finish, the sidecars are terminated.

This feature became stable in Kubernetes v1.33 (enabled by default since v1.29), so any current cluster has it.

### Ambassador

A sidecar that proxies outbound connections on the app's behalf. The app talks to `localhost:6379`; the ambassador handles TLS, auth, sharding or discovery to the real Redis or database. Example: the Cloud SQL Auth Proxy, or a `pgbouncer` sidecar.

### Adapter

A sidecar that transforms the app's output into a standard format: for example, an exporter that reads an app's custom status page and exposes Prometheus metrics, or a container that converts log formats.

```text
  sidecar: extends/enhances    ambassador: proxies OUT     adapter: normalises OUTPUT
  [app]--files-->[shipper]     [app]->localhost->[proxy]->  [app]-->[exporter]--> /metrics
```

## Sharing inside a pod

**Network.** All containers share one IP and port space. Two containers cannot both listen on port 8080. They reach each other via `localhost`. Ports are reachable from other pods on the pod IP.

**Volumes.** An `emptyDir` is created when the pod starts and deleted when the pod is removed (it survives container restarts). Use `emptyDir: { medium: Memory, sizeLimit: 64Mi }` for a tmpfs (it counts against the container's memory). This is the standard way to pass files between init containers, sidecars and the app, or to give a read-only-rootfs container a writable `/tmp`.

**Processes.** With `shareProcessNamespace: true`, containers see each other's processes (useful for signalling a reload or debugging). The pause container becomes PID 1 for everyone.

## The downward API

Pods often need to know about themselves: their name (for logs and metrics), namespace, IP, node, or their own resource limits (to size a Node.js heap). The downward API exposes these as env vars or files without calling the Kubernetes API.

```yaml
env:
  - name: POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
  - name: POD_NAMESPACE
    valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
  - name: POD_IP
    valueFrom: { fieldRef: { fieldPath: status.podIP } }
  - name: NODE_NAME
    valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
  - name: APP_VERSION
    valueFrom: { fieldRef: { fieldPath: "metadata.labels['app.kubernetes.io/version']" } }
  - name: MEMORY_LIMIT_MB
    valueFrom:
      resourceFieldRef: { containerName: api, resource: limits.memory, divisor: 1Mi }
```

Env vars are set once at container start. If you need values that can change (labels, annotations), use a `downwardAPI` volume; the kubelet updates the files.

```yaml
volumes:
  - name: podinfo
    downwardAPI:
      items:
        - path: labels
          fieldRef: { fieldPath: metadata.labels }
```

:::tip Node.js heap and container limits
Node's default V8 heap size is not tied to your container memory limit in a way you should rely on. Use the downward API to pass the limit and size the heap explicitly, e.g. `NODE_OPTIONS=--max-old-space-size=192` for a 256Mi limit (roughly 75%), leaving room for buffers and native memory. Otherwise you may see exit code 137 `OOMKilled` before V8 ever runs a full GC.
:::

## Resources and probes: a first look

Both get their own module later; you need the basics now.

**Resources.** `requests` are what the scheduler reserves on a node; `limits` are enforced at runtime. Exceeding a memory limit gets the container OOM-killed (exit 137). Exceeding a CPU limit gets it throttled, not killed. Requests and limits together determine the pod's **QoS class**: `Guaranteed` (requests = limits for every container), `Burstable` (some requests), `BestEffort` (none, first to be evicted under pressure). A common production pattern: set CPU and memory requests, set a memory limit, and leave out the CPU limit to avoid throttling latency-sensitive Node.js services.

**Probes.** The kubelet runs them per container:

| Probe | Question | On failure |
| --- | --- | --- |
| `startupProbe` | Has it finished starting? | Keeps other probes disabled until it passes; kills the container after `failureThreshold × periodSeconds` |
| `livenessProbe` | Is it stuck beyond repair? | Restarts the container |
| `readinessProbe` | Can it serve traffic right now? | Removes the pod from Service endpoints (no restart) |

Probe handlers: `httpGet`, `tcpSocket`, `grpc`, `exec`. For shipit-api, `/healthz` (process alive, no dependency checks) is the liveness probe and `/readyz` (DB and Redis reachable) is the readiness probe.

:::warning Never check dependencies in a liveness probe
If `/healthz` checks Postgres and Postgres has a hiccup, every API pod fails liveness at the same moment and the kubelet restarts all of them, turning a short database blip into a full outage. Dependencies belong in readiness only.
:::

## Graceful termination

When a pod is deleted (rollout, scale-down, node drain, eviction), this happens:

```text
 t=0  Pod marked Terminating (deletionTimestamp set)
      |-- in parallel ------------------------------------------------------
      |  (a) EndpointSlice controller removes pod from Services;            |
      |      kube-proxy on every node updates rules (takes a moment!)       |
      |  (b) kubelet runs preStop hook (if any), THEN sends SIGTERM to      |
      |      PID 1 of each container                                        |
      |---------------------------------------------------------------------
      |  app stops accepting, finishes in-flight requests, closes DB pool, exits
 t=terminationGracePeriodSeconds (default 30s, includes preStop time)
      kubelet sends SIGKILL to anything still running (exit 137)
```

Two consequences:

1. **The endpoint race.** (a) and (b) happen in parallel. If your app exits immediately on SIGTERM, some nodes still route new connections to it for a second or two, and clients see connection errors during every deploy. The fix is a short `preStop` delay so the endpoint removal propagates before the app starts shutting down:

```yaml
lifecycle:
  preStop:
    sleep: { seconds: 5 }   # native sleep action (stable since v1.32); older clusters: exec: { command: ["sleep","5"] }
```

2. **Your process must actually receive and handle SIGTERM.** In Node.js:

```typescript
const server = app.listen(port);
process.on('SIGTERM', () => {
  console.log('SIGTERM received, draining');
  server.close(async () => {          // stop accepting, wait for in-flight requests
    await pool.end();                 // close Postgres pool
    await redis.quit();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 20_000).unref();  // safety net below the grace period
});
```

NestJS: call `app.enableShutdownHooks()` and implement `OnApplicationShutdown`.

:::warning Signals and PID 1
- Use the exec form `CMD ["node", "dist/main.js"]`. The shell form `CMD node dist/main.js` runs `/bin/sh -c`, and the shell may not forward SIGTERM to Node.
- `npm start` as PID 1 has historically not forwarded signals reliably. Run `node` directly.
- A process that is PID 1 in its namespace gets **no default signal handlers**: if Node.js has no `SIGTERM` listener, the signal is ignored and the pod hangs in `Terminating` for the whole grace period, then gets SIGKILLed. Add a handler, or use an init like `tini` (`docker run --init` equivalent).
:::

Set `terminationGracePeriodSeconds` to cover preStop + your longest reasonable request or job (e.g. 60 s for an API with long uploads, longer for queue workers that finish a message).

:::deep What actually happens inside the kubelet on delete
When you `kubectl delete pod`, the API server does not remove the object. It sets `metadata.deletionTimestamp` and `deletionGracePeriodSeconds`. The kubelet sees this through its watch and starts the kill sequence: for each container, run the preStop hook (synchronously, counting against the grace period), then ask the runtime via CRI `StopContainer(timeout)`, which sends the image's `STOPSIGNAL` (SIGTERM by default) and SIGKILL after the timeout. Native sidecars are stopped after main containers, in reverse order of declaration. Once all containers are gone and volumes are unmounted, the kubelet tells the API server to delete the object for real (grace period 0), and only then does it disappear from `kubectl get pods`. `kubectl delete pod x --grace-period=0 --force` skips the wait on the API side, which can leave a process still running on the node while a replacement starts: dangerous for StatefulSets.
:::

## Why you rarely create bare pods

A bare Pod has nobody watching over it. If its node dies, the pod is gone forever. If you change its spec, most fields are immutable (you can change images, a few other fields, and, in recent versions, resources via in-place resize, but not much else). There are no rollouts and no scaling.

Use controllers instead:

| You want | Use |
| --- | --- |
| A stateless service with N replicas | Deployment |
| One pod per node | DaemonSet |
| Stable identity and storage | StatefulSet |
| Run to completion | Job / CronJob |

Bare pods are fine for one-off debugging: `kubectl run tmp --image=busybox:1.37 --rm -it --restart=Never -- sh`.

## Static pods

Static pods are defined as files in the kubelet's `staticPodPath` (usually `/etc/kubernetes/manifests`) and run directly by the kubelet, even without an API server. The API shows a read-only **mirror pod** named `<name>-<node>`. kubeadm (and kind) run the control plane this way, as you saw in module 01. You will rarely write your own; managed clusters do not give you node access to do so anyway.

## Ephemeral debug containers

Production images are often minimal (distroless, `scratch`, or `node:22-slim` without curl). When you need to debug one, you cannot `kubectl exec` into a shell that does not exist. **Ephemeral containers** let you add a temporary container to a *running* pod:

```bash
# attach a busybox shell that shares the target container's process namespace
kubectl debug -it pod/shipit-api-7d9f-x2k --image=busybox:1.37 --target=api -- sh

# a full network toolkit
kubectl debug -it pod/shipit-api-7d9f-x2k --image=nicolaka/netshoot --target=api
```

- `--target` puts the debug container in the target container's PID namespace, so `ps` shows the app's processes and you can read `/proc/<pid>/root/...` to see its filesystem.
- It shares the pod's network namespace automatically, so `curl localhost:3000/healthz` works.
- Ephemeral containers cannot be removed or restarted; they disappear with the pod. They have no ports, probes or resources.

Two other modes:

```bash
# copy the pod with changes (e.g. a different command) to debug a crash loop
kubectl debug pod/shipit-api-7d9f-x2k -it --copy-to=api-debug --container=api -- sh
# a privileged pod on a node with the host filesystem at /host
kubectl debug node/lab-worker -it --image=busybox:1.37
```

## Pitfalls and best practices

:::warning Common pod mistakes
- **Putting the database in the app's pod.** They then scale together and die together. Separate workloads.
- **No SIGTERM handling** → slow deploys (30 s hangs) and dropped requests.
- **Liveness probes that are too aggressive or check dependencies** → restart storms.
- **Env var values as numbers** (`value: 3000`) → validation error; quote them.
- **Missing memory limits** on Node.js services → one leaky pod can pressure the whole node.
- **Relying on container start order** in `containers` → use init containers or native sidecars.
:::

Best practices:

- One main process per container; sidecars only when they share the pod's lifecycle.
- Name your ports (`http`) and reference names in probes and Services.
- Exec-form commands, SIGTERM handlers, a short preStop sleep and a deliberate grace period.
- Run as non-root with `allowPrivilegeEscalation: false` and a read-only root filesystem plus `emptyDir` for `/tmp`.
- Use the downward API for pod identity in logs and metrics.

## Summary

- A pod is co-scheduled containers sharing a network namespace (via the pause container) and volumes.
- Phase, conditions and container states are different things; STATUS is a computed summary.
- `restartPolicy` controls in-place restarts; CrashLoopBackOff is the back-off between them.
- Init containers run first, in order; native sidecars are init containers with `restartPolicy: Always`.
- The downward API exposes pod metadata and limits to containers.
- Graceful termination = endpoint removal in parallel with preStop → SIGTERM → grace period → SIGKILL.
- Use controllers, not bare pods; use `kubectl debug` for minimal images.
