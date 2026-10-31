# BigQuery on a self-hosted server

Agents can query and explore BigQuery datasets and tables through their owners'
Google accounts once the server's operator registers a Google Cloud OAuth app.
Each person then connects their Google account from Switch Console and turns
BigQuery on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under BigQuery.

Without the app, BigQuery is listed on the server as "BigQuery is not set up on
this server. Ask whoever runs your Switch server to add it under Connectors in
the Switch dashboard."

## What you need

- A **Google Cloud project** where the BigQuery API (`bigquery.googleapis.com`)
  is enabled.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  Google sends each sign-in back to it. It must be `https://`, or
  `http://localhost:<port>` for a server on your own computer, which Google
  accepts for testing.
- An account with permission to create OAuth credentials in the Google Cloud
  console.

## Register the OAuth app

1. **Enable the API**: In the Google Cloud Console, navigate to **APIs &
   Services > Library**, search for **BigQuery API**, and enable it. Or:
   ```bash
   gcloud services enable bigquery.googleapis.com --project <project-id>
   ```
2. **Configure the OAuth Consent Screen**: Under **Google Auth Platform >
   Branding**, set the app name and user support email. Set the audience to
   **Internal** (for organization members only) or **External** (if testing or
   offering to accounts outside a Google Workspace organization).
3. **Add Scopes**: Add the following scopes to the consent screen:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/bigquery`
4. **Create a Web Client**: Under **Google Auth Platform > Clients**, select
   **Create Client**, choose **Web application**, and add the authorized
   redirect URI:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/bigquery/flows/callback
   ```
   for example
   `https://switch.example.com/gateway/service-connections/bigquery/flows/callback`.
5. **Download Credentials**: Copy the generated **Client ID** and **Client
   Secret**.

## Internal or External

The consent screen's audience decides who can connect, and what Google asks of
the app first. Switch cannot tell which a client is, and works with either.

- **Internal**: only people in your Google Workspace organization can connect.
  Google does not review the app, and refresh tokens last until revoked.
  This is the one to choose when everyone who connects is in the organization.
- **External**: anyone with a Google account can connect, but while the app is in
  "Testing" publishing status, only designated test users can connect, and Google expires
  refresh tokens after 7 days, requiring weekly re-authentication. Production
  verification is required for persistent access across external accounts.

## User IAM permissions

For agents to run queries and read datasets on behalf of their owners, the
connected Google account must have sufficient BigQuery IAM roles in Google
Cloud:
- **`roles/mcp.toolUser`** to invoke Google Cloud's remote Model Context Protocol endpoint.
- **`roles/bigquery.jobUser`** (or permissions including
  `bigquery.jobs.create`) to run query jobs billed to the project.
- **`roles/bigquery.dataViewer`** on the target datasets and tables to query
  them with `execute_sql_readonly`.
- **`roles/bigquery.dataEditor`** or **`roles/bigquery.admin`** only if the user
  intends to permit data modification statements via `execute_sql`.

## Configure Switch

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors**. Choose **Set up
BigQuery** and enter the **Client ID** and **Client Secret**.

Alternatively, on a headless or self-hosted deployment without the dashboard,
set `BIGQUERY_CLIENT_CONFIG_PATH` in the server environment pointing to a JSON
file containing:
```json
{
  "client_id": "<your-client-id>.apps.googleusercontent.com",
  "client_secret": "<your-client-secret>"
}
```
