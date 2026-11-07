# ClickUp: unavailable connection

ClickUp remains a disabled catalog placeholder under the
[maintainer's corrected decision](https://github.com/sandbox-quantum/switch/issues/836#issuecomment-6650763832).
It cannot connect, receive agent grants or expose tools. No skill is shipped.

## Evidence, checked 2026-11-08

- [Official MCP guide](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server):
  server `https://mcp.clickup.com/mcp`.
- [Authorization metadata](https://mcp.clickup.com/.well-known/oauth-authorization-server):
  authorization-code flow, registration at `https://mcp.clickup.com/oauth/register`,
  public-client authentication (`none`), PKCE S256, scopes `read` and `write`,
  and only `authorization_code` in the advertised grants. No refresh grant or
  revocation endpoint is advertised. Advertising registration is not a tested DCR flow.
- [Resource metadata](https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp):
  the MCP resource above, authorization server `https://mcp.clickup.com`, and
  the same scopes. These are not `task:read` / `task:write`.
- ClickUp's [API authentication guide](https://developer.clickup.com/docs/authentication)
  and [FAQ](https://developer.clickup.com/docs/faq) document non-expiring OAuth
  access tokens. That API documentation is not direct measurement of every
  MCP-issued token response.

Only anonymous metadata GETs were performed. No client registration, token
exchange, refresh, identity lookup, tool call or authenticated session was tested.
An unadvertised revocation endpoint does not prove that vendor revocation is
impossible; disconnect behavior remains unverified. Public scope names do not
establish read-only enforcement.

## Why Switch keeps it disabled

The [connection policy](../design/service-connections-v2.md#tokens) bounds the
lifetime of credentials handed to agents. Active OAuth entries require a finite
`token.max_lifetime` and rotating/reusable refresh. A local cache timeout cannot
shorten the vendor credential's lifetime. Neither invented expiry nor
`refresh: none` is an acceptable workaround; shared OAuth code is unchanged.

Before enablement, establish actual expiring, renewable MCP tokens compatible
with that policy, then verify registration/callbacks, identity, granted scopes,
read-only mutation denial, refresh, disconnect and grant removal in a running
session. Add a complete entry and skill only after those gates and maintainer
review. No working-connector demo is claimed by this placeholder.

## Recheck without credentials

```sh
curl --fail --silent --show-error \
  https://mcp.clickup.com/.well-known/oauth-authorization-server
curl --fail --silent --show-error \
  https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp
```

Expect JSON matching the metadata above; network failure is unverified evidence,
not a failed authenticated test. Metadata may change after this dated snapshot.
