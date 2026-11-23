# Service connections: v2, services beyond GitHub

Status: built (Phases 1 and 2). This note covers what v2 adds to
[`service-connections-v1.md`](service-connections-v1.md): any OAuth vendor
whose tools are its own MCP servers or its command-line tool, and any vendor
people connect with a key they paste, connected, granted and called from a
session on generic parts. Atlassian (Jira), Linear, Google Workspace, Airtable and
Datadog are live; Datadog was built as the first key, and signs in at the
site people pick now that keys are refused (see [Keys](#keys) and
[Datadog](#datadog)). v1's tables,
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
                              # static: the operator's, saved in the dashboard or named
                              # by <PREFIX>_CLIENT_CONFIG_PATH (client_settings)
    redirect: [loopback, core]   # loopback (Switch Console) and/or core (Core's
                                 # callback); a server picks with SERVICE_SIGN_IN_REDIRECT
    loopback_ports: [39231, 39232, 39233, 39234, 39235]
    prompt: consent           # sent with every authorization
    # authorization_params: { access_type: offline }   # also sent with every
    #   authorization; only keys Core does not set itself (access_type,
    #   include_granted_scopes)
    revocation_discovered: true   # or revocation_url: https://…; with neither,
                                  # remove_access: where people remove Switch
    # revocation_ends_tokens: true   # revoking the sign-in ends its tokens too
    #   (Google's, GitLab's); unsaid, they are taken to live until they expire
  identity:                   # GET with the token; dotted paths in its JSON
    url: https://api.atlassian.com/me
    account_id: account_id
    label: email
    # mcp_tool: whoami        # in place of url: call this read-only
    #                         #   tool on the entry's MCP server
    # arguments: { query: me }  # with mcp_tool only: fixed arguments for
    #                           #   the tool, in place of {}
token: { kind: pass_through, max_lifetime: 28800 }
# token.note: shown in Switch Console beside how long agent access lasts, for
#   a vendor that limits it further (Sentry)
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

A static client is the server operator's, and comes from one of two places
(`connections/app_credentials.py`): a row saved from the dashboard's Connector
apps page (`service_app_credentials`, its secret encrypted with the keyring),
or the JSON file `<PREFIX>_CLIENT_CONFIG_PATH` names, holding `client_id` and
`client_secret` and nothing else. Configuration wins where both are set. With
neither, the service is shown as not set up on this server, and people are told
to ask whoever runs it; a file set but unusable stops the server, and a saved
row that cannot be used leaves the service not set up, with the reason on the
operator's page. A saved client is checked with the vendor before it is stored
and is in use at once. Each connection records the client it signed in through
(`service_connections.oauth_client_id`), so one made through a client the
operator has since replaced is told to reconnect rather than refused by the
vendor.

### Choices before a sign-in

A vendor with regional deployments has a different MCP server, account API
and authorization server at each site. Its entry lists what the person picks
before signing in, as fields from a fixed list (an `api_key` entry's choice
fields, never a secret), and names them in its URLs:

```yaml
auth:
  oauth:
    registration: dynamic
    redirect: [loopback]
    choices:
      - { name: site, label: Example site, secret: false,
          choices: [example.com, eu.example.com] }
  identity:
    url: "https://api.{site}/me"
mcp:
  servers:
    - { name: example, url: "https://mcp.{site}/v1/mcp" }
```

Any URL an OAuth entry names may hold `{name}` for one of its choices: its MCP
servers' (which a dynamically registered client's endpoints are discovered
from), its identity's, and its `authorization_url`, `token_url` and
`revocation_url`. The loader refuses a template naming anything else, a
choice that is secret or has no list, and any template at all in an entry
without choices.

`GET /gateway/service-connections` answers each entry's choices as
`sign_in_choices` (name, label, help and list, as a key form's fields; null
for an entry without), and Switch Console's Connect dialog shows a picker for
each above its Connect button, starting on the connection's own choice when
the person connects again. Switch Console sends what was picked with the
start of the sign-in
(`POST /gateway/service-connections/{service}/flows` with
`choices: {site: ...}`), and sends no `choices` for an entry without, as a
server from before them takes a start. Core refuses, with 422, a start that leaves one out,
picks a value not in its list, or names a choice the entry does not have. The
flow keeps the choices in `sign_in_flows.details`, and every step of the
sign-in calls the URLs rendered with them. The connection keeps them twice:
in `service_connections.choices`, from which the grants answer gives a
session the MCP server at the connection's own site, and in its encrypted
secret, so a refresh or a revocation calls the site the sign-in was made at
without another read. A connection made with a choice the catalog no longer
offers must reconnect.

A client Core registers is registered once per choice: each site is another
authorization server with its own registration endpoint. Its row in
`service_oauth_clients` is keyed by the service and `choice`, the picked
values as one string (a lone choice's value, or compact JSON of several in
the order of their names), so one site's client never replaces another's,
and a connection is held against the client for its own choice. A static
client is the one client at every choice; checking it asks the vendor at the
first of each list only, and says so.

An entry without choices behaves as it always has: its connections keep `{}`,
and its one registered client stays under the empty choice.

Each connection also records how it was made, `service_connections.method`:
`oauth` for a sign-in, `keys` for pasted keys (Datadog's connections from
before the column read so), and `token` for a pasted token (below).
`GET /gateway/service-connections` answers each connection's `method` and
`choices`, null where the person has not connected it. Each entry offers the
ways it connects (`ConnectionDefinition.methods`: `keys` for an `api_key`
entry; `oauth`, and each pasted method it lists, for an OAuth entry). A
connection made in a way its entry no longer offers, as Datadog's keys once
Datadog signed in, reads as needing reconnecting, a grant on it is refused,
and asking for its token is refused before anything it holds is used; its
row is left as it is, so an entry that offers that way again takes the
connection back.

A connection made before its OAuth entry asked for a choice it now needs
(Datadog's keys, pasted before Datadog asked for a site, which sits only
inside what they hold) is treated the same way, with `reconnect_code`
`choices_missing` and "Datadog was connected before it asked for a site.
Connect it again.": nothing it holds is read to fill the choice in. What a
disconnect, or a connect that replaces a connection, says Switch could not
revoke follows the row's `method`, which the broker hands the adapter beside
the secret, so such keys say they are pasted keys rather than a sign-in.

### Pasted credentials beside a sign-in

A vendor whose people can also make a credential of their own (a personal
access token, or an API key and an application key) lists it on its OAuth
entry, beside the sign-in:

```yaml
auth:
  oauth:
    choices:
      - { name: site, label: Example site, secret: false,
          choices: [example.com, eu.example.com] }
  identity:
    url: "https://api.{site}/me"
  paste:                        # at most two: token and keys
    - name: token               # what service_connections.method records
      label: Personal access token
      fields:                   # what is pasted: every field secret
        - { name: pat, label: Personal access token, secret: true }
      headers: { Authorization: "Bearer {pat}" }    # the fields and choices
      expires: vendor           # its vendor ends it on the date it was made for
      alias: "^(expat_[a-z0-9]+)_"   # optional: the part the vendor shows people
      help_url: https://docs.example.com/tokens
    - name: keys
      label: API and application keys
      fields:
        - { name: api_key, label: API key, secret: true }
        - { name: application_key, label: Application key, secret: true }
      headers: { X-Api-Key: "{api_key}", X-App-Key: "{application_key}" }
      expires: never            # offered only with ALLOW_NON_EXPIRING_KEYS
token: { kind: pass_through, max_lifetime: 3600 }   # the sign-in's token only
```

A field may not be named `token` (a template's `{token}` is the whole token
handed out) or after a choice, and every field goes in some header. The
site is the sign-in's choice, picked once for every method. The loader
refuses a method on an entry without MCP servers or on any adapter but
`oauth`, and the entry's `max_lifetime`, still at most seven days, bounds
only the sign-in's own token.

- **Connecting.** `PUT /gateway/service-connections/{service}/paste` with
  `{"method": "token", "fields": {"pat": "..."}, "choices": {"site": "..."}}`.
  Core holds the fields and choices to the entry, then makes an MCP
  `initialize` at the entry's first MCP server, rendered for the site, with
  the method's headers: a vendor that grants MCP by scope answers it with
  the narrowest credential that can use MCP at all. A refusal is a 422 that
  says so; nothing is stored. The entry's identity call is then made with the
  same headers. Where it answers, its id and label name the connection; where
  the credential may not read the account, the credential's SHA-256 is the
  account id, and the label is the token's `alias` match (a public prefix
  such as `expat_ab12`) or "<Service> keys · <site>". The connection is at
  the write level (`KEY_CONSENT`): it reaches whatever the credential allows,
  so a grant on it is on or off. One account is linked to one person in a
  workspace, and pasting again or signing in replaces it in place. The answer
  is `{warning, external_identity, method, choices}`.
- **The services list** carries `paste`, the methods the server offers for
  each service (`method`, `label`, `fields`, `help_url`, `expires` and
  `access_note`), and, for each connection, `access_note` ("Reaches what your
  token allows.", null for a sign-in) and, where its status says it must be
  reconnected, `reconnect_code` and `reconnect_reason`.
- **Expiry.** Switch neither asks for nor stores the credential's end date:
  its vendor enforces it. Every token request makes the same MCP `initialize`
  in place of a refresh, under the connection's lock. A 401 marks the
  connection `needs_reauthorization` with `token_refused`, and the list's
  `reconnect_reason` says a new one must be pasted; an unreachable vendor is
  a retryable 503 that marks nothing.
- **Issuing.** The token is the api_key shape,
  `{"secret": {fields}, "public": {choices}}`, and the grant's MCP servers
  carry the method's header templates, which the session host renders. The
  answer's `expires_at` and `expires_in` are null, `use_until` is an hour
  after the issue, and the broker's "more than `max_lifetime` left" check
  does not apply. Its issuance record is live for that hour, which is what a
  withdrawal's warning names.
- **Never-expiring keys.** `ALLOW_NON_EXPIRING_KEYS`, off by default, offers
  `expires: never` methods. Off, they are left out of `paste`, a paste with
  one is refused (403 `forbidden`), and a connection made with one while it
  was on reads as `needs_reauthorization` (`method_not_offered`), is left out
  of a session's grants, and is refused at issue and grant time. A
  never-expiring key can only be revoked at the vendor. An `api_key` entry
  stays refused either way (`key_never_expires`).
- **Disconnecting** forgets the credential and says that only the vendor
  can revoke it.
- **Switch Console** offers each method under the sign-in ("Use a token
  instead", "Use API keys instead"), on a paste step with the sign-in's own
  pickers above the method's fields, and one line on how long each way
  lasts: the sign-in's token's lifetime, "refreshed by Switch"; "on the date
  you set in <Service>" for `expires: vendor`; "Never expires; only
  <Service> can revoke it" for `expires: never`. A connector's page shows
  `access_note` in place of the level, and for `token_refused` offers "Paste
  a new one", which opens the paste step on the connection's method.

## Tokens

The broker holds every token to its entry's `max_lifetime`, and a minted one to
the hour, as before, except a credential pasted in place of a sign-in, whose
end only its vendor knows (see "Pasted credentials beside a sign-in"). For a
pass-through service:

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
hour. A token already handed out stays valid at the vendor until it expires:
for a pass-through service nothing can revoke the owner's token alone (for
Google, revoking it would end the owner's whole sign-in), so its issuance
record is marked withdrawn and the change's `warning` says until when it may
keep working, up to the entry's `max_lifetime` (an hour for Google, eight
hours for Atlassian, whose tokens cannot be asked for shorter). A disconnect,
or a reconnect that replaces the sign-in, also revokes the sign-in itself
where the vendor allows it. Where that ends its tokens too
(`revocation_ends_tokens`, Google's and GitLab's), and the revocation succeeded, the
warning leaves the service out.

## Connecting

Routes under `/gateway/service-connections/{service}/flows`: start, authorize,
callback, complete, status and drop.
Switch Console starts a flow with a one-time state, its listener's port and a
completion secret. Core keeps the PKCE verifier and exchanges the code, so
neither Console nor the browser holds a token. The browser comes back the way
the server names for the service where it can offer it, else the first way the
catalog allows that it can:

- **loopback**: straight to Console's listener on 127.0.0.1. With
  `loopback_ports`, only on one of them; Console listens on the first free one.
- **core**: to Core's callback (needs `GATEWAY_PUBLIC_URL`), which sends the
  browser straight on to Console's listener with the code. A cookie set as the
  browser left through Core ties it to that browser, and the callback takes a
  flow's code once; a page is shown only when the return cannot be verified
  or the consent was cancelled.

A deployment names the way back per service in `SERVICE_SIGN_IN_REDIRECT`, JSON
such as `{"atlassian":"core"}`; a service it does not name comes back the first
way its entry lists, which for an entry listing both is loopback. A slug not in
the catalog, or a way its entry does not list, stops the server as it starts;
the config itself checks only the slug's shape, so reading it (as a migration
does) never loads the catalog. `core` on a server without `GATEWAY_PUBLIC_URL`
is a warning at startup: the service signs in through loopback where its entry
lists loopback; otherwise it cannot be connected until `GATEWAY_PUBLIC_URL` is
set. Every replica needs the same value, because they share one registered
client per service and choice, and replicas that differ keep replacing it.
To change the value, restart every replica together (scale down, then up),
not as a rolling update; otherwise people may have to reconnect more than once.
Some vendors take Core's callback,
`<GATEWAY_PUBLIC_URL>/gateway/service-connections/<service>/flows/callback`,
only once their admin has allow-listed it (for Atlassian, an admin of each
site people sign in to; for Datadog, an admin of each organization, under
the MCP OAuth redirect URLs in Organization Settings), so that comes first; until then the vendor shows its
own error page, which never reaches Switch, and the start answers the callback
(`callback_url`) for Console's Connect dialog to show under its spinner with
the line "If <Service> shows an error, an admin must allow-list this URL at
<Service>." Core's callback is registered only where sign-ins use it, so naming
`core` for a service whose client Core registers, or no longer naming it,
registers a new client at the next connect, and every connection to that
service on the server reads as needing to reconnect, once. For a client the
operator registers, Connector apps lists the same addresses.

Console's listener brings Console to the front as the code arrives, and
posts it back with the completion secret; in that one step Core exchanges
it, reads the account, refuses an account already linked to another person
in the workspace, and writes the connection through `broker.connect()`.
There is no confirm step: the person chose the account at the vendor. The
flow then reads `connected` (with the account and any warning) or `failed`
(with the reason), holding no token, until Console drops it or it expires.
The consent recorded is what the vendor granted: write where every write
scope was granted, else read. A vendor whose consent page offers levels the
scopes asked for cannot tell apart, and whose token answers with its own
list of permissions, is read by markers instead,
`access.consent: {read: <scope>, write: <scope>}`: write where the token's
`scope` holds the write marker, read where it holds only the read marker, and
the sign-in is refused where it holds neither. Only an OAuth entry with both
levels names markers. Flows are rows in `sign_in_flows`, so any process can
take any step: ten minutes each, at most 256 per workspace, one per person.

A dynamically registered client is the deployment's own, kept in
`service_oauth_clients` (one row per service and choice, encrypted with the
keyring, re-encrypted at key rotation, no tenant). Registration asks for a
public client with the entry's scopes, Console's listener where the entry lists
loopback, and Core's callback only where sign-ins come back through it, under a
lock held in the database, and is repeated when the registration endpoint,
redirects or scopes change. A secret a
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
in that folder's `status.json`, and the agent controller reports it with `git`
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
token that lives longer than an hour, that a token already handed out may
keep working until it expires.

`GET /gateway/service-connections/{service}/agents` lists the caller's own
agents in the workspace, each with whether it holds a grant on the service and
whether others can address it, for the "used by" list and the checklist
Console offers after connecting. Another member's agents never appear; an
unknown or placeholder slug is 404.

"Others can address it" (`addressing_open`, here and on the agent's grants
list) is true for an open policy, for a rule that admits every person or a
person by an identity the owner has not claimed, and for a rule that names any
agent, by id or `"*"` (`AddressingPolicy.admits_others` in `addressing.py`).
The owner's own agents (`owner_agents`) do not count: they already act for the
owner, so the default policy, "you and your agents", raises no warning. An
agent is not the person, though: whoever addressed the owner's other agent can
have it pass the request on, and the grant is then used for them. Nothing
refuses that path, which an `owner_agents` rule admits; "Make owner-only", in
Console and the dashboard alike, sets the owner alone, which closes it.
Carrying the originating person on agent-to-agent messages, so that "you and
your agents" can be safe for an agent with grants, is a later follow-up.

## Switching connections on

The whole feature is behind the `service_connections` feature flag
(`FEATURE_FLAGS_ENABLED`), off by default. Off, the routes for connections,
sign-ins, keys, grants, the workspace's switches and connector apps are not
mounted, on either the gateway or the agent API: an agent host reads the
missing `service-grants` route as no grants, and Switch Console and the
dashboard, which show connectors and an agent's grants only with the flag on,
offer no service at all. GitHub's own connect routes and the older catalog
(`/gateway/provider-connections`, for a Console from before connections), the
boot-time GitHub move and the token upkeep run either way; a GitHub
connection made through those routes cannot be granted until the flag is on.

## Switching a service off

`DISABLED_SERVICES` is JSON, `{"<slug>": "<reason>"}`; an empty reason reads
"Switched off on this server." A switched-off service is listed with its
reason and cannot be connected, granted or issued a token (403 `forbidden`);
disconnecting still works. A slug outside the catalog stops the server.

## Switching a service on for a workspace

A workspace admin switches each catalog service on or off for the workspace
(`GET` and `PUT /gateway/workspace/services[/{service}]`, admins only,
and the operator in a workspace they belong to). A service with no setting
takes the workspace's default, `tenants.services_on_by_default`: off for every
workspace made since services started off, so a new workspace has none until
an admin switches each on, and on for the workspaces that already had members
then, so nothing they used stopped working. A row is written only when an
admin touches the switch, and each change is audited
(`workspace_service.enabled` / `.disabled`). The switch applies only with the
`service_connections` flag on; with it off, GitHub works as it always has.
The list carries `connected_members` and `granted_agents`, what Console shows
before an admin confirms switching off.

Off, nobody in the workspace can start a sign-in, paste a key, connect, grant
or be issued a token for the service: 403 `forbidden`, "Atlassian is not
enabled in this workspace. Ask a workspace admin; they switch it on under
Connectors in Switch Console." The server's own `DISABLED_SERVICES` reason is
checked first. A sign-in that completes after the switch is refused and
revoked at the vendor. Grants are kept, but the grants list a session reads
leaves the service out, so a running session loses the service within half a
minute, as it does a removed grant: its host restarts it without the service.
A token already handed out may be used until that restart, except GitHub's,
which the switch queues and revokes before it answers (`warning` when some
could not be yet; the five-minute tick keeps trying). A pass-through token is
marked withdrawn, and the `warning` says until when it may keep working. On
again, the grants come back with no re-grant.

The service list (`GET /gateway/service-connections`) carries
`workspace_enabled` per service. Like the switch, the list exists only with
the flag on.

Beside `unavailable_reason`, the sentence people read, each entry carries
`unavailable_code`, null when the service can be granted, so a client can say
what each person can do about it (`UnavailableCode` in
`connections/broker.py`):

- `coming_soon`: the catalog has it switched off.
- `switched_off`: the operator switched it off (`DISABLED_SERVICES`).
- `needs_https`: its app can't work on this server: GitHub's App needs
  `GATEWAY_PUBLIC_URL` to be https, or loopback http (`localhost`,
  `127.0.0.1` or `::1`, as on a server Switch Console runs at
  `http://127.0.0.1`), and it is plain http to another host.
- `app_not_set_up`: its app is the operator's to set up, under Admin →
  Connector apps, and is not (`server_setup_needed` is true for exactly this).
- `not_set_up`: nothing on this server connects it, and no app would.
- `not_fully_set_up`: it can be connected but not granted: its app lacks a
  part (a GitHub App configured with no signing key).
- `key_never_expires`: it connects with a key that never expires
  (`token.max_lifetime: null`), which Switch never hands to an agent, so it
  can be neither connected nor granted. One already connected can still be
  disconnected, and an existing grant is refused at issue time (403
  `forbidden`).

`get_my_context`'s `services` carry the same code.

## Keys

For a vendor whose people connect with a key rather than a sign-in (PagerDuty,
Snowflake and the like, and Datadog until it signed in), an entry names
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
      # or a value held to a pattern (an account, a subdomain), in place of
      # choices: `pattern: "[a-z0-9][a-z0-9-]{0,62}"`, matched in full
    identity:                   # checks the key, before anything is stored
      method: GET               # or POST, with a JSON body
      url: "https://api.{site}/me"          # a URL names choices and patterns
      headers: { X-Api-Key: "{api_key}" }
      account_id: user.id       # optional: without it, the key's SHA-256
      label: user.email         # optional: without it, the name and choices
      # requires: result.tools  # optional: a path the answer must hold, for a
                                # vendor that refuses with 200 (JSON-RPC errors)
    help_url: https://docs.example.com/keys
token: { kind: pass_through, max_lifetime: null }   # never handed to an agent
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
whatever its vendor let it), and a `max_lifetime` other than null.

