# PagerDuty on a self-hosted server

Agents can read their owners' PagerDuty incidents, services, schedules and
on-call, and, with write access, acknowledge, resolve and annotate incidents,
once the server's operator registers a PagerDuty Scoped OAuth app. Each person
then connects their own PagerDuty account from Switch Console and turns
PagerDuty on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under PagerDuty.

Without the app, PagerDuty is listed on the server as not set up.

## What you need

- A **PagerDuty account** to own the app, with a Manager, Global Admin or
  Account Owner role: App Registration is open to those alone. Use an account
  your organization owns; an app can't be moved to another account later.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  PagerDuty sends people back to Switch there; without it, PagerDuty cannot be
  set up.
- Accounts in PagerDuty's **US service region**. EU-region accounts are served
  at other addresses, which Switch does not use yet.

## Register the app

In PagerDuty, open **Integrations**, **Developer Tools**, **App Registration**,
and create a new app:

1. **Name** it as people should see it when PagerDuty asks them to authorize
   it, for example "Switch".
2. Add **OAuth 2.0** functionality and choose **Scoped OAuth**, not Classic
   User OAuth. Classic offers only blanket read or write, and its tokens live
   longer than Switch accepts.
3. **Redirect URL**: the server's callback, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/pagerduty/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
4. **Scopes**: exactly these nine.
   - `users.read`
   - `incidents.read`, `incidents.write`
   - `services.read`
   - `schedules.read`
   - `oncalls.read`
   - `escalation_policies.read`
   - `teams.read`
   - `change_events.read`

   PagerDuty does not refuse a sign-in that asks for a scope the app lacks: it
   hands out a token that holds none of them, and connecting fails. Leave out
   every other write scope: without them PagerDuty refuses agents' attempts to
   change services, schedules, teams, event orchestrations or status pages.
5. **Save**, and copy the app's **Client ID** and **Client Secret**.

The app works at once for people on the PagerDuty account that registered it.
For people on other PagerDuty accounts, PagerDuty must publish the app, and an
admin of each account install it.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Choose
**Set up PagerDuty**. The dialog walks the steps above, with the redirect URL
to copy and the scopes to choose; paste the app's **Client ID** and **Client
Secret** and choose **Check and save**. Switch first asks PagerDuty about the
client, and saves it only if PagerDuty accepts the client ID and secret
together. That cannot show the app's scopes or where it is installed, so
connect once yourself to confirm. The secret is stored encrypted and is in use
at once.

### Or, from configuration

Write the app's client id and secret to a JSON file on the server, readable by
switch-core alone and never committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

Then point switch-core at it with an absolute path and restart it:

```bash
PAGERDUTY_CLIENT_CONFIG_PATH=/etc/switch/pagerduty-client.json
```

While it is set, configuration wins over a client saved in the dashboard.

## What people do

1. In Switch Console: Settings, Connections, PagerDuty, Connect, choosing
   read-only or read and write. The browser opens PagerDuty's authorization
   page and comes back to Switch.
2. On an agent's page, the agent's owner turns PagerDuty on. The agent acts as
   its owner: what it acknowledges, resolves or notes shows in PagerDuty as
   done by them, and it reaches no more than their PagerDuty role allows.

PagerDuty has no way for Switch to revoke a sign-in. When someone disconnects,
Switch forgets the token and tells them to revoke it on the app's page under
Integrations, OAuth Apps; until then it works until it expires, within a day.
An admin can revoke every token the app holds there, or uninstall it.

## Switching it off

Any of these lists PagerDuty as unavailable, with its reason, and stops
agents' next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"pagerduty": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `PAGERDUTY_CLIENT_CONFIG_PATH`, where it is set from configuration.
