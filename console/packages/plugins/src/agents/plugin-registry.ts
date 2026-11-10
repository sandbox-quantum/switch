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
import { provider as kiro } from './impl/kiro';

export const pluginRegistry = createPluginRegistry<CLIAgentPluginProvider>();

// Registration order is the order the desktop app lists providers in.
for (const p of [codex, claude, antigravity, cursor, opencode, kiro]) {
  pluginRegistry.register(p);
}
