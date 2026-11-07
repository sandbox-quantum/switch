import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

const PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * Pi from npm, installed into the user prefix on Linux, as OpenCode is:
 * npm's default global prefix there is a system directory, which the user a
 * headless agent controller runs as often cannot write to, and Switch Console
 * and the agent controller both look for CLIs in `$HOME/.local/bin`. macOS
 * and Windows keep the plain global install, whose prefixes are the user's.
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
      'Minimal, extensible open-source coding agent that runs on the model provider you sign it in to.',
    websiteUrl: 'https://pi.dev',
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
      throw new Error('Pi runs through the session host, over its RPC mode.');
    },
  },
});
