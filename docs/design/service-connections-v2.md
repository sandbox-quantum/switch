# Service connections: v2, services beyond GitHub

Status: built (Phases 1 and 2). This note covers what v2 adds to
[`service-connections-v1.md`](service-connections-v1.md): any OAuth vendor
whose tools are its own MCP servers or its command-line tool, and any vendor
people connect with a key they paste, connected, granted and called from a
session on generic parts, with Atlassian (Jira), Google Workspace and Datadog
as the first. v1's tables,
broker checks, agent routes, token cache and redaction carry over unchanged;
GitHub works as it did.

## What changes from v1

| v1 | v2 |
|---|---|
| One adapter, GitHub's, built by hand in `main.py` | Built from the catalog (`connections/registry.py`): each enabled entry names its `adapter`, `github`, the generic `oauth`, or `api_key` |
| Catalog `connection.yaml` v2 | v3: `adapter`, `token`, `auth.oauth`, `auth.identity`, `mcp` or `cli` (below) |
| Every token minted per issue, at most an hour | `minted` (GitHub) or `pass_through`: the owner's own access token, with the catalog's lifetime cap |
| Grants with a level, tools and resources | A pass-through grant is **on or off**: it takes the connection's level |
| Connecting through GitHub's own flow | A generic flow for `oauth` entries; GitHub keeps its own |
| No vendor tools in a session | One loopback MCP server per granted vendor server, run by the session host |
| A service is set up or not | `DISABLED_SERVICES` switches one off, with a reason people see |

## Catalog v3

```yaml
slug: atlassian
enabled: true
adapter: oauth                # github | oauth
auth:
  type: oauth
  refresh: rotating           # rotating | reusable
  oauth:
    registration: dynamic     # dynamic: Core registers its own client
                              # static: client_settings names <PREFIX>_CLIENT_CONFIG_PATH
    redirect: [loopback]      # loopback (Switch Console) and/or core (Core's callback)
    loopback_ports: [39231, 39232, 39233, 39234, 39235]
    prompt: consent           # sent with every authorization
    # authorization_params: { access_type: offline }   # also sent with every
    #   authorization; only keys Core does not set itself (access_type,
    #   include_granted_scopes)
    revocation_discovered: true   # or revocation_url: https://…
  identity:                   # GET with the token; dotted paths in its JSON
    url: https://api.atlassian.com/me
    account_id: account_id
    label: email
token: { kind: pass_through, max_lifetime: 28800 }
mcp:
  servers:
    - { name: atlassian, url: "https://mcp.atlassian.com/v2/mcp" }
access:
  read:  { scopes: [...] }
  write: { scopes: [...] }
tools: { mode: pass_through } # the vendor's tool list as it is, until classified
```

The loader stays strict and refuses an entry whose fields contradict its
adapter: a GitHub entry with MCP servers, a pass-through GitHub token, an
`oauth` entry without its client, identity or tools, a minted token that
outlives an hour, and so on. Without `authorization_url` and `token_url`, the
endpoints are discovered from the first MCP server: the metadata its 401 names
(RFC 9728), else the well-known addresses, then the authorization server's
metadata (RFC 8414), which must offer PKCE with S256. A dynamically registered
client always discovers. Placeholder entries keep their short form.

The adapter is named for how it signs in, `oauth`, not for how its tools are
reached. Its entry delivers its tools one of two ways, never both: the vendor's
MCP servers (`mcp`), or the vendor's command-line tool (`cli`), which the
session host runs as one Switch tool:

```yaml
cli:
  name: example            # the tool's name in the session, beside `switch`
  binary: excli            # run directly, never through a shell
  token_env: EXCLI_TOKEN   # set only in that run's environment
  config_env: EXCLI_CONFIG_DIR   # where the tool has one: a folder per session
  allow: [items, boards]   # a command's first argument must be one of these
  deny: [auth, --profile]  # first arguments, and flags refused anywhere
  path_flags: { --upload: read, --output: write, -o: write }
  path_args: [{ after: +put, direction: read }]   # `excli +put <file>`
  output_cap_bytes: 65536  # more goes to a file
  timeout_s: 120
  token_refused:           # how a run says the vendor refused its token,
    exit_code: 1           # so the session host asks again and retries once
    json_path: error.code  # in the JSON the tool writes to standard output
    value: 401
```

