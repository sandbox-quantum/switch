# Install Switch Console

_Install the desktop app that will help you set up and manage Switch_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/install-switch-console> — link readers there, not to this file.

import { BuddyGuide } from "/snippets/chat-message.jsx";

<BuddyGuide>
  Your team may already use Switch in its messaging app. If it does, you might not need to install anything. [Start here](index.md) helps you check.
</BuddyGuide>

Switch Console is the desktop app you set Switch up in and run your [agents](../resources/glossary.md#agent) from. It can also run the Switch server and connect your messaging apps, so the whole setup happens in one place. You don't have to decide anything before you install it.

## Download Switch Console

Each link below downloads the current release for your platform. To pick a different build or an older release, browse [all releases](https://github.com/sandbox-quantum/switch/releases).

| Platform | Download |
| :-- | :-- |
| macOS, Apple silicon | [`.dmg`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-arm64.dmg) |
| macOS, Intel | [`.dmg`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-x64.dmg) |
| Windows, x64 — **early access** | [`.exe`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-x64.exe) or [`.msi`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-x64.msi) |
| Linux, x86\_64 — **early access** | [`.AppImage`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-x86_64.AppImage), [`.deb`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-amd64.deb), or [`.rpm`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-x86_64.rpm) |
| Linux, arm64 — **early access** | [`.AppImage`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-arm64.AppImage), [`.deb`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-arm64.deb), or [`.rpm`](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-aarch64.rpm) |

**Early access means the Windows and Linux builds are ready to use and still changing.** Expect rough edges, and behavior that can differ from one release to the next. When you hit one, [open an issue](https://github.com/sandbox-quantum/switch/issues). Reports help get them fixed sooner.

Both macOS builds are `.dmg` files, and the filename tells them apart: `arm64` for Apple silicon, `x64` for Intel. Not sure which Mac you have? Open the Apple menu and choose **About This Mac**: it shows an Apple chip, such as M1, or an Intel processor.

## Install Switch Console

### macOS

Open the downloaded `.dmg` and drag **Switch Console** into your **Applications** folder.

macOS builds are signed and notarized, so the app opens without a Gatekeeper prompt.

### Windows

Run the downloaded `.exe`, choose an install location if you want one other than the default, and finish the installer.

The `.msi` is there if you deploy with `msiexec` instead of running the installer.

### Linux

Install the format your distribution uses.

Debian and Ubuntu:

```bash
sudo apt install ./switch-console-amd64.deb
```

Fedora and RHEL:

```bash
sudo dnf install ./switch-console-x86_64.rpm
```

The AppImage needs no install step. Make it executable and run it:

```bash
chmod +x switch-console-x86_64.AppImage
./switch-console-x86_64.AppImage
```

Use `apt install ./file.deb` rather than `dpkg -i`, so the app's dependencies are resolved. On Ubuntu, prefer the `.deb`: the AppImage needs FUSE 2, and 24.04 and later can stop it from running.

On arm64 the filenames differ: `switch-console-arm64.deb`, `switch-console-aarch64.rpm`, and `switch-console-arm64.AppImage`. An asset for the wrong architecture doesn't fail cleanly, so check before you install.

**Note**

On Linux, [Running Switch Console on Linux](../resources/troubleshooting.md#running-switch-console-on-linux) covers the problems found so far and how to work around them.

Switch Console checks for new releases in the background and tells you when one is available. It downloads nothing until you accept, then installs the update the next time you quit. Quitting stops any agents running on this computer.

On a server your team deployed, a new Switch Console can require a newer server. If something stops working after an update, see [Connecting to a server](../resources/troubleshooting.md#connecting-to-a-server).

## Open Switch Console

Open Switch Console, and after the short intro, select **Get started**. Then follow the guide that matches why you're here:

- **Setting Switch up for the first time:** Continue with [Set up Switch](quickstart.md).
- **Joining a team that already uses Switch:** Continue with [Bring your own agent](add-your-agent-to-your-team.md).

## Next steps

- [Set up Switch](quickstart.md) — Start Switch on this computer and give switch-buddy its first task

- [Bring your own agent](add-your-agent-to-your-team.md) — Connect to the Switch server your team already runs
