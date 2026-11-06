import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/** Moonshot's installers for Kimi Code, `kimi`, which serves ACP as `kimi acp`. */
export const KIMI_INSTALL_UNIX = 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';
/** Written without `$` or `%`: the install runner's shell may be PowerShell or cmd.exe. */
export const KIMI_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "irm https://code.kimi.com/kimi-code/install.ps1 | iex"';
const KIMI_INSTALL_NPM = {
  method: 'npm' as const,
  command: 'npm install -g @moonshot-ai/kimi-code',
  uninstallCommand: 'npm uninstall -g @moonshot-ai/kimi-code',
};

export const plugin = definePlugin(
  {
    id: 'kimi',
    name: 'Kimi Code',
    description:
      "Moonshot AI's Kimi Code CLI over ACP, with its own sign-in, approvals and resumable sessions.",
    websiteUrl: 'https://www.kimi.com/code',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'kimi',
      binaryNames: ['kimi'],
      installCommands: {
        macos: [
          { method: 'curl', command: KIMI_INSTALL_UNIX, recommended: true },
          KIMI_INSTALL_NPM,
        ],
        linux: [
          { method: 'curl', command: KIMI_INSTALL_UNIX, recommended: true },
          KIMI_INSTALL_NPM,
        ],
        windows: [
          { method: 'powershell', command: KIMI_INSTALL_WINDOWS, recommended: true },
          KIMI_INSTALL_NPM,
        ],
      },
      updates: {
        kind: 'supported',
        releaseSource: {
          kind: 'none',
        },
        update: {
          kind: 'cli',
          args: ['upgrade', '--yes'],
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
      throw new Error('Kimi Code runs through the ACP session host.');
    },
  },
});
