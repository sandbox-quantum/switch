import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * Pi, installed into the user prefix on Linux, for the reason OpenCode is: npm's
 * default global prefix there is a system directory, so `npm install -g` needs
 * root, which the user a remote agent runs as typically does not have.
 * `$HOME/.local/bin` is already on the PATH Switch Console captures for a remote
 * host. macOS and Windows keep the plain global install.
 */
const PI_HOST_DEPENDENCY = (() => {
  const base = npmDependency({ id: 'pi', package: PI_PACKAGE, binaryNames: ['pi'] });
  return {
    ...base,
    installCommands: {
      ...base.installCommands,
      linux: [
        {
          method: 'npm' as const,
          command: `npm install -g --prefix "$HOME/.local" ${PI_PACKAGE}`,
          uninstallCommand: `npm uninstall -g --prefix "$HOME/.local" ${PI_PACKAGE}`,
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
      'Pi, a minimal terminal coding agent that works with many model providers; Switch adds approvals and its room tools.',
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
      throw new Error('Pi runs through the session host.');
    },
  },
});
