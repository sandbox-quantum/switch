# Service connections: v1 implementation spec

Status: proposed. This is the implementation spec for connecting a person's own
accounts on outside services and granting them to that person's agents. It
covers the Core foundation (tables, the credential broker, the agent routes and
the gateway API), the agent host that every Console provider runs in, and
moving GitHub onto all of it. Services beyond GitHub come next, on the same
foundation: see [`service-connections-v2.md`](service-connections-v2.md).

The target contract is `controller-contract-v1.md`; its §5 is amended alongside
this spec, and the deviations are listed below.

"Connector" already means something else in Core (`agents.connector_type`,
`bridges/agent/server_connectors/`), so this feature says **service** and
**service connection** throughout: in tables, routes, code and screens.

## Shape

- **Connection:** one person's sign-in to one service in one workspace, keyed by
  tenant, user and service. Core holds its long-lived secret (the refresh
  token), encrypted with the server keyring.
- **Grant:** agent X may use its owner's connection to service S, at an access
  level, with a tool list and, where the vendor's token can be narrowed,
  resources (GitHub: an installation and repositories). Only the agent's owner
  grants, and only their own connection.
- **Broker** (`connections/broker.py`): the only code that decrypts a
  connection's secret. It refreshes under a per-connection lock, runs the
  issuance checks, issues a token valid for at most one hour, records every
  issuance and revokes what can be revoked.
- **Agent host:** when a session starts, it reads the agent's grants from
  Core, adds the granted skills to the session, fetches tokens and serves them
  to the session's tools and helpers. Tokens are redacted from everything the
  agent host and its session hosts write or send.
- **Catalog:** `connections/catalog/<slug>/connection.yaml` and, for an enabled
  service, `skill/SKILL.md`. Validated at import.

The vendor's token is the access boundary: an agent with a grant can do what
its owner's token can do at the vendor, minus the tools its grant leaves out.
Tool lists are best-effort, because only GitHub's token reaches the session, and
an agent holding a token could call the vendor's API directly.

## v1 scope and deliberate deviations from the controller contract

| Target contract | v1 | Why |
|---|---|---|
| §5 `POST /v1/management/controllers/{id}/connector-token` | **An agent route**, `POST /agents/{agent_id}/service-tokens/{service}`. §5 is amended to match | The controller's local relay forwards `/agents/{id}/...` with the controller access token and keeps management paths local. Core's middleware already checks the binding and puts the controller on the request. A directly connected agent calls the same route with its own key, so there is one route and one set of checks |
| §2 `skills` (and `repo`) carried in the assignment | **Not used.** The agent host reads `GET /agents/{agent_id}/service-grants` when a session starts | Console, the controller, the SSH sidecar and the cloud worker all start sessions through `runAgentHost`, so this is one change for every agent. A sidecar running with Console closed still sees a new grant. `DefinitionV1` stays as it is, and a grant change bumps no revision |
| `credential.revoked` when a grant is removed | **Not used** | That frame means the controller itself is revoked: the controller stops every agent and wipes its credential. A removed grant needs no frame: the next token fetch fails, and GitHub tokens are revoked at once |
| A vendor or Switch tool started with the token | **The agent host keeps the token** and serves the tools from the session's loopback MCP server, as it serves the Switch tools | No Jira or Google token enters a CLI's environment, arguments or files. GitHub is the exception: `git` and `gh` need the token, so its helpers ask the agent host for it |
| Skills installed into the provider's skills folder | **Delivered the way the Switch skill is:** system context for Claude Code, Codex, Cursor and Antigravity; a per-session skill file for OpenCode | On laptops and servers the provider's skills folder is the user's own (`~/.claude`, `~/.codex`), so an install there would reach every session, Switch or not |
| §3 tool status such as `mcp:jira` | `git` and `gh` only | No service in v1 has tools of its own on the machine |

Not in v1:

- Workspace (shared) connections. Every connection is personal.
- Narrowing a grant to projects or files, except GitHub repositories, which the
  installation token itself enforces.
- Approval before a write. A write grant says that writes run without asking.
- Grants for agents with their own runtime (registered with "register other").
  Nothing would start their tools, so the grant API refuses them.
- "Also grant to subagents". A subagent is its own agent with its own grants.
- A stream frame when grants change. A running session keeps its tools until
  it restarts; a removed grant stops at the next token fetch.
- The GitHub helpers on Windows. They are shell scripts; Windows machines
  report `git` and `gh` as unsupported until a follow-up.
- GitHub Enterprise Server and Jira Data Center.

## Core

### Config (`config.py`)

- `service_token_retention_days: int = 30` (`SERVICE_TOKEN_RETENTION_DAYS`), at
  least 1. Issuance records older than this are pruned.
