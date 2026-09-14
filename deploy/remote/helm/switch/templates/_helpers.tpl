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
{{- if .secretNameOverride -}}
{{- .secretNameOverride -}}
{{- else if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "switch.fullname" . }}-secrets
{{- end -}}
{{- end }}

{{/*
The Secret's data block, so the pre-upgrade copy the migration reads is
rendered from this one source and cannot drift from the release's own.
*/}}
{{- define "switch.secretData" -}}
{{- if not .Values.postgresql.existingSecret }}
POSTGRES_PASSWORD: {{ required "secrets.postgresPassword is required (unless postgresql.existingSecret is set)" .Values.secrets.postgresPassword | b64enc | quote }}
{{- end }}
{{- if and .Values.postgresql.owner.username (not .Values.postgresql.owner.existingSecret) }}
DB_OWNER_PASSWORD: {{ required "secrets.dbOwnerPassword is required when postgresql.owner.username is set (unless postgresql.owner.existingSecret is set)" .Values.secrets.dbOwnerPassword | b64enc | quote }}
{{- end }}
AGENT_REGISTRATION_TOKEN: {{ required "secrets.agentRegistrationToken is required" .Values.secrets.agentRegistrationToken | b64enc | quote }}
JWT_SECRET_KEY: {{ required "secrets.jwtSecretKey is required" .Values.secrets.jwtSecretKey | b64enc | quote }}
GATEWAY_ADMIN_EMAIL: {{ required "secrets.gatewayAdminEmail is required" .Values.secrets.gatewayAdminEmail | b64enc | quote }}
GATEWAY_ADMIN_PASSWORD: {{ required "secrets.gatewayAdminPassword is required" .Values.secrets.gatewayAdminPassword | b64enc | quote }}
{{- if .Values.mattermost.enabled }}
MATTERMOST_ADMIN_PASSWORD: {{ .Values.secrets.mattermostAdminPassword | default .Values.secrets.postgresPassword | b64enc | quote }}
MATTERMOST_USER_PASSWORD: {{ .Values.secrets.mattermostUserPassword | default .Values.secrets.postgresPassword | b64enc | quote }}
{{- end }}
{{- if .Values.switchCore.oidc.enabled }}
GATEWAY_OIDC_CLIENT_SECRET: {{ required "secrets.gatewayOidcClientSecret is required when switchCore.oidc.enabled" .Values.secrets.gatewayOidcClientSecret | b64enc | quote }}
{{- end }}
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

{{/*
The bootstrapped Postgres superuser: "postgres" in managed mode (the account
POSTGRES_USER creates on the StatefulSet below), or postgresql.external.username
in existing mode. The identity the managed StatefulSet, its initdb scripts and
the create-runtime-role Job bootstrap and administer with. Distinct from
switch.postgresUser below, which is DB_USER: the restricted role the RLS
policies apply to.

In managed mode those two are genuinely different accounts. In existing mode
they are the same value, because the chart does not manage that database and
has only the one username to go on — so this helper is *not* what Mattermost
should connect as there; see switch.mattermostDbUser.
*/}}
{{- define "switch.postgresSuperUser" -}}
{{- if eq .Values.postgresql.mode "existing" -}}
{{- .Values.postgresql.external.username | default "postgres" -}}
{{- else -}}
postgres
{{- end -}}
{{- end }}

