import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import {
  buildStandardCommand,
  cursorMcpAdapter,
} from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

const CURSOR_INSTALL_UNIX = 'curl https://cursor.com/install -fsS | bash';
/**
 * Cursor's documented Windows install, `irm 'https://cursor.com/install?win32=true' | iex`
 * (https://cursor.com/docs/cli/installation), run through `powershell -c` so it works from
 * cmd.exe as well as PowerShell. Written without `$` or `%` for the same reason.
 */
export const CURSOR_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "irm \'https://cursor.com/install?win32=true\' | iex"';

export const plugin = definePlugin(
  {
    id: 'cursor',
    name: 'Cursor',
    description:
      "Cursor's agent CLI; provides editor-style, location-aware assistance from the shell.",
    websiteUrl: 'https://cursor.com/docs/cli/overview',
    cliLabel: 'Cursor CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'cursor',
      binaryNames: ['agent', 'cursor-agent'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: CURSOR_INSTALL_UNIX,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: CURSOR_INSTALL_UNIX,
          },
        ],
        windows: [
          {
            method: 'powershell',
            command: CURSOR_INSTALL_WINDOWS,
          },
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'package-manager',
        },
      },
    },
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
      flag: '',
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
        autoApproveFlag: '-f --approve-mcps',
        // No documented CLI flag selects Cursor's Auto-review run mode, so auto
        // mode launches it asking as approval-required does.
        initialPromptFlag: '',
        resumeFlag: '--resume',
      }),
  },
  mcp: {
    ...cursorMcpAdapter(),
    // Read at session start, and only the model and the instructions.
    launchProfileSettings: () => ({}),
  },
});
