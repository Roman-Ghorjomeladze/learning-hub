A dense reference for daily work and hands-on exams. Set these up once:

```bash
alias k=kubectl
source <(kubectl completion zsh)          # bash: source <(kubectl completion bash)
compdef k=kubectl                          # zsh: completion for the alias
export do="--dry-run=client -o yaml"       # k create deploy web --image=nginx $do > web.yaml
export now="--force --grace-period=0"      # dev clusters only
```

## Contexts and configuration

| Task | Command |
| --- | --- |
| List contexts / current | `kubectl config get-contexts` / `kubectl config current-context` |
| Switch context | `kubectl config use-context kind-dev` |
| Default namespace for context | `kubectl config set-context --current --namespace=shipit` |
| Who am I | `kubectl auth whoami` |
| Merge another kubeconfig | `KUBECONFIG=~/.kube/config:./other.yaml kubectl config view --flatten > merged` |
| Cluster info / versions | `kubectl cluster-info`, `kubectl version` |
| API resources and short names | `kubectl api-resources` (`-o wide`, `--namespaced=false`, `--api-group=apps`) |
| Field docs | `kubectl explain deploy.spec.strategy --recursive` |

## kind

```bash
kind create cluster --name dev                         # single node
kind create cluster --name dev --config kind.yaml      # multi-node, port mappings...
kind get clusters
kind load docker-image shipit-api:1.0.0 --name dev     # local image into all nodes
kind export logs ./kind-logs --name dev                # node + component logs
docker exec -it dev-control-plane bash                 # nodes are containers
kind delete cluster --name dev
```

```yaml
# kind.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:                  # host:8080 -> node:30080 (for a NodePort)
      - { containerPort: 30080, hostPort: 8080 }
  - role: worker
  - role: worker
# networking: { disableDefaultCNI: true, podSubnet: 192.168.0.0/16 }   # to install Calico/Cilium
```

## Reading state

```bash
kubectl get pods -o wide                       # node, IP
kubectl get pods -A                            # all namespaces
kubectl get deploy,rs,pods,svc -l app=web      # several kinds, label filter
kubectl get pods --show-labels
kubectl get pods -w                            # watch
kubectl get pod web-0 -o yaml                  # full object
kubectl describe pod web-0                     # human summary + events
kubectl get events -n shipit --sort-by=.lastTimestamp
kubectl events -n shipit --for pod/web-0       # newer events command
kubectl get events -A --field-selector type=Warning
kubectl get pods --field-selector status.phase=Pending
kubectl get endpointslices -l kubernetes.io/service-name=web
kubectl top nodes; kubectl top pods -A --sort-by=memory     # needs metrics-server
```

## Creating and changing objects

```bash
# generators (add $do to print YAML instead of creating)
kubectl create deployment web --image=nginx:1.27 --replicas=3 --port=80
kubectl expose deployment web --port=80 --target-port=80 [--type=NodePort]
kubectl run tmp --image=busybox:1.36 --rm -it --restart=Never -- sh
kubectl create configmap app-cfg --from-literal=LOG_LEVEL=info --from-file=config.json
kubectl create secret generic db --from-literal=password=s3cret
kubectl create secret tls web-tls --cert=tls.crt --key=tls.key
kubectl create job once --image=busybox:1.36 -- echo hi
kubectl create cronjob nightly --image=busybox:1.36 --schedule="0 2 * * *" -- echo hi
kubectl create job manual-run --from=cronjob/nightly
kubectl create serviceaccount ci
kubectl create role pod-reader --verb=get,list,watch --resource=pods
kubectl create rolebinding ci-read --role=pod-reader --serviceaccount=dev:ci
kubectl create clusterrolebinding ops-view --clusterrole=view --group=ops

# declarative
kubectl apply -f manifests/                     # file, dir (-R recursive) or URL
kubectl apply -k overlays/prod                  # kustomize
kubectl diff -f manifests/                      # what would change
kubectl apply -f x.yaml --dry-run=server        # validate against the API + admission
kubectl apply --server-side -f big-crds.yaml    # server-side apply
kubectl delete -f manifests/

# edits
kubectl edit deploy web
kubectl set image deploy/web nginx=nginx:1.27.3
kubectl set env deploy/web LOG_LEVEL=debug
kubectl set resources deploy/web -c nginx --requests=cpu=100m,memory=128Mi --limits=memory=256Mi
kubectl label pod web-0 tier=frontend --overwrite
kubectl label pod web-0 tier-                  # remove a label
kubectl annotate deploy web team=payments
kubectl patch deploy web -p '{"spec":{"replicas":4}}'                                   # strategic merge
kubectl patch deploy web --type=json -p '[{"op":"replace","path":"/spec/replicas","value":2}]'
kubectl patch obj/x --type=merge -p '{"metadata":{"finalizers":null}}'                   # last resort
```