{{/*
DB_USER: the runtime role every request is actually served over, and the one
the row-level-security policies apply to.

  mode: existing -> postgresql.external.username, unchanged from what this
                    chart has always sent. The chart does not manage that
                    database, so it cannot create a role in it — DB_USER keeps
                    pointing at whatever account you configure until you
                    create a restricted one yourself and repoint this at it.
  mode: managed  -> postgresql.managed.runtimeUsername, a role this chart
                    creates itself (fresh installs: templates/postgresql/
                    configmap-init.yaml; upgrades of a deployment that
                    predates it: the create-runtime-role pre-upgrade hook Job).
                    Managed mode is the one mode where the chart owns the
                    Postgres it points at, so it is the only mode where it
                    *can* create the role — leaving this at the superuser by
                    default there would make the chart's own default install
                    the one deployment shape with no tenant isolation in it,
                    which is the opposite of what this change is for.
*/}}
{{- define "switch.postgresUser" -}}
{{- if eq .Values.postgresql.mode "existing" -}}
{{- .Values.postgresql.external.username | default "postgres" -}}
{{- else -}}
{{- .Values.postgresql.managed.runtimeUsername -}}
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
DB_OWNER_USER: the schema owner switch-core migrates and grants as.

  owner.username set       -> exactly that value, in either postgresql mode.
  owner.username unset,
    mode: managed           -> "postgres", the bootstrapped superuser: it
                                already exists, already owns the schema, and
                                its password is already tracked as
                                secrets.postgresPassword, so a managed install
                                needs no separate owner credential configured
                                at all.
  owner.username unset,
    mode: existing          -> empty. The chart has no external database
                                superuser to default to, so an unconfigured
                                owner there really does mean "no owner
                                configured" — see the values.yaml comment on
                                postgresql.owner for what that implies at boot.
*/}}
{{- define "switch.postgresOwnerUser" -}}
{{- if .Values.postgresql.owner.username -}}
{{- .Values.postgresql.owner.username -}}
{{- else if eq .Values.postgresql.mode "managed" -}}
postgres
{{- end -}}
{{- end }}

{{/*
Name/key of the Secret holding the schema owner's password, mirroring
switch.postgresSecretName/Key above for the runtime role.

Only consulted when postgresql.owner.username is explicitly set — that is the
only case with a DB_OWNER_PASSWORD key of its own (see switch.secretData). The
managed default owner (switch.postgresOwnerUser resolving to "postgres" with
no owner.username set) has no such key: it is the bootstrapped superuser, so
its password is whatever switch.postgresSecretName/Key already resolve to, and
callers must fall back to those directly rather than through this helper.
*/}}
{{- define "switch.postgresOwnerSecretName" -}}
{{- if .Values.postgresql.owner.existingSecret -}}
{{- .Values.postgresql.owner.existingSecret -}}
{{- else -}}
{{- include "switch.secretName" . -}}
{{- end -}}
{{- end }}

{{- define "switch.postgresOwnerSecretKey" -}}
{{- .Values.postgresql.owner.existingSecretKey | default "DB_OWNER_PASSWORD" -}}
{{- end }}

{{/*
The credentials Mattermost connects to its own "mattermost" database with,
and the reason they are not switch.postgresUser's.

Mattermost creates and migrates its own schema, so it needs an account with
rights in that database. The runtime role has none: it is granted CRUD on the
tables switch-core's own migration created, in switch-core's own database, and
nothing anywhere else. There is no isolation argument for restricting
Mattermost either — its schema carries no row-level security and no tenant
column — so the administrative account is simply the right one.

In managed mode that is the bootstrapped superuser, unchanged: initdb creates
the "mattermost" database as "postgres" and postgresql.owner.username does not
move it, so this deliberately does not follow that value there.

Existing mode is the case this exists for. switch.postgresSuperUser and
switch.postgresUser both resolve to postgresql.external.username there, so the
moment an operator repoints external.username at a restricted role — which is
exactly what docs/old/rds-migration.md asks them to do — Mattermost would
follow it onto a role with no rights in its database and fail to start. When an
owner is configured, use it; when one is not, this is a deployment that has not
split its roles yet and external.username is still the administrative account,
which is the behaviour it has always had.

The three helpers below share one condition, so it is written once and the
other two ask it. It answers with a non-empty string or nothing, which is what
`if` reads — deliberately not "true"/"false", since an `include` returning the
string "false" is still truthy and inviting a reader to compare against it
would be inviting a bug.
*/}}
{{- define "switch.mattermostUsesOwner" -}}
{{- if and (eq .Values.postgresql.mode "existing") .Values.postgresql.owner.username -}}
owner
{{- end -}}
{{- end }}

