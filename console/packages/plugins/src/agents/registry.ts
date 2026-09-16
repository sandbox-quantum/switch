// The single plugin registry
import {
  type CLIAgentPluginProvider,
  createPluginRegistry,
} from '@switch-console/core/agents/plugins';
import { provider as antigravity } from './impl/antigravity';
import { provider as claude } from './impl/claude';
import { provider as codex } from './impl/codex';
import { provider as cursor } from './impl/cursor';
import { provider as opencode } from './impl/opencode';

export const pluginRegistry = createPluginRegistry<CLIAgentPluginProvider>();

for (const p of [antigravity, claude, codex, cursor, opencode]) {
  pluginRegistry.register(p);
}
