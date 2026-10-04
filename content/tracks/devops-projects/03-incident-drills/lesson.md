## Why practise breaking things

Every production incident you will face is some combination of a small number of failure patterns: a bad config, a missing dependency, a resource limit, a network rule, an image that cannot run, a tool's state that disagrees with reality. Senior engineers are not faster because they know more commands; they are faster because they have **seen the pattern before** and they follow a **method** that keeps them calm and effective when the pattern is new.

This module is a game day. The labs are 12 drills that inject real faults into the shipit stack from Project 1 (Docker, Kubernetes, Helm and Terraform). You get a symptom, like a pager alert, and work it to resolution. The lesson gives you the method: how to respond, how to troubleshoot, and how to write a blameless postmortem.

:::info Interview value
"Tell me about an incident you handled" and "a pod is in CrashLoopBackOff, walk me through it" are standard senior questions. After these drills you will have concrete stories, the vocabulary (mitigate vs resolve, contributing factors, blast radius) and a repeatable debugging sequence to talk through out loud.
:::

## The incident lifecycle

```text
  ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────────┐
  │  DETECT  │──►│  TRIAGE  │──►│ MITIGATE  │──►│ RESOLVE  │──►│  POSTMORTEM  │
  └──────────┘   └──────────┘   └───────────┘   └──────────┘   └──────────────┘
   alert, user    impact? scope?  stop the        fix the root    learn, write
   report, CI     severity? who   bleeding:       cause; verify   it down, assign
   failure        leads? what     rollback,       recovery;       action items;
                  changed?        scale, failover monitor         share widely
        ◄──────────── communicate status the whole time ─────────────►
```

**Detect.** Ideally an alert on a user-facing symptom (error rate, latency, failed synthetic check) fires before customers notice. In the drills, `drills/watch.sh` plays the role of a synthetic monitor: one request per second through the Gateway, printing the status code. Good detection alerts on **symptoms** (users get 503s), not on every possible cause (CPU at 80%).

**Triage.** Answer quickly, in this order:

1. **What is the user impact?** Who is affected, how badly, since when? This sets severity.
2. **What changed?** Deploys, config changes, infra changes, traffic changes, dependency incidents. The large majority of incidents follow a change. `kubectl rollout history`, `helm history`, Argo CD history, the deploy log, `git log` on the GitOps repo.
3. **Who leads?** One incident commander, even if it is you alone. Declare it.

**Mitigate.** Restore service **before** you understand the root cause. Rollback is the most powerful mitigation because it is fast, well-tested and reversible. Others: scale up, fail over, disable a feature flag, shed load, block a bad client. A mitigated incident at minute 5 with root cause found at minute 60 beats an outage that lasts 60 minutes while you debug live.

**Resolve.** Find and fix the root cause and the contributing factors, verify recovery with the same signal that detected the problem, and watch for recurrence.

**Postmortem.** Write down what happened, why, and what will change so it does not happen again (or is detected and mitigated faster). Blameless, specific, with owners and dates.

### Severity and roles (small-team version)

| Severity | Meaning | Example | Response |
| --- | --- | --- | --- |
| SEV1 | Major user-facing outage or data loss risk | All requests 503 | All hands, status page, updates every 15–30 min |
| SEV2 | Significant degradation or partial outage | Elevated errors for one feature, a stuck deploy blocking a fix | Incident channel, IC assigned, regular updates |
| SEV3 | Minor impact, workaround exists | One pod crash-looping behind a healthy rollout | Handle in working hours, ticket |

Even with two people, separate the roles: the **incident commander** coordinates, decides and communicates; the **operator** types commands. When one person does both, they stop communicating at exactly the wrong moment. A third role, **scribe**, keeps the timeline; in small teams the IC does it in the incident channel.

## The troubleshooting mindset

:::tip Seven habits that shorten incidents
1. **Mitigate first, investigate second.** Roll back if a recent change is plausible, even before you are sure.
2. **Ask "what changed?" before "what is wrong?".** Diff the last known good state against now.
3. **Follow the request path.** Client → DNS → load balancer/Gateway → Service → endpoints → pod → container → dependency. Find the first hop where it breaks.
4. **Trust signals, not assumptions.** "The secret is definitely there" is a hypothesis; `kubectl get secret` is evidence.
5. **Form one hypothesis, test it, change one thing at a time.** Changing three things at once leaves you not knowing which one helped, and may add a second incident.
6. **Write a timeline as you go.** Timestamps, commands run, observations. It feeds the postmortem and keeps the team in sync.
7. **Timebox rabbit holes.** If a line of investigation shows nothing in 10–15 minutes, step back, re-read the symptoms, or ask someone to look with fresh eyes.
:::