{{- define "switch.mattermostDbUser" -}}
{{- if include "switch.mattermostUsesOwner" . -}}
{{- .Values.postgresql.owner.username -}}
{{- else -}}
{{- include "switch.postgresSuperUser" . -}}
{{- end -}}
{{- end }}

{{- define "switch.mattermostDbSecretName" -}}
{{- if include "switch.mattermostUsesOwner" . -}}
{{- include "switch.postgresOwnerSecretName" . -}}
{{- else -}}
{{- include "switch.postgresSecretName" . -}}
{{- end -}}
{{- end }}

{{- define "switch.mattermostDbSecretKey" -}}
{{- if include "switch.mattermostUsesOwner" . -}}
{{- include "switch.postgresOwnerSecretKey" . -}}
{{- else -}}
{{- include "switch.postgresSecretKey" . -}}
{{- end -}}
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
Name of the ConfigMap holding the database CA bundle — the user's own, or the
chart-managed one rendered from postgresql.caBundle.contents. Empty when no
bundle is configured, which is what every caller tests to decide whether to
mount anything.
*/}}
{{- define "switch.dbCaBundleConfigMap" -}}
{{- if .dbCaConfigMapOverride -}}
{{- .dbCaConfigMapOverride -}}
{{- else if .Values.postgresql.caBundle.existingConfigMap -}}
{{- .Values.postgresql.caBundle.existingConfigMap -}}
{{- else if .Values.postgresql.caBundle.contents -}}
{{- include "switch.fullname" . }}-db-ca
{{- end -}}
{{- end }}

{{/*
The CA ConfigMap's data block, shared with the pre-upgrade copy for the same
reason as the Secret's.
*/}}
{{- define "switch.dbCaBundleData" -}}
{{ .Values.postgresql.caBundle.key }}: |
{{ .Values.postgresql.caBundle.contents | indent 2 }}
{{- end }}

{{/*
Path the CA bundle is mounted at inside every container that connects to the
database.
*/}}
{{- define "switch.dbCaBundlePath" -}}
{{- printf "%s/%s" (trimSuffix "/" .Values.postgresql.caBundle.mountPath) .Values.postgresql.caBundle.key -}}
{{- end }}

{{- define "switch.dbCaBundleVolume" -}}
- name: db-ca-bundle
  configMap:
    name: {{ include "switch.dbCaBundleConfigMap" . }}
    items:
      - key: {{ .Values.postgresql.caBundle.key }}
        path: {{ .Values.postgresql.caBundle.key }}
{{- end }}

{{- define "switch.dbCaBundleVolumeMount" -}}
- name: db-ca-bundle
  mountPath: {{ .Values.postgresql.caBundle.mountPath }}
  readOnly: true
{{- end }}

{{/*
Refuse a TLS configuration that cannot work, at template time rather than on
the first connection of a rolled-out pod.
*/}}
{{- define "switch.validateDbTls" -}}
{{- $ca := .Values.postgresql.caBundle -}}
{{- if and $ca.contents $ca.existingConfigMap -}}
{{- fail "postgresql.caBundle: set contents or existingConfigMap, not both." -}}
{{- end -}}
{{- $bundle := include "switch.dbCaBundleConfigMap" . -}}
{{- $verifying := has .Values.postgresql.sslMode (list "verify-ca" "verify-full") -}}
{{- if and $verifying (not $bundle) -}}
{{- fail (printf "postgresql.sslMode=%s checks the server certificate against a CA bundle, but postgresql.caBundle is empty. Supply the provider's root CA (for RDS, https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) or use sslMode=require." .Values.postgresql.sslMode) -}}
{{- end -}}
{{- if and $bundle (not $verifying) -}}
{{- fail (printf "postgresql.caBundle is set but postgresql.sslMode=%s never checks the server certificate, so the bundle would have no effect. Use verify-ca or verify-full." .Values.postgresql.sslMode) -}}
{{- end -}}
{{- end }}

