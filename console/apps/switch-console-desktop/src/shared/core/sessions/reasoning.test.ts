import { expect, it } from 'vitest';
import { reasoningLabel, reasoningListSchema, type ReasoningTurn } from './reasoning';

const turn = (startedAt: string | null, completedAt: string | null): ReasoningTurn => ({
  turnId: 'turn',
  text: 'Look first.',
  startedAt,
  completedAt,
});

it('labels reasoning by what is known of its timing', () => {
  expect(reasoningLabel(null, true)).toBeNull();
  expect(reasoningLabel(null, false)).toBeNull();
  expect(reasoningLabel(turn('2026-10-08T12:00:00.000Z', null), true)).toEqual({
    label: 'Thinking…',
    seconds: null,
  });
  expect(reasoningLabel(turn(null, null), true)).toEqual({ label: 'Thinking…', seconds: null });
  expect(
    reasoningLabel(turn('2026-10-08T12:00:00.000Z', '2026-10-08T12:00:04.400Z'), true)
  ).toEqual({ label: 'Thought for 4s', seconds: 4 });
  expect(
    reasoningLabel(turn('2026-10-08T12:00:00.000Z', '2026-10-08T12:00:12.600Z'), false)
  ).toEqual({ label: 'Thought for 13s', seconds: 13 });
  expect(
    reasoningLabel(turn('2026-10-08T12:00:00.000Z', '2026-10-08T12:00:00.100Z'), false)
  ).toEqual({ label: 'Thought for 1s', seconds: 1 });
});

it('says only "Thought" without a real start, and never makes a duration up', () => {
  expect(reasoningLabel(turn(null, '2026-10-08T12:00:04.000Z'), false)).toEqual({
    label: 'Thought',
    seconds: null,
  });
  expect(reasoningLabel(turn(null, '2026-10-08T12:00:04.000Z'), true)).toEqual({
    label: 'Thought',
    seconds: null,
  });
  // The turn ended without the reasoning completing.
  expect(reasoningLabel(turn('2026-10-08T12:00:00.000Z', null), false)).toEqual({
    label: 'Thought',
    seconds: null,
  });
  expect(reasoningLabel(turn('not a time', '2026-10-08T12:00:04.000Z'), false)).toEqual({
    label: 'Thought',
    seconds: null,
  });
});

it('reads a reasoning list and refuses anything else', () => {
  const list = { epoch: 'epoch', turns: [turn(null, null)] };
  expect(reasoningListSchema.parse(list)).toEqual(list);
  expect(reasoningListSchema.safeParse({ state: 'connected' }).success).toBe(false);
});
