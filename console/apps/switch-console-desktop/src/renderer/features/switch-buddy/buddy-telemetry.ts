import { report } from '@renderer/lib/telemetry/report';
import type { RendererTelemetryEvents } from '@shared/core/telemetry/renderer-events';

type BuddyAction = RendererTelemetryEvents['buddy_step']['action'];
type TelemetryProvider = RendererTelemetryEvents['buddy_step']['provider'];

const PROVIDERS: readonly TelemetryProvider[] = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'antigravity',
  'deepseek-harness',
  'pi',
  'copilot',
  'kiro',
  'mistral-vibe',
  'goose',
  'qwen',
  'droid',
  'cline',
  'junie',
  'openhands',
];

/** A provider id as telemetry may carry it: one of these, else `none`. */
function asTelemetryProvider(provider: string | null): TelemetryProvider {
  return PROVIDERS.find((known) => known === provider) ?? 'none';
}

/** Something done on the way to switch-buddy. */
export function reportBuddyStep(action: BuddyAction, provider: string | null): void {
  report('buddy_step', { action, provider: asTelemetryProvider(provider) });
}
