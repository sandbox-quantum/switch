import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/** Factory's installers for `droid`, from https://docs.factory.com/droid-cli/quickstart. */
export const DROID_INSTALL_UNIX = 'curl -fsSL https://app.factory.ai/cli | sh';
/** Written without `$` or `%`, which the install runner's shell would expand. */
export const DROID_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "irm https://app.factory.ai/cli/windows | iex"';

export const plugin = definePlugin(
  {
    id: 'factory-droid',
    name: 'Factory Droid',
    description:
      "Factory's coding agent CLI over ACP, with its autonomy levels, a choice of models and persistent sessions.",
    websiteUrl: 'https://docs.factory.com/droid-cli/overview',
    cliLabel: 'Factory Droid (droid)',
    // Without a login or a key, starting a session requests a device-pairing
    // sign-in, so models are listed only once the sign-in check passes.
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
      id: 'factory-droid',
      binaryNames: ['droid'],
      installDocs: 'https://docs.factory.com/droid-cli/quickstart',
      installCommands: {
        macos: [{ method: 'curl', command: DROID_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'curl', command: DROID_INSTALL_UNIX, recommended: true }],
        windows: [{ method: 'powershell', command: DROID_INSTALL_WINDOWS, recommended: true }],
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
      throw new Error('Factory Droid runs through the ACP session host.');
    },
  },
});
