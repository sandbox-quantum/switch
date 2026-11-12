import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

export const JUNIE_INSTALL_COMMAND = 'curl -fsSL https://junie.jetbrains.com/install.sh | bash';
export const JUNIE_INSTALL_COMMAND_WINDOWS =
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm \'https://junie.jetbrains.com/install.ps1\')"';
const JUNIE_NPM_INSTALL = 'npm install -g @jetbrains/junie';

export const plugin = definePlugin(
  {
    id: 'junie',
    name: 'Junie',
    description:
      "JetBrains' coding agent, run through its CLI over ACP with native approvals, model choice and saved conversations.",
    websiteUrl: 'https://junie.jetbrains.com/docs/junie-cli-acp.html',
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
      installCommands: {
        macos: [
          { method: 'curl', command: JUNIE_INSTALL_COMMAND, recommended: true },
          { method: 'homebrew', command: 'brew tap jetbrains-junie/junie && brew install junie' },
          { method: 'npm', command: JUNIE_NPM_INSTALL },
        ],
        linux: [
          { method: 'curl', command: JUNIE_INSTALL_COMMAND, recommended: true },
          { method: 'npm', command: JUNIE_NPM_INSTALL },
        ],
        windows: [
          { method: 'powershell', command: JUNIE_INSTALL_COMMAND_WINDOWS, recommended: true },
          { method: 'npm', command: JUNIE_NPM_INSTALL },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        // `junie update` downloads the next version, applied at the next start.
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
      throw new Error('Junie runs through the ACP session host.');
    },
  },
});