### A default debugging sequence for Kubernetes

```bash
# 1. Scope: what is unhealthy, where?
kubectl get pods -n <ns> -o wide
kubectl get deploy,rs,svc,endpointslices,httproute -n <ns>

# 2. Why? Events and status are the single richest source.
kubectl describe pod <pod> -n <ns>                    # Events at the bottom, Last State, Reason, Exit Code
kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -30

# 3. What did the process say?
kubectl logs <pod> -n <ns> -c <container>
kubectl logs <pod> -n <ns> --previous                 # the crashed instance, not the restarted one

# 4. What changed?
kubectl rollout history deploy/<name> -n <ns>
helm history <release> -n <ns>
kubectl diff -f <manifest>                            # your manifest vs live

# 5. Test from inside the network.
kubectl debug -it <pod> -n <ns> --image=busybox:1.36 --target=<container> -- sh   # same net namespace
kubectl run tmp -n <ns> --rm -it --restart=Never --image=curlimages/curl -- sh
kubectl exec -n <ns> deploy/<name> -- node -e '...'    # use what the app image already has
```

:::warning Ephemeral debug containers and runAsNonRoot
`kubectl debug --target` adds a container to the existing pod, so it inherits the pod-level `securityContext`. If the pod sets `runAsNonRoot: true` (shipit does), a root-only image such as `busybox` or `nicolaka/netshoot` is rejected with `container has runAsNonRoot and image will run as root`. Options: exec into the app container and use what it has (`node -e`, `wget`), run a separate test pod with the same labels in a non-production namespace, or use a debug image that runs as a non-root user.
:::

### Reading pod status

| What you see | It means | First thing to check |
| --- | --- | --- |
| `Pending` | Not scheduled yet | `describe pod` events: insufficient CPU/memory, taints, node selectors, **unbound PVC** |
| `ContainerCreating` (for long) | Scheduled, but the sandbox or volumes are not ready | Events: volume mount/attach errors, CNI errors, missing ConfigMap/Secret volume |
| `CreateContainerConfigError` | Kubelet cannot build the container config | Missing Secret/ConfigMap **or key** referenced by `env`/`envFrom` |
| `ErrImagePull` / `ImagePullBackOff` | Image cannot be pulled | Name/tag typo, private registry without pull secret, no matching platform in the index |
| `RunContainerError` / `StartError` | Runtime could not start the process | Entrypoint not found, permission denied, **`exec format error`** |
| `CrashLoopBackOff` | Process starts then exits, repeatedly; kubelet backs off (10 s, 20 s, … up to 5 min) | `logs --previous`, `Last State: Terminated, Reason, Exit Code` |
| `OOMKilled` (in Last State) | Kernel killed the container for exceeding its memory limit | Memory limit vs actual usage, leaks, buffering large payloads |
| `Running` but `0/1 READY` | Readiness probe failing; pod gets no traffic | `describe` probe failure message, the readiness endpoint itself, dependencies |
| `Terminating` (stuck) | Finalizers, or a node that is gone | `kubectl get pod -o yaml` finalizers, node status |
| `Evicted` | Node pressure (memory, disk) | Node conditions, pod requests vs usage |

### Exit codes worth memorising

| Code | Meaning | Typical cause |
| --- | --- | --- |
| 0 | Clean exit | A long-running server should not exit at all; check the command |
| 1 | Generic application error | Uncaught exception, config validation (`missing required env`) |
| 126 | Command found but not executable | Missing execute bit, wrong permissions |
| 127 | Command not found | Typo in `command`, binary missing from the image, CRLF in a shebang |
| 134 | SIGABRT (128+6) | Node: `FATAL ERROR: ... JavaScript heap out of memory` |
| 137 | SIGKILL (128+9) | OOMKilled by the kernel, or killed after the grace period |
| 139 | SIGSEGV (128+11) | Native crash, often a wrong-architecture native module |
| 143 | SIGTERM (128+15) | Graceful termination request that the process exited on |