An entry with a `cli` has no MCP server to discover from, so it names its
`authorization_url` and `token_url` (and `revocation_url`, where the vendor has
one), and its client is the operator's (`registration: static`). No two
entries may give a session a server of the same name.

`<PREFIX>_CLIENT_CONFIG_PATH` names a static client's settings, a JSON file
holding `client_id` and `client_secret` and nothing else. Unset, the service is
shown as not set up on this server, with the entry's `setup_note`; set but
unusable, the server does not start.

## Tokens

The broker holds every token to its entry's `max_lifetime`, and a minted one to
the hour, as before. For a pass-through service:

- The adapter hands out the owner's cached access token, never `revocable`:
  revoking it alone would end the owner's connection. An adapter that offers it
  as revocable is refused.
- Core renews it while 15 minutes remain, ten more than the agent host's own
  five, so the host does not ask again on every use.
- The token answer (contract §5) gains `expires_in`, the remaining life as Core
  counts it, and `use_until`, the earlier of the expiry and an hour from now.
  The agent host times its cache from when the answer arrived and asks again
  five minutes before `use_until`, so the grant checks run at least hourly
  whatever the vendor's lifetime. It does not hand out a token past
  `use_until` while Core cannot be reached.

A removed grant stops a running session within a minute: the agent host reads
the grants again at most every 30 seconds while it holds a token, drops one
whose grant has moved on or gone, and the next ask is refused. While Core
cannot be reached that check cannot run, and `use_until` bounds it to the
hour. A token already handed out stays valid at the vendor until it expires.

## Connecting

Routes under `/gateway/service-connections/{service}/flows`: start, authorize,
callback, complete, status and drop.
Switch Console starts a flow with a one-time state, its listener's port and a
completion secret. Core keeps the PKCE verifier and exchanges the code, so
neither Console nor the browser holds a token. The browser comes back the first
way the catalog allows that this server can offer:

- **loopback**: straight to Console's listener on 127.0.0.1. With
  `loopback_ports`, only on one of them; Console listens on the first free one.
- **core**: to Core's callback (needs `GATEWAY_PUBLIC_URL`), which sends the
  browser straight on to Console's listener with the code. A cookie set as the
  browser left through Core ties it to that browser, and the callback takes a
  flow's code once; a page is shown only when the return cannot be verified
  or the consent was cancelled.

Console's listener brings Console to the front as the code arrives, and
posts it back with the completion secret; in that one step Core exchanges
it, reads the account, refuses an account already linked to another person
in the workspace, and writes the connection through `broker.connect()`.
There is no confirm step: the person chose the account at the vendor. The
flow then reads `connected` (with the account and any warning) or `failed`
(with the reason), holding no token, until Console drops it or it expires.
The consent recorded is what the vendor granted: write where every write
scope was granted, else read. Flows are rows in `sign_in_flows`, so any
process can take any step: ten minutes each, at most 256 per workspace, one
per person.

A dynamically registered client is the deployment's own, kept in
`service_oauth_clients` (one row per service, encrypted with the keyring,
re-encrypted at key rotation, no tenant). Registration asks for a public client
with the entry's redirects and scopes, under a lock held in the database, and is
repeated when the registration endpoint, redirects or scopes change. A secret a
vendor issues to such a client anyway is not used.

## Sessions

The grants answer gains `mcp_servers` (contract §5). For each, the session host
(`host/vendor-mcp.ts`) serves an MCP server on loopback, behind a bearer made
for the run, given to the coding tool under the server's own name beside
Switch's. Every list and call asks the agent host for the token over the pipe,
adds it to the session's redactions, and calls the vendor over HTTPS with
redirects refused. A 401 asks again, naming the refused token, and retries once.
A vendor has 20 s to list its tools and two minutes per call, so a slow or
failing vendor is one failed server and the Switch tools keep working.

The session's loopback token endpoint, which GitHub's helpers use, serves only
services with a helper on the machine. No other service's token is ever in the
coding tool's environment, arguments or files.

Only text reaches the coding tool: anything else a vendor tool answers is
replaced by a line saying what was left out.

The grants answer also gains `cli_tools`. For each, the session host
(`host/vendor-cli.ts`) serves one tool on loopback, under the entry's `cli.name`,
taking `{args}`: the command line after the binary, one argument per item. The
host runs the vendor's binary itself:

- **Checked first, never a shell.** The first argument must be allowed and not
  denied; a denied flag is refused in any form (`--f`, `--f=v`, `-fv`); short
  options may not be combined, so no path flag hides in a cluster; `--` is
  refused. A positional file (`path_args`) must come right after its word,
  wherever that word stands, so no option can stand between them. Every path
  is checked against the session's folder before anything else: nothing runs,
  and no token is asked for, for a refused command.
- **A folder of its own.** Each run works in a fresh folder holding only an
  empty `.env` (a tool that loads `.env` from its folder or a parent's finds
  that one and stops) and the files staged for it. A path flag's file must be
  inside the session's folder once symbolic links are resolved: a file read is
  copied in, a file written is moved out once the run succeeds. Anything else
  the run leaves, such as a download, moves to `.switch/<tool>/` in the
  session's folder, which git ignores, and the answer says where.
- **The token, and nothing else.** The run's environment holds the token in
  `token_env`, a configuration folder and home kept for the session, and the
  host's own proxy and certificate-authority settings; nothing of the coding
  tool's. The token is asked for on every run, added to the session's
  redactions, and scrubbed from the output.
- **Refused, timed out, too long.** A run that ends as `token_refused` says is
  run once more on a token asked for again, naming the refused one. A run past
  `timeout_s` is stopped. Output past `output_cap_bytes` is saved to
  `.switch/<tool>/` and its path returned with the start of it; past 64 MiB the
  run is stopped.

The binary is the entry's pinned build (`cli.release`): a version and, per
machine (`<platform>-<arch>`, as Node names them), an archive's URL, its
SHA-256 and the binary's path inside it. On a tool's first use on a machine,
the session host (`host/cli-binaries.ts`) downloads its archive over HTTPS,
keeps it only if the SHA-256 matches, unpacks it with the system's `tar` (which
reads `.zip` too on Windows) and installs it under
`~/.local/state/switch/tools/<binary>/<sha256>/`, once per machine. Upgrading a
tool is a catalog change; a machine without a build is told so when the tool
is called. What each install found (installed, failed, no build here) is kept
in that folder's `status.json`, and the agents controller reports it with `git`
and `gh` in its status (`ok`, `missing` or `unsupported`).

Pinning the build in the catalog means Core names a binary that session hosts
run. The SHA-256 is what holds it: a host runs only an archive that matches the
hash shipped in the catalog, never a newer one a vendor publishes.

## Grants

A pass-through service's grant names no level, tools or resources: the broker
gives it the connection's level and refuses one that names any, and issuing
reads the level from the connection as it is now, so reconnecting read-only
narrows every grant at once. Console and the dashboard show such a service as a
switch beside GitHub's grant and repository picker, saying that the agent acts
as its owner there, that off stops its sessions within a minute, and, for a
token that lives longer, that a token already handed out stays valid until it
expires or the owner disconnects.

`GET /gateway/service-connections/{service}/agents` lists the caller's own
agents in the workspace, each with whether it holds a grant on the service and
whether others can address it, for the "used by" list and the checklist
Console offers after connecting. Another member's agents never appear; an
unknown or placeholder slug is 404.

"Others can address it" (`addressing_open`, here and on the agent's grants
list) is false only for owner-only in its strict sense: the owner alone, in
person. Any agent sender counts as someone else, the owner's own agents
included, so "you and your agents" (`owner_agents`) and any named agent make it
true. An agent is not the person: whoever addressed the owner's other agent can
have it pass the request on, and the grant is then used for them. This is what
Console reports and warns about; it does not refuse the agent-to-agent path,
which an `owner_agents` rule still admits. Carrying the originating person on
agent-to-agent messages, so that "you and your agents" can be safe for an agent
with grants, is a later follow-up.

## Switching connections on

The whole feature is behind the `service_connections` feature flag
(`FEATURE_FLAGS_ENABLED`), off by default. Off, the routes for connections,
sign-ins, keys and grants are not mounted, on either the gateway or the agent
API: an agent host reads the missing `service-grants` route as no grants, and
Switch Console and the dashboard, which ask those routes, offer GitHub's link
alone, as a server from before connections did. GitHub's own connect routes,
the boot-time GitHub move and the token upkeep run either way.