- `github_app_config_path: str | None = None` (`GITHUB_APP_CONFIG_PATH`): the
  GitHub App's JSON settings, `{client_id, client_secret, slug, origin}`, the
  same shape as today's hosted GitHub settings file.
- `github_app_private_key_path: str | None = None`
  (`GITHUB_APP_PRIVATE_KEY_PATH`): the absolute path to the App's signing key.
- Both are read on every deployment, not only in the cloud. Setting one without
  the other is a startup error.
- For one release, when both are unset, `HOSTED_GITHUB_CONFIG_PATH` and the
  `github_private_key_path` in the hosted controller file still work, and Core
  logs a deprecation warning at startup naming the new settings. Without that
  signing key GitHub can be connected but not granted: the catalog and the
  grant API say so, and nothing is issued.
- With no GitHub App configured, Core starts, the catalog shows GitHub as not
  configured on this server, and the grant API refuses GitHub grants saying so.
  It never skips silently.

### Catalog: `connection.yaml` v2

```yaml
slug: github
name: GitHub
category: Source control
description: Clone, branch, push and open pull requests in the repositories you grant.
enabled: true
auth:
  type: oauth                  # oauth | api_key
  refresh: rotating            # rotating | reusable | none
  client_settings: GITHUB_APP  # prefix of the settings that hold the client
access:
  read:  { permissions: { contents: read, pull_requests: read } }
  write: { permissions: { contents: write, pull_requests: write } }
tools:
  read: []
  write: []
```

- `access.<level>` holds `scopes` (OAuth scopes, a list) or `permissions`
  (GitHub App permissions, a map of name to `read` or `write`), never both.
  Levels are `read` and `write`; `write` requires `read`.
- `tools.read` and `tools.write` name the service's tools. A read grant gets the
  read list; a write grant gets both. GitHub has none: its tools are `git` and
  `gh`.
- The loader refuses, naming the entry: a level with no scopes or permissions;
  a tool listed under both `read` and `write` (a write tool listed under read);
  an enabled entry without `access.read`, `tools` or `auth.refresh`.
  Placeholder entries may leave the v2 fields out.
- The loader stays strict (`extra="forbid"`). `machine_tool` and other fields
  arrive only when something reads them.
- **Skill lint**, with the rewritten GitHub skill: a skill file that mentions
  `GH_TOKEN`, `gh auth`, "access token" or "API key" (any case) is refused at
  import. A skill describes tasks, tools and limits, never credentials or
  setup.
- The `google-workspace` description drops Calendar, which v1 does not cover.

### Tables (all `TenantScoped`, RLS like every scoped table, one migration)

The migration installs the RLS policy through its own copy of `db/rls_ddl.py`,
as `b7e2c9d4a1f6_agent_controllers.py` does, and every index leads with
`tenant_id`.

- `service_connections`: primary key (`tenant_id`, `user_id`, `service`).
  - `user_id` references `users` and cascades, as `provider_connections` does.
  - `service` is a catalog slug, checked in code, not by a database check, so a
    new service needs no migration.
  - `status` (`active | needs_reauthorization | error`), `consent`
    (`read | write`), `granted_scopes` JSONB (the scopes the vendor reported;
    empty for GitHub, whose permissions come from the App).
  - `account_id`: the vendor's stable id for the account (GitHub's numeric user
    id), and `external_identity`: what a person recognises (a login, or a site).
  - `encrypted_secret`: keyring-encrypted JSON holding the refresh token, its
    expiry where the vendor gives one, and the cached access token with its
    expiry. `secret_revision` bumps on every write of it.
  - `error_code` null, `created_at`, `updated_at`.
- `service_grants`: primary key (`tenant_id`, `id`); unique (`tenant_id`,
  `agent_id`, `service`).
  - `agent_id`, `owner_id`, `service`, `access` (`read | write`), `tool_mode`
    (`allow | deny`), `tools` JSONB, `resources` JSONB (GitHub:
    `{installation_id, repository_ids}`), `account_id` (the vendor account the
    grant was made for), `created_by`, `created_at`, `updated_at`.
  - (`tenant_id`, `agent_id`) references `agents` and cascades. (`tenant_id`,
    `owner_id`, `service`) references `service_connections` and cascades, so
    disconnecting removes the connection's grants; re-linking updates the
    connection in place and keeps them.
  - The owner equals the agent's owner, and the access never exceeds the
    connection's consent: checked when the grant is saved and again at every
    issuance.
