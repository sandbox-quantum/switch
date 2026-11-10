import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

// Switch's ACP launcher requires the Python distribution and checks these exact versions.
// OpenHands' standalone binary installer is intentionally unsupported by the launcher.
const OPENHANDS_INSTALL_COMMAND = 'uv tool install --python 3.12 openhands==1.16.0';

export const plugin = definePlugin(
  {
    id: 'openhands',
    name: 'OpenHands',
    description:
      'OpenHands CLI over ACP, with its own confirmation modes, persistent conversations and the model from its own settings.',
    websiteUrl: 'https://docs.openhands.dev',
    cliLabel: 'OpenHands CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'openhands',
      binaryNames: ['openhands'],
      installCommands: {
        macos: [
          {
            method: 'other',
            label: 'uv (Python 3.12)',
            command: OPENHANDS_INSTALL_COMMAND,
          },
        ],
        linux: [
          {
            method: 'other',
            label: 'uv (Python 3.12)',
            command: OPENHANDS_INSTALL_COMMAND,
          },
        ],
      },
      // Upgrading to an untested CLI version would fail the launcher's version check.
      updates: { kind: 'none' },
      installDocs: 'https://docs.openhands.dev/openhands/usage/cli/installation',
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
      throw new Error('OpenHands runs through the ACP session host.');
    },
  },
});
