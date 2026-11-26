# Asana on a self-hosted server

Agents can read and update tasks, projects and comments in their owners'
Asana workspace once the server's operator registers an Asana MCP app. Each
person then connects their own Asana account from Switch Console and turns
Asana on for the agents they choose.

Without the app, Asana is listed on the server as not set up.

## What you need

- An **Asana account** to own the app. Use one that belongs to the
  organization: deleting the app revokes every connection on the server.
- The server's **`GATEWAY_PUBLIC_URL`**.

## Register the app

In Asana's developer console (`https://app.asana.com/0/my-apps`), create an
app and choose **MCP** as its type. Asana's MCP server has no dynamic client
registration, so this registration is the only way in.

1. **Redirect URLs**: add both, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/asana/flows/callback
   http://127.0.0.1:39231/switch-services/callback
   ```
   The second is for signing in from Switch Console.
2. **Distribution**: choose the workspaces whose members will connect. A
   person outside them is refused at sign-in.
3. Copy the **client ID** and **client secret**.

MCP apps have no scopes to choose. The consent page asks to read and to
create and modify tasks, projects and comments, so every connection can write.

## Give Switch the client

Under **Connector apps**, choose **Set up Asana** and paste the client ID and
secret. Or save them as `{"client_id": "...", "client_secret": "..."}` in a
file named by `ASANA_CLIENT_CONFIG_PATH` (Helm: `switchCore.asanaClientSecret`).

Switch cannot check the client: Asana refuses a made-up code the same way
whatever is wrong with the client ID, secret or redirect URL. Connect once to
confirm.