- `service_token_issuances`: primary key (`tenant_id`, `id`).
  - `grant_id`, `agent_id`, `owner_id`, `service`, `principal`
    (`controller | agent_key`), `controller_id` null, `permissions` JSONB,
    `resources` JSONB, `expires_at`, `token_sha256`, `encrypted_token` null,
    `revoke_requested`, `attempts`, `claim_until` null, `created_at`.
  - No foreign keys to grants, agents or users, so a record outlives them.
  - `encrypted_token` is kept only where the vendor can revoke one token
    (GitHub), and cleared once the token has expired or been revoked.
  - Rows older than `service_token_retention_days` are pruned.

`db/key_rotation.py` gains `(ServiceConnection, "encrypted_secret")` and
`(ServiceTokenIssuance, "encrypted_token")`, so a key rotation re-encrypts
them.

Grants are tool lists over the catalog: `allow` means only `tools`; `deny`
means every tool of the access level except `tools`. A new read grant is
`allow` with the catalog's read list; a new write grant is `deny` with none.

### Store (`db/stores/service_connection_store.py`)

Connections, grants and issuances. `lock_connection` takes
`pg_advisory_xact_lock` on `service-connection:{tenant}:{user}:{service}` with
a 25 s `lock_timeout`, as GitHub's connection lock does today.

### Broker (`connections/broker.py`)

The broker keeps four seams narrow, so each can be tested on its own and none
assumes where tokens go next:

- **Connection credential:** one function returns a usable vendor access token
  for a connection: decrypt, refresh under the lock if the cached token
  expires within 5 minutes, store the new pair, commit. Nothing else reads
  `encrypted_secret`. One owner's agents share one token and one refresh.
- **Grant decision:** the ordered issuance checks below live in one function
  that returns a decision (grant, access, permissions, resources, tools) or
  raises a coded error. The routes stay thin.
- **Delivery:** the token route and the adapter's `issue` and `revoke_issued`
  are the only code that knows a token goes to the agent.
- **Records:** every issuance is written by one broker function.

`ServiceBroker`:

- `issue(agent, principal, service) -> {token, expires_at, resources}`: decide,
  get the connection credential, call the adapter, check the expiry, record the
  issuance and count it. A refresh runs in its own transaction, outside the
  request's, and survives the request being cancelled (the `finish_shielded`
  pattern).
- `revoke_grant(grant)` and `disconnect(user, service)`: delete the rows, queue
  revocation of the issuances they cover, commit, then run one bounded
  revocation batch outside the transaction. `disconnect` also revokes the
  connection at the vendor where the adapter supports it.
- A refresh the vendor refuses for good (a revoked or lapsed refresh token)
  sets `needs_reauthorization` and `error_code`, and the fetch fails with
  `connector_revoked`. A transient failure leaves the status alone and fails
  retryable.

**Adapters** (`connections/adapters/`): a `ServiceAdapter` protocol with
`refresh`, `issue`, `revoke_issued` and `revoke_connection`, registered per
service at startup. The foundation registers none outside tests, which use a
fake adapter; GitHub's is registered when a GitHub App is configured.

**Revocation sweep.** It generalises today's GitHub sweep: issuances with a
token that is still live and whose grant, connection or owner's membership is
gone are queued, then revoked through the adapter, with `attempts` and
`claim_until` as today. It runs after every access change the broker makes, and
every five minutes for changes made elsewhere: deleting an agent removes its
grants by cascade, and the next tick revokes its GitHub tokens. A workspace
that holds no token's ciphertext costs the tick one read. Issuances past
retention are pruned hourly.

### Checks at every issuance

In order, each with its own error, in the contract envelope
`{"error": {"code", "message", "retryable"}}`:

1. The agent exists in the request's tenant (the middleware resolves it), it
   has an owner, and the owner is still a workspace member. Otherwise
   `403 forbidden`.
2. A grant exists for the agent and service. Otherwise `403 grant_missing`,
   naming the agent, the service and where its owner grants it.
3. The grant's owner and the agent's owner are the same person, so the
   connection is theirs. Otherwise `403 forbidden`.
4. A controller token belongs to that person (`scope["controller"].owner_id`);
   the middleware has already checked the binding (`403 not_assigned`). An
   agent key belongs to an agent with no binding; the middleware refuses a
   bound one with `409 managed_by_controller`. Otherwise `403 forbidden`.
5. The connection exists (else `404 connector_not_connected`) and is `active`
   (else `409 connector_revoked`, with the fix in the message).
6. The grant's `account_id` matches the connection's. Otherwise
   `409 grant_account_changed`: the owner re-linked a different account, and
   must grant again.
7. The grant's access does not exceed the connection's consent. Otherwise
   `403 forbidden`, saying which to change. Permissions and scopes come from
   the catalog for the grant's level.