## Rollouts and scaling

| Task | Command |
| --- | --- |
| Watch a rollout | `kubectl rollout status deploy/web` |
| History / one revision | `kubectl rollout history deploy/web [--revision=3]` |
| Roll back | `kubectl rollout undo deploy/web [--to-revision=2]` |
| Restart pods (new ReplicaSet) | `kubectl rollout restart deploy/web` |
| Pause / resume | `kubectl rollout pause deploy/web` / `resume` |
| Scale | `kubectl scale deploy/web --replicas=5` |
| Autoscale | `kubectl autoscale deploy web --cpu-percent=70 --min=2 --max=5` |
| Wait for a condition | `kubectl wait --for=condition=Ready pod -l app=web --timeout=120s` |

## Logs, exec, debug, port-forward

```bash
kubectl logs web-0 [-c container] [-f] [--tail=50] [--since=10m] [--timestamps]
kubectl logs web-0 --previous                 # the crashed instance
kubectl logs deploy/web --all-containers
kubectl logs -l app=web --prefix --max-log-requests=10
kubectl exec -it web-0 -- sh
kubectl exec web-0 -- env
kubectl cp web-0:/etc/nginx/nginx.conf ./nginx.conf
kubectl port-forward svc/web 8080:80          # also pod/web-0, deploy/web
kubectl debug -it web-0 --image=nicolaka/netshoot --target=web          # ephemeral container
kubectl debug web-0 -it --copy-to=web-dbg --container=web -- sh          # copy with new command
kubectl debug web-0 -it --copy-to=web-dbg --set-image=web=busybox:1.36
kubectl debug node/kind-worker -it --image=busybox:1.36                 # host fs at /host
kubectl debug -it web-0 --image=busybox:1.36 --profile=restricted       # PSA-restricted namespaces
```

## Output formatting: jsonpath, custom-columns, sorting

```bash
# jsonpath
kubectl get pods -o jsonpath='{.items[*].metadata.name}'
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.podIP}{"\n"}{end}'
kubectl get pod web-0 -o jsonpath='{.spec.containers[*].image}'
kubectl get pod web-0 -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
kubectl get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}'
kubectl get secret db -o jsonpath='{.data.password}' | base64 -d
kubectl get secret db -o go-template='{{range $k,$v := .data}}{{$k}}={{$v|base64decode}}{{"\n"}}{{end}}'

# custom columns
kubectl get pods -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,IP:.status.podIP
kubectl get pods -o custom-columns='POD:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,REASON:.status.containerStatuses[0].state.waiting.reason'
kubectl get nodes -o custom-columns=NAME:.metadata.name,KUBELET:.status.nodeInfo.kubeletVersion,TAINTS:.spec.taints[*].key
kubectl get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image,READY:.status.readyReplicas

# sorting and names
kubectl get pods --sort-by=.metadata.creationTimestamp
kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'
kubectl get pods -o name                       # pod/web-0 ... (handy for xargs)
kubectl get pods -o json | jq -r '.items[] | select(.status.phase!="Running") | .metadata.name'
```

## Labels, selectors and field selectors

