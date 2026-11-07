import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const AMP_INSTALL_COMMAND = 'curl -fsSL https://ampcode.com/install.sh | bash';
const AMP_NPM_INSTALL = 'npm install -g @ampcode/cli';

export const plugin = definePlugin(
  {
    id: 'amp',
    name: 'Amp',
    description:
      "Sourcegraph's coding agent, run through its CLI in execute mode with Switch deciding every tool call, its Dial modes as the model choice, and threads that resume.",
    websiteUrl: 'https://ampcode.com/docs/cli',
    cliLabel: 'Amp CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'amp',
      binaryNames: ['amp'],
      versionArgs: ['version'],
      installCommands: {
        macos: [
          { method: 'curl', command: AMP_INSTALL_COMMAND, recommended: true },
          { method: 'npm', command: AMP_NPM_INSTALL },
        ],
        linux: [
          { method: 'curl', command: AMP_INSTALL_COMMAND, recommended: true },
          { method: 'npm', command: AMP_NPM_INSTALL },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'npm',
          package: '@ampcode/cli',
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

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('Amp runs through the session host.');
    },
  },
});
