import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ChatMessage,
  liveSessionStartingNotices,
  SESSION_STARTING_MESSAGE,
  TURN_FAILED_PHRASE,
  turnEndNotice,
  UNPOSTED_REPLY_MESSAGE,
} from '@shared/core/chats/chats';

function message(messageId: string, clientId: string, body: string): ChatMessage {
  return {
    messageId,
    body,
    sender: { clientId, name: clientId, kind: 'agent', agentId: clientId, userId: null },
  } as unknown as ChatMessage;
}

function ask(messageId: string): ChatMessage {
  return {
    messageId,
    body: 'please help',
    sender: { clientId: 'me', name: 'me', kind: 'human', agentId: null, userId: 'me' },
  } as unknown as ChatMessage;
}

const noTurns = new Map<string, Set<string>>();

describe('session-starting notices', () => {
  it('shows a notice while it is the latest message from its agent', () => {
    const messages = [
      message('$ask', 'helper', 'hi'),
      message('$start', 'helper', SESSION_STARTING_MESSAGE),
      message('$other', 'reviewer', 'unrelated'),
    ];
    expect(liveSessionStartingNotices(messages, noTurns)).toEqual(new Set(['$start']));
  });

  it('hides a notice once its agent posts again', () => {
    const messages = [
      message('$start', 'helper', SESSION_STARTING_MESSAGE),
      message('$reply', 'helper', 'Here is the answer.'),
    ];
    expect(liveSessionStartingNotices(messages, noTurns)).toEqual(new Set());
  });

  it('hides a notice once its agent shows a turn for the message it answers', () => {
    const messages = [ask('$ask'), message('$start', 'helper', SESSION_STARTING_MESSAGE)];
    const turns = new Map([['$ask', new Set(['helper'])]]);
    expect(liveSessionStartingNotices(messages, turns)).toEqual(new Set());
  });

  it('keeps a notice while only another agent or an earlier turn shows activity', () => {
    const messages = [
      ask('$old'),
      message('$reply', 'helper', 'Done.'),
      ask('$ask'),
      message('$start', 'helper', SESSION_STARTING_MESSAGE),
    ];
    const turns = new Map([
      ['$old', new Set(['helper'])],
      ['$ask', new Set(['reviewer'])],
    ]);
    expect(liveSessionStartingNotices(messages, turns)).toEqual(new Set(['$start']));
  });

  it('matches the text the host posts', () => {
    const source = readFileSync(
      join(__dirname, '../../../../../packages/agent-providers/src/host/watcher-tools.ts'),
      'utf8'
    );
    expect(source).toContain(`SESSION_STARTING_MESSAGE = '${SESSION_STARTING_MESSAGE}'`);
  });
});

describe('turn-end notices', () => {
  it('reads how the turn ended and why', () => {
    const read = (body: string) => turnEndNotice(message('$n', 'helper', body));
    expect(
      read(
        'I finished without replying. The turn was interrupted: Claude turn ended: error_during_execution'
      )
    ).toEqual({ outcome: 'interrupted', reason: null });
    expect(read('I finished without replying. The turn failed: Not signed in.')).toEqual({
      outcome: 'failed',
      reason: 'Not signed in.',
    });
    expect(read('I finished without replying. The turn failed.')).toEqual({
      outcome: 'failed',
      reason: null,
    });
    expect(read('I finished without replying.')).toEqual({ outcome: 'completed', reason: null });
  });

  it('leaves other messages alone', () => {
    expect(
      turnEndNotice(
        message('$n', 'helper', 'I finished without posting a reply. My last words were:\n\nHi')
      )
    ).toBeNull();
    expect(
      turnEndNotice(message('$n', 'helper', 'I finished without replying. Then more.'))
    ).toBeNull();
    expect(turnEndNotice(ask('$n'))).toBeNull();
  });

  it('matches the text the host posts', () => {
    const source = readFileSync(
      join(__dirname, '../../../../../packages/agent-providers/src/host/session-host.ts'),
      'utf8'
    );
    // The host posts only a failed turn now; the others are still read, for
    // the notices older hosts left in a chat's history.
    expect(source).toContain(`\`${UNPOSTED_REPLY_MESSAGE} ${TURN_FAILED_PHRASE}\${reason}\``);
    expect(source).toContain("? `: ${cap(detail.trim(), 1000)}` : '.'");
  });
});