**A field held to a pattern** is typed freely, so a URL may hold it only where
it can pick an account and never another host: as a whole host label followed
by labels the template fixes (`https://{account}.example.com/...`, at least a
domain and its suffix), or as a whole path segment (`.../v1/{database}/...`).
The loader refuses it anywhere else: beside other text in a label or segment,
in the domain itself, or in the query. Its pattern must compile and must not
match an empty value. When someone connects, Core holds the value to the
pattern in full and, whatever the pattern allows, to one DNS label where it is
a host label and one unreserved path segment where it is a segment.

**A key is never handed to an agent.** It does not expire and only its vendor
can revoke it, so whatever ran beside the agent could keep it for good, past a
removed grant or a disconnect. The broker refuses to issue one (403
`forbidden`), the services list marks it `key_never_expires`, and it can be
neither connected nor granted; one already connected can be disconnected.
What follows describes the connection as it was built, which stays in place
for a later server-side use of the key.

- **Connecting.** Switch Console shows the entry's fields (the services list
  carries them as `key`) and sends them to
  `PUT /gateway/service-connections/{service}/key`. Core holds each field to
  the entry (a choice among its choices, a pattern field to its pattern and
  its place in the URL, a secret one printable line without spaces), makes
  the identity call, and stores the fields encrypted only when
  the vendor accepts them; a refusal names the fields to check. One account
  is linked to one person in a workspace, as for a sign-in. Re-pasting
  replaces the key in place, keeping the grants.
