# HubSpot on a self-hosted server

Agents can read and update HubSpot contacts, companies and deals in their
owners' HubSpot accounts once the server's operator creates a HubSpot MCP
connector. Each person then connects their own HubSpot account from Switch
Console and turns HubSpot on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Adding a connector.

Without the connector, HubSpot is listed on the server as not set up.

## What you need

- A **HubSpot account** to own the MCP connector, on HubSpot's current
  Developer Platform. Use one that belongs to the organization rather than
  to one person: whoever owns the connector can edit or delete it, and
  deleting it stops every connection on the server.
- The server's **`GATEWAY_PUBLIC_URL`**, if sign-ins should come back to
  Switch over the server's own address. Without it, only the loopback
  redirect (Switch Console's own listener) is registered.

## Create the MCP connector

In HubSpot, open **Development**, then **MCP Connectors**, then **Create MCP
connector**:

1. **Name** it as people should see it, for example "Switch".
2. **Redirect URLs**: register every one of these, exactly, port included:
   ```
   http://127.0.0.1:39241/switch-services/callback
   http://127.0.0.1:39242/switch-services/callback
   http://127.0.0.1:39243/switch-services/callback
   http://127.0.0.1:39244/switch-services/callback
   http://127.0.0.1:39245/switch-services/callback
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/hubspot/flows/callback
   ```
   Leave the last one out where the server has no public URL. HubSpot sends
   people back only to a registered URL, matched exactly, so if the public
   URL changes, change it here too, or sign-ins fail.
3. Create the connector. On its details page, copy the **Client ID** and the
   **Client secret**; HubSpot shows the secret once.

HubSpot does not let the operator define the connector's scopes when creating
the app. The consent page offers granular optional permissions based on the
server's tools and the person's account. For a contact-read demo, select None
under Optional, then only "View properties and other details about contacts",
leaving required account metadata selected. Do not select All, writes,
publishing or an upgrade for this demo. Check availability in the actual
account; a paid feature's disabled permission is not proof that core contact
read is unavailable.

Switch does not send a scope parameter for this unscoped connector. The entry
is conservatively write-capable, not a Switch-enforced read-only level. The
person's actual vendor consent still limits access. Account identity comes
from the root integer user and account fields returned by `get_user_details`;
the adapter accepts explicit case/snake spellings and rejects missing or
ambiguous IDs, without falling back to a configured account.

## Give Switch the client

In Switch Console, open **Admin > Connector apps > HubSpot > Set up**. Enter
the connector's Client ID and Client secret directly into Switch's own form.
Keep the secret out of terminals, chat messages, recordings and version control.
Check and save, then inspect the result. HubSpot's measured setup response
`invalid_request` with status `BAD_AUTH_CODE` cannot verify credentials, even
when the secret is wrong. The catalog opts into that exact inconclusive shape:
Switch can save it as unverified, never ready or successfully checked. Definite
client or redirect refusals still fail. Complete a normal sign-in to validate
the unchanged saved client through the real token, identity and broker flow.
A saved configuration is not proof of a completed sign-in or permissions.

Self-hosted operators can also use the documented `HUBSPOT_CLIENT_CONFIG_PATH`
configuration route. That is not a shell-environment workaround for Console's
managed native server, which supplies its own environment. Do not edit the
managed server's generated environment file.

## Free-account eligibility and limits

HubSpot's remote CRM MCP server is generally available to all HubSpot accounts,
and its current documentation explicitly describes free-tool accounts. The
free CRM signup states that no credit card is needed. A paid AI-client
subscription is not a requirement imposed by this custom Switch-client route.
Core CRM tool availability still depends on the account and user permissions;
call `get_user_details` after connecting to inspect the actual access.

This is the remote server at `https://mcp.hubspot.com`, not the local developer
MCP server or HubSpot's credit-bearing Agent Builder. Do not activate paid plans,
trials, credit features or beta revenue tools for a demo. The account owner must
review the applicable Customer and Developer Terms before creating or using it.
Use only authorized synthetic data in a recording, and never show credentials.

Sources, checked November 6, 2026:
- https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available
- https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server
- https://www.hubspot.com/products/crm
- https://legal.hubspot.com/hs-developer-terms

## What people do

1. In Switch Console: Connectors, HubSpot, Connect. The browser
   opens HubSpot; the person picks their HubSpot account, grants the
   permissions, and comes back.
2. They turn HubSpot on for an agent. The agent's HubSpot tools work as that
   person, within the access they granted.

A connection lasts until the person disconnects it or the connector's
owner deletes or revokes it. Disconnecting in Switch stops Switch using the
sign-in at once; HubSpot keeps it authorized until the person uninstalls
Switch under Settings, Integrations, Connected Apps.

## A minimal read check

Inspect `get_user_details`' current schema and request only
`include: ["TOOL_INFORMATION"]` where supported. The default request can also
ask for `USER_INFORMATION`, which was refused with the minimal contact-read
consent during live testing. Check the returned contact READ and search-tool
availability before attempting a CRM read. Do not add user-profile scopes to
fix an unneeded section.
Use `search_crm_objects`' actual schema, limit the read, and keep record values,
account IDs and emails out of a public demo.
