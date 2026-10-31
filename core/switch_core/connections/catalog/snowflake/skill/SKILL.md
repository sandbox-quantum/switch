---
name: snowflake
description: Query Snowflake data through the owner's configured Cortex MCP server.
---

# Snowflake

Use the Snowflake MCP tools to answer questions about data and Cortex agents in
the connected account. The tools available depend on the MCP server configured
by the Snowflake administrator.

Work safely:

- Read the available tool descriptions and relevant schemas before querying.
- Prefer read-only queries and a least-privileged default role. For read-only
  access, the Snowflake admin should restrict the OAuth integration to a
  read-only role and disable secondary roles; the Switch grant does not make
  SQL tools read-only. Keep query scope narrow because queries can incur
  compute costs.
- Do not create, alter, or otherwise write data unless the user explicitly asks.
- Before deleting data, changing access, or closing a resource, explain the
  impact and get the user's confirmation.
- Tool annotations are hints, not access controls. Snowflake role grants and
  the configured MCP server determine what an operation can actually do.
- If an operation is not available or the role does not allow it, say so rather
  than attempting an administrative workaround.
