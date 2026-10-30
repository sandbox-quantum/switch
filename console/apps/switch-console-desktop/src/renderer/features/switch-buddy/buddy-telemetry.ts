import { report } from '@renderer/lib/telemetry/report';
import type { ChatAgent } from '@shared/core/chats/chats';
import type { RendererTelemetryEvents } from '@shared/core/telemetry/renderer-events';
import { isBuddy } from './buddy-identity';

type BuddyAction = RendererTelemetryEvents['buddy_step']['action'];
type TelemetryProvider = RendererTelemetryEvents['buddy_step']['provider'];

const PROVIDERS: readonly TelemetryProvider[] = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'antigravity',
  'mistral-vibe',
];

/** A provider id as telemetry may carry it, or `none` for an unknown one. */
function asTelemetryProvider(provider: string | null): TelemetryProvider {
  return PROVIDERS.find((known) => known === provider) ?? 'none';
}

/** Something done on the way to switch-buddy. */
export function reportBuddyStep(action: BuddyAction, provider: string | null): void {
  report('buddy_step', { action, provider: asTelemetryProvider(provider) });
}

/**
 * A message the person is sending to their own buddy, as the how-manyth in
 * the chat, counted from what the chat already holds of theirs. Nothing of the
 * message itself.
 */
export function reportBuddyMessage(agents: readonly ChatAgent[], sentBefore: number): void {
  const [agent] = agents;
  if (agents.length !== 1 || !agent || !isBuddy({ name: agent.name })) return;
  const nth = sentBefore + 1;
  report('buddy_message_sent', {
    nth: nth >= 6 ? '6+' : (String(nth) as '1' | '2' | '3' | '4' | '5'),
  });
}
