{{/*
Full name, truncated for K8s name limits.
*/}}
{{- define "switch.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "switch.labels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/*
Selector labels for a named component.
Usage: {{ include "switch.selectorLabels" (dict "Release" .Release "component" "switch-core") }}
*/}}
{{- define "switch.selectorLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Secret name. Defaults to the chart-managed Secret; set secrets.existingSecret to
have every consumer read from a pre-existing Secret instead (e.g. one synced by
the External Secrets Operator / sealed-secrets). When set, the chart renders no
Secret of its own.
*/}}
{{- define "switch.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "switch.fullname" . }}-secrets
{{- end -}}
{{- end }}

{{/*
PostgreSQL connection details.

  mode: managed  -> the chart's in-cluster StatefulSet.
  mode: existing -> an operator-supplied external database (RDS / Cloud SQL /
                    Azure / self-run), configured under postgresql.external.

Every consumer (switch-core, mattermost, the wait-for init containers) resolves
the host/port/user/database and the password secret through these helpers so the
two modes stay in lockstep.
*/}}
{{- define "switch.postgresHost" -}}
{{- if eq .Values.postgresql.mode "existing" -}}
{{- required "postgresql.external.host is required when postgresql.mode=existing" .Values.postgresql.external.host -}}
{{- else -}}
{{- include "switch.fullname" . }}-postgresql
{{- end -}}
{{- end }}

{{- define "switch.postgresPort" -}}
{{- if eq .Values.postgresql.mode "existing" -}}
{{- .Values.postgresql.external.port | default 5432 -}}
{{- else -}}
5432
{{- end -}}
{{- end }}

{{- define "switch.postgresUser" -}}
{{- if eq .Values.postgresql.mode "existing" -}}
{{- .Values.postgresql.external.username | default "postgres" -}}
{{- else -}}
postgres
{{- end -}}
{{- end }}

{{- define "switch.postgresDatabase" -}}
{{- if eq .Values.postgresql.mode "existing" -}}
{{- .Values.postgresql.external.database | default "switch" -}}
{{- else -}}
{{- .Values.postgresql.database -}}
{{- end -}}
{{- end }}

{{/*
Name/key of the Secret holding the Postgres password. Defaults to the
chart-managed Secret; set postgresql.existingSecret to source it from an
external secret (e.g. one synced by external-secrets / sealed-secrets).
*/}}
{{- define "switch.postgresSecretName" -}}
{{- if .Values.postgresql.existingSecret -}}
{{- .Values.postgresql.existingSecret -}}
{{- else -}}
{{- include "switch.secretName" . -}}
{{- end -}}
{{- end }}

{{- define "switch.postgresSecretKey" -}}
{{- .Values.postgresql.existingSecretKey | default "POSTGRES_PASSWORD" -}}
{{- end }}

{{/*
Other service hostnames (used in env vars and init containers).
*/}}

{{- define "switch.switchCoreHost" -}}
{{- include "switch.fullname" . }}-switch-core
{{- end }}

{{- define "switch.gatewayHost" -}}
{{- include "switch.fullname" . }}-gateway
{{- end }}

{{- define "switch.mattermostHost" -}}
{{- include "switch.fullname" . }}-mattermost
{{- end }}

{{/*
Public origin of the Teams bridge listener: the value the bridge's
public_base_url must be set to.

Always https, whatever `tls.enabled` says. That flag governs whether *this*
Ingress carries a certificate, not what Microsoft dials — and Graph refuses a
plaintext URL, so http is never the answer. Deriving the scheme from the flag
printed `http://<host>` as the value to use whenever TLS terminated upstream,
which is the documented ALB pattern.

Empty only when the host is genuinely unknown to the chart: a host-less rule
behind a CDN that owns the public name. The caller must then ask the operator
rather than print a guess.
*/}}
{{- define "switch.teamsPublicOrigin" -}}
{{- $teams := .Values.switchCore.teamsBridge -}}
{{- if and (eq $teams.ingress.mode "dedicated") $teams.ingress.host -}}
{{- printf "https://%s" $teams.ingress.host -}}
{{- else if and (eq $teams.ingress.mode "shared") .Values.ingress.host -}}
{{- printf "https://%s" .Values.ingress.host -}}
{{- end -}}
{{- end }}

{{/*
Reject Teams bridge configurations that would deploy a listener nothing can
reach. Publishing the port without routing it produces a bridge that creates
channels and posts fine while silently receiving nothing, which is the exact
failure this block exists to prevent — so these are render-time errors rather
than something you discover hours later at Graph subscription time.
*/}}
{{- define "switch.validateTeamsBridge" -}}
{{- $teams := .Values.switchCore.teamsBridge -}}
{{- $mode := $teams.ingress.mode -}}
{{- $modes := list "dedicated" "shared" "external" -}}
{{- if not $teams.enabled -}}
{{- if $mode -}}
{{- fail (printf "switchCore.teamsBridge.ingress.mode is %q but switchCore.teamsBridge.enabled is false: nothing publishes port %v for it to route to. Set enabled=true, or clear the mode." $mode $teams.port) -}}
{{- end -}}
{{- else -}}
{{- if not $mode -}}
{{- fail "switchCore.teamsBridge.enabled is true but switchCore.teamsBridge.ingress.mode is unset. Microsoft calls the Teams listener from the public internet, so publishing the port is only half the job — choose how the two callback paths are routed: \"dedicated\" (the chart renders an Ingress for them on their own host), \"shared\" (add them to the chart's managed Ingress), or \"external\" (you route them yourself; see samples/ingress.example.yaml)." -}}
{{- end -}}
{{- if not (has $mode $modes) -}}
{{- fail (printf "switchCore.teamsBridge.ingress.mode must be one of dedicated, shared or external — got %q." $mode) -}}
{{- end -}}
{{- if and (eq $mode "shared") (ne .Values.ingress.mode "managed") -}}
{{- fail (printf "switchCore.teamsBridge.ingress.mode is \"shared\" but ingress.mode is %q: there is no chart-managed Ingress to add the Teams paths to. Set ingress.mode=managed, or use teamsBridge.ingress.mode=dedicated to give Teams its own Ingress, or \"external\" to route it yourself." .Values.ingress.mode) -}}
{{- end -}}
{{- if and (eq $mode "shared") (not .Values.ingress.host) -}}
{{- fail "switchCore.teamsBridge.ingress.mode is \"shared\" but ingress.host is empty. Microsoft resolves the notification URL from public DNS, so the Ingress needs a real hostname rather than a catch-all rule." -}}
{{- end -}}
{{- if and (ne $mode "external") (not .Values.ingress.teamsPaths) -}}
{{- fail "ingress.teamsPaths is empty, so the Teams Ingress would render a rule with no paths — which Helm accepts and the Kubernetes API rejects at apply time. Restore the two callback paths, or set switchCore.teamsBridge.ingress.mode=external if you route them yourself." -}}
{{- end -}}
{{- if and (eq $mode "dedicated") (not $teams.ingress.host) $teams.ingress.tls.enabled -}}
{{- fail "switchCore.teamsBridge.ingress.mode is \"dedicated\" with TLS enabled but switchCore.teamsBridge.ingress.host is empty: a host-less rule cannot carry a TLS certificate. Either set the host, or set tls.enabled=false if something upstream terminates TLS and owns the public name (a CDN or reverse proxy — then public_base_url is that name, not this Ingress's)." -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Prepend the global image registry if set.
Usage: {{ include "switch.image" (dict "global" .Values.global "image" .Values.switchCore.image) }}
*/}}
{{- define "switch.image" -}}
{{- if .global.imageRegistry -}}
{{- printf "%s/%s" .global.imageRegistry .image }}
{{- else -}}
{{- .image }}
{{- end -}}
{{- end }}

{{/*
imagePullSecrets block from .Values.global.imagePullSecrets (a list of Secret
names) — for pulling images from a private registry. Renders nothing when the
list is empty. Guard the include so the empty case leaves no stray line:
  {{- if .Values.global.imagePullSecrets }}
  {{- include "switch.imagePullSecrets" . | nindent 6 }}
  {{- end }}
*/}}
{{- define "switch.imagePullSecrets" -}}
imagePullSecrets:
{{- range .Values.global.imagePullSecrets }}
  - name: {{ . }}
{{- end }}
{{- end }}

{{/*
switch-core container env. Shared by the switch-core Deployment and the
pre-upgrade migration Job so they always run against the same configuration
(env.py builds a full SwitchConfig, so the migration Job needs every var too).
Include with `nindent 12`.
*/}}
{{- define "switch.coreEnv" -}}
- name: DB_HOST
  value: {{ include "switch.postgresHost" . | quote }}
- name: DB_PORT
  value: {{ include "switch.postgresPort" . | quote }}
- name: DB_USER
  value: {{ include "switch.postgresUser" . | quote }}
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "switch.postgresSecretName" . }}
      key: {{ include "switch.postgresSecretKey" . }}
