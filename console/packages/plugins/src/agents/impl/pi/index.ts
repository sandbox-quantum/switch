import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

const PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * Pi from npm (it needs Node 22.19 or later). On Linux it goes into the user
 * prefix, as OpenCode does: npm's default global prefix there needs root,
 * which the user a remote agent runs as rarely has.
 */
const PI_HOST_DEPENDENCY = (() => {
  const base = npmDependency({ id: 'pi', package: PACKAGE });
  return {
    ...base,
    installCommands: {
      ...base.installCommands,
      linux: [
        {
          method: 'npm' as const,
          command: `npm install -g --prefix "$HOME/.local" ${PACKAGE}`,
          uninstallCommand: `npm uninstall -g --prefix "$HOME/.local" ${PACKAGE}`,
          recommended: true,
        },
      ],
    },
  };
})();

export const plugin = definePlugin(
  {
    id: 'pi',
    name: 'Pi',
    description:
      'Pi, the open-source coding agent that works with many model providers, driven over its RPC mode.',
    websiteUrl: 'https://pi.dev',
    cliLabel: 'Pi coding agent',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: PI_HOST_DEPENDENCY,
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
      throw new Error('Pi runs through the session host.');
    },
  },
});
