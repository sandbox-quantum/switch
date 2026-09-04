# Install Switch Console

_Install the desktop app that will help you set up and manage Switch_

Published at <https://docs.flintai.dev/flintai/switch/getting-started/install-switch-console> — link readers there, not to this file.

Switch Console is the desktop app that guides you through setting up Switch. If you haven't already, review [Setting up Switch](index.md) to decide where your server will run and prepare the connections you'll need.

**Note**

If someone has already added you to a Switch room, you don't need to install or set up Switch yourself. Jump to [Meet Switch](../using/index.md) to learn how a room works and how to work in it.

## Download Switch Console

Download the latest release from [sandbox-quantum/switch](https://github.com/sandbox-quantum/switch/releases), then install Switch Console for your operating system.

| Platform | Download |
| :-- | :-- |
| macOS, Apple silicon | `.dmg` or `.zip` |
| macOS, Intel | `.dmg` or `.zip` |
| Windows, x64 | `.exe` or `.msi` |
| Linux, x86\_64 | `.deb`, `.AppImage`, or `.rpm` |
| Linux, arm64 | `.deb`, `.AppImage`, or `.rpm` |

The two macOS downloads are built separately, and the filename is what tells them apart: `arm64` for Apple silicon, `x64` for Intel.

## Open Switch Console

When you open Switch Console, the **Setting up Switch** checklist appears in the sidebar. It reflects your setup's current state—it doesn't track which pages you've read or which buttons you've clicked.

Some steps may already be complete. That’s normal. For example, **Set up agent providers** is complete when Switch detects a **Switch connector** in an **agent provider** — the application that runs an agent on your machine. The connector lets Switch communicate with the provider and may have been installed before Switch Console.

The checklist isn't a strict sequence. Each step checks a separate setup requirement, so steps can complete in any order.

**Tip**

The checklist highlights only the first unfinished step. Use the sidebar to open the setup area for another step when needed.

When every step is complete, the checklist tells you:

> **All set! You can now start collaborating with your agents!**

## Next steps

- [Add a server](add-a-server.md) — Give your rooms and agents somewhere to run
