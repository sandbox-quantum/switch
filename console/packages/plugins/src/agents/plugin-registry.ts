// The single plugin registry
import {
  type CLIAgentPluginProvider,
  createPluginRegistry,
} from '@switch-console/core/agents/plugins';
import { provider as antigravity } from './impl/antigravity';
import { provider as claude } from './impl/claude';
import { provider as codex } from './impl/codex';
import { provider as copilot } from './impl/copilot';
import { provider as cursor } from './impl/cursor';
import { provider as deepseekHarness } from './impl/deepseek-harness';
import { provider as droid } from './impl/droid';
import { provider as goose } from './impl/goose';
import { provider as kiro } from './impl/kiro';
import { provider as mistralVibe } from './impl/mistral-vibe';
import { provider as opencode } from './impl/opencode';
import { provider as pi } from './impl/pi';
import { provider as qwen } from './impl/qwen';

export const pluginRegistry = createPluginRegistry<CLIAgentPluginProvider>();

// Registration order is the order the desktop app lists providers in.
for (const p of [
  codex,
  claude,
  antigravity,
  copilot,
  cursor,
  kiro,
  opencode,
  deepseekHarness,
  pi,
  mistralVibe,
  goose,
  qwen,
  droid,
]) {
  pluginRegistry.register(p);
}
