# BigQuery on a self-hosted server

Agents can inspect BigQuery datasets and run read-only queries by default.
An agent can run the write-capable `execute_sql` tool only when its owner
explicitly grants the write level. Google IAM permissions still determine
which projects, datasets and jobs the connected Google identity can access.

Switch connects to Google's official BigQuery remote MCP server at
`https://bigquery.googleapis.com/mcp`. Enable service connections with
`FEATURE_FLAGS_ENABLED=service_connections`.

## What the Google Cloud administrator sets up

1. Choose a Google Cloud project and enable the BigQuery API. Google's BigQuery
   MCP server is available when the API is enabled. The BigQuery sandbox can
   be used for testing without enabling billing.
2. Grant the Google identity that will connect the following roles on the
   project, or verified custom roles containing the required permissions:
   - `roles/mcp.toolUser` to make MCP tool calls;
   - `roles/bigquery.jobUser` to run query jobs;
   - `roles/bigquery.dataViewer` to read BigQuery data.
3. Create an OAuth client in Google Auth Platform. BigQuery uses static OAuth
   registration. A separate client and consent screen from Google Workspace
   are recommended so that the two connections request access independently.
   The same Web client can be deliberately configured for both.
4. Add this exact authorized redirect URI to the OAuth client:

   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/bigquery/flows/callback
   ```

   The public server URL must use HTTPS. For local development, Google permits
   localhost redirect URIs over HTTP.
5. In Switch Console, open **Admin → Connector apps**, select **Set up
   BigQuery**, enter the OAuth client ID and secret, and save. Or configure
   `BIGQUERY_CLIENT_CONFIG_PATH` to a JSON file containing `client_id` and
   `client_secret`.

The connection uses Google's BigQuery OAuth scope and OpenID/email scopes for
the account identity. Google documents the BigQuery MCP scope as
`https://www.googleapis.com/auth/bigquery`; it can read and manage BigQuery
data, so OAuth scopes do not create the read-only boundary. Switch's read
grant excludes `execute_sql` from the agent's available tools. The write grant
includes it. IAM remains an additional boundary, not a substitute for the
Switch tool restriction.

## Query costs and limits

BigQuery queries may incur charges. The BigQuery MCP server's
`execute_sql_readonly` tool permits read-only SQL and rejects DML, DDL and
Python UDFs; `execute_sql` is the only non-read-only MCP tool. Query responses
are limited to 3,000 rows and queries are cancelled after three minutes.

SQL `LIMIT` limits returned rows but does not reduce bytes scanned. Inspect
table metadata before querying, select only needed columns, and filter on
partition columns when available. Ask for confirmation before write queries
and before queries that may scan a large amount of data.

To turn the connector off, use **Admin → Connectors**. To stop new
connections on this server, remove BigQuery under **Admin → Connector apps**
or unset `BIGQUERY_CLIENT_CONFIG_PATH`.
