import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const plugin = definePlugin(
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    description: 'GitHub Copilot CLI with ACP sessions, model selection and tool approvals.',
    websiteUrl: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server',
    cliLabel: 'GitHub Copilot CLI',
  },
  {
    autoApprove: { kind: 'supported' },
    effort: { kind: 'none' },
    hostDependency: {
      id: 'copilot',
      binaryNames: ['copilot'],
      installCommands: {
        macos: [{ method: 'npm', command: 'npm install -g @github/copilot' }],
        linux: [{ method: 'npm', command: 'npm install -g @github/copilot' }],
        windows: [{ method: 'npm', command: 'npm install -g @github/copilot' }],
      },
      updates: {
        kind: 'supported',
        releaseSource: { kind: 'none' },
        update: { kind: 'package-manager' },
      },
    },
    mcp: { kind: 'none' },
    models: { kind: 'none' },
    plugins: { kind: 'none' },
    prompt: { kind: 'none' },
    sessions: { kind: 'resumable' },
    repoAgents: { kind: 'none' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('GitHub Copilot CLI runs through the ACP session host.');
    },
  },
});
