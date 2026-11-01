import { expect, it } from 'vitest';
import { roomCancelReply } from './room-cancel-reply';

const rejected = (code: string | null) => ({ status: 'rejected', code });

it('says the message was withdrawn once the cancel applied', () => {
  expect(roomCancelReply({ status: 'applied', code: null })).toBe(
    'Cancelled before the agent started. The agent will not receive it.'
  );
});

it('points at !interrupt for a message the agent already started on', () => {
  expect(roomCancelReply(rejected('TURN_ALREADY_STARTED'))).toBe(
    "The agent has already started on that message, so it can't be cancelled. To stop the agent's current turn, use `!interrupt` with its mention."
  );
});

it('says why for each refusal the host names', () => {
  expect(roomCancelReply(rejected('TURN_ALREADY_CANCELLED'))).toBe(
    'That message was already cancelled.'
  );
  expect(roomCancelReply(rejected('NOT_YOUR_MESSAGE'))).toBe(
    'Only the person who sent that message can cancel it.'
  );
  expect(roomCancelReply(rejected('TURN_NOT_FOUND'))).toBe(
    'There is no message with that ID waiting for this agent in this room.'
  );
  expect(roomCancelReply(rejected('TURN_NOT_QUEUED'))).toBe(
    'That message is no longer waiting, so there is nothing to cancel.'
  );
});

it('gives one plain refusal for any other reason the session refused', () => {
  for (const code of ['COMMAND_REJECTED', 'PROVIDER_ERROR', 'SOMETHING_NEW', null])
    expect(roomCancelReply(rejected(code))).toBe(
      "I couldn't cancel that message: the session refused it."
    );
});

it('never claims an outcome the host did not record', () => {
  for (const outcome of [
    null,
    { status: 'unknown', code: 'OUTCOME_UNKNOWN' },
    { status: 'unknown', code: 'HOST_RESTARTED' },
    { status: 'accepted', code: null },
    { status: 'dispatched', code: null },
  ])
    expect(roomCancelReply(outcome)).toBe(
      "I couldn't confirm the cancellation; check the activity card."
    );
});

it('never starts an answer with a command prefix', () => {
  const outcomes = [
    null,
    { status: 'applied', code: null },
    { status: 'unknown', code: null },
    ...[
      'TURN_ALREADY_STARTED',
      'TURN_ALREADY_CANCELLED',
      'NOT_YOUR_MESSAGE',
      'TURN_NOT_FOUND',
      'TURN_NOT_QUEUED',
      'COMMAND_REJECTED',
      null,
    ].map(rejected),
  ];
  for (const outcome of outcomes) expect(roomCancelReply(outcome).trimStart()).not.toMatch(/^!/);
});
