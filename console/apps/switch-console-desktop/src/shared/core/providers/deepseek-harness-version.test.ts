import { DSH_GATE_VERSIONS } from '@switch-console/agent-providers';
import { pluginRegistry } from '@switch-console/plugins/agents';
import { expect, it } from 'vitest';

// A session not in full access refuses any dsh but the ones its approval gate is verified with.
it('installs the DeepSeek Harness release the approval gate is verified with', () => {
  const plugin = pluginRegistry.getAll().find((p) => p.metadata.id === 'deepseek-harness');
  const { installCommands } = plugin!.capabilities.hostDependency;
  for (const platform of ['macos', 'linux'] as const)
    expect(installCommands[platform]?.[0]?.command).toMatch(
      new RegExp(`@deepseek-ai/dsh@${DSH_GATE_VERSIONS.at(-1)!.replaceAll('.', '\\.')}$`)
    );
});