8. The adapter's token expires within an hour, with 60 s of leeway. Otherwise
   it is revoked and the fetch fails `500 internal`.

A service not in the catalog is `404 not_found`; a service whose adapter is not
registered (GitHub with no App configured) is `503 internal`, not retryable,
saying so. The vendor refusing the issue (the owner lost access to a granted
repository) is `403 forbidden` with the vendor's reason; the vendor being
unreachable is `503 internal`, retryable. Every success and refusal is counted.

### Agent-bridge routes

Both are agent routes: the agent's own key, or a controller access token acting
as an agent bound to it. A path naming another agent is refused `403`, as on
every agent route.

- `GET /agents/{agent_id}/service-grants`
  - Returns `{grants: [{service, access, tool_mode, tools, resources, skill}]}`,
    `skill` being `{name, content}` (the service's `SKILL.md`).
- `POST /agents/{agent_id}/service-tokens/{service}`
  - No body. Returns `200 {token, expires_at, resources}` with
    `Cache-Control: no-store`. Errors as above.
  - Each call issues a new token; the agent host caches it.

Both are mounted with the other agent routes in
`bridges/agent/api/service_routes.py`. The relay already forwards them.

### Gateway routes (cookie, `get_current_user`)

- `GET /gateway/service-connections`: each catalog entry with the user's
  status: `not_connected`, `active`, `needs_reauthorization` or `error`, plus
  `enabled` and `auth_type` from the catalog, `connectable` (the server has
  the service's adapter), `configured` (false when the
  service cannot be granted here, with the reason), `consent` and
  `external_identity`. It replaces `/provider-connections/catalog`, which
  Console still reads from a server that answers this route 404.
- `DELETE /gateway/service-connections/{service}`: the connection's owner.
  Deletes it; grants cascade; issued tokens are queued for revocation and
  revoked; the connection is revoked at the vendor where supported.
- `GET /gateway/agents/{agent_id}/service-grants`: the agent's owner. Each
  grant, a plain summary of its reach ("Build bot can read and push to 2
  repositories, acting as the GitHub App"; the screens add the repositories'
  names from the owner's GitHub connection), `missing`, and `addressing_open`
  (`AddressingPolicy.admits_others()`: an open policy, or any rule that
  admits every human or agent, whatever its rooms, a human by an identity the
  owner has not claimed, or another person's agent), for the warning below. `missing` names a
  grant the agent works without: a live cloud launch with a repository and no
  GitHub grant (the launch could not make it, or someone removed it), with the
  reason and the grant that restores it, which the screens offer in one click.
- `PUT /gateway/agents/{agent_id}/service-grants/{service}`: the agent's owner,
  who must own the connection. Body `{access?, tool_mode?, tools?, resources}`.
  Creates or replaces the grant; with no `access` it is `read`, with the read
  tool list. The grant's `account_id` is the connection's at that moment.
  Replacing a grant with one that reaches less (write to read, fewer
  resources) or on another account revokes what was issued under the old one;
  a changed tool list does not, since a token is not narrowed by tools.
- `DELETE /gateway/agents/{agent_id}/service-grants/{service}`: the agent's
  owner. Removes the grant and revokes its issued tokens.

Refusals on the grant API:

- Someone else's agent: `404`, as a missing one.
- No connection to the service: `409`, naming where to connect it.
- Write on a read-only connection: `422`.
- **An agent with no Console agent type:** `422`, saying that nothing would
  start its tools. The type is `metadata.known_agent_type`, read by
  `known_agent_for` in `gateway/known_agents.py` (`claude-code`, `codex`,
  `opencode`, `antigravity`, `cursor`); the `agent_type` column does not hold
  it. This is how agents with their own runtime are refused.
- A service with no registered adapter: `422`, naming why ("not available on
  this server yet", or "the GitHub App is not configured").
- Tools outside the catalog's lists for the level, or resources the adapter
  rejects (GitHub: more than 500 repositories, a repository the user cannot
  see, or one they cannot push to for write): `422`.

**Addressing warning.** When `addressing_open` is true, the grant screens warn
that someone else can address the agent and so use the owner's grant, and
offer "Make owner-only". Owner-only still leaves instructions others write in
shared rooms, delegation through the owner's other open agents, and results
posted to shared rooms; the warning names them.

**Grant screens.** The gateway's agent page, Console's agent settings and
Console's dialog for editing a cloud agent show the agent's owner its grants (summary, level, repositories), a missing
one with "Grant it", the addressing warning, and a GitHub grant form (an
installation of the App, its repositories, read or read and push). Both say
that the agent acts as the GitHub App, that a GitHub grant replaces the
owner's own HTTPS login to github.com for the agent's sessions while SSH
remotes keep the owner's keys, that on the owner's own computer a grant
limits what Switch hands the agent and not what the machine allows, and that
Windows is not supported yet; for a cloud agent, which has no other GitHub
sign-in and runs on no machine of the owner's, only the first applies. Console's connection list shows a connection
needing reauthorization and why a service cannot be granted on the server.

### Audit, member removal and metrics

- `db/audit.py` gains `service.connected`, `service.disconnected`,
  `service_grant.set` and `service_grant.removed`. Issuances are not audit
  events: they run hourly per session and have their own table.
- `remove_member` (`gateway/tenants.py`) deletes the member's service
  connections (grants cascade) and queues their issued tokens for revocation,
  then revokes them after its commit, as it does for GitHub today. It still
  refuses while the member owns agents.
- `observability/catalogue.py` declares a counter of issuances and refusals,
  with attributes `service` (a catalog slug) and `outcome` (`issued` or a
  reason code), both fixed sets.

## Agent host (`console/packages/agent-providers`)

One change serves every runtime: Console with management off, a controller
(Console or daemon), the SSH sidecar and the cloud worker all run sessions
through `runAgentHost`.

- **Grants at session start** (`host/service-access.ts`): when a session starts
  or resumes, its session host reads `service-grants` through the agent's
  Switch endpoint: its own key, or the controller's relay. A Switch without the
  route answers 404, read as no grants. When the grants cannot be read the
  session starts without them, the log says why, and the session is told in
  its context that its granted services are not set up and are loaded again
  when it next starts.
- **Skills:** granted skills are added when a session is prepared
  (`prepareSharedConfig`), after the agent's template is applied, so resuming
  neither drops nor repeats them. They join `execution.context` for Claude
  Code, Codex, Cursor and Antigravity, and go to OpenCode as skill files.
- **The token ask:** a session ask, `service-token {service, rejected}`,
  answered in `sessionToolAnswerer` beside the Switch tool asks, which is the
  only place session asks are answered, in every runtime. The answer is a token
  or Core's refusal, marked final for `grant_missing`, `grant_account_changed`,
  `forbidden` and `connector_*`.
- **Token cache** (`host/service-tokens.ts`): one token per service, shared by
  the agent's sessions on the machine, asked for on first use and again 5
  minutes before it expires, one request at a time. While Switch cannot renew
  it, the current token is handed out as long as it has more than a minute
  left, with a warning. `rejected` is a token the service refused (Git erasing
  it, `gh` told 401): the cache drops it so the next ask gets one under the
  grant as it is now, or Core's refusal. Only one such report a minute per
  service is acted on; another within the minute is refused with that reason,
  so a token GitHub keeps refusing does not become a token per command. A
  final refusal drops the token.
- **Loopback endpoint for helpers** (`host/service-endpoint.ts`): a session
  whose agent has a GitHub grant gets a `127.0.0.1` endpoint with a
  per-session bearer, named in its environment as `SWITCH_SERVICE_ENDPOINT` and
  `SWITCH_SERVICE_BEARER` (no `KEY`, `SECRET` or `TOKEN` in the name, which
  Codex's environment policy can strip from what its commands get, depending
  on its version and settings).
  `POST /services/{service}/token` with `{rejected}`
  answers `{token, expires_at}`; 404 for a service not granted when the session
  started; 403 with Core's message after a final refusal, which ends the
  service for the rest of that session; 503 with the reason otherwise. An ask
  the agent host does not answer within 90 s (one from before this build
  ignores it) is a 503.
- **Redaction** (`host/redaction.ts`, from `host/hosted-log.ts`): exact-value
  redaction of every issued token, raw, URL-encoded and as base64 of
  `x-access-token:<token>`. The agent host scrubs the arguments of every tool
  call it makes for its sessions, room messages included, and its supervisor
  scrubs what the session hosts it runs write to `worker.log`, reading the
  values as they are added. Each session host scrubs every event before it is
  recorded, so its journal, Console's view and the activity rows Switch shows
  on the bridges are scrubbed together. No token passes through the agent
  host's own log lines. An assistant message is published whole, revision by
  revision, and split into 4096-character parts: its text is scrubbed before
  the split, and while it streams, a trailing piece that could be the start
  of a token is held back until the rest arrives or the message completes, so
  no revision or part carries a token in pieces. Not covered: the provider
  CLI's own transcript files.
- **Tool status** (`agent-controller/src/status.ts`): the controller reports
  `git` and `gh` in §3's `tools`: `ok` when on `PATH`, `missing` when not, and
  `unsupported` on Windows.

### GitHub helpers (`host/service-github.ts`, from `host/hosted-github.ts`)

- The credential helper and the `gh` wrapper are modes of the session host's
  own bundle (`--git-credential`, `--github-cli`). They ask the session's
  loopback endpoint; plain `http` is accepted only to `127.0.0.1`.
- The helper accepts repeated `capability[]` and `wwwauth[]` lines, which newer
  Git sends, so private clones work with Git 2.47 and later. On `erase` it
  reports the token as rejected; it stores nothing.
- The wrapper finds the real `gh` on `PATH`, skipping its own folder, and runs
  it with the token as `GH_TOKEN`. It watches `gh`'s stderr for GitHub
  refusing the token (`HTTP 401`, `Bad credentials`) and reports it, so the
  next command has another.
- **Laptops and servers, agents with a GitHub grant:** the helper is set, for
  the session only, through `GIT_CONFIG_PARAMETERS` in its environment (as
  `git -c` passes settings, read by every Git since 1.7.2, and with no name a
  secret filter takes, unlike `GIT_CONFIG_KEY_*`), for
  `https://github.com` alone: an empty helper entry first clears the helpers
  met so far for that URL, then Switch's, with `useHttpPath` so it is told the
  repository. The machine's own helpers for that URL (`machineGitHubHelpers`,
  in Git's order) go to the helper in `SWITCH_GITHUB_FALLBACK` rather than
  after it in Git's config, where they would be asked with the path, which a
  keychain does not store its sign-in under. The user's other credential
  helpers and Git config are untouched, and SSH remotes still use the user's
  keys.
- **Fail open, said:** when Switch gives no token for a request, the helper
  asks the machine's own helpers itself (without the path, and with the
  wrapper off `PATH`, so `!gh auth git-credential` reaches the real `gh`) and
  passes their `store` and `erase` on; the `gh` wrapper runs the real `gh`
  without a token, so it uses its own login. That covers every reason: Switch
  unreachable, the grants unreadable, the grant removed or narrowed, GitHub
  disconnected or re-linked, and a repository the grant does not reach. The
  endpoint tells the last from the token itself: GitHub answers 404 for a
  repository outside it, asked once a repository per session; when GitHub
  cannot say, the token is handed out. `gh` takes the repository as it does
  (`-R`, `GH_REPO`, the folder's `origin`); a command naming none has the
  token. Never silently: the helper or wrapper says so on stderr, the session
  host logs it, and the session shows a `SERVICE_FALLBACK` warning (once per
  reason or repository) in Console's transcript and the activity on the
  bridges. The GitHub skill tells the agent to tell the user that such a
  command acted as the owner, outside the grant. A push to a repository the
  grant reaches only for reading is not caught: Git does not tell a helper
  whether it fetches or pushes. The cloud has no machine sign-in to fall
  back to, so there it fails with the reason.
- **Agents without a GitHub grant:** nothing is installed, so the agent keeps
  the user's own Git and `gh` logins, as today.
- **Grants that could not be read** as the session started: the helpers are
  installed anyway and give no token, so git and `gh` fall back as above,
  with the fallback said. That holds for an agent with no GitHub grant too,
  for that session: it cannot be told apart.
- **Windows:** the helpers do not run there. Nothing is installed, the
  session shows a `SERVICE_FALLBACK` warning, and the agent uses the
  machine's own sign-in.
- **Cloud:** keeps full isolation (every other credential helper cleared,
  prompts off).

- **Under Console:** the scripts set `ELECTRON_RUN_AS_NODE=1` themselves, since
  Console runs agent hosts on Electron's binary and strips `ELECTRON_*` from
  the session's environment; the wrapper keeps it from what `gh` starts.
- **The cloud bootstrap** (`host/hosted-bootstrap.ts`) no longer renews a token
  itself through `/hosted/github-credential`. For its own clone of a granted
  repository, before any session runs, it asks
  `POST /agents/{id}/service-tokens/github` with the agent's key (on `https`
  only, once more if Core says to retry), and sessions set GitHub up from the
  grant. A deployment's saved plan from the earlier build, which differs only
  by the old GitHub launch variables, is upgraded in place once, with a
  warning; any other difference is still refused. A deployment given a mounted
  personal token is unchanged.

### Fallback: what is available to the agent can be used by it

One rule for every connector. Access through Switch is used first. When
Switch cannot or will not give it (unreachable, the grants unreadable, the
grant removed or narrowed, or the resource outside it), the agent uses
whatever the machine it runs on already gives it, and that is never silent:
the command's output, the session (`SERVICE_FALLBACK`, shown in Console and
on the bridges) and the host log say so. Where the machine gives nothing, as
in the cloud, the command fails with the reason. A connector answers only
"a token, or none and why"; the fallback and the flag are the host's.

**What removing a grant means.** On the owner's own machine, removing or
narrowing a grant stops Switch giving that access; it does not take away
access the machine already has. An agent whose GitHub grant is removed goes
back to where an agent with no grant is: the owner's own sign-in, if there is
one, with each use flagged. In the cloud there is no such sign-in, so removing
the grant ends the agent's GitHub access.

**Shared machines.** "The machine's own sign-in" is whatever the machine the
agent runs on is signed in as, under the account the session runs as. On a
laptop that is the owner's. On a shared server or SSH host it can be a service
account's, or another person's: a fallback there acts as them, flagged the
same way. Run agents on a shared host under an account whose own sign-ins are
the ones they should fall back to, or under one with none.

#### What a grant does not do on the owner's machine

On a laptop or server, a GitHub grant adds access through Switch; it does
not contain the agent. The session runs as the owner, so it still reaches
whatever the owner's own setup reaches: SSH remotes and their keys, a
`url.*.insteadOf` rewrite away from `https://github.com`, the real `gh` called
by its path past the wrapper, and a `GITHUB_TOKEN` or `GH_TOKEN` in the
environment it inherits. Agents on one machine are not isolated from each
other either: the session's endpoint bearer is in the environment of
everything the CLI starts, MCP servers included, and any process running as
the same user can read it and ask for that agent's token; the wrapper hands
`gh` (and its extensions, and what they start) the token itself as
`GH_TOKEN`. Containing an agent is what the cloud deployment is for.

A fallback does not run the plain `gh auth` commands that print or hand out
the machine's token (`auth token`, `auth status --show-token`,
`auth git-credential`), to keep it out of transcripts and the bridges. That
is a speed bump, not a guarantee: it is a denylist, so a `gh alias` for one
of them gets past it, and the agent can call the real `gh` anyway.

## GitHub on the new model

- **Adapter** (`connections/adapters/github.py`): the user-token refresh moves
  here from `gateway/github_connections.py`. Installation tokens cover the
  grant's repositories (up to 500) with the level's permissions: read is
  contents and pull requests read, so `gh pr list` and `gh pr view` work;
  write makes both write; workflows are never writable. Before issuing, it
  checks the user still sees each repository, and can push to it for write.
  It keeps today's checks on GitHub's response (exact permissions, exact
  repository ids), and revokes issued tokens one at a time.
- **Connect:** the flow is unchanged. `confirm` and `disconnect` write
  `service_connections`; a GitHub connection's consent is `write`. Re-linking
  still revokes the old tokens. Re-linking the same account keeps grants
  working; a different account trips `grant_account_changed`.
- **Cloud launches** create the agent's GitHub grant (its installation and
  repository, write) in their own transaction. The launch spec keeps the
  repository only for cloning. If a disconnect removes the grant, the agent's
  fetch fails naming the fix, and its page shows the missing grant.
