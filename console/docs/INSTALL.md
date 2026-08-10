# Installing Switch Console

Switch Console is distributed as a desktop app through **GitHub Releases on this
repository** (`sandbox-quantum/switch`). The repo is private, so the release
downloads are automatically limited to people with repo-read access — there is
no separate sign-up or allowlist. No need to build from source.

> Builds are currently **macOS arm64** (Apple Silicon) and **Linux x64**.
> Windows is not built yet.

## Download

### Option A — browser (simplest)

1. Make sure you're signed in to GitHub with read access to
   `sandbox-quantum/switch`.
2. Open the repo's **[Releases](https://github.com/sandbox-quantum/switch/releases)**
   page.
3. Find the latest release titled **`Switch Console <version>`** (tag
   `switch-console-v<version>`).
4. Under **Assets**, download the file for your platform — `.dmg` on macOS, or
   one of `.AppImage` / `.deb` / `.rpm` on Linux.

If you don't have repo access the assets return a 404 — ask in the Switch
Workforce hub to be added as a repo reader.

### Option B — command line

```bash
# Latest Switch Console release (requires `gh auth login` with repo access):
gh release list --repo sandbox-quantum/switch | grep switch-console-v

# Download the installer from a specific release (macOS):
gh release download switch-console-v<version> \
  --repo sandbox-quantum/switch \
  --pattern '*.dmg'

# Linux — pick the format your distro uses:
gh release download switch-console-v<version> \
  --repo sandbox-quantum/switch \
  --pattern '*.AppImage'   # or '*.deb' / '*.rpm'
```

> A plain `curl` of the asset URL will **not** work — private-repo release
> assets require authentication (a browser session or a `gh`/GitHub token).

## Install (macOS)

1. Open the downloaded `.dmg`.
2. Drag **Switch Console** into your **Applications** folder.

### First launch — one-time Gatekeeper bypass

These builds are **unsigned** (no Apple Developer certificate), so macOS
Gatekeeper blocks the first launch. Clear it once, either way:

- **Right-click → Open**: right-click (or Control-click) Switch Console in
  Applications, choose **Open**, then confirm **Open** in the dialog. macOS
  remembers the choice for future launches.
- **Or via Terminal**:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Switch Console.app"
  ```

After that, launch Switch Console normally.

## Install (Linux x64)

Linux builds are **unsigned**. Pick the format your distro uses:

- **AppImage** — no install step; make it executable and run it:

  ```bash
  chmod +x switch-console-x86_64.AppImage
  ./switch-console-x86_64.AppImage
  ```

- **Debian / Ubuntu** (`.deb`):

  ```bash
  sudo apt install ./switch-console-amd64.deb
  ```

- **Fedora / RHEL** (`.rpm`):

  ```bash
  sudo dnf install ./switch-console-x86_64.rpm
  ```

> The app does not yet set a `desktopName`, so desktop environments may not
> associate its windows with the installed `.desktop` entry (the icon can appear
> as a duplicate or generic entry in the taskbar). Tracked under CHOO-1905.

## Updating

Switch Console checks this repo's Releases for new versions in-app. Because the repo
is private, the updater authenticates using the **GitHub CLI token you already
have** — no extra login inside the app:

1. Make sure the [`gh` CLI](https://cli.github.com) is installed and you've run
   `gh auth login` once.
2. Switch Console reads your token via `gh auth token` and offers the update when
   one is available (Settings → checks automatically; you can also recheck
   manually).

If `gh` isn't installed or you're not logged in, the app shows
"Sign in to GitHub to enable updates" and stays on the current version — you can
always grab a newer build manually from the
[Releases page](https://github.com/sandbox-quantum/switch/releases) and
re-install (drag over the old app).

## Notes

- Release **asset filenames are prefixed `switch-console-`** (e.g.
  `switch-console-arm64.dmg`). The macOS app id still reads `com.switchdash.*`,
  which is deliberate — it is what carries update continuity for copies
  installed before the rename, and no user sees it.
- **Upgrading a Linux install from a pre-rename build:** `apt` and `dnf` see
  `switch-console` as a new package rather than an upgrade of `switchdash`, so
  remove the old one yourself (`sudo apt remove switchdash`) or the two sit
  side by side.
- Switch Console releases use the `switch-console-v*` tag prefix and are published with
  the repo-wide "Latest" badge **off**, so they never collide with other release
  streams in this repo.
