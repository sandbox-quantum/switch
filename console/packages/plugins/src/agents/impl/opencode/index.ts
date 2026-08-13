import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  createFileDropPlugin,
  npmDependency,
  opencodeMcpAdapter,
} from '@switch-console/core/agents/plugins/helpers';
import { buildOpencodeHookBehavior } from './hooks';
import { icon } from './icon';
import { OPENCODE_PLUGIN_CONTENT } from './plugin-file';
import { buildOpencodeSwitchConnector } from './switch-connector';

const OPENCODE_PLUGIN_PATH = '.opencode/plugins/switchdash-notifications.js';
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
const OPENCODE_HOST_DEPENDENCY = (() => {
  const base = npmDependency({ id: 'opencode', package: 'opencode-ai' });
  return {
    ...base,
    installCommands: {
      ...base.installCommands,
      linux: [
        {
          method: 'npm' as const,
          command: 'npm install -g --prefix "$HOME/.local" opencode-ai',
          uninstallCommand: 'npm uninstall -g --prefix "$HOME/.local" opencode-ai',
          recommended: true,
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
    hooks: {
      kind: 'plugin',
      scope: 'workspace',
      // 'start' is declared even though OpenCode has no turn-start event: the
      // dropped plugin derives one from a new user message and posts it. Saying
      // so suppresses the synthetic start the hook service would otherwise emit
      // on input-submitted, which would both duplicate this one and miss turns
      // the user starts by typing into the TUI directly.
      //
      // No 'notification': the plugin reports real turn boundaries now, so
      // nothing sends the idle_prompt that used to stand in for them.
      supportedEvents: ['start', 'stop', 'session', 'tool-use', 'tool-done'],
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
      kind: 'file-drop',
      scope: 'workspace',
    },
    prompt: {
      kind: 'argv',
      flag: '--prompt',
    },
    sessions: {
      kind: 'resumable',
    },
    repoAgents: { kind: 'none' },
    // OpenCode has no plugin marketplace to install a connector from — its
    // `plugin` subcommand installs one npm module and has no list, remove or
    // version verb — so Switch Console writes the connector's files itself.
    switchSetup: {
      kind: 'files',
      connectorName: 'Switch connector',
      artifact: 'switch-connector-opencode',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        extraEnv: ctx.autoApprove ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {},
        initialPromptFlag: '--prompt',
        resumeFlag: '--session',
        sessionIdFlag: '--session',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--continue',
        validateSessionId,
      }),
  },
  sessions: { validateSessionId },
  hooks: buildOpencodeHookBehavior(),
  switchSetup: { files: buildOpencodeSwitchConnector() },
  mcp: opencodeMcpAdapter(),
  plugins: createFileDropPlugin({
    relativePath: OPENCODE_PLUGIN_PATH,
    content: OPENCODE_PLUGIN_CONTENT,
  }),
});
