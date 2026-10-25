# Asana operator setup

Use the standard server `https://mcp.asana.com/v2/mcp`, not the separately licensed
Command endpoint. Asana requires a pre-registered **MCP app**, with no dynamic
client registration. A standard API app or PAT is not a verified substitute.

1. Create an app in the [developer console](https://app.asana.com/0/my-apps), choosing
   **Asana MCP**.
2. Under OAuth, register the exact callback:
   `http://127.0.0.1:39231/switch-services/callback`.
   Console owns this existing loopback host and path; the catalog fixes the port.
3. Under Manage distribution, select the workspaces allowed to authorize the app.
   Choosing Specific workspaces with an empty list prevents sign-in. Use synthetic
   tasks in a disposable workspace during development.
4. Save the app under Admin -> Connector apps, or create a private JSON file with
   only `client_id` and `client_secret`, and set `ASANA_CLIENT_CONFIG_PATH` to its
   absolute path in Core's process environment. File configuration takes precedence.
   Keep this file outside source control, restrict access, and never copy it into
   an agent's working folder.
5. Enable `FEATURE_FLAGS_ENABLED=service_connections`, start Core with these settings,
   and connect Asana from Switch Console's Connections. A local `just` run can load
   the config-file path from `.env`; directly launched processes need the environment
   variable set explicitly.

## Permissions and lifecycle

Asana MCP permits every available tool within the user's existing permissions.
It does not document granular read-only MCP consent. Switch omits `scope`, records
read/write consent, and offers grants on or off. It does not invent narrower scopes.
Read before updates, review bulk changes, and confirm destructive actions.

Asana documents one-hour access tokens and a long-lived refresh token. Core renews
the sign-in through the generic OAuth adapter. Disconnecting revokes the refresh
sign-in, which Asana documents as deauthorizing associated bearer tokens.

## Known limits

- Asana answers a token it no longer accepts (revoked, or replaced by a reconnect)
  with a tool error, `{"error": "unauthorized"}`, rather than HTTP 401. The session
  host asks Switch for a new token only on a 401, so a session that already holds
  the old token keeps failing until that token's issue expires (at most an hour)
  or the agents controller restarts. Normal hourly renewal is not affected.
- Advanced task search (`search_tasks`) needs a paid Asana plan. The skill falls
  back to the basic task and project tools on a free plan.

## References

- [MCP registration and lifecycle](https://developers.asana.com/docs/integrating-with-asanas-mcp-server)
- [Tools and permissions](https://developers.asana.com/docs/mcp-tools-reference)
- [OAuth](https://developers.asana.com/docs/oauth)