## Switching a service off

`DISABLED_SERVICES` is JSON, `{"<slug>": "<reason>"}`; an empty reason reads
"Switched off on this server." A switched-off service is listed with its
reason and cannot be connected, granted or issued a token (403 `forbidden`);
disconnecting still works. A slug outside the catalog stops the server.

## Switching a service on for a workspace

A workspace admin switches each catalog service on or off for the workspace
(`GET` and `PUT /gateway/workspace/services[/{service}]`, admins and owners,
and the operator in a workspace they belong to). A service with no setting is
on, so an upgraded server behaves as before; a row is written only when an
admin touches the switch, and each change is audited
(`workspace_service.enabled` / `.disabled`). The switch applies only with the
`service_connections` flag on; with it off, GitHub works as it always has.
The list carries `connected_members` and `granted_agents`, what Console shows
before an admin confirms switching off.

Off, nobody in the workspace can start a sign-in, paste a key, connect, grant
or be issued a token for the service: 403 `forbidden`, "Datadog is not enabled
in this workspace. Ask a workspace admin; they switch it on under Connectors in
Switch Console." The server's own `DISABLED_SERVICES` reason is checked first.
A sign-in that completes after the switch is refused and revoked at the
vendor. Grants are kept, but the grants list a session reads leaves the
service out, so a running session loses the service within half a minute, as
it does a removed grant: its host restarts it without the service. A token
already handed out may be used until that restart, except GitHub's, which the
switch queues and revokes before it answers (`warning` when some could not be
yet; the five-minute tick keeps trying). On again, the grants come back with
no re-grant.

The service list (`GET /gateway/service-connections`) carries
`workspace_enabled` per service, `true` for every service when the flag is
off.

## Keys

For a vendor whose people connect with a key rather than a sign-in (Datadog,
New Relic, PagerDuty, Snowflake and the like), an entry names
`adapter: api_key`:

```yaml
adapter: api_key
auth:
  type: api_key
  refresh: none                 # a key is used as it is
  api_key:
    fields:                     # 1 to 4; at least one secret
      - { name: api_key, label: API key, secret: true, help: Where to make it. }
      - name: site              # not secret: a choice, never free text
        label: Site
        secret: false
        choices: [example.com, eu.example.com]
    identity:                   # checks the key, before anything is stored
      method: GET               # or POST, with a JSON body
      url: "https://api.{site}/me"          # a URL names only choices
      headers: { X-Api-Key: "{api_key}" }
      account_id: user.id       # optional: without it, the key's SHA-256
      label: user.email         # optional: without it, the name and choices
    help_url: https://docs.example.com/keys
token: { kind: pass_through, max_lifetime: 3600 }   # handed out an hour at a time
mcp:
  servers:
    - name: example
      url: "https://mcp.{site}/mcp"
      headers: { Authorization: "Token token={api_key}" }
# or cli: with env: { EXAMPLE_KEY: "{api_key}" } in place of token_env
tools: { mode: pass_through }
```

The loader refuses a template naming an unknown field, a URL naming a secret
one, a server without headers, an entry naming `access` (a key reaches
whatever its vendor let it), and a token handed out for longer than an hour.

- **Connecting.** Switch Console shows the entry's fields (the services list
  carries them as `key`) and sends them to
  `PUT /gateway/service-connections/{service}/key`. Core holds each field to
  the entry (a choice among its choices, a secret one printable line without
  spaces), makes the identity call, and stores the fields encrypted only when
  the vendor accepts them; a refusal names the fields to check. One account
  is linked to one person in a workspace, as for a sign-in. Re-pasting
  replaces the key in place, keeping the grants.
- **The token.** The connection's secret is the token a session host is
  handed: compact JSON, `{"public": {...}, "secret": {...}}`. Each issue
  hands it out for an hour, so the grant checks run at least hourly, and the
  host's grant check reaches running sessions within half a minute.
- **Sessions.** The host renders each MCP server's `url` and `headers`, or the
  tool's `env`, from the token, and redacts every secret field on its own as
  well as the whole token. The key never reaches the coding tool.
- **Grants** are on or off, as for any pass-through service, at the highest
  level: what the agent can do is what the key allows.
- **Disconnecting** forgets the key, and says that only the vendor can revoke
  it. Keys do not expire and are not refreshed.

