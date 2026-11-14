import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  npmDependency,
  opencodeMcpAdapter,
} from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';
import { opencodeLaunchProfileModels } from './models';
import {
  opencodeLaunchProfile,
  opencodeLaunchProfileSettings,
  opencodeProfilePaths,
} from './profile';

const validateSessionId = (id: string) => id.startsWith('ses');

/**
 * OpenCode, installed into the user prefix on Linux.
 *
 * npm's default global prefix there is a system directory, so `npm install -g`
 * needs root — which the user a remote agent runs as typically does not have,
 * and the install fails with EACCES. `$HOME/.local` needs no root, and
 * `$HOME/.local/bin` is already on the PATH Switch Console captures for a
 * remote host, so the binary is found afterwards without further wiring.
 *
 * macOS and Windows keep the plain global install: their default prefixes are
 * user-writable, and changing them would strand anyone who already has it.
 */
/**
 * OpenCode 2 is a different package (`@opencode/cli`, formerly `opencode-ai`)
 * that owns the same `opencode` command, so npm will not install it over 1.x:
 * updating 1.x removes it first, and puts the same version back if OpenCode 2
 * does not install. Sign-ins, settings and saved sessions carry over, since
 * OpenCode 2 reads what 1.x left.
 */
const OPENCODE_2 = '2.0.0';

const OPENCODE_2_SUMMARY =
  'Your sign-ins, opencode.json, agents, commands, skills and saved sessions carry over, and agents resume their conversations. The opencode command in your terminal becomes OpenCode 2 too. Sessions already running keep the version they started with until they stop. If OpenCode 2 does not install, this version is put back.';

const OPENCODE_HOST_DEPENDENCY = (() => {
  const base = npmDependency({ id: 'opencode', package: '@opencode/cli' });

  // Uninstall must target both the current package (@opencode/cli) and the
  // legacy name (opencode-ai) that Console used to install. Users may have
  // either one; npm silently skips whichever isn't present.
  const patchUninstall = (options: typeof base.installCommands.macos) =>
    options?.map((opt) => ({
      ...opt,
      ...(opt.uninstallCommand ? { uninstallCommand: opt.uninstallCommand + ' opencode-ai' } : {}),
      ...(opt.method === 'npm'
        ? {
            lineMigration: {
              below: OPENCODE_2,
              removeCommand: 'npm uninstall -g opencode-ai',
              restoreCommand: 'npm install -g opencode-ai@{version}',
              summary: OPENCODE_2_SUMMARY,
            },
          }
        : {}),
    }));

  return {
    ...base,
    installCommands: {
      macos: patchUninstall(base.installCommands.macos),
      windows: patchUninstall(base.installCommands.windows),
      linux: [
        {
          method: 'npm' as const,
          command: 'npm install -g --prefix "$HOME/.local" @opencode/cli',
          uninstallCommand: 'npm uninstall -g --prefix "$HOME/.local" @opencode/cli opencode-ai',
          recommended: true,
          // 1.x may sit in either prefix. Removing it from the system one needs
          // write access there; without it the upgrade stops before changing anything.
          lineMigration: {
            below: OPENCODE_2,
            removeCommand:
              'npm uninstall -g opencode-ai && npm uninstall -g --prefix "$HOME/.local" opencode-ai',
            restoreCommand: 'npm install -g --prefix "$HOME/.local" opencode-ai@{version}',
            summary: OPENCODE_2_SUMMARY,
          },
        },
      ],
    },
  };
})();

export const plugin = definePlugin(
  {
    id: 'opencode',
    name: 'OpenCode',
    description:
      'OpenCode CLI that interfaces with models for code generation and edits from the shell.',
    websiteUrl: 'https://opencode.ai/docs/cli/',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: OPENCODE_HOST_DEPENDENCY,
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
    },
    models: {
      kind: 'none',
    },
    plugins: {
      kind: 'none',
    },
    prompt: {
      kind: 'argv',
      flag: '--prompt',
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
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        extraEnv: ctx.autoApprove ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {},
        // Approves every ask but keeps what the person's own config denies.
        autoModeFlag: '--auto',
        initialPromptFlag: '--prompt',
        resumeFlag: '--session',
        sessionIdFlag: '--session',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--continue',
        validateSessionId,
      }),
  },
  sessions: { validateSessionId },
  mcp: {
    ...opencodeMcpAdapter(),
    // The profile carries per-agent model / variant / sampling / instructions in
    // a config file under `~/.config/opencode/switch`, loaded with
    // `OPENCODE_CONFIG` because OpenCode has no flag that would load it. It
    // registers no MCP server: the session host supplies the Switch one to each
    // session it starts.
    launchProfile: opencodeLaunchProfile,
    launchProfilePaths: opencodeProfilePaths,
    launchProfileSettings: opencodeLaunchProfileSettings,
    // A variant is whatever the chosen model declares, so the only correct list
    // is the one the installed OpenCode reports. Asking also lets a typed model
    // be checked, which matters because OpenCode accepts an unknown one in
    // silence and only fails when the agent tries to answer.
    launchProfileModels: opencodeLaunchProfileModels,
  },
});