- **A launch change revokes the agent's GitHub tokens**, as it always has: the
  lifecycle routes queue them with the change, and the hosted controller's
  poll queues the tokens of every agent whose launch is no longer running.
  The change also moves the grant's `revision` on; the broker records a token
  only against the revision it issued under, reading the grant `FOR SHARE`,
  so a token being issued as the launch stops is taken back. The change takes
  no connection lock, so a stop never waits on a refresh at the vendor.
- **The machine agent list** sends every agent an empty `skills` list:
  deployed workers refuse an agent without the key, and leave an empty list
  out of the deployment they hand the bootstrap. Sessions get skills from
  `service-grants`. A bootstrap given no skills removes the `github` skill an
  earlier one installed into the provider's skills folder, which would
  otherwise reach the session twice.
- **`/hosted/github-credential`** calls the broker for one release, for cloud
  workers not yet updated, then goes. After the issue it checks the launch
  under its lock and revokes the token if the launch changed meanwhile.
- **Reads** of GitHub connections (`gateway/tenants.py`,
  `gateway/connection_catalog.py`) use only the new tables.
- **Moving the data** (`connections/github_move.py`), at boot after key
  rotation, because it needs the server's keys: copies each GitHub row from
  `provider_connections` (the ciphertext as is: same keyring, same JSON), with
  the account's stable id and login read from it; adds a write grant for each
  live cloud launch with an agent; copies unexpired `github_issued_tokens` into
  issuances with their hash, queued for revocation where today's rules no
  longer accept them. It runs once per tenant, recorded in `tenant_data_moves`
  in the same transaction, so a later boot never undoes a disconnect or a
  removed grant. A row it cannot read is skipped, logged and counted; that
  person connects GitHub again.
