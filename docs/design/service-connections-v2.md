# Service connections: v2, services beyond GitHub

Status: built (Phase 1). This note covers what v2 adds to
[`service-connections-v1.md`](service-connections-v1.md): any OAuth vendor
whose tools are its own MCP servers, connected, granted and called from a
session on generic parts, with Atlassian (Jira) as the first. v1's tables,
broker checks, agent routes, token cache and redaction carry over unchanged;
GitHub works as it did.

## What changes from v1

| v1 | v2 |
|---|---|
| One adapter, GitHub's, built by hand in `main.py` | Built from the catalog (`connections/registry.py`): each enabled entry names its `adapter`, `github` or the generic `oauth` |
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

A removed grant stops a running session within an hour: the next ask is
refused. A token already handed out stays valid at the vendor until it expires.

## Connecting

Routes under `/gateway/service-connections/{service}/flows`: start, authorize,
callback (GET, then the POST relay), complete, status, confirm and cancel.
Switch Console starts a flow with a one-time state, its listener's port and a
completion secret. Core keeps the PKCE verifier and exchanges the code, so
neither Console nor the browser holds a token. The browser comes back the first
way the catalog allows that this server can offer:

- **loopback**: straight to Console's listener on 127.0.0.1. With
  `loopback_ports`, only on one of them; Console listens on the first free one.
- **core**: to Core's callback (needs `GATEWAY_PUBLIC_URL`), which shows whose
  Switch account the sign-in will join and relays the code to Console's
  listener. A cookie set as the browser left through Core ties it to that
  browser.

Console posts the code back with its completion secret; Core exchanges it and
reads the account; the connection is written through `broker.connect()` only
when Console confirms. The consent recorded is what the vendor granted: write
where every write scope was granted, else read. Flows live in memory: ten
minutes each, at most 256, one per person.

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
  refused. Nothing runs, and no token is asked for, for a refused command.
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

The binary is found on the host's `PATH` until a pinned build is shipped.

## Grants

A pass-through service's grant names no level, tools or resources: the broker
gives it the connection's level and refuses one that names any, and issuing
reads the level from the connection as it is now, so reconnecting read-only
narrows every grant at once. Console and the dashboard show such a service as a
switch beside GitHub's grant and repository picker, saying that the agent acts
as its owner there, that off stops its sessions within an hour, and, for a
token that lives longer, that a token already handed out stays valid until it
expires or the owner disconnects.

## Switching a service off

`DISABLED_SERVICES` is JSON, `{"<slug>": "<reason>"}`; an empty reason reads
"Switched off on this server." A switched-off service is listed with its
reason and cannot be connected, granted or issued a token (403 `forbidden`);
disconnecting still works. A slug outside the catalog stops the server.

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
- Only Jira's scopes are asked for, so no Confluence or Teamwork Graph tools,
  whose calls spend the organization's Rovo credits.

To connect: Settings, Connections in Switch Console, then Atlassian. Nothing
needs configuring on the server. To roll back, add `atlassian` to
`DISABLED_SERVICES`, or set the entry's `enabled: false`.

## Not yet

- `grants.changed` on the agent and controller streams: a grant change reaches
  a running session within the hour, not at once.
- Tool classification by level, and read-only grants narrower than the
  connection.
- Tool-list prefetch and per-user call limits; each call now opens its own MCP
  session at the vendor.
- Connecting Atlassian from the web dashboard, and a server setting that moves
  a vendor to Core's callback (today the catalog's order decides).
- Google Workspace, which waits on Google's developer preview.
- A live run against a real Jira site stays manual and outside CI.
