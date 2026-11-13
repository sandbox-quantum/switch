import type { ProviderSetup } from '@switch-console/core/agents/provider-setup';
import { antigravitySetup } from './impl/antigravity/setup';
import { claudeSetup } from './impl/claude/setup';
import { clineSetup } from './impl/cline/setup';
import { codexSetup } from './impl/codex/setup';
import { copilotSetup } from './impl/copilot/setup';
import { cursorSetup } from './impl/cursor/setup';
import { deepseekHarnessSetup } from './impl/deepseek-harness/setup';
import { droidSetup } from './impl/droid/setup';
import { gooseSetup } from './impl/goose/setup';
import { junieSetup } from './impl/junie/setup';
import { kiroSetup } from './impl/kiro/setup';
import { mistralVibeSetup } from './impl/mistral-vibe/setup';
import { opencodeSetup } from './impl/opencode/setup';
import { piSetup } from './impl/pi/setup';
import { qwenSetup } from './impl/qwen/setup';

/** Each agent provider's setup, by provider id. */
export const providerSetups: Record<string, ProviderSetup> = {
  antigravity: antigravitySetup,
  claude: claudeSetup,
  cline: clineSetup,
  codex: codexSetup,
  copilot: copilotSetup,
  cursor: cursorSetup,
  'deepseek-harness': deepseekHarnessSetup,
  droid: droidSetup,
  goose: gooseSetup,
  junie: junieSetup,
  kiro: kiroSetup,
  'mistral-vibe': mistralVibeSetup,
  opencode: opencodeSetup,
  pi: piSetup,
  qwen: qwenSetup,
};