- **Next release:** a migration drops `github` from the `provider_connections`
  checks and drops `github_issued_tokens`, and `/hosted/github-credential` is
  removed. Until then the old tables are left as they were at the move, for a
  rollback to the previous build.

## Who reaches Core how

Every agent Console's providers run uses the same two routes; only the
credential on the hop to Core differs.

| Agent | Reaches Core with | Tools and helpers run in | Issuance names |
|---|---|---|---|
| Controller-backed (Console or daemon controller) | The relay, which sends the controller token and `X-Switch-Agent-Id` | The agent host in the controller | The agent and the controller |
| Run by Console directly (management off) | The agent's own key | Console's agent host | The agent |
| SSH host sidecar | The agent's own key | The sidecar's agent host | The agent |
| Cloud worker | The agent's own key, from the worker's credentials | The worker's agent host | The agent |
| An agent with its own runtime | Its own key | Nothing is started: v1 refuses its grants | — |

A controller-backed agent's own key is refused everywhere with
`409 managed_by_controller`, so it can only fetch through its controller.
Moving an agent onto or off a controller needs no grant change, since grants
belong to the agent.

## Reason codes

The contract's codes plus `grant_missing` (`403`, the agent has no grant for
the service) and `grant_account_changed` (`409`, the owner re-linked a
different vendor account), both added to the contract's §9. Core's
implementation also uses `forbidden`, `not_found` and `internal`, as the
management routes do.

