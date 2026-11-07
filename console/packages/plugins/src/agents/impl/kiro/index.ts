import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/** Kiro's installer, which puts `kiro-cli` in `~/.local/bin`. */
export const KIRO_INSTALL_UNIX = 'curl -fsSL https://cli.kiro.dev/install | bash';

export const plugin = definePlugin(
  {
    id: 'kiro',
    name: 'Kiro',
    description:
      "AWS's Kiro agent CLI over ACP, with Kiro's models, its credit-based plans and persistent sessions.",
    websiteUrl: 'https://kiro.dev/docs/cli/acp/',
    cliLabel: 'Kiro CLI (kiro-cli acp)',
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
      installDocs: 'https://kiro.dev/docs/cli/setup/',
      installCommands: {
        macos: [{ method: 'curl', command: KIRO_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'curl', command: KIRO_INSTALL_UNIX, recommended: true }],
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
      throw new Error('Kiro runs through the ACP session host.');
    },
  },
});
