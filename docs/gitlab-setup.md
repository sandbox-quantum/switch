# GitLab connector setup

This connector uses GitLab.com's official remote MCP server at
`https://gitlab.com/api/v4/mcp`. Enable Switch service connections with
`FEATURE_FLAGS_ENABLED=service_connections`. A GitLab top-level group owner
must [allow MCP access](https://docs.gitlab.com/user/model_context_protocol/mcp_server/#prerequisites).
Individual tools can require additional permissions or paid features.

The operator creates a confidential
[GitLab OAuth application](https://docs.gitlab.com/integration/oauth_provider/)
with the scopes `mcp read_api read_user api`. Register the exact HTTPS callback
shown by Switch's dashboard under Connector apps for GitLab:
`<GATEWAY_PUBLIC_URL>/gateway/service-connections/gitlab/flows/callback`.
`GATEWAY_PUBLIC_URL` must be the public HTTPS base URL of Core.

Save the application's ID and secret under Connector apps in the dashboard.
Alternatively, set `GITLAB_CLIENT_CONFIG_PATH` to an operator-owned JSON file
containing only `client_id` and `client_secret`. Keep that file outside the
repository, readable only by the Core process. File configuration takes
precedence over saved settings. Without a configured app, Console reports that
the service needs server setup.

Static registration follows the
[maintainer's instruction on #816](https://github.com/sandbox-quantum/switch/issues/816#issuecomment-6546340077).
The registration probe reported in that discussion returned only `mcp` and
the authorization-code grant even when additional scopes and refresh were
requested. This implementation does not claim to have repeated that probe.

People connect from Switch Console's Connections page and choose read or
write consent. Read requests `mcp read_api read_user`; write requests
`mcp api read_user`. Identity comes from `/api/v4/user` using the stable numeric
`id` and the `username` label. GitLab documents `read_api` as read access and
`api` as complete read/write API access, including all accessible groups and
projects. There is no project picker or narrower general write scope here.
The `mcp` scope is required by the MCP endpoint. Tools are passed through,
so the tool list itself does not enforce read-only access.

Core discovers OAuth endpoints and requires PKCE S256. GitLab
[documents](https://docs.gitlab.com/api/oauth2/) rotating refresh and a default
two-hour access lifetime; the catalog caps pass-through lifetime at 7200
seconds. Core handles renewal and calls the discovered revocation endpoint
when disconnecting. A missing refresh token prevents sign-in. People can
also revoke the application in GitLab under Access, Applications.

This entry supports GitLab.com only. Self-managed deployments need an
administrator to enable MCP, a compatible GitLab version, and an application
registered on that instance. Their MCP, identity and OAuth hosts differ;
support needs a separate catalog entry or a future host configuration feature.
Changing a callback alone does not make this entry reach another host.

## Verification still required

Automated tests use synthetic OAuth responses and do not prove GitLab's
runtime enforcement. Before production use, verify both consent levels with
a disposable project, especially that write calls fail with read consent:
`mcp` is itself a capability, so REST scope documentation alone is insufficient
proof of the MCP boundary. Do not infer authorization from tool annotations.

Live QA must also cover Console connect, grant to an agent, room tool use,
automatic renewal in an active session, grant removal stopping access within
a minute, disconnect and vendor revocation, and absence of authentication
material from transcripts, rooms and logs. Record the issue's requested
connect → grant → tool use → grant-off video using disposable data.
