import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import type { HostDependencyDescriptor } from '@switch-console/core/deps';
import { icon } from './icon';

/** Installed from npm. Augment supports Windows only inside WSL, so no Windows install is offered. */
function auggieHostDependency(): HostDependencyDescriptor {
  const { installCommands, ...descriptor } = npmDependency({
    id: 'auggie',
    package: '@augmentcode/auggie',
    installDocs: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
  });
  return {
    ...descriptor,
    installCommands: { macos: installCommands.macos, linux: installCommands.linux },
  };
}

export const plugin = definePlugin(
  {
    id: 'auggie',
    name: 'Auggie',
    description:
      "Augment Code's CLI agent, with a context engine that indexes the agent's working directory.",
    websiteUrl: 'https://docs.augmentcode.com/cli/acp/agent',
    cliLabel: 'Auggie CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: auggieHostDependency(),
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
      throw new Error('Auggie runs through the ACP session host.');
    },
  },
});
