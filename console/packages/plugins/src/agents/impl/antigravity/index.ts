import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';
import { ANTIGRAVITY_INSTALL_COMMAND } from './install';

export const plugin = definePlugin(
  {
    id: 'antigravity',
    name: 'Antigravity',
    description:
      'Google Antigravity ACP with native authentication, approvals and persistent conversations.',
    websiteUrl: 'https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp',
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
      binaryNames: ['antigravity-acp'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: ANTIGRAVITY_INSTALL_COMMAND,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: ANTIGRAVITY_INSTALL_COMMAND,
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
  sessions: {
    configFields: () => [
      {
        key: 'model',
        label: 'Model',
        type: 'text',
        catalogue: { kind: 'model' },
        help: 'Used for new sessions. Leave blank to use the Antigravity default.',
      },
    ],
  },
  prompt: {
    buildCommand: () => {
      throw new Error('Antigravity runs through the ACP session host.');
    },
  },
});
