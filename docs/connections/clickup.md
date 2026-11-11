# ClickUp connection: unavailable

ClickUp is listed in the catalog as unavailable. It cannot be connected, granted
to an agent or used from a Switch room. This is the accepted outcome for
[#836](https://github.com/sandbox-quantum/switch/issues/836), following the
[maintainer's November 5 decision](https://github.com/sandbox-quantum/switch/issues/836#issuecomment-6650763832).
It is not an enabled connector or a demonstration of successful authorization.

## Why it is disabled

ClickUp's [authentication guide](https://developer.clickup.com/docs/authentication)
and [API FAQ](https://developer.clickup.com/docs/faq) document that OAuth access
tokens do not expire. Its [official MCP guide](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server)
allows OAuth only, not an API key substituted by the client.

The public MCP discovery documents were checked on **November 6, 2026**:

| Observation | Result |
|---|---|
| Unauthenticated `GET https://mcp.clickup.com/mcp` | HTTP 401 with a protected-resource metadata URL in `WWW-Authenticate` |
| Protected-resource metadata | Resource `https://mcp.clickup.com/mcp`, authorization server `https://mcp.clickup.com`, scopes `read` and `write` |
| Authorization-server metadata | Dynamic registration endpoint, public clients (`none`), authorization code flow and PKCE `S256` |
| Advertised grant types | `authorization_code` only; no `refresh_token` |

The exact responses, URLs and UTC timestamp are in
[clickup-discovery.json](clickup-discovery.json). These are unauthenticated public
metadata responses: no client was registered, no consent was requested, no token
was obtained, and no ClickUp workspace was read or changed. Non-expiry is a
vendor-documentation claim, not a token lifetime measured in this probe. An
unadvertised refresh grant was not attempted.

The advertised scopes are **`read` and `write`**, not `task:read` and
`task:write`. No access level is offered while the connection is disabled. Public
scope names alone do not prove a read-only grant's behavior.

Switch's OAuth loader deliberately requires a finite `token.max_lifetime` and a
`rotating` or `reusable` refresh mode. A made-up lifetime would not shorten a
vendor token; `refresh: none` would not make it refreshable. The catalog does not
relax that policy or switch to API-key authentication to work around it.

Disabled catalog entries must not ship a skill. There is therefore no agent
skill, MCP server declaration or access profile for this connection. The logo
identifies the unavailable catalog entry; it does not indicate that connecting
works. Loader tests keep it disabled and reject enabling it merely by changing
its flag.

## Reproduce the public discovery check

These commands need no sign-in and do not register a client:

```sh
curl --fail-with-body --include \
  --header 'Accept: application/json, text/event-stream' \
  https://mcp.clickup.com/mcp
# Expected: HTTP 401; --fail-with-body exits 22 and retains the JSON explanation.

curl --fail --silent --show-error \
  https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp

curl --fail --silent --show-error \
  https://mcp.clickup.com/.well-known/oauth-authorization-server
```

Discovery can change. Re-check it and the vendor's token documentation before
revisiting the entry; the recorded snapshot is historical evidence, not a runtime
allowlist or proof of future compatibility.

## What would permit enabling it

Revisit only after ClickUp documents or demonstrates expiring, refreshable MCP
access tokens compatible with the loader. Then verify actual scopes, identity,
redirect behavior, token lifetime and refresh rotation; add the complete OAuth
entry and task-focused skill together. Do not enable this short-form entry alone.

An eventual skill should help agents read tasks and lists before proposing
changes, identify the exact task/list before writing, and ask before closing,
deleting or making broad changes. It should explain workspace visibility and
plan-dependent call limits without describing credentials.

Before claiming a working integration, complete the issue's live acceptance:
connect in Console; grant to an agent; use it from a room; remove the grant and
verify access stops within a minute; exercise refresh and disconnect; inspect
transcripts and logs for leakage; record the requested video. None of those
steps is claimed by this compatibility assessment.