```bash
kubectl get pods -l app=web,tier!=cache
kubectl get pods -l 'env in (prod,staging)'
kubectl get pods -l '!canary'                  # label not present
kubectl get pods --field-selector spec.nodeName=kind-worker
kubectl delete pods -l app=web --field-selector status.phase=Failed
```

## Nodes and scheduling

```bash
kubectl cordon kind-worker; kubectl uncordon kind-worker
kubectl drain kind-worker --ignore-daemonsets --delete-emptydir-data [--timeout=5m]
kubectl taint nodes kind-worker dedicated=db:NoSchedule        # remove: ... dedicated=db:NoSchedule-
kubectl label nodes kind-worker disktype=ssd
kubectl describe node kind-worker | sed -n '/Allocated resources/,/Events/p'
kubectl get pdb -A                              # ALLOWED DISRUPTIONS before draining
```

## RBAC and auth

```bash
kubectl auth can-i create deployments -n dev
kubectl auth can-i '*' '*' --as system:serviceaccount:dev:ci
kubectl auth can-i --list -n dev --as jane --as-group dev-team
kubectl auth can-i get pods --subresource=log -n dev --as jane
kubectl create token ci -n dev --duration=15m [--audience=vault]
kubectl get rolebindings,clusterrolebindings -A -o wide | grep ci
kubectl auth reconcile -f rbac.yaml
kubectl label ns shipit pod-security.kubernetes.io/enforce=restricted --dry-run=server --overwrite
```

## Troubleshooting map

| Symptom | First command | Typical cause |
| --- | --- | --- |
| `Pending` | `describe pod` → Events | Insufficient CPU/memory requests, taints, affinity, unbound PVC |
| `ImagePullBackOff` | `describe pod` | Typo/tag, private registry auth, wrong arch |
| `CreateContainerConfigError` | `describe pod` | Missing ConfigMap/Secret or key; runAsNonRoot with root user |
| `CrashLoopBackOff` | `logs --previous`, `describe` Last State | App error (exit 1), OOMKilled (137), failing liveness probe |
| Running, 0/1 ready | `describe pod` (readiness events) | Readiness probe path/port, dependency down |
| Deployment 0 pods | `describe rs` | Quota, Pod Security, webhook denial |
| Service no response | `get endpointslices` | Selector mismatch, pods not ready, targetPort, NetworkPolicy |
| Stuck `Terminating` | `get -o yaml` → finalizers | Finalizer controller gone, SIGTERM ignored, node lost |
| HPA `<unknown>` | `kubectl top pods` | metrics-server missing, no CPU requests |

## Helm

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts && helm repo update
helm search repo kube-prometheus-stack --versions | head
helm show values oci://ghcr.io/stefanprodan/charts/podinfo > values.yaml
helm upgrade --install app ./chart -n app --create-namespace -f values.yaml -f values-prod.yaml \
  --set image.tag=$SHA --wait --timeout 5m --rollback-on-failure        # Helm 3: --atomic
helm list -A; helm status app -n app; helm history app -n app
helm get values app -n app [--all]; helm get manifest app -n app
helm rollback app 3 -n app
helm uninstall app -n app [--keep-history]
helm create mychart; helm lint mychart --strict
helm template app ./chart -f values.yaml [--show-only templates/deployment.yaml]
helm install app ./chart --dry-run=server --debug
helm test app -n app
helm dependency update ./chart
helm package ./chart; helm push chart-0.1.0.tgz oci://ghcr.io/me/charts
helm registry login ghcr.io -u me
```

Template snippets:

```yaml
{{- include "chart.labels" . | nindent 4 }}
{{- with .Values.resources }}
resources:
  {{- toYaml . | nindent 2 }}
{{- end }}
image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
name: {{ required "database.secret is required" .Values.database.secret }}
checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- if .Capabilities.APIVersions.Has "gateway.networking.k8s.io/v1" }} ... {{- end }}
```

## Kustomize

```bash
kubectl kustomize overlays/prod             # render
kubectl apply -k overlays/prod              # apply
kustomize edit set image shipit-api=ghcr.io/me/shipit-api:1.4.2
kustomize edit fix                          # migrate deprecated fields
```

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shipit-prod
resources: [../../base]
images:
  - { name: shipit-api, newName: ghcr.io/me/shipit-api, newTag: "1.4.2" }
replicas:
  - { name: shipit-api, count: 4 }
configMapGenerator:
  - name: api-config
    behavior: merge
    literals: [LOG_LEVEL=info]
patches:
  - path: resources.yaml
  - target: { kind: Deployment, name: shipit-api }
    patch: |-
      - op: add
        path: /spec/template/metadata/annotations/team
        value: payments
```