### Datadog

Datadog's remote MCP server takes an API key and an application key in
headers named with underscores (`DD_API_KEY`, `DD_APPLICATION_KEY`), unlike its
REST API's hyphens, at `https://mcp.<site>/api/unstable/mcp-server/mcp`, for
the six commercial sites (not GovCloud). The identity call is the REST API's
`/api/v1/validate`, which checks the API key; the application key is checked
by the MCP server on the first call, since a key scoped to `mcp_read` alone
may not read the current user. A Datadog administrator turns MCP access on for
the organization (Organization Settings, Preferences), and the application key
needs `mcp_read`, and `mcp_write` for changes.

## Adding a connector

A connector is a catalog entry and a skill, with no code, when the vendor fits
one of three shapes. Pick the first that fits:

1. **A remote MCP server with OAuth** (Atlassian): `adapter: oauth` with `mcp`.
   Where the vendor offers dynamic client registration, nothing is set up on
   the server (`registration: dynamic`); otherwise each server's operator
   registers an OAuth app and names it in `<PREFIX>_CLIENT_CONFIG_PATH`
   (`registration: static`).
2. **A command-line tool with OAuth** (Google Workspace): `adapter: oauth` with
   `cli`, a pinned release per platform with its SHA-256, and the allow and
   deny lists that keep it to the vendor's own commands.
3. **A key** (Datadog): `adapter: api_key`, above, with `mcp` or `cli`.

Then:

- `connections/catalog/<slug>/connection.yaml`, and `skill/SKILL.md` with
  `name: <slug>` and a description in its frontmatter. The skill describes
  tasks, tools and limits, never credentials: the loader refuses one that
  mentions an access token, an API key, `GH_TOKEN` or `gh auth`.
- No two entries may give a session a server of the same name, and none may
  be named `switch`.
