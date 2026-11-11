import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins';
import { homebrewOption, npmDependency } from '@switch-console/core/agents/plugins/helpers';
import { icon } from './icon';

const QWEN_PACKAGE = '@qwen-code/qwen-code';

/**
 * Qwen Code from npm or Homebrew, as its README offers. On Linux npm installs
 * into the user prefix: the default global prefix there needs root, and
 * `$HOME/.local/bin` is already on the PATH Switch Console captures for a
 * remote host (see OpenCode's plugin).
 */
const QWEN_HOST_DEPENDENCY = (() => {
  const brew = homebrewOption({ formula: 'qwen-code' });
  const base = npmDependency({
    id: 'qwen',
    package: QWEN_PACKAGE,
    extraOptions: { macos: [brew], linux: [brew] },
  });
  return {
    ...base,
    installCommands: {
      ...base.installCommands,
      linux: [
        {
          method: 'npm' as const,
          command: `npm install -g --prefix "$HOME/.local" ${QWEN_PACKAGE}`,
          uninstallCommand: `npm uninstall -g --prefix "$HOME/.local" ${QWEN_PACKAGE}`,
          recommended: true,
        },
        brew,
      ],
    },
  };
})();

export const plugin = definePlugin(
  {
    id: 'qwen',
    name: 'Qwen Code',
    description:
      "Alibaba's open-source coding agent over ACP, with approvals, questions and persistent conversations.",
    websiteUrl: 'https://qwenlm.github.io/qwen-code-docs/',
  },
  {
    autoApprove: {
      kind: 'supported',
    },
    effort: {
      kind: 'none',
    },
    hostDependency: QWEN_HOST_DEPENDENCY,
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
      throw new Error('Qwen Code runs through the ACP session host.');
    },
  },
});
