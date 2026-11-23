import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const KIRO_INSTALL_COMMAND = 'curl -fsSL https://cli.kiro.dev/install | bash';
/**
 * Kiro's documented Windows install, `irm 'https://cli.kiro.dev/install.ps1' | iex`
 * (https://kiro.dev/docs/getting-started/installation/), run through `powershell -c` so it
 * works from cmd.exe as well as PowerShell. Written without `$` or `%` for the same reason.
 */
export const KIRO_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "irm https://cli.kiro.dev/install.ps1 | iex"';

export const plugin = definePlugin(
  {
    id: 'kiro',
    name: 'AWS Kiro',
    shortName: 'Kiro',
    description:
      "Kiro's agent CLI over ACP, with its own sign-in, model choice, approvals and persistent conversations.",
    websiteUrl: 'https://kiro.dev/docs/cli/acp/',
    cliLabel: 'Kiro CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'kiro',
      binaryNames: ['kiro-cli'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: KIRO_INSTALL_COMMAND,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: KIRO_INSTALL_COMMAND,
          },
        ],
        windows: [
          {
            method: 'powershell',
            command: KIRO_INSTALL_WINDOWS,
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'package-manager',
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
      throw new Error('Kiro CLI runs through the ACP session host.');
    },
  },
});
