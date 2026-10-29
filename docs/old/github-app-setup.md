# GitHub on a self-hosted server

People connect their GitHub account through a GitHub App the server's
operator creates, and grant agents repositories of the App's installations.
An agent's token is an installation token for exactly the repositories
granted, acting as the App, and lasts at most an hour. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md).

Without the App, GitHub is listed on the server as "GitHub is not set up on
this server. Whoever runs your Switch server can set it up in Switch Console,
under Admin → Connector apps."

## What you need

- The server's **`GATEWAY_PUBLIC_URL`**, an `https://` address, or a loopback
  `http://` one (`localhost`, `127.0.0.1` or `::1`) on a server only its own
  computer reaches, such as one Switch Console runs: GitHub sends each sign-in
  back to it, and to no other `http://` address.
- A GitHub account or organization to own the App. An App owned by an
  organization keeps working when the person who created it leaves.

## Create the App

In GitHub: Settings, Developer settings, GitHub Apps, **New GitHub App** (for
an organization, under the organization's settings).

1. **Callback URL**:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/provider-connections/github/callback
   ```
   for example
   `https://switch.example.com/gateway/provider-connections/github/callback`.
2. Turn on **Expire user authorization tokens**. Switch keeps each person's
   sign-in fresh with its refresh token, and refuses a sign-in that does not
   expire.
3. Under **Repository permissions**, set **Contents** and **Pull requests** to
   **Read and write** (Metadata is read-only, and always on). These are the
   most an agent's token can carry, as the catalog's `github` entry lists them;
   a read grant asks for read only. With them at **Read-only**, agents can
   read through the App and not write: a write grant on it is refused.
4. Choose who can install it: only this account, or any account if people
   will install it on their own organizations.
5. Create the App. On its settings page, **generate a client secret** and
   **generate a private key** (a `.pem` file, downloaded once).

## Give Switch the App

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up GitHub**. The dialog shows the
callback URL to register, with a copy button. Paste the App's **Client ID**
and **Client secret**, and choose the **Private key** file; it is read in your
browser and never shown. Then choose **Check and save**.

Switch asks GitHub first: it signs a request with the private key as the App
named by the client ID, which proves the two belong to one App and tells
Switch the App's name, so you never type it, and its repository permissions;
and it tells a right client secret from a wrong one. Nothing is saved unless
GitHub accepts all three and the App has Contents and Pull requests at least
at Read-only. An App with them at Read-only is saved read-only: the check
says so, the card says "Agents can read only", and agents can be granted
reading and not writing, until the App has Read and write. Switch keeps what
GitHub answered, and **Check it works** asks again, so after changing the
App's permissions at GitHub, check it to have Switch follow. Whether each
account that installed the App has accepted a change to its permissions is
GitHub's to show, on the installation's page.
The secret and the key are stored encrypted, like every other stored
credential (see [key rotation](key-rotation.md)), and the App is in use at
once: nobody needs to restart anything. The card then shows the key's
fingerprint, which matches the one GitHub lists under the App's private keys,
and the App's install link to share.

People install the App on the accounts and repositories it may reach, then
connect GitHub from Switch Console.

## Rotating the secret or the key

Generate a new client secret or private key in the App's settings, then choose
**Update secret or private key** on the card and enter only what changed.
Nobody is disconnected: sign-ins belong to the App, not to its secret, and
tokens already issued stay valid until they expire, within the hour. Once the
card shows the new key's fingerprint, delete the old key at GitHub.

## Replacing the App

**Use a different app** sets up another App, with another client ID. Everyone
connected through the current App must connect again, and choose their
repositories again too, since a grant names the old App's installations. The
dialog says how many people in how many workspaces that is before anything
changes, and their connections show as needing reconnection. Tokens already
handed to agents stay valid at GitHub for up to an hour; if the old App's
secret or key leaked, delete it at GitHub as well.

**Remove** leaves GitHub not set up: nobody can connect it, and the people
connected lose it until an App is set up again. They can still disconnect.

## Or, from configuration

The App can be set in the server's configuration instead:

- `GITHUB_APP_CONFIG_PATH`: a JSON file with `client_id`, `client_secret`,
  `slug` (the App's name in its URL) and `origin` (the address GitHub calls
  back, https or loopback http; normally `GATEWAY_PUBLIC_URL`);
- `GITHUB_APP_PRIVATE_KEY_PATH`: the private key's `.pem`, by absolute path.

With Helm, `switchCore.githubConnectionsSecret` holds `github.json`, and
`switchCore.githubAppPrivateKeyPath` names the key inside a mounted Secret.
The two are set together or not at all, and set but unusable, switch-core
does not start. Switch does not ask GitHub about a configured App before
using it, so it takes the App to have the permissions of step 3: without
them, a write grant fails at its first token rather than being refused.

**Configuration wins**: while it is set, Switch uses it, an App saved in the
dashboard is ignored (switch-core says so at startup, and so does the card),
and saving from the dashboard is refused. The deprecated
`HOSTED_GITHUB_CONFIG_PATH` counts as configuration too; it names no private
key, so GitHub can be connected but not granted, and it can't be copied into
Switch. Unset it, restart, and set the App up from the dashboard instead.

To move a configured App into the dashboard, choose **Manage it here
instead** on its card: **Copy into Switch** saves the configured values with
nothing retyped, then remove the two variables (or the two Helm values) and
restart switch-core. It is the same App, so nobody reconnects. Copying is
refused while the file's `origin` differs from `GATEWAY_PUBLIC_URL`, since a
saved App is called back at `GATEWAY_PUBLIC_URL`.

## Several replicas

Sign-ins in progress are kept in the database, and a change to the App
reaches every switch-core replica within seconds; one that misses the news
finds it within half a minute. Keep query strings out of every access log
in front of the callback: its URL carries a single-use OAuth code.
