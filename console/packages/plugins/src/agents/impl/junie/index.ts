import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/** JetBrains' installers for Junie CLI, which serves ACP as `junie --acp=true`. */
export const JUNIE_INSTALL_UNIX = 'curl -fsSL https://junie.jetbrains.com/install.sh | bash';
/** Written without `$` or `%`, as Antigravity's is: the install runner's shell may be PowerShell or cmd.exe. */
export const JUNIE_INSTALL_WINDOWS =
  'powershell -NoProfile -Command "iex (irm \'https://junie.jetbrains.com/install.ps1\')"';

export const plugin = definePlugin(
  {
    id: 'junie',
    name: 'Junie',
    description:
      "JetBrains' Junie CLI over ACP, with its own sign-in, approvals and persistent conversations.",
    websiteUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
    cliLabel: 'Junie CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'junie',
      binaryNames: ['junie'],
      installDocs: 'https://junie.jetbrains.com/docs/junie-cli.html',
      installCommands: {
        macos: [{ method: 'curl', command: JUNIE_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'curl', command: JUNIE_INSTALL_UNIX, recommended: true }],
        windows: [{ method: 'powershell', command: JUNIE_INSTALL_WINDOWS, recommended: true }],
      },
      // Junie stages and applies its own updates.
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'auto',
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

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('Junie runs through the ACP session host.');
    },
  },
});
