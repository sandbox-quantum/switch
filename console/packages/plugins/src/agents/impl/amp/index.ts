import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

/**
 * Amp, via the community `amp-acp` bridge. Amp itself has no native ACP; the
 * bridge speaks ACP v1 over stdio and drives the Amp CLI. The Amp CLI must
 * also be installed and signed in (`amp login` or `AMP_API_KEY`).
 *
 * On Linux, install into the user prefix so a remote agent user needs no root
 * (same pattern as OpenCode).
 */
const AMP_HOST_DEPENDENCY = (() => {
  const base = npmDependency({
    id: 'amp',
    package: 'amp-acp',
    binaryNames: ['amp-acp'],
    versionSuffix: '@0.12.0',
    // amp-acp --version prints nothing useful; presence on PATH is enough.
    skipVersionProbe: true,
    installDocs: 'https://ampcode.com/manual#get-started',
  });
  return {
    ...base,
    installCommands: {
      ...base.installCommands,
      linux: [
        {
          method: 'npm' as const,
          command: 'npm install -g --prefix "$HOME/.local" amp-acp@0.12.0',
          uninstallCommand: 'npm uninstall -g --prefix "$HOME/.local" amp-acp',
          recommended: true,
        },
      ],
    },
  };
})();

export const plugin = definePlugin(
  {
    id: 'amp',
    name: 'Amp',
    description:
      "Sourcegraph's Amp coding agent, via amp-acp: native sessions, approvals and deep-reasoning modes.",
    websiteUrl: 'https://ampcode.com/docs/sdk',
    cliLabel: 'Amp',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: AMP_HOST_DEPENDENCY,
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
      throw new Error('Amp runs through the ACP session host.');
    },
  },
});