## Argo CD

```bash
kubectl create ns argocd
kubectl apply -n argocd --server-side --force-conflicts -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
kubectl -n argocd port-forward svc/argocd-server 8443:443
argocd login localhost:8443 --insecure --username admin
argocd app list; argocd app get shipit; argocd app diff shipit
argocd app sync shipit; argocd app history shipit; argocd app rollback shipit <id>
kubectl -n argocd annotate application shipit argocd.argoproj.io/refresh=normal --overwrite
```

## Minimal manifest templates

### Deployment + Service

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels: { app: web }
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginxinc/nginx-unprivileged:1.27-alpine
          ports:
            - { name: http, containerPort: 8080 }
          envFrom:
            - configMapRef: { name: web-config }
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
          readinessProbe:
            httpGet: { path: /, port: http }
          livenessProbe:
            httpGet: { path: /, port: http }
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: { app: web }
  ports:
    - { name: http, port: 80, targetPort: http }
```

### ConfigMap and Secret

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: web-config }
data:
  LOG_LEVEL: info
  app.json: |
    { "featureX": true }
---
apiVersion: v1
kind: Secret
metadata: { name: db }
type: Opaque
stringData:                     # plain text in, base64 stored
  url: postgres://shipit:change-me@postgres:5432/shipit
```

### Gateway + HTTPRoute (Ingress is the legacy equivalent)

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: web }
spec:
  gatewayClassName: eg
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: app.example.com
      tls:
        certificateRefs: [{ kind: Secret, name: web-tls }]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: web }
spec:
  parentRefs: [{ name: web }]
  hostnames: [app.example.com]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /api } }]
      backendRefs: [{ name: api, port: 80 }]
    - backendRefs: [{ name: web, port: 80 }]
```

### StatefulSet with storage (+ headless Service)

```yaml
apiVersion: v1
kind: Service
metadata: { name: db }
spec:
  clusterIP: None
  selector: { app: db }
  ports: [{ port: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db }
spec:
  serviceName: db
  replicas: 1
  selector:
    matchLabels: { app: db }
  template:
    metadata:
      labels: { app: db }
    spec:
      containers:
        - name: postgres
          image: postgres:17
          env:
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: db-pass, key: password } }
            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 1Gi } }
```

### Job and CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: cleanup }
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 2
      ttlSecondsAfterFinished: 3600
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: cleanup
              image: busybox:1.36
              command: ["sh", "-c", "echo cleaning up"]
```

### HPA and PDB

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: web }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: web }
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: web }
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app: web }
```

### NetworkPolicy (default deny + allow)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: db-from-api }
spec:
  podSelector:
    matchLabels: { app: db }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: api }
      ports: [{ protocol: TCP, port: 5432 }]
```

### Role + RoleBinding + ServiceAccount

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: ci }
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: deployer }
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "patch", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ci-deployer }
subjects:
  - { kind: ServiceAccount, name: ci, namespace: dev }
roleRef: { kind: Role, name: deployer, apiGroup: rbac.authorization.k8s.io }
```

### Hardened pod securityContext

```yaml
spec:
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: app
      image: shipit-api:1.0.0
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
      volumeMounts: [{ name: tmp, mountPath: /tmp }]
  volumes: [{ name: tmp, emptyDir: {} }]
```
