import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

// Not offered on Windows until it is verified there (see the runtime's
// unsupportedPlatforms).
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
