import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/** Amp's installer, from https://ampcode.com/docs/cli; `amp update` updates what it installs. */
export const AMP_INSTALL_UNIX = 'curl -fsSL https://ampcode.com/install.sh | bash';

export const plugin = definePlugin(
  {
    id: 'amp',
    name: 'Amp',
    description:
      "Amp's coding agent CLI in execute mode, with its mode dial for the model and threads that persist on ampcode.com.",
    websiteUrl: 'https://ampcode.com/docs/cli',
    cliLabel: 'Amp CLI',
    // Starting a session creates its thread, which signs a signed-out Amp in.
    sessionStartMaySignIn: true,
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
      installDocs: 'https://ampcode.com/docs/cli',
      installCommands: {
        macos: [{ method: 'curl', command: AMP_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'curl', command: AMP_INSTALL_UNIX, recommended: true }],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
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