{{/*
Reject a log format switch-core would refuse at startup, so a typo is a render
error rather than a crash loop.
*/}}
{{- define "switch.validateLogging" -}}
{{- if not (has .Values.switchCore.logging.format (list "text" "json")) -}}
{{- fail (printf "switchCore.logging.format must be text or json, not %q." .Values.switchCore.logging.format) -}}
{{- end -}}
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
{{- $ownerUser := include "switch.postgresOwnerUser" . }}
{{- if $ownerUser }}
- name: DB_OWNER_USER
  value: {{ $ownerUser | quote }}
- name: DB_OWNER_PASSWORD
  valueFrom:
    secretKeyRef:
      {{- if .Values.postgresql.owner.username }}
      name: {{ include "switch.postgresOwnerSecretName" . }}
      key: {{ include "switch.postgresOwnerSecretKey" . }}
      {{- else }}
      name: {{ include "switch.postgresSecretName" . }}
      key: {{ include "switch.postgresSecretKey" . }}
      {{- end }}
{{- end }}
{{- if not .Values.postgresql.requireRestrictedRole }}
- name: DB_REQUIRE_RESTRICTED_ROLE
  value: "false"
{{- end }}
- name: DB_SSL_MODE
  value: {{ .Values.postgresql.sslMode | quote }}
{{- if include "switch.dbCaBundleConfigMap" . }}
- name: DB_SSL_ROOT_CERT
  value: {{ include "switch.dbCaBundlePath" . | quote }}
{{- end }}
- name: DB_POOL_SIZE
  value: {{ .Values.postgresql.pool.size | quote }}
- name: DB_MAX_OVERFLOW
  value: {{ .Values.postgresql.pool.maxOverflow | quote }}
- name: DB_POOL_TIMEOUT
  value: {{ .Values.postgresql.pool.timeout | quote }}
- name: DB_TCP_KEEPALIVE_IDLE
  value: {{ .Values.postgresql.tcp.keepaliveIdle | quote }}
- name: DB_TCP_KEEPALIVE_INTERVAL
  value: {{ .Values.postgresql.tcp.keepaliveInterval | quote }}
- name: DB_TCP_KEEPALIVE_COUNT
  value: {{ .Values.postgresql.tcp.keepaliveCount | quote }}
- name: DB_TCP_USER_TIMEOUT
  value: {{ .Values.postgresql.tcp.userTimeout | quote }}
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
{{- $oidcScopes := required "switchCore.oidc.scopes is required when oidc.enabled" .Values.switchCore.oidc.scopes }}
{{- if not (has "openid" (regexSplit "\\s+" (trim $oidcScopes) -1)) }}
{{- fail (printf "switchCore.oidc.scopes must include \"openid\" — without it the provider issues no id_token and the gateway falls back to a userinfo call it may not answer. Got %q." $oidcScopes) }}
{{- end }}
- name: GATEWAY_OIDC_SCOPES
  value: {{ $oidcScopes | quote }}
- name: GATEWAY_OIDC_PROVIDER_LABEL
  value: {{ .Values.switchCore.oidc.providerLabel | quote }}
{{- if .Values.switchCore.oidc.redirectUrl }}
- name: GATEWAY_OIDC_REDIRECT_URL
  value: {{ .Values.switchCore.oidc.redirectUrl | quote }}
{{- end }}
{{- if not .Values.switchCore.oidc.requireEmailVerified }}
- name: GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED
  value: "false"
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
- name: LOG_FORMAT
  value: {{ .Values.switchCore.logging.format | quote }}
- name: LOG_LEVEL
  value: {{ .Values.switchCore.logging.rootLevel | quote }}
- name: TENANT_ID
  value: {{ .Values.switchCore.logging.tenantId | quote }}
- name: SERVICE_NAME
  value: {{ .Values.switchCore.logging.serviceName | quote }}
{{- with .Values.switchCore.logging.environment }}
- name: ENVIRONMENT
  value: {{ . | quote }}
{{- end }}
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
