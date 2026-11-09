import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { icon } from './icon';

/**
 * JetBrains' official installer for the Junie CLI, which serves ACP as
 * `junie --acp=true`. No npm package or Homebrew formula is documented
 * (checked 2026-11-06); a manual zip download from
 * github.com/JetBrains/junie-acp-release also exists (the ACP registry's own
 * distribution), but this script is what JetBrains tells people to run.
 */
export const JUNIE_INSTALL_UNIX = 'curl -fsSL https://junie.jetbrains.com/install.sh | bash';
/**
 * Written without `$` or `%`: the install runner's shell may be PowerShell or
 * cmd.exe, and each would expand one of them before `powershell -c` ran.
 */
export const JUNIE_INSTALL_WINDOWS =
  'powershell -NoProfile -Command "iex (irm \'https://junie.jetbrains.com/install.ps1\')"';

export const plugin = definePlugin(
  {
    id: 'junie',
    name: 'Junie',
    description: "JetBrains' coding agent CLI over ACP, with its own sign-in and approvals.",
    websiteUrl: 'https://junie.jetbrains.com',
    cliLabel: 'Junie CLI',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: {
      id: 'junie',
      binaryNames: ['junie'],
      installDocs: 'https://junie.jetbrains.com/docs/junie-cli.html',
      installCommands: {
        macos: [{ method: 'curl', command: JUNIE_INSTALL_UNIX, recommended: true }],
        linux: [{ method: 'curl', command: JUNIE_INSTALL_UNIX, recommended: true }],
        windows: [{ method: 'powershell', command: JUNIE_INSTALL_WINDOWS, recommended: true }],
      },
      updates: {
        kind: 'supported',
        releaseSource: { kind: 'none' },
        update: { kind: 'cli', args: ['update'] },
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
      throw new Error('Junie runs through the ACP session host.');
    },
  },
});