## Tests

Store, broker and route tests run against the real Postgres fixtures; only the
vendor's HTTP side is faked.

- **Store** (`db/stores/test_service_connection_store.py`): a connection is
  unique per tenant, user and service, and its secret round-trips through the
  keyring and never shows in `repr`; a grant is unique per agent and service,
  and deleting the agent or the connection deletes it; with tenant B bound,
  tenant A's connections, grants and issuances read back empty, and a grant in
  tenant B naming tenant A's agent fails its foreign key; pruning removes only
  issuances past retention. The schema catalogue, `tenant_id` index, frozen DDL
  and key-rotation tests cover the new tables.
- **Broker** (`connections/test_broker.py`, fake adapter): two concurrent issues
  on an expiring rotating secret make one refresh, both get tokens, and the
  stored secret is the new pair; a failed refresh sets `needs_reauthorization`
  and the next fetch fails `connector_revoked`; a token valid for two hours is
  refused and revoked; no secret or token appears in captured logs.
- **Routes** (`bridges/agent/test_service_tokens.py`,
  `gateway/test_service_connections.py`), the real app on Postgres: every
  issuance check's refusal; another owner's controller bound to the agent;
  a controller not bound to it (`not_assigned`); a controller-backed agent's
  own key (`managed_by_controller`); tenant A's key naming tenant B's agent; a
  success carries `Cache-Control: no-store`, writes one issuance and logs no
  token; the grant API's refusals; a new grant with no access is read;
  re-linking a different account (`grant_account_changed`) and the same one
  (grants keep working); a disconnect deletes grants and the next fetch fails
  `grant_missing`; an agent deleted after a GitHub token was issued has the
  token revoked by the sweep.
