import type { Command } from '@switch-console/shared/session-v1';
import { expect, it } from 'vitest';
import { resolveCurrent } from './shared-host';

const interrupt = (roomId: string | null): Command =>
  ({
    commandId: 'c',
    sessionId: 's',
    epoch: 'current',
    origin: { surface: 'slack', actorId: 'a', roomId, threadId: null, messageId: 'm' },
    body: { type: 'turn.interrupt', turnId: 'current' },
  }) as unknown as Command;

const snapshot = {
  session: { epoch: 'e1' },
  turns: [{ turnId: 'running-turn', status: 'running' }],
};

it('interrupts the running turn only for the room it is working for', () => {
  const origins: Record<string, { roomId: string | null }> = {
    'running-turn': { roomId: 'room-a' },
  };
  const originOf = (turnId: string) => origins[turnId] ?? null;

  expect(resolveCurrent(interrupt('room-a'), snapshot, originOf)?.body).toEqual({
    type: 'turn.interrupt',
    turnId: 'running-turn',
  });
  expect(resolveCurrent(interrupt('room-b'), snapshot, originOf)).toBeNull();
  // Not from a room (Console's own stop), or a turn no room started: as before.
  expect(resolveCurrent(interrupt(null), snapshot, originOf)).not.toBeNull();
  expect(resolveCurrent(interrupt('room-b'), snapshot, () => null)).not.toBeNull();
  expect(resolveCurrent(interrupt('room-a'), { ...snapshot, turns: [] }, originOf)).toBeNull();
});