:::try Read a crash in 60 seconds
Pick any pod in your Project 1 cluster and run `kubectl get pod <pod> -n shipit -o jsonpath='{.status.containerStatuses[0].lastState}{"\n"}'`. For a healthy pod it prints `{}`. Now kill the process inside one API pod (`kubectl exec -n shipit <pod> -- sh -c 'kill 1'`) and run it again: you should see `terminated` with an exit code and reason. Which code did you get, and why is it not 137? (Node handled SIGTERM gracefully and exited 0 after the shutdown delay; a SIGKILL would have given 137.)
:::

:::deep Two different "out of memory" failures in Node
A Node process can run out of memory in two unrelated ways, and they need different fixes.

1. **V8 heap exhaustion.** JavaScript objects live in V8's heap, which has a size limit (`--max-old-space-size`, otherwise derived from available memory). When the heap is full and garbage collection cannot free enough, V8 aborts with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`. Exit code 134, the container's reason is `Error`, **not** `OOMKilled`. You get a stack trace.
2. **Container memory limit (cgroup OOM kill).** The kernel counts the whole process RSS: V8 heap **plus** off-heap memory (Buffers, native addons, thread stacks, code). When it exceeds `resources.limits.memory`, the kernel sends SIGKILL. Exit code 137, reason `OOMKilled`, no log line from the app at all.

Setting `--max-old-space-size` to roughly 70–80% of the limit makes case 2 into case 1 for heap-heavy workloads, which is easier to diagnose. It does nothing for Buffer-heavy code (file uploads, image processing, reading a whole export into memory), where the real fix is streaming. Drill 2 is case 2.
:::

## Useful commands by layer

| Layer | Commands |
| --- | --- |
| Docker / images | `docker image inspect --format '{{.Os}}/{{.Architecture}}' img`, `docker buildx imagetools inspect img`, `docker run --rm --entrypoint sh img -c 'head -1 /entrypoint.sh'`, `docker logs`, `docker events` |
| Pods and workloads | `kubectl get/describe`, `logs --previous`, `get events --sort-by=.lastTimestamp`, `rollout status/history/undo`, `kubectl diff`, `kubectl get pod -o jsonpath='{.status.containerStatuses[*].lastState}'` |
| Networking | `kubectl get svc,endpointslices`, `kubectl get networkpolicy`, `kubectl debug ... --target`, `nslookup`/`nc -zv` from a debug container, `kubectl port-forward` to bypass the Gateway, `kubectl get httproute -o yaml` (status conditions) |
| Resources and scaling | `kubectl top pods/nodes`, `kubectl describe hpa`, `kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/<ns>/pods`, `kubectl describe node` (Allocated resources) |
| Storage | `kubectl get pvc,pv,storageclass`, `kubectl describe pvc` (events from the provisioner) |
| Access | `kubectl auth can-i <verb> <resource> --as=system:serviceaccount:<ns>:<sa>` |
| Helm | `helm status`, `helm history`, `helm get values --revision N`, `helm get manifest`, `helm rollback <release> <rev>`, `helm upgrade --rollback-on-failure` (Helm 4; `--atomic` in Helm 3) |
| Terraform | `terraform plan -refresh-only`, `terraform state list/show`, `terraform apply -refresh-only`, `terraform force-unlock <LOCK_ID>`, `import`/`removed` blocks to reconcile ownership |
| Argo CD | `kubectl get applications -n argocd`, the app's diff and history in the UI, `argocd app diff`, `argocd app history` |

:::warning Commands that make incidents worse
- `kubectl delete pod` as a reflex: it destroys the evidence (`--previous` logs, Last State) and often just recreates the same failure. Capture `describe` and logs first.
- `kubectl edit` in production during an incident without writing it down: the fix works, then the next deploy or Argo CD self-heal silently reverts it, and nobody knows why the incident came back. Mitigate with a rollback or a commit when you can; if you must hot-patch, record it in the timeline and follow up in Git.
- `terraform force-unlock` while another apply is genuinely running: two writers corrupt state. Prove the lock holder is dead first.
- `helm uninstall` to "reset" a failed release: deletes everything the chart owns, including PVCs created by the chart templates. Roll back instead.
:::

## Blameless postmortems

