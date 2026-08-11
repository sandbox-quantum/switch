import type { DependencyDescriptor } from '@switch-console/core/deps/runtime';

/**
 * `apt-get -y` is not enough to make an install unattended.
 *
 * `-y` answers apt's own questions. It does not reach the hooks apt runs
 * afterwards, each of which has its own frontend and will happily open a dialog
 * on the terminal we attached:
 *
 * - **needrestart** draws a whiptail box ("Pending kernel upgrade", then
 *   "Daemons using outdated libraries") and waits for a keypress. This is not
 *   hypothetical — it is what left `gh` installed but `apt-get` never exiting on
 *   a real host, holding `/var/lib/dpkg/lock-frontend` until it was killed by
 *   hand. Every later install then failed with "Could not get lock", blaming a
 *   lock our own tooling was holding.
 * - **debconf** prompts for package configuration.
 * - **dpkg** prompts when a config file we do not own has changed.
 *
 * Nobody can answer any of those, so all three are silenced rather than left to
 * hang a step forever.
 */
const APT = 'sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get';

function aptInstall(packages: string): string {
  return `${APT} update && ${APT} install -y -o Dpkg::Options::=--force-confold ${packages}`;
}

/**
 * Core host tools a remote host needs to run Switch Console agent sessions: the
 * same binaries the remote-session preflight verifies (tmux, node, git). Unlike
 * agent dependencies (built from the plugin registry), these are static — the
 * plugin system has no notion of host tooling.
 *
 * These are surfaced only on the remote-host management page; the local
 * dependency manager continues to track agent CLIs only. `updates`/`uninstall`
 * are intentionally omitted: Switch Console detects and installs these tools but does
 * not manage their upgrade/removal lifecycle.
 */
export const CORE_DEPENDENCIES: DependencyDescriptor[] = [
  {
    id: 'git',
    name: 'Git',
    category: 'core',
    commands: ['git'],
    versionArgs: ['--version'],
    docUrl: 'https://git-scm.com/downloads',
    installCommands: {
      macos: [{ method: 'homebrew', command: 'brew install git', recommended: true }],
      linux: [
        {
          method: 'apt',
          command: aptInstall('git'),
          recommended: true,
        },
      ],
    },
  },
  {
    id: 'tmux',
    name: 'tmux',
    category: 'core',
    commands: ['tmux'],
    versionArgs: ['-V'],
    docUrl: 'https://github.com/tmux/tmux/wiki/Installing',
    installCommands: {
      macos: [{ method: 'homebrew', command: 'brew install tmux', recommended: true }],
      linux: [
        {
          method: 'apt',
          command: aptInstall('tmux'),
          recommended: true,
        },
      ],
    },
  },
  {
    id: 'node',
    name: 'Node.js',
    category: 'core',
    commands: ['node'],
    versionArgs: ['--version'],
    // The sidecar bundle and the remote-session reachability probe rely on global
    // `fetch` / `AbortSignal.timeout` / optional chaining, stable only from Node 18.
    minVersion: '18.0.0',
    docUrl: 'https://nodejs.org/en/download',
    installCommands: {
      macos: [{ method: 'homebrew', command: 'brew install node', recommended: true }],
      linux: [
        {
          // Distro `apt install nodejs` ships ancient Node on LTS Ubuntu (v12 on
          // 22.04), and NodeSource's package conflicts with a pre-installed distro
          // libnode. Install the official prebuilt LTS tarball into /usr/local
          // instead: no apt repo, no package conflicts, and /usr/local/bin precedes
          // /usr/bin on the default PATH so it wins over any distro node.
          method: 'curl',
          command:
            'set -e; A=$(uname -m); case "$A" in x86_64) A=x64;; aarch64|arm64) A=arm64;; *) echo "unsupported arch $A" >&2; exit 1;; esac; F=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE "node-v22[0-9.]*-linux-$A\\.tar\\.xz" | head -1); curl -fsSL "https://nodejs.org/dist/latest-v22.x/$F" | sudo tar -xJ -C /usr/local --strip-components=1',
          label: 'Official tarball',
          recommended: true,
        },
      ],
    },
  },
];