- **The token.** The connection's secret is compact JSON,
  `{"public": {...}, "secret": {...}}`, the shape a session host would render
  into its templates.
- **Sessions.** The host renders each MCP server's `url` and `headers`, or the
  tool's `env`, from the token, and redacts every secret field on its own as
  well as the whole token. The key never reaches the coding tool.
- **Grants** are on or off, as for any pass-through service, at the highest
  level: what the agent can do is what the key allows.
- **Disconnecting** forgets the key, and says that only the vendor can revoke
  it. Keys are long-lived and are not refreshed.

Datadog was the first entry built this way. Its remote MCP server takes an
API key and an application key in headers named with underscores
(`DD_API_KEY`, `DD_APPLICATION_KEY`), unlike its REST API's hyphens. Refused
with every key, it now signs in instead (see [Datadog](#datadog)), and no
shipped entry is connected with a key; the key tests run against an entry of
their own.

### Snowflake

Snowflake's MCP server is per account and per object, at
`https://<account>.snowflakecomputing.com/api/v2/databases/<db>/schemas/<schema>/mcp-servers/<name>`,
made by an administrator with `CREATE MCP SERVER`, and takes a programmatic
access token as `Authorization: Bearer`. A person types the account
(`orgname-accountname`, one DNS label, so a region or privatelink address is
not supported), the database, schema and server (one path segment each, as
unquoted identifiers) and the token. Snowflake has no OAuth client one Switch
server could share, so the token is the shape for now; like Datadog's keys it
is never handed to an agent, and the card says so.

The identity call is the server's `tools/list`. Measured against a Snowflake
account: a wrong token is 401, but a server that does not exist, or that the
token's role may not use, is 200 with a JSON-RPC error, so the check
`requires` `result.tools` and repeats Snowflake's own reason. The
`X-Snowflake-Authorization-Token-Type` header is not needed. Snowflake names
no user in that answer, so the account is the token's SHA-256. A token
restricted to a role with only `SELECT` cannot write, which Snowflake enforces
("Insufficient privileges"); the server's tools are the administrator's
choice, so Switch has one level and the role decides. A token needs a network
policy covering its user, or an authentication policy that waives that, and
lasts 15 days by default, up to 365.

## Adding a connector

A connector is a catalog entry and a skill, with no code, when the vendor fits
one of three shapes. Pick the first that fits:

1. **A remote MCP server with OAuth** (Atlassian, Datadog, Linear): `adapter: oauth`
   with `mcp`. Where the vendor offers dynamic client registration, nothing is
   set up on the server (`registration: dynamic`); otherwise each server's
   operator registers an OAuth app and saves it under Connectors in the
   dashboard, or names it in `<PREFIX>_CLIENT_CONFIG_PATH`
   (`registration: static`). Where the vendor's API refuses its MCP tokens
   (Sentry), the account is read from a tool on the MCP server
   (`identity.mcp_tool`). A vendor with a deployment per region names its
   sites as [choices before the sign-in](#choices-before-a-sign-in).
2. **A command-line tool with OAuth** (Google Workspace): `adapter: oauth` with
   `cli`, a pinned release per platform with its SHA-256, and the allow and
   deny lists that keep it to the vendor's own commands.
3. **A key**: `adapter: api_key`, above, with `mcp` or `cli`. Such an entry
   is refused today, since a key is never handed to an agent.

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

## Shared OAuth catalog opt-ins

`auth.identity.mcp_tool` names an MCP tool that identifies the account. An
entry names exactly one of `url`, `mcp_tool` or `introspection: true`. A
`url` is for an authenticated JSON GET. Entries with a `url` keep their REST
identity.

Before Core calls the tool, it checks these things:

- Exactly one tool on the server has the name.
- The tool has `readOnlyHint: true`.
- Its `inputSchema` has `type: object`.
- Its `required` is absent or a list. Each name in the list is a key of the
  entry's `arguments`. Without `arguments`, the list is empty.
- With `arguments`, its `properties` is an object that declares each key. A
  declared key has no `type`, or `type: string`.

Core reads nothing else in the schema and runs no JSON Schema validator. On a
small hostile schema, a validator can spend minutes of CPU time and block
Core's event loop. If a check fails, sign-in fails with `needs_arguments`,
and Core does not call the tool. A tool that still refuses its arguments
fails when Core calls it, with `tool_error`: an `isError` result or a
JSON-RPC invalid-params error.

This check only shows that the schema needs no argument that the entry does
not give. It does not show that the tool only reads. That rests on
`readOnlyHint: true` and on the catalog review of the tool an entry names.
The MCP specification calls tool annotations untrusted.

`auth.identity.arguments` is for a tool that identifies the caller only when
it is told to, such as a user lookup that takes "me". The loader accepts it
only with `mcp_tool`. It has 1 to 4 keys. Each key matches
`^[A-Za-z_][A-Za-z0-9_]{0,63}$`. Each value is a string of 1 to 64
characters, with no `{` or `}` and no control characters. The values are
fixed catalog text, never from a person or from the vendor, so the loader
refuses a template. An entry gives only a value that the vendor documents as
the caller, and cites that documentation in its YAML comment. A value that
names another account would sign the person in as that account.

Core calls the tool with the entry's `arguments`, or with `{}` without
them. Core does not check the result against the
tool's `outputSchema`, because the MCP SDK's check can fetch a remote `$ref`.
Core's own checks apply instead. The result must be one JSON object, from
`structuredContent` or from one text block. Each `account_id` path must give
a string with at least one character that is not a space, or an integer.
Missing ids, arrays and results with several accounts fail sign-in. Core never
picks the first account.

`account_id` is one path, or a list of 2 to 8 paths, for example
`[userId, hubId]`. Core percent-encodes each part of a list and joins the
parts with `:`. So a separator in a vendor id cannot make two accounts look
the same. The single-path form keeps the vendor id unchanged. The two forms
give different ids for the same account, so an entry chooses its form once.

The MCP identity call has these limits:

- 15 seconds for the whole call.
- 1 MiB per response, and 4 MiB for all responses together.
- 20 pages of `tools/list`. A repeated cursor fails.
- 64 KiB for the tool's result.
- No redirects, and no compressed responses.

The identity call reaches only the addresses that Core's outbound policy
allows. So a self-hosted MCP server on a private address must be listed in
`OUTBOUND_ALLOWED_PRIVATE_HOSTS`.

A failure of the tool checks or of the result names one reason code:
`tool_not_found`, `not_read_only`, `needs_arguments`, `tool_error`,
`bad_result` or `protocol_error`. A response over a limit gives `bad_result`.
An answer that is not valid MCP, or a redirect, gives `protocol_error`.

Other failures have no reason code:

- A 401 from the MCP server. The person must reconnect.
- A timeout, a 429, a 5xx, a network error or a host that does not resolve.
  The person can try again.
- Any other 4xx. The message gives the status, for example "would not say
  whose sign-in this is (HTTP 403)".
- An MCP server address that the outbound policy refuses.
- A Core HTTP client that is not held to the outbound policy. Core then sends
  no request.

Core reports an HTTP error on `tools/call` only when the 15-second limit
ends.

Every message is fixed text and never holds vendor text.

Core drops the vendor's log notifications. While the call runs, Core replaces
each log record from the MCP SDK with a fixed line.

`auth.identity.introspection: true` is for a vendor whose MCP tokens reach no
account endpoint. Core sends the token to the `introspection_endpoint` in the
discovered metadata (RFC 7662). Core authenticates there as it does at the
token endpoint. Only an answer with `active: true` names an account. If the
metadata has no introspection endpoint, Core refuses the sign-in before the
person consents.

The introspection request does not have the MCP identity call's limits. It
has these:

- 20 seconds for each connect, read and write, from Core's HTTP client for
  services. No limit applies to the whole request.
- 64 KiB for the answer.
- No redirects.
- Only the addresses that Core's outbound policy allows.

Core never reads the ids in the token response, because nothing checks that
response against the token later. The introspection answer is the vendor's
live answer for the token. With a list `account_id` such as
`[workspace_id, user_id]`, the same person in two workspaces has two account
ids. A person still has one connection for each service, so connecting the
second workspace replaces the first.

For a server whose OAuth endpoints Core discovers, Core reads `resource` from
the protected-resource metadata. If the metadata names none, Core uses the
configured MCP URL. Core accepts the value only if it has the MCP URL's
scheme (https), host and port. A URL without a port has port 443. The value
must have no query and no fragment. Its path must be the MCP URL's path, or a
parent path on a segment boundary. So `/v1` covers `/v1/mcp`, but `/mcp` does
not cover `/mcp2`. Otherwise sign-in fails before Core reads the metadata's
authorization servers. The path rule is the MCP Python SDK's. RFC 9728 §3.3 wants
an exact match, but Airtable advertises its origin for its `/mcp` server. Core
sends the accepted value in the authorization request, the code exchange and
every refresh.

`access.unscoped: true` is only for vendors that advertise and document no
OAuth scopes. The catalog entry must cite that evidence in a YAML comment.
Only an OAuth entry can be unscoped, and its Read and Write scope lists must
be empty. The authorization request omits `scope`, and consent always records
Write, never Read. The opt-in does not make the tools read-only. An unscoped
entry has no access profiles, and no access profile can be unscoped. Entries
without the opt-in still need non-empty scopes. Core does not enforce a
narrower level through the listed tools.

Neither feature enables a connector. Each connector supplies its own verified
identity mapping, evidence comments, skill, tests and live acceptance.

## Atlassian

Built from a sign-in run against a test Atlassian Cloud site with default MCP
settings:

- Atlassian offers only dynamic registration, so Core registers its client.
  Refresh works with the client id alone.
- A sign-in returns to Core's own address only where an organization admin has
  added it, so Atlassian connects through Switch Console, in loopback mode,
  unless the server names `core` for it in `SERVICE_SIGN_IN_REDIRECT` once
  Core's callback has been added. Atlassian matches the loopback port exactly,
  hence the five fixed ports.
- Consenting to Jira's scopes alone fails after Accept unless the request also
  carries the identity scopes, `offline_access` and `prompt=consent`. Atlassian
  reflects the result: a read-only sign-in still lists `executeWrite` and
  `executeDestructive`, but `discover` returns no write operations and
  `getAccessibleAtlassianResources` reports each product as read-only.
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

To connect: Connectors in Switch Console, then Atlassian. Nothing
needs configuring on the server. To roll back, add `atlassian` to
`DISABLED_SERVICES`, or set the entry's `enabled: false`.

## Datadog

Built from Datadog's public MCP and OAuth metadata at each of its sites, and
tested live at US1: the sign-in with Full and Limited access, a pasted token,
and pasted keys, each with an agent reading monitors through Switch:

- Each site is a Datadog of its own: its own accounts, MCP server and
  authorization server. The person picks theirs before signing in, from the
  seven public sites (`datadoghq.com`, `us3.datadoghq.com`,
  `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`,
  `ap2.datadoghq.com`, `uk1.datadoghq.com`); government sites offer no MCP
  server. Every URL in the entry names the site: the MCP server,
  `https://mcp.{site}/v1/mcp`, and the identity call,
  `https://api.{site}/api/v2/current_user`.
- The MCP server's 401 names its resource metadata, which names the MCP
  server itself as the authorization server; that server's metadata, on the
  MCP host, names endpoints on the site's app host. Discovery needs nothing
  of its own.
- Datadog offers only dynamic registration, of a public client (PKCE S256,
  no secret), so Core registers one at each site people sign in at. The one
  scope is `mcp_all`. Datadog's consent page calls every client "Datadog
  Generic MCP Client", whatever name it registered.
- The consent page offers Full access or Limited (read-only) access, and the
  token's `scope` lists every permission given, never `mcp_all`, with
  `mcp_write` only for Full. The entry's consent markers read the level from
  it: `write` with `mcp_write`, `read` with `mcp_read` alone, refused with
  neither. Write tools are listed either way, and an organization admin can
  hide them for everyone with the MCP Write Access switch; the skill says so.
- Access tokens live 3,599 seconds; refresh tokens are reused, never rotated.
  Datadog advertises no revocation, so a disconnect says where to remove the
  sign-in in Datadog (Personal Settings, Authorized Apps).
- The account is the user in the organization signed in to (`data.id`), named
  by their email; one person in two organizations is two accounts. Connectors
  shows the site beside the email.
- A sign-in comes back to Switch Console on five fixed ports, which Datadog
  takes from any organization; it adds `site`, `domain`, `dd_oid` and
  `dd_org_name` to the redirect, which neither Console's listener nor Core's
  callback reads. Core's callback works only once an organization admin has
  added it to the MCP OAuth redirect URLs in Organization Settings; then the
  server may name `core` for datadog in `SERVICE_SIGN_IN_REDIRECT` (see
  [Connecting](#connecting)).
- In place of the sign-in, a person may paste a personal access token
  (field `pat`, sent as a bearer, `expires: vendor`) or an API key and an
  application key (in `DD_API_KEY` and `DD_APPLICATION_KEY`, as Datadog's
  MCP server reads them, `expires: never`, so offered only with
  `ALLOW_NON_EXPIRING_KEYS`). A token with `user_access_read` is named by its
  Datadog user; one without, by its public part (`ddpat_…`), and keys by
  "Datadog keys · <site>" where the identity call does not answer with
  them. The token's scopes are `mcp_read`, and `mcp_write` for writes.
- A connection made with keys, when Datadog was connected with keys, has no
  site but inside the keys it holds. It reads as needing reconnecting
  (`choices_missing`) and is never used, whether or not the server allows
  keys that never expire; it is not filled in. Disconnecting or replacing it
  says Switch has forgotten the pasted keys but cannot revoke them.

To connect: Connectors in Switch Console, then Datadog. Nothing needs
configuring on the server. To roll back, add `datadog` to
`DISABLED_SERVICES`.

## Linear

Linear's official remote MCP server, `https://mcp.linear.app/mcp`, with no
new adapter code:

- Linear's MCP server offers OAuth 2.1 with dynamic client registration, so
  Core registers its client and nothing is set up on the server.
- A sign-in returns through Core where `GATEWAY_PUBLIC_URL` is set, and
  otherwise straight to Switch Console on one of five fixed loopback ports.
  `prompt=consent` is sent on every connect, but Linear shows no consent
  screen when the browser's Linear login approved the client before
  (measured). A reconnect then signs in as that login, in the workspace it
  picked then.
- Switch asks for the write level (`read write`) on every connect, and a
  grant is on or off, so a connection can read and write. The read level
  (`read` alone) is what Linear enforces: such a token lists only the
  read-only tools (measured). The scope decides, not the separate
  `/mcp/readonly` URL. `admin` (workspace settings, teams, members) is never
  asked for.
- Linear's GraphQL API answers an MCP token 401, so the account is read from
  the MCP server. Its `whoami` tool is not read-only, and a read sign-in does
  not list it. Core calls `get_user` with `arguments: { query: me }`.
  `get_user` is read-only and is listed for both scopes, and Linear documents
  "me" as a value of `query`. Measured, `get_user` "me" returns one user, the
  signed-in one, also next to a member named "me". The account is that
  user's `id`, labelled by its email. The same login has a different id in
  each Linear workspace.
- Linear's access tokens live 86100 seconds (measured `expires_in`, first
  token and after a refresh), hence `max_lifetime: 86100`. An agent's copy
  may outlive a removed grant by up to that long, though agents ask again
  hourly. Refresh tokens rotate. The old refresh token still works for a
  short time after the rotation (measured; the time was not measured).
- A disconnect revokes at the revocation endpoint the authorization server
  advertises.
- Tools pass through unchanged. The skill has the agent read before writing,
  search before creating, confirm before changing status, assignee or
  priority, and close, archive or delete only an item the user named.

To connect: Connectors in Switch Console, then Linear. Nothing needs
configuring on the server. To roll back, add `linear` to
`DISABLED_SERVICES`, or set the entry's `enabled: false`.

## Airtable

Built from sign-in runs against free Airtable accounts; the operator's setup
is in [`docs/old/airtable-setup.md`](../old/airtable-setup.md).

- Each server's operator registers an Airtable OAuth integration and saves it
  under Connector apps, or names it in `AIRTABLE_CLIENT_CONFIG_PATH`. The
  browser comes back to Core's own callback, as Google's does, so the server
  needs `GATEWAY_PUBLIC_URL` and nothing listens on people's computers; a
  loopback redirect would work on any server, but the operator chose the
  https callback. The Connector apps entry lists the callback and the scopes
  the integration must tick, and is checked with a made-up code and verifier
  sent to the callback: Airtable
  answers `invalid_grant` for the right client ID and secret, `invalid_client`
  otherwise, and compares the redirect only with a real code, so the first
  connection confirms it. Airtable offers dynamic registration, but
  files the registered client under the Builder Hub of the first person to
  authorize it. There it stays limited to development, so Airtable refuses
  everyone else ("cannot be used outside of development"), and deleting it
  leaves Core with a client Airtable refuses on its own consent page, where
  Core never sees the error. An integration the operator owns and publishes
  (support email, privacy policy, terms of service) avoids both.
- The endpoints are discovered from the MCP server, whose 401 names its
  metadata, which lists `client_secret_basic` and `none` as the token
  endpoint's methods. An integration with a secret must send it as HTTP
  Basic: in the body Airtable refuses it, even when right (`invalid_client`).
  The adapter sends a secret as Basic wherever the metadata lists Basic and
  not `client_secret_post`, and in the body everywhere else, Google included.
  Airtable asks for the PKCE verifier before it looks at the client.
- Airtable's consent screen chooses bases, interfaces and workspaces, not
  scopes: a person cannot leave the write scopes out, at sign-in or later. So
  every connection is granted the write level, and what an agent reaches is
  narrowed on Airtable's side, by the bases shared and the person's base role.
- Not asked for: `schema.bases:write`. Without it Airtable refuses creating or
  changing tables and fields, though its server lists those tools anyway.
  `data.records:write` includes deleting records.
- Access tokens live 60 minutes, and no `offline_access` is needed for a
  refresh token. Each refresh returns a new refresh token and ends the
  previous access token at once, so a host still holding it is refused once
  and asks again. whoami (`api.airtable.com/v0/meta/whoami`) accepts the MCP
  server's token; it returns no email without a scope the server does not
  offer, so a connection is named by its account id.
- Airtable has no revocation endpoint. Each sign-in is its own grant there,
  and the integration reaches every base any of a person's grants shared, so
  a sign-in Switch drops (a disconnect, a reconnect, one a switched-off
  workspace refuses) still works and widens the next. Its entry's
  `remove_access`, which an OAuth entry without revocation must have, tells
  the person to revoke it under Integrations, Third-party integrations.
- `list_secrets` is account-wide and returns each automation secret's id, name
  and creation time, never its value.
- On Enterprise plans an admin may allowlist third-party clients by client id:
  the operator's integration has one, the same for everyone on the server. Not
  tried: no Enterprise account was at hand.

To connect: Connectors in Switch Console, then Airtable. To roll
back, add `airtable` to `DISABLED_SERVICES`, remove its client under
Connector apps or unset `AIRTABLE_CLIENT_CONFIG_PATH`, or set the entry's
`enabled: false`.

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
  and saves it under Connectors in the dashboard, or names its settings in
  `GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH`
  ([operator setup](../old/google-workspace-setup.md)). Without either, Google
  Workspace is listed as not set up on this server.
- **Offline access.** Google returns a refresh token only for
  `access_type=offline`, and on a later sign-in only with `prompt=consent`;
  both go with every authorization. Refresh tokens are reusable.
- **The account chooser first.** `prompt` also carries `select_account`, so a
  browser signed in to another Google account (a personal one, or another
  organization's) does not pick it unasked. `prompt` takes several values,
  space-separated, as OAuth writes them.
- **Tokens.** Access tokens lived 3,599 s, so `max_lifetime` is 3,600: a
  token handed out never has more than an hour left, and one Google issued
  for longer is refused rather than handed out.
- **The account** is OpenID's `sub`, labelled by `email`, from userinfo.
- **Scopes as Google names them.** Google answers with full scope URLs
  (`email` comes back as `.../auth/userinfo.email`), and the level is read by
  comparing them, so the entry names them that way. A person who unticks the
  write scopes connects read-only, and Google refuses every change.
- **Re-linking cannot narrow.** While the app holds access, Google's consent
  shows what it already has, with nothing to untick: connecting read-only after
  read and write takes a disconnect first.
- **Disconnecting revokes** at `oauth2.googleapis.com/revoke`, which ends every
  token of the person's sign-in to that app, so the entry says
  `revocation_ends_tokens` and the disconnect's warning does not name Google
  Workspace once the revocation succeeded.
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
`enabled: false`, or remove its client (under Connectors, or by unsetting
`GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH`). Each lists
it as unavailable, with its reason, and the next token request fails.

## Notion

Built from sign-in runs against a Notion workspace through Notion's hosted MCP
server, with a dynamically registered public client:

- Notion offers dynamic registration and takes the loopback redirect on any
  port, so Core registers its client and Notion connects through Switch
  Console. Its consent screen asks the person to tick that they trust the
  loopback address before they can continue.
- A Notion MCP token reaches neither Notion's REST API (`/v1/users/me`
  answers 401) nor the MCP server's `/userinfo` (403, `insufficient_scope`).
  Notion's authorization server advertises an `introspection_endpoint` that
  takes a public client's id alone, and its answer for a live token has
  `active: true`, our `client_id`, `workspace_id` and `user_id`. The account
  is the two ids. A person has one Notion connection. Connecting another
  workspace replaces it, and grants made for the first workspace fail until
  the person grants them again. The answer names neither by name, so the
  connection is labelled with the workspace's id. The token response carries
  the same ids, but it is never read for identity, since nothing checks it
  against the token later.
- Notion has one scope, `default`, and its consent screen picks a workspace,
  not scopes or pages, so every connection is granted the write level and
  reaches what the person can reach in that workspace.
- Access tokens live 8 hours; each refresh returns a new refresh token.
  Revocation is at the token endpoint, as the metadata advertises; revoking
  the refresh token makes the access token inactive at once.
- The server listed 77 tools, read-only and destructive ones annotated as
  such; they pass through. Some (Notion's own agents, suggested edits) need a
  paid plan or Notion AI and say so when refused. The skill keeps the agent to reading, editing with
  confirmation, and deleting only what the user named.

To connect: Settings, Connections in Switch Console, then Notion. Nothing
needs configuring on the server. To roll back, add `notion` to

## Sentry

Built from sign-ins against sentry.io with a test organization:

- Sentry's MCP server (`mcp.sentry.dev/mcp`) offers dynamic registration,
  PKCE S256 and revocation at its token endpoint, so Core registers its client
  and nothing is set up on the server. It connects through Switch Console in
  loopback mode, on Atlassian's five ports.
- The token answer names nobody, and `sentry.io/api/0/users/me/` answers an
  MCP token with 401: the token works with the MCP server alone. So the
  account is read from the server's own `whoami` tool (`identity.mcp_tool`).
  Core lists the server's tools, checks that `whoami` is read-only
  (`readOnlyHint: true`) and needs no argument, calls it, and reads
  `user.id` and `user.email` from its structured answer.
- The first access token lives 3600 s. Sentry's MCP server never refreshes
  upstream: a refresh re-issues a token that lives as long as the person's
  30-day Sentry token has left (`tokenExchangeCallback` in getsentry/sentry-mcp).
  That outlives the entry's `max_lifetime`, and a pass-through token may be
  capped at 7 days at most, so the broker withholds it (503, retryable) and
  hands it out only in its last hour (about day 30). The broker refreshes a
  pass-through token 15 minutes before it expires, so a request after about
  minute 45 gets the refusal; a token an agent already holds works until it
  expires. Agents have Sentry for up to an hour after each sign-in. The cap
  stays: raised for one vendor, a grant turned off would leave an agent's
  copy valid for weeks. The entry's `token.note` says so, and Switch Console
  shows it on Sentry's page and before connecting, so nobody expects more.
- For another hour, the owner disconnects and connects again. A disconnect
  deletes every agent's Sentry grant, so the owner then turns Sentry on again
  for each agent.
- Sentry's consent screen asks which skills to allow: Inspect Issues & Events
  (read-only tools), Seer, Triage Issues, and Manage Projects & Teams. The
  token's scopes are the same four (`org:read`, `project:write`,
  `team:write`, `event:write`) whatever is chosen. The choice limits the tools
  on Sentry's side, and Sentry remembers it for the next sign-in. A read level
  cannot be asked for by scope, so every connection is granted the write
  level, and a person who wants a read-only agent allows Inspect alone.
  `alerts:write` is not asked for, but `project:write` still lets tools
  create, change and delete alert rules. No admin scope is asked for, so
  Sentry refuses to delete projects and teams.
- Tools pass through unchanged.
- Sentry.io only: a self-hosted Sentry is not part of this entry.

To connect: Settings, Connections in Switch Console, then Sentry. Nothing
needs configuring on the server. To roll back, add `sentry` to
`DISABLED_SERVICES`, or set the entry's `enabled: false`.

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
- Connecting Atlassian from the web dashboard.
- Connecting any service from the web dashboard: Switch Console starts every
  sign-in, Google Workspace's included, though Google's comes back through
  Core.
- Google Workspace on Switch's hosted service, which waits on Google's review
  of Switch's own app.
- Keeping a CLI vendor's token out of the CLI's process (a credential proxy).
- Live runs against a real Jira site, a real Google Workspace and a real
  Datadog organization stay manual and outside CI, which tests `gws`'s
  handling against a stand-in, never the real binary, and Datadog's sign-in
  against a stand-in for each of its sites.
- Connecting a key from the web dashboard: Switch Console starts it, as every
  connect.
