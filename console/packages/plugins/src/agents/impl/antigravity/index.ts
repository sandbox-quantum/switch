import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/** Google's installers for the Antigravity CLI, `agy`, which serves ACP as `agy acp`. */
export const AGY_INSTALL_UNIX = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
/**
 * Written without `$` or `%`: the install runner's shell may be PowerShell or
 * cmd.exe, and each would expand one of them before `powershell -c` ran. It
 * installs `agy.exe` into `%LOCALAPPDATA%\agy\bin`.
 */
export const AGY_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "irm https://antigravity.google/cli/install.ps1 | iex"';
export const AGY_INSTALL_WINDOWS_CMD =
  'curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd';

export const plugin = definePlugin(
  {
    id: 'antigravity',
    name: 'Antigravity',
    description:
      'Google Antigravity CLI over ACP, with its own sign-in, approvals and persistent conversations.',
    websiteUrl: 'https://antigravity.google/docs/ide/extensions/acp/',
    cliLabel: 'Antigravity CLI (agy)',
    sessionStartMaySignIn: true,
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'antigravity',
      // `agy` first; `antigravity-acp` is the runtime Switch Console installed
      // before Google's CLI served ACP, still run where it is all there is.
      binaryNames: ['agy', 'antigravity-acp'],
      installDocs: 'https://antigravity.google/docs/install?tab=cli',
      installCommands: {
        macos: [{ method: 'curl', command: AGY_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'curl', command: AGY_INSTALL_UNIX, recommended: true }],
        windows: [
          {
            method: 'powershell',
            command: AGY_INSTALL_WINDOWS,
            recommended: true,
          },
          { method: 'curl', label: 'Command Prompt', command: AGY_INSTALL_WINDOWS_CMD },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'cli',
          args: ['update'],
        },
      },
    },
    mcp: {
      kind: 'none',
    },
    models: {
      kind: 'none',
    },
    plugins: {
      kind: 'none',
    },
    prompt: {
      kind: 'none',
    },
    sessions: {
      kind: 'resumable',
    },
    repoAgents: { kind: 'none' },
  },
  { icon }
);

/**
 * How the Antigravity CLI at `binaryPath` updates. agy updates itself; the
 * legacy `antigravity-acp` launcher takes no update command, so updating it
 * installs agy with Google's installer, which then takes over. That launcher
 * was only ever installed on macOS and Linux.
 */
export function antigravityUpdateCommand(binaryPath: string): { command: string; args: string[] } {
  const name = binaryPath.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase();
  return name.startsWith('antigravity-acp')
    ? { command: 'bash', args: ['-c', AGY_INSTALL_UNIX] }
    : { command: binaryPath, args: ['update'] };
}

export const provider = registerPluginBehavior(plugin, {
  hostDependency: { buildUpdateCommand: antigravityUpdateCommand },
  prompt: {
    buildCommand: () => {
      throw new Error('Antigravity runs through the ACP session host.');
    },
  },
});
