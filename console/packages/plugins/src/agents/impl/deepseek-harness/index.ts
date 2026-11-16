import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

/**
 * The packages whose install scripts dsh needs: its spawn helper, node-pty and koffi (which
 * its Windows sandbox calls the OS through) among them. Recent npm skips install scripts a
 * package has not been allowed to run, and dsh then installs but cannot run commands.
 * Older npm, which runs them anyway, accepts the flag.
 */
export const DSH_ALLOW_SCRIPTS =
  '--allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs';

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
    hostDependency: npmDependency({
      id: 'deepseek-harness',
      package: '@deepseek-ai/dsh',
      binaryNames: ['dsh'],
      installFlags: DSH_ALLOW_SCRIPTS,
      installDocs: 'https://github.com/deepseek-ai/deepseek-harness#run-from-npm',
    }),
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
