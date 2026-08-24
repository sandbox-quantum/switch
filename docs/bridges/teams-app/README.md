# Agent Switch — Teams app package

The three files beside this one are a complete Microsoft Teams app package.
Zip them, upload the zip, and the Switch bot exists in your tenant with the
Switch name, icons and command menu already set.

- `manifest.json` — the app definition
- `color.png` — 192×192 full-colour icon
- `outline.png` — 32×32 white-on-transparent icon for the Teams app bar

Teams reads icons from inside the package; a manifest cannot point at an image
URL. That is why they are committed here rather than described.

## Use it

**1. Replace the placeholders.**

| Placeholder | Replace with |
| --- | --- |
| `00000000-0000-0000-0000-000000000000` (3 places: `id`, `bots[0].botId`, `webApplicationInfo.id`) | Your Azure Bot's app id — the `app_id` from [TEAMS_SETUP.md §1.1](../TEAMS_SETUP.md#11-app-registration). The same value in all three. |
| `switch.example.com` in `validDomains` | The host of your `public_base_url` |
| `https://example.com/privacy` and `https://example.com/terms` | Your organisation's privacy policy and terms. Teams does not check them on upload, so leaving these installs fine and then tells your users the app has no privacy policy. |

**2. Decide about the `authorization` block.** It asks for resource-specific
consent to read channel messages and settings, scoped to the team the app is
installed in. **Delete it** unless you are taking that route — if you granted
tenant-wide Graph permissions in Entra instead, it asks every team owner to
consent to something the deployment does not use. See
[§1.4](../TEAMS_SETUP.md#14-graph-api-permissions) for the two routes.

**3. Zip the three files flat**, from this directory:

```bash
zip -j agent-switch-teams.zip manifest.json color.png outline.png
```

`-j` matters. The three files must sit at the root of the zip — Teams rejects a
package whose contents are inside a folder.

**4. Upload it**, as described in
[TEAMS_SETUP.md §1.6](../TEAMS_SETUP.md#16-teams-app-package).

## Changing it later

A manifest edit only reaches an installed app if you **raise `version`** and
upload again. Teams matches on `id`, so the same `id` with a higher `version`
replaces the app rather than adding a second one. Leave `version` alone and
nothing happens, silently.

Never change `id` after the app is installed: Teams would treat the upload as a
different app.

## What the manifest asks for

- **Scopes** `team`, `personal` and `groupChat` — Switch bridges channels, 1:1
  chats and group chats.
- **`commandLists`** — the ten commands Teams offers in the bot's menu. Each
  title carries its `/` because Teams types the title verbatim and prepends
  nothing; without it the command arrives as an ordinary message. The menu is
  presentation only, so a command missing here still works if someone types it.
  Ten is the platform's limit per scope, not ours; `!help` lists them all.
- **`authorization.permissions.resourceSpecific`** — the resource-specific
  consent route for reading channel messages and channel settings, scoped to
  the team the app is installed in. Delete it if you granted tenant-wide Graph
  permissions in Entra instead; see
  [§1.4](../TEAMS_SETUP.md#14-graph-api-permissions) for the two routes.
- **`supportsFiles: false`** — Switch does not yet relay files inbound from
  Teams, and says so on the message rather than dropping them quietly.

## Where the icons came from

`color.png` is the Switch Console app icon's mark and palette, redrawn as a
flat 192×192 square: Teams masks the corners itself, so a package icon must not
round its own. `outline.png` is the same mark in white on transparency, which
is what the Teams app bar expects. Both derive from
`gateway/public/switch_logo_light.svg`.

The Azure Bot resource carries its **own** icon, separately from this package.
Set it there too, or the bot shows a default avatar in some surfaces.