A postmortem exists to make the system safer, not to find who to blame. The premise: everyone acted reasonably given the information, tools and pressure they had at the time. If a human could make the mistake, the system allowed it, and the system is what you fix. Blame makes people hide information, and hidden information is how the same incident happens again.

Practical rules:

- Write it within a few days, while memory is fresh. The IC owns it; everyone involved reviews it.
- Describe actions and decisions, not people: "the deploy was approved without a staging run" rather than "Alex skipped staging".
- Look for **contributing factors**, not a single root cause. Real incidents are usually a chain: a risky change, plus a missing check, plus a gap in alerting.
- Ask "why was this possible?" and "why wasn't it caught earlier?" at each step (the "five whys", used as a thinking aid, not a ritual).
- Every action item has an **owner** and a **due date**, and is tracked like any other work. Prefer items that remove a class of problem (a CI check, a policy, a safer default) over "be more careful".
- Celebrate what went well. Fast detection and a clean rollback are worth reinforcing.

### Template

```text
Title:            <short, specific: "503s on /items during release 1.4 rollout">
Date / duration:  2026-10-04 14:02–14:19 UTC (17 min), SEV2
Authors:          <IC>, <operator>
Status:           Draft | In review | Final

Summary
  Two or three sentences: what users experienced, how long, what fixed it.

Impact
  Who and what was affected, with numbers (error rate, requests failed, customers, revenue, SLO budget used).

Timeline (UTC)
  14:00  Release 1.4 merged; Argo CD starts sync
  14:02  Synthetic check: 503 (detection)
  14:04  Incident declared, IC: <name>
  14:07  Hypothesis: new readiness probe path; confirmed via pod events
  14:09  Mitigation: git revert of deploy commit; Argo CD syncs 1.3
  14:12  Error rate back to baseline (mitigated)
  14:19  Root cause confirmed, incident closed (resolved)

Root cause and contributing factors
  - Root cause: readiness probe path changed to /ready (404) in the chart
  - Contributing: Deployment strategy was Recreate, so no old pods kept serving
  - Contributing: no staging smoke test for chart changes

Detection
  How we found out. Could we have found out sooner? Was the alert actionable?

Response
  What went well. What went poorly. Where we got lucky.

Action items
  | Action                                          | Type     | Owner | Due        |
  | Restore RollingUpdate maxUnavailable: 0         | Prevent  | Roma  | 2026-10-06 |
  | kubeconform + e2e smoke on chart changes in CI  | Detect   | Roma  | 2026-10-10 |
  | Alert on 5xx rate > 1% for 2 min at the Gateway | Detect   | Roma  | 2026-10-10 |

Lessons learned
  What should other teams know?
```

:::try Write a postmortem for Project 1's Milestone 6
In Milestone 6 of Project 1 you removed the shutdown delay and saw 502s during a rollout. Fill in the template for that "incident" in 10 minutes. Focus on contributing factors (out-of-band change, push-based tool blind to drift) and on action items that change the system, not people.
:::

## How the drills work

Every drill follows the same shape so you practise the method, not just the fix:

```text
 1. Reset      drills/reset.sh                 → healthy baseline in namespace "gameday"
 2. Monitor    drills/watch.sh (own terminal)  → timestamped status codes, your "pager"
 3. Inject     the drill's script              → do NOT read it closely; treat it as an unknown change
 4. Respond    triage → mitigate → find root cause → fix → verify with watch.sh
 5. Debrief    answer the postmortem prompt in 3–5 sentences
```

Rules that make it realistic:

- **Start a timer** when you run the inject script. Write down the time you detected, mitigated and resolved. Your goal over time is to shrink time-to-mitigate.
- **Use hints only after 10 minutes** of honest investigation.
- **Mitigate first** where the drill causes user impact; resolve properly afterwards.
- **Fix it the durable way.** A `kubectl` hot fix is fine as mitigation, but say what the permanent fix in Git/Helm/Terraform would be.
- **Pair if you can.** One person injects (and knows the answer), the other responds and talks through their reasoning, exactly like an interview.

:::mac Tools for the drills
Everything runs on the kind cluster from Project 1 (`make up`). You also need `hey` (`brew install hey`) for load, and Docker for the Terraform lock drill's S3-compatible server. On Apple Silicon, kind nodes are arm64, which matters for the exec-format drill.
:::
