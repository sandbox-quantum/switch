import type { Item, Snapshot } from '@switch-console/shared/session-v1';

/**
 * Which path a message the agent was sent took, as its activity shows it:
 * steered into the turn that was running when it arrived, or waiting in the
 * queue for its own turn. Null when there is nothing to say — the message
 * started its turn at once, or that turn has run.
 */
export type MessageDelivery = { kind: 'steered' } | { kind: 'queued'; ahead: number } | null;

/**
 * Notices the delivery label already says, which the transcript does not repeat.
 * A steer that could not join the running turn keeps its notice, since that
 * is what explains why the message was not steered.
 */
export const DELIVERY_NOTICE_CODES: ReadonlySet<string> = new Set(['MESSAGE_STEERED']);

export function messageDelivery(item: Item, turns: Snapshot['turns']): MessageDelivery {
  if (item.kind !== 'user-message' || !item.itemId.startsWith('user-')) return null;
  const commandId = item.itemId.slice('user-'.length);
  // The host draws a message in its own turn, named after its command, unless
  // it joined the turn that was running.
  if (item.turnId !== commandId) return { kind: 'steered' };
  const index = turns.findIndex((turn) => turn.turnId === commandId);
  if (index < 0 || turns[index].status !== 'queued') return null;
  const ahead = turns
    .slice(0, index)
    .filter((turn) => turn.status === 'queued' || turn.status === 'running').length;
  return { kind: 'queued', ahead };
}

/** What the activity card says under the message. */
export function messageDeliveryLabel(delivery: MessageDelivery): string | null {
  if (delivery === null) return null;
  if (delivery.kind === 'steered') return 'Steered into the running turn';
  if (delivery.ahead === 0) return 'Queued · runs next';
  return `Queued · ${delivery.ahead} ahead`;
}