- Tests: the shipped entry's values in `tests/switch_core/connections/
  test_loader.py`, and anything the adapter does differently in its own tests.
- QA by hand against the real vendor, from Switch Console (which starts every
  connect): connect, grant to an agent, use the tools in a session, check the
  token appears nowhere in the transcript or the room, turn the grant off and
  check the session stops within a minute, disconnect. A vendor without
  dynamic registration needs a development OAuth app of the tester's own.
- Say in the entry's comments what the vendor needs turned on (Datadog's MCP
  access) and anything measured rather than documented (a token's lifetime).

## Atlassian

Built from a sign-in run against a test Atlassian Cloud site with default MCP
settings:

- Atlassian offers only dynamic registration, so Core registers its client.
  Refresh works with the client id alone.
- A sign-in returns to Core's own address only where an organization admin has
  added it, so Atlassian connects through Switch Console, in loopback mode.
  Atlassian matches the loopback port exactly, hence the five fixed ports.
- Consenting to Jira's scopes alone fails after Accept unless the request also
  carries the identity scopes, `offline_access` and `prompt=consent`. Atlassian
  enforces the result: a read-only sign-in hides the write tools.
- Access tokens live 8 hours; refresh tokens rotate.
- The default server lists a few tools, `discover`, and `executeRead`,
  `executeWrite` and `executeDestructive`; those pass through unchanged.
- Jira's and Confluence's scopes are asked for (`read`, `search` and, for
  writing, `write`, each `:agent-interface`). Not Rovo's cross-product search
  (`search:rovo`) or Teamwork Graph (`read:all:twg`), whose every call spends
  the organization's Rovo credits. Four Confluence write tools (infographics
  and apps on a page) spend them too, 15-30 credits a request; tools pass
  through unclassified, so a write grant offers them, and the skill tells the
  agent to use them only when asked. A person who connected before Confluence
  was added connects again to consent to its scopes; until then Atlassian
  shows no Confluence tools.

To connect: Settings, Connections in Switch Console, then Atlassian. Nothing
needs configuring on the server. To roll back, add `atlassian` to
`DISABLED_SERVICES`, or set the entry's `enabled: false`.

## Google Workspace

Drive, Docs, Sheets, Slides and Calendar; not Gmail. Google's Workspace MCP
servers are in developer preview, whose terms forbid offering them to people
outside the company running them, so a session reaches Google through `gws`
([googleworkspace/cli](https://github.com/googleworkspace/cli)), Google's
command-line tool for its generally available APIs, run by the session host as
the `gws` tool on the `google-workspace` server (`cli`, above). The token
reaches the `gws` run's environment, for that run only, and never the coding
tool.

Built from a spike against a test Workspace with an Internal app:

- **Its own client per server.** Each server's operator registers an internal
  Google app, a Web client whose redirect is Core's callback,
  `<GATEWAY_PUBLIC_URL>/gateway/service-connections/google-workspace/flows/callback`,
  and names its settings in `GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH`
  ([operator setup](../old/google-workspace-setup.md)). Unset, Google Workspace
  is listed as not set up on this server.
- **Offline access.** Google returns a refresh token only for
  `access_type=offline`, and on a later sign-in only with `prompt=consent`;
  both go with every authorization. Refresh tokens are reusable.
- **The account chooser first.** `prompt` also carries `select_account`, so a
  browser signed in to another Google account (a personal one, or another
  organization's) does not pick it unasked. `prompt` takes several values,
  space-separated, as OAuth writes them.
- **Tokens.** Access tokens lived 3,599 s; `max_lifetime` is 3,920, Google's
  documented sample. Agents still ask again hourly.
- **The account** is OpenID's `sub`, labelled by `email`, from userinfo.
- **Scopes as Google names them.** Google answers with full scope URLs
  (`email` comes back as `.../auth/userinfo.email`), and the level is read by
  comparing them, so the entry names them that way. A person who unticks the
  write scopes connects read-only, and Google refuses every change.
- **Re-linking cannot narrow.** While the app holds access, Google's consent
  shows what it already has, with nothing to untick: connecting read-only after
  read and write takes a disconnect first.
- **Disconnecting revokes** at `oauth2.googleapis.com/revoke`, which ends every
  token of the person's sign-in to that app.
- **`gws` 0.22.5,** pinned per machine; the Linux builds are the musl ones,
  which run on glibc and musl systems alike, and Windows has an x64 build only.
  Its first argument is a service (`drive`, `docs`, `sheets`, `slides`,
  `calendar`) or `schema`; `auth`, `gmail`, `admin`, `chat`, `--api-version`
  (and `drive:v2` and the like) and `--sanitize` are refused. `--upload`,
  `--output`/`-o` and `drive +upload <file>` are its local files. A refused
  token ends a run with exit 1 and Google's 401.
- **`gws` reads a `.env`** from its working folder or the nearest parent with
  one, which could point it at a proxy; each run's folder holds an empty
  `.env` of its own, which stops the search.

Another process running as the same user could read the token from a `gws`
run's environment while it runs, or replace what that run executes. Keeping
the token out of `gws` altogether (a credential proxy in the session host) is a
later spike.

Self-hosted servers come first. Switch's hosted service lists Google Workspace
as unavailable through its own deployment settings, not this repository:
`DISABLED_SERVICES` `{"google-workspace": "<the reason people see>"}`.

To roll back: add `google-workspace` to `DISABLED_SERVICES`, set the entry's
`enabled: false`, or unset `GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH`. Each lists
it as unavailable, with its reason, and the next token request fails.

## Not yet

- Shared workspace connections, and a per-workspace OAuth client: every
  connection is a person's own, and every workspace signs in through the
  deployment's one client per vendor. A workspace's switch only turns a
  service on or off.
- `grants.changed` on the agent and controller streams: a grant change reaches
  a running session within half a minute, by the host reading the grants
  again, not at once.
- Tool classification by level, and read-only grants narrower than the
  connection.
- Tool-list prefetch and per-user call limits; each call now opens its own MCP
  session at the vendor.
- Connecting Atlassian from the web dashboard, and a server setting that moves
  a vendor to Core's callback (today the catalog's order decides).
- Connecting any service from the web dashboard: Switch Console starts every
  sign-in, Google Workspace's included, though Google's comes back through
  Core.
- Google Workspace on Switch's hosted service, which waits on Google's review
  of Switch's own app.
- Keeping a CLI vendor's token out of the CLI's process (a credential proxy).
- Live runs against a real Jira site, a real Google Workspace and a real
  Datadog organization stay manual and outside CI, which tests `gws`'s
  handling against a stand-in, never the real binary, and Datadog's key check
  against a stand-in transport.
- Connecting a key from the web dashboard: Switch Console starts it, as every
  connect.
