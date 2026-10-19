import { describe, expect, it } from 'vitest';
import { hiddenStopRows } from '@renderer/features/chats/stop-rows';
import type { ChatMessage } from '@shared/core/chats/chats';

const human = { kind: 'human' } as ChatMessage['sender'];
const agent = { kind: 'agent' } as ChatMessage['sender'];
const row = (
  messageId: string,
  body: string,
  sender = human,
  threadRootId: string | null = null
) => ({
  messageId,
  body,
  sender,
  threadRootId,
});

describe('hiddenStopRows', () => {
  it('hides a Stop command and its acknowledgement', () => {
    const messages = [
      row('$ask', 'fix the build'),
      row('$stop', '!interrupt @coder'),
      row('$ack', 'Interrupted my current turn. ([Open in Switch Console](x))', agent, '$stop'),
      row('$next', 'try again'),
    ];
    expect(hiddenStopRows(messages)).toEqual(new Set(['$stop', '$ack']));
  });

  it('hides a Stop still waiting for its answer', () => {
    expect(hiddenStopRows([row('$stop', '!interrupt @coder')])).toEqual(new Set(['$stop']));
  });

  it('shows a Stop the agent could not carry out, with its answer', () => {
    const messages = [
      row('$stop', '!interrupt @coder'),
      row('$no', "I can't be interrupted — this isn't supported for me.", agent, '$stop'),
    ];
    expect(hiddenStopRows(messages).size).toBe(0);
  });

  it('leaves other commands and messages alone', () => {
    const messages = [
      row('$reset', '!reset @coder'),
      row('$ack', 'Resetting my session.', agent, '$reset'),
      row('$talk', '!interrupting cow'),
      row('$quote', 'Interrupted my current turn.'),
    ];
    expect(hiddenStopRows(messages).size).toBe(0);
  });
});
