# Azure DevOps connector app

One Microsoft Entra app registration serves every Switch server. Create it
under <https://entra.microsoft.com> (or the Azure portal, Microsoft Entra
ID, App registrations):

1. **Accounts:** "Accounts in any organizational directory" (multi-tenant).
   Single-tenant registrations are rejected with `AADSTS50194` at the
   organizations endpoint. The remote MCP server needs an Entra-backed
   Azure DevOps organization; standalone Microsoft-account organizations
   are not supported.
2. **Redirect:** add a **Mobile and desktop applications** platform with
   `http://localhost` (any port is accepted there, RFC 8252) and, for a
   hosted Core, a **Web** platform with
   `<GATEWAY_PUBLIC_URL>/gateway/service-connections/azure-devops/flows/callback`.
3. **Permissions (delegated, Azure DevOps MCP):** request `Ado.Mcp.Tools`,
   documented by Microsoft as
   `api://2a72489c-aab2-4b65-b93a-a91edccf33b8/Ado.Mcp.Tools` in the
   [user-delegation guide](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-user-delegation).
   The connection also requests `offline_access` for refresh and `openid`.
   This provisional entry offers one honestly labelled write-capable level:
   granular read/write scope enforcement has not been verified. Do not add
   guessed scopes or use `.default` to bypass that check. Grant admin consent
   where tenant policy requires it. Confirm actual consent and MCP/profile
   access during live QA before claiming the connection works.
4. **Public client:** enable "Allow public client flows"; the app has no
   client secret (PKCE only).
5. Save the client ID in Admin > Connector apps > Azure DevOps, or name a JSON
   file in `AZURE_DEVOPS_CLIENT_CONFIG_PATH`.

Sign-in goes through the multi-tenant `organizations` endpoint, so the
first user from each new tenant sees the admin-consent requirement.
Disconnect removes consent under the user's Microsoft account or the
tenant's Enterprise applications; Entra has no token revocation endpoint.

The server URL is `https://mcp.dev.azure.com` with the organization named
per tool call. Guest (B2B) users of an org cannot use the root URL
(Microsoft documents this); they are out of scope for this connector.

## Validation limits

This candidate has no real-tenant demo. Automated checks use fake vendor
responses and do not establish app registration, admin consent, the token
audience accepted by the profile API, hosted MCP tools, scope enforcement,
natural expiry/refresh, reconnect or vendor-side removal. The profile API
identity mapping remains provisional pending live verification. Do not call
these checks passed from the automated suite.
