import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

const MISTRAL_VIBE_INSTALL_COMMAND = 'curl -LsSf https://mistral.ai/vibe/install.sh | bash';

/**
 * Re-reads PATH from the registry into the running PowerShell, so a `uv` the line before
 * just installed can be called without opening a new terminal. No `$` or `%`, so it
 * survives cmd.exe and PowerShell alike.
 */
const REFRESH_PATH =
  "[Environment]::SetEnvironmentVariable('Path', " +
  "[Environment]::GetEnvironmentVariable('Path', 'User') + ';' + " +
  "[Environment]::GetEnvironmentVariable('Path', 'Machine'), 'Process')";

/**
 * Mistral's documented Windows install (https://github.com/mistralai/mistral-vibe#get-started):
 * install uv with `irm https://astral.sh/uv/install.ps1 | iex`, then
 * `uv tool install mistral-vibe` in a new terminal. Done here in one PowerShell, refreshing
 * PATH in between instead of opening a new terminal.
 */
export const MISTRAL_VIBE_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "' +
  `irm https://astral.sh/uv/install.ps1 | iex; ${REFRESH_PATH}; uv tool install mistral-vibe"`;

/** `uv tool install` leaves an installed tool alone, so updates upgrade it instead. */
export const MISTRAL_VIBE_UPDATE_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "' + `${REFRESH_PATH}; uv tool upgrade mistral-vibe"`;

export const plugin = definePlugin(
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    description:
      "Mistral's coding agent CLI over ACP, with approvals, model choice and resumable conversations.",
    websiteUrl: 'https://github.com/mistralai/mistral-vibe',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'mistral-vibe',
      binaryNames: ['vibe-acp'],
      installCommands: {
        macos: [
          {
            method: 'curl',
            command: MISTRAL_VIBE_INSTALL_COMMAND,
          },
        ],
        linux: [
          {
            method: 'curl',
            command: MISTRAL_VIBE_INSTALL_COMMAND,
          },
        ],
        windows: [
          {
            method: 'powershell',
            command: MISTRAL_VIBE_INSTALL_WINDOWS,
            updateCommand: MISTRAL_VIBE_UPDATE_WINDOWS,
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
      throw new Error('Mistral Vibe runs through the ACP session host.');
    },
  },
});
