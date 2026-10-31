// The single plugin registry
import {
  type CLIAgentPluginProvider,
  createPluginRegistry,
} from '@switch-console/core/agents/plugins';
import { provider as amp } from './impl/amp';
import { provider as antigravity } from './impl/antigravity';
import { provider as claude } from './impl/claude';
import { provider as codex } from './impl/codex';
import { provider as cursor } from './impl/cursor';
import { provider as opencode } from './impl/opencode';

export const pluginRegistry = createPluginRegistry<CLIAgentPluginProvider>();

// Registration order is the order the desktop app lists providers in.
for (const p of [codex, claude, antigravity, cursor, opencode, amp]) {
  pluginRegistry.register(p);
}