- **Agent host** (Vitest): a token is refreshed before expiry and dropped on
  refusal; raw, URL-encoded and base64 forms are redacted from journal
  entries, room posts and activity rows; granted skills reach each provider's
  context and OpenCode's skill folder; the helper accepts repeated
  `capability[]` lines and refuses non-loopback `http`; `gh` resolves past the
  wrapper; under Console the helper runs on Electron's binary.
- **GitHub:** a migration test on Postgres (a GitHub row becomes a connection,
  a live launch a grant, and the old route still answers); the existing GitHub
  connection, cloud launch and cloud worker tests move to the new tables.

## Rollout

Deploy Core with both GitHub credential routes, then update Console and the
cloud workers, then remove the old route and the old tables in the next
release.

## Operating a self-hosted Core with GitHub

A self-hosted Core registers its own GitHub App, because the App's callback
must reach that Core:

- Permissions: Contents (read and write), Pull requests (read and write),
  Metadata (read). Nothing else; in particular, not Workflows.
- Callback URL: `<core origin>/gateway/provider-connections/github/callback`.
- User-to-server token expiry on: Core stores the refresh token and refreshes
  the user token itself.
- Settings: `GITHUB_APP_CONFIG_PATH` (the App's client id, client secret, slug
  and the Core's origin, as JSON) and `GITHUB_APP_PRIVATE_KEY_PATH` (its signing
  key).

Installation tokens act as the App: pushes, pull requests and comments show as
the App's bot, not the person. Branch protection still applies; rules that
trust the App must not exist.
