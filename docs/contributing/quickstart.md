# Contributor quickstart: clone to first reply

Run Core from your checkout, connect Switch Console, get a real agent reply,
then make a small change. First-time downloads determine setup time; this is
a short walkthrough, not a promise of a five-minute installation.

**Switch changes fast.** If a command or screen differs, ask in the
[issue tracker](https://github.com/sandbox-quantum/switch/issues), including
your OS, `git rev-parse HEAD`, the failing step and its error. Remove secrets.

## Choose the execution environment

Use bash on Linux or macOS for Core. On Windows 11, use **Ubuntu in WSL2**
with Docker Desktop's integration enabled for that distribution. Clone into
the Linux filesystem, for example under `~/src`, rather than reusing a Windows
checkout. Native Windows Core currently imports the Unix-only `resource`
module; Git Bash does not solve that failure.

Run Console on your desktop. On Windows, build it in a **separate Windows
checkout of the same commit**, using Windows Node/pnpm and a Windows provider
CLI. Keep Python environments and `node_modules` separate across the two OSes.