- name: DB_NAME
  value: {{ include "switch.postgresDatabase" . | quote }}
- name: DB_SSL_MODE
  value: {{ .Values.postgresql.sslMode | quote }}
- name: DB_POOL_SIZE
  value: {{ .Values.postgresql.pool.size | quote }}
- name: DB_MAX_OVERFLOW
  value: {{ .Values.postgresql.pool.maxOverflow | quote }}
- name: DB_POOL_TIMEOUT
  value: {{ .Values.postgresql.pool.timeout | quote }}
{{- with .Values.postgresql.idleInTransactionSessionTimeout }}
- name: DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT
  value: {{ . | quote }}
{{- end }}
- name: AGENT_AUTH_CACHE_TTL_SECONDS
  value: {{ .Values.switchCore.authCache.ttlSeconds | quote }}
- name: MATRIX_SERVER_NAME
  value: {{ .Values.clientIdentity.serverName | quote }}
- name: AGENT_REGISTRATION_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "switch.secretName" . }}
      key: AGENT_REGISTRATION_TOKEN
- name: JWT_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "switch.secretName" . }}
      key: JWT_SECRET_KEY
- name: GATEWAY_ADMIN_EMAIL
  valueFrom:
    secretKeyRef:
      name: {{ include "switch.secretName" . }}
      key: GATEWAY_ADMIN_EMAIL
