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
| One adapter, GitHub's, built by hand in `main.py` | Built from the catalog (`connections/registry.py`): each enabled entry names its `adapter`, `github` or the generic `oauth-mcp` |
| Catalog `connection.yaml` v2 | v3: `adapter`, `token`, `auth.oauth`, `auth.identity`, `mcp` (below) |
| Every token minted per issue, at most an hour | `minted` (GitHub) or `pass_through`: the owner's own access token, with the catalog's lifetime cap |
| Grants with a level, tools and resources | A pass-through grant is **on or off**: it takes the connection's level |
| Connecting through GitHub's own flow | A generic flow for `oauth-mcp` entries; GitHub keeps its own |
| No vendor tools in a session | One loopback MCP server per granted vendor server, run by the session host |
| A service is set up or not | `DISABLED_SERVICES` switches one off, with a reason people see |

## Catalog v3

```yaml
slug: atlassian
enabled: true
adapter: oauth-mcp            # github | oauth-mcp
auth:
  type: oauth
  refresh: rotating           # rotating | reusable
  oauth:
    registration: dynamic     # dynamic: Core registers its own client
                              # static: client_settings names <PREFIX>_CLIENT_CONFIG_PATH
    redirect: [loopback]      # loopback (Switch Console) and/or core (Core's callback)
    loopback_ports: [39231, 39232, 39233, 39234, 39235]
    prompt: consent           # sent with every authorization
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
`oauth-mcp` entry without its client, identity or servers, a minted token that
outlives an hour, and so on. Without `authorization_url` and `token_url`, the
endpoints are discovered from the first MCP server: the metadata its 401 names
(RFC 9728), else the well-known addresses, then the authorization server's
metadata (RFC 8414), which must offer PKCE with S256. A dynamically registered
client always discovers. Placeholder entries keep their short form.

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
