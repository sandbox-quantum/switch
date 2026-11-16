import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

/**
 * The dsh release Switch's approval gate is verified with, the last of the runtime's
 * `DSH_GATE_VERSIONS` (a test keeps the two in step). A session that is not in full access
 * refuses any other, so the install pins it rather than taking npm's latest.
 */
export const DSH_INSTALL_VERSION = '0.2.1-rc.5';

/**
 * The packages whose install scripts dsh needs: its spawn helper, node-pty and koffi among
 * them. Recent npm (the one Node 26 ships)
 * skips install scripts a package has not been allowed to run, and dsh then installs but
 * cannot run commands. Older npm runs them anyway; it warns that the flag is an unknown
 * config, and installs as before.
 */
export const DSH_ALLOW_SCRIPTS =
  '--allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs';

// Not offered on Windows until a Switch session has run there (see the runtime's
// unsupportedPlatforms). The CLI alone was tried on Windows 11.
function macAndLinux(
  descriptor: ReturnType<typeof npmDependency>
): ReturnType<typeof npmDependency> {
  const { macos, linux } = descriptor.installCommands;
  return { ...descriptor, installCommands: { macos, linux } };
}

export const plugin = definePlugin(
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    description:
      "DeepSeek's open-source agent harness (dsh, developer preview; verified with 0.2.1-rc.5) over ACP, with sandboxed tools, approvals and resumable conversations.",
    websiteUrl: 'https://github.com/deepseek-ai/deepseek-harness',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: macAndLinux(
      npmDependency({
        id: 'deepseek-harness',
        package: '@deepseek-ai/dsh',
        binaryNames: ['dsh'],
        installFlags: DSH_ALLOW_SCRIPTS,
        versionSuffix: `@${DSH_INSTALL_VERSION}`,
        installDocs: 'https://github.com/deepseek-ai/deepseek-harness#run-from-npm',
      })
    ),
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
      throw new Error('DeepSeek Harness runs through the ACP session host.');
    },
  },
});
