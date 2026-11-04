import type { Item, Snapshot } from '@switch-console/shared/session-v1';
import { expect, it } from 'vitest';
import { messageDelivery, messageDeliveryLabel } from './message-delivery';

const message = (commandId: string, turnId: string): Item => ({
  itemId: `user-${commandId}`,
  turnId,
  revision: 1,
  kind: 'user-message',
  status: 'completed',
  title: '',
  text: 'hello',
  attachments: [],
  origin: null,
});
const turn = (
  turnId: string,
  status: Snapshot['turns'][number]['status']
): Snapshot['turns'][number] => ({ type: 'turn.upsert', turnId, status, commandId: turnId });

it('says a message drawn in another turn was steered into it', () => {
  const turns = [turn('first', 'running')];
  expect(messageDelivery(message('correction', 'first'), turns)).toEqual({ kind: 'steered' });
  expect(messageDeliveryLabel({ kind: 'steered' })).toBe('Steered into the running turn');
  // It stays steered once that turn has ended.
  expect(messageDelivery(message('correction', 'first'), [turn('first', 'completed')])).toEqual({
    kind: 'steered',
  });
});

it('says a queued message is queued, and how much is in front of it', () => {
  const turns = [
    turn('done', 'completed'),
    turn('running', 'running'),
    turn('waiting', 'queued'),
    turn('mine', 'queued'),
  ];
  expect(messageDelivery(message('mine', 'mine'), turns)).toEqual({ kind: 'queued', ahead: 2 });
  expect(messageDeliveryLabel({ kind: 'queued', ahead: 2 })).toBe('Queued · 2 ahead');
  expect(messageDeliveryLabel({ kind: 'queued', ahead: 0 })).toBe('Queued · runs next');
});

it('says nothing for a message whose own turn is running or has run', () => {
  expect(messageDelivery(message('mine', 'mine'), [turn('mine', 'running')])).toBeNull();
  expect(messageDelivery(message('mine', 'mine'), [turn('mine', 'completed')])).toBeNull();
  expect(messageDeliveryLabel(null)).toBeNull();
});

it('says nothing for what is not a message the agent was sent', () => {
  const reply: Item = { ...message('x', 'turn'), itemId: 'assistant', kind: 'assistant-message' };
  expect(messageDelivery(reply, [turn('turn', 'running')])).toBeNull();
  // A message the provider itself reported, not one the host was sent.
  const echoed: Item = { ...message('x', 'turn'), itemId: '["turn","u1"]' };
  expect(messageDelivery(echoed, [turn('turn', 'running')])).toBeNull();
});
