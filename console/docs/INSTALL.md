# Installing Switch Console

Switch Console is distributed as a desktop app through **GitHub Releases on this
repository** (`sandbox-quantum/switch`). The repo is public, so the downloads
need no account, token or sign-up. No need to build from source.

> Builds are currently **macOS arm64 (Apple Silicon) and x64 (Intel)**, **Linux
> x64 and arm64** and **Windows x64**. Windows builds are not code signed — see
> [Install (Windows x64)](#install-windows-x64).

## Download

### Option A — browser (simplest)

1. Open the repo's **[Releases](https://github.com/sandbox-quantum/switch/releases)**
   page.
2. Find the latest release titled **`Switch Console <version>`** (tag
   `switch-console-v<version>`).
3. Under **Assets**, download the file for your platform — `.dmg` on macOS, one
   of `.AppImage` / `.deb` / `.rpm` on Linux, or `.exe` on Windows (a `.msi` is
   also published if you deploy that way).

### Option B — command line

Release assets are public, so a plain `curl` works — no token, no `gh`:

```bash
# Download an installer from a specific release (macOS — Apple Silicon):
curl -fLO https://github.com/sandbox-quantum/switch/releases/download/switch-console-v<version>/switch-console-arm64.dmg
# macOS on Intel:
curl -fLO https://github.com/sandbox-quantum/switch/releases/download/switch-console-v<version>/switch-console-x64.dmg

# Linux — pick the format your distro uses:
curl -fLO https://github.com/sandbox-quantum/switch/releases/download/switch-console-v<version>/switch-console-x86_64.AppImage

# Windows:
curl -fLO https://github.com/sandbox-quantum/switch/releases/download/switch-console-v<version>/switch-console-x64.exe
```

With the [`gh` CLI](https://cli.github.com), if you prefer it:

```bash
gh release list --repo sandbox-quantum/switch | grep switch-console-v
gh release download switch-console-v<version> \
  --repo sandbox-quantum/switch \
  --pattern '*.dmg'
```

## Install (macOS)

Two `.dmg` files are published — take the one matching your Mac:

| Mac | Asset |
| --- | --- |
| Apple Silicon (M1 and later) | `switch-console-arm64.dmg` |
| Intel | `switch-console-x64.dmg` |

Apple menu → **About This Mac** names the chip if you are unsure; `uname -m`
prints `arm64` or `x86_64`.

1. Open the downloaded `.dmg`.
2. Drag **Switch Console** into your **Applications** folder.

Tagged macOS releases are signed and notarized with SandboxAQ's Developer ID, so
they open without a Gatekeeper bypass. Both architectures receive in-app updates,
each one offered its own build.

## Install (Linux)

Linux builds are **unsigned**. First check which arch you are on — the assets
carry it in the filename, and each packager reports it differently:

```bash
dpkg --print-architecture     # amd64 | arm64
```

An asset for the wrong arch does not fail cleanly. `apt` reports every
dependency as "not installable" (including core ones like `libuuid1`), which
reads like a broken package list rather than an arch mismatch.

Pick the format your distro uses:

- **AppImage** — no install step; make it executable and run it:

  ```bash
  chmod +x switch-console-x86_64.AppImage      # arm64: switch-console-arm64.AppImage
  ./switch-console-x86_64.AppImage
  ```

  On Ubuntu 22.04+ the AppImage needs FUSE 2 (`sudo apt install libfuse2`), and
  on 24.04+ AppArmor's restriction on unprivileged user namespaces can break
  Electron's sandbox. The `.deb` has neither problem — it installs
  `chrome-sandbox` correctly — so prefer it on Ubuntu.

- **Debian / Ubuntu** (`.deb`):

  ```bash
  sudo apt install ./switch-console-amd64.deb  # arm64: switch-console-arm64.deb
  ```

  Use `apt install ./file.deb` rather than `dpkg -i`, so the Electron runtime
  dependencies get resolved.

- **Fedora / RHEL** (`.rpm`):

  ```bash
  sudo dnf install ./switch-console-x86_64.rpm # arm64: switch-console-aarch64.rpm
  ```

> The app does not yet set a `desktopName`, so desktop environments may not
> associate its windows with the installed `.desktop` entry (the icon can appear
> as a duplicate or generic entry in the taskbar).

## Install (Windows x64)

1. Run the downloaded `switch-console-x64.exe`.
2. Choose an install location if you want a non-default one, and finish the
   installer.

### Code signing

Windows builds from **0.27.2** onwards are Authenticode signed, via Azure Trusted
Signing, as `SandboxAQ`. The installer no longer trips the blue **"Windows
protected your PC"** SmartScreen prompt, and AppLocker / WDAC policies that block
unsigned binaries no longer refuse it outright (CHOO-1468).

Two caveats:

- **0.27.1 and earlier are unsigned.** They still show the SmartScreen prompt —
  click **More info**, then **Run anyway** — and managed Windows may refuse them.
  Installing a current version is the fix.
- SmartScreen also weighs a certificate's reputation, so a brand-new one can
  still warn on early downloads. That fades as installs accumulate; it is not a
  sign the signature is missing. To check one yourself: right-click the `.exe` →
  **Properties** → **Digital Signatures**.

The `.msi` supports the usual `msiexec` flow if you would rather not run the
installer interactively.

### Docker-backed features are not available on Windows

Switch Console can manage a local or remote Switch server through Docker. That
path is **macOS/Linux only** — Docker CLI discovery does not resolve
`docker.exe` on Windows. Connecting to a Switch server that is already running
elsewhere is unaffected.

Windows support is new and less exercised than the other platforms; please report
anything that misbehaves.

## Updating

Switch Console checks this repo's Releases for new versions in-app and offers the
update when one is available — no sign-in of any kind. Settings checks
automatically; you can also recheck manually.

You can always grab a newer build manually from the
[Releases page](https://github.com/sandbox-quantum/switch/releases) and
re-install (drag over the old app).

## Building from source

Only needed for a platform with no published artifact. Requires the Node version
in `console/.nvmrc` and the pinned pnpm, plus `build-essential`, `python3` (for
the native modules) and `rpm` if you want the `.rpm` target. Budget ~10 GB free
disk: Electron's download plus the unpacked tree are several GB.

```bash
git clone https://github.com/sandbox-quantum/switch.git
cd switch/console
pnpm install
pnpm run build                                       # workspace packages, then the app
pnpm --filter @switch-console/desktop run rebuild    # native modules for THIS machine
cd apps/switch-console-desktop
pnpm run package:linux          # or package:linux:arm64 / package:mac / package:mac:x64 / package:win
```

The first two steps are not optional. Packaging from the app directory alone
fails at the renderer with `Failed to resolve entry for package
"@switch-console/shared"` — the workspace packages publish a `dist/` that has
not been built yet. And because `npmRebuild` is off, skipping the rebuild ships
whatever native binaries happen to be in `node_modules`.

Artifacts land in `console/apps/switch-console-desktop/release/`.

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