- name: GATEWAY_ADMIN_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "switch.secretName" . }}
      key: GATEWAY_ADMIN_PASSWORD
{{- if .Values.switchCore.oidc.enabled }}
- name: GATEWAY_OIDC_ISSUER_URL
  value: {{ required "switchCore.oidc.issuerUrl is required when oidc.enabled" .Values.switchCore.oidc.issuerUrl | quote }}
- name: GATEWAY_OIDC_CLIENT_ID
  value: {{ required "switchCore.oidc.clientId is required when oidc.enabled" .Values.switchCore.oidc.clientId | quote }}
- name: GATEWAY_OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "switch.secretName" . }}
      key: GATEWAY_OIDC_CLIENT_SECRET
- name: GATEWAY_OIDC_SCOPES
  value: {{ .Values.switchCore.oidc.scopes | quote }}
- name: GATEWAY_OIDC_PROVIDER_LABEL
  value: {{ .Values.switchCore.oidc.providerLabel | quote }}
{{- if .Values.switchCore.oidc.redirectUrl }}
- name: GATEWAY_OIDC_REDIRECT_URL
  value: {{ .Values.switchCore.oidc.redirectUrl | quote }}
{{- end }}
{{- if not .Values.switchCore.oidc.passwordLoginEnabled }}
- name: GATEWAY_PASSWORD_LOGIN_ENABLED
  value: "false"
{{- end }}
{{- end }}
- name: GATEWAY_COOKIE_SECURE
  value: {{ .Values.switchCore.cookieSecure | quote }}
- name: SWITCH_LOG_LEVEL
  value: {{ .Values.switchCore.logLevel | default "INFO" | quote }}
# switch-core sits behind the cluster/ALB and enforces its own
# BearerAuthMiddleware, so fastmcp's browser-oriented DNS-rebinding
# Host/Origin guard (default-on since mcp 1.28) only rejects the
# in-cluster Host (e.g. switch-switch-core:8000) with a 421.
- name: FASTMCP_HTTP_HOST_ORIGIN_PROTECTION
  value: "false"
{{- if .Values.switchCore.frontendBaseUrl }}
- name: FRONTEND_BASE_URL
  value: {{ .Values.switchCore.frontendBaseUrl | quote }}
{{- end }}
{{- if .Values.switchCore.gatewayPublicUrl }}
- name: GATEWAY_PUBLIC_URL
  value: {{ .Values.switchCore.gatewayPublicUrl | quote }}
{{- end }}
{{- end }}

{{/*
Wait-for init container template.
Usage: {{ include "switch.waitFor" (dict "name" "postgres" "host" (include "switch.postgresHost" .) "port" "5432") }}
*/}}
{{- define "switch.waitFor" -}}
- name: wait-for-{{ .name }}
  image: busybox:1.36
  command: ["sh", "-c", "until nc -z {{ .host }} {{ .port }}; do echo 'waiting for {{ .name }}...'; sleep 2; done"]
{{- end }}

{{/*
Wait-for-http init container template.
Usage: {{ include "switch.waitForHttp" (dict "name" "gateway" "url" "http://host:8000/health") }}
*/}}
{{- define "switch.waitForHttp" -}}
- name: wait-for-{{ .name }}
  image: busybox:1.36
  command: ["sh", "-c", "until wget -q --spider {{ .url }}; do echo 'waiting for {{ .name }}...'; sleep 2; done"]
{{- end }}
