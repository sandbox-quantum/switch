import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import type { HostDependencyDescriptor } from '@switch-console/core/deps';
import { icon } from './icon';

const GROK_INSTALL_COMMAND = 'curl -fsSL https://x.ai/cli/install.sh | bash';
const GROK_WINDOWS_INSTALL_COMMAND = 'irm https://x.ai/cli/install.ps1 | iex';

const grokBuildHostDependency: HostDependencyDescriptor = {
  id: 'grok-build',
  binaryNames: ['grok'],
  installDocs: 'https://docs.x.ai/build/overview',
  installCommands: {
    macos: [
      {
        method: 'curl',
        command: GROK_INSTALL_COMMAND,
        updateCommand: GROK_INSTALL_COMMAND,
      },
    ],
    linux: [
      {
        method: 'curl',
        command: GROK_INSTALL_COMMAND,
        updateCommand: GROK_INSTALL_COMMAND,
      },
    ],
    windows: [
      {
        method: 'powershell',
        command: GROK_WINDOWS_INSTALL_COMMAND,
        updateCommand: GROK_WINDOWS_INSTALL_COMMAND,
      },
    ],
  },
  updates: {
    kind: 'supported',
    releaseSource: { kind: 'none' },
    update: { kind: 'package-manager' },
  },
};

export const plugin = definePlugin(
  {
    id: 'grok-build',
    name: 'Grok Build',
    description: 'xAI coding agent for project-aware assistance and code changes.',
    websiteUrl: 'https://x.ai/cli',
    cliLabel: 'Grok Build CLI',
    sessionStartMaySignIn: true,
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: grokBuildHostDependency,
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
      throw new Error('Grok Build runs through the ACP session host.');
    },
  },
});
