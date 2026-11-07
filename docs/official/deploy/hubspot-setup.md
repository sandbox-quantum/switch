# HubSpot connector setup

HubSpot's remote MCP server requires a manually created MCP Connector. It
does not offer dynamic client registration. The Switch entry uses a static
OAuth client and the standard HubSpot MCP server, with PKCE handled by Switch.

## Configure HubSpot

1. Use a HubSpot account on the new Developer Platform.
2. In the account, open **Development > MCP Connectors** and create a
   connector for Switch.
3. Set its redirect URL to the callback for this Core deployment:
   `{GATEWAY_PUBLIC_URL}/gateway/service-connections/hubspot/flows/callback`.
   The value must match exactly, including the scheme and path.
4. Save the connector and copy its client ID and client secret from its
   details page.
5. In Switch's operator **Connector apps** settings, add those values for
   HubSpot. For a file-based deployment, set
   `HUBSPOT_CLIENT_CONFIG_PATH` to a JSON file containing only `client_id` and
   `client_secret`.

## Connect an account

Enable `FEATURE_FLAGS_ENABLED=service_connections`. In Switch Console, connect
HubSpot and choose read-only CRM access or write access only when needed. The
HubSpot consent screen chooses permissions at installation time; it does not
use a fixed scope list on the connector configuration page. HubSpot requires
an account administrator to connect once before other account users can
connect.

HubSpot documents 30-minute access tokens and single-use refresh-token
rotation. Switch renews tokens automatically. Disconnecting uses the
authorization server's advertised revocation endpoint when available.
