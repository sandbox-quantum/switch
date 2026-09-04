import type { ProviderItem, ProviderRuntimeEvent } from '@switch-console/agent-providers';
import { describe, expect, it } from 'vitest';
import { ProviderTranscript } from './provider-transcript';

let sequence = 0;

function event(body: Partial<ProviderRuntimeEvent> & { type: string }): ProviderRuntimeEvent {
  sequence += 1;
  return {
    eventId: `e${sequence}`,
    provider: 'opencode',
    sessionId: 'session-1',
    createdAt: `2026-01-01T00:00:0${sequence % 10}.000Z`,
    ...body,
  } as ProviderRuntimeEvent;
}

function item(overrides: Partial<ProviderItem> = {}): ProviderItem {
  return {
    id: 'item-1',
    type: 'command_execution',
    status: 'in_progress',
    title: 'ls -la',
    toolName: 'bash',
    ...overrides,
  };
}

describe('ProviderTranscript', () => {
  it('starts empty, in the starting state', () => {
    const transcript = new ProviderTranscript('session-1');
    expect(transcript.snapshot()).toEqual({
      sessionId: 'session-1',
      state: 'starting',
      entries: [],
      turns: [],
      pendingInputIds: [],
    });
  });

  it('reports a session state change once, not on every repeat', () => {
    const transcript = new ProviderTranscript('session-1');
    expect(transcript.apply(event({ type: 'session.state.changed', status: 'ready' }))).toEqual([
      { type: 'state', state: 'ready' },
    ]);
    expect(transcript.apply(event({ type: 'session.state.changed', status: 'ready' }))).toEqual([]);
  });

  describe('turns', () => {
    it('opens a turn and closes it with its outcome', () => {
      const transcript = new ProviderTranscript('session-1');
      transcript.apply(event({ type: 'turn.started', turnId: 't1' }));
      transcript.apply(event({ type: 'turn.completed', turnId: 't1', outcome: 'completed' }));

      const { turns } = transcript.snapshot();
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ turnId: 't1', status: 'completed' });
      expect(turns[0]?.endedAt).toBeDefined();
    });

    it('keeps the turn it opened rather than restarting the clock on completion', () => {
      const transcript = new ProviderTranscript('session-1');
      transcript.apply(event({ type: 'turn.started', turnId: 't1' }));
      const startedAt = transcript.snapshot().turns[0]?.startedAt;
      transcript.apply(event({ type: 'turn.completed', turnId: 't1', outcome: 'interrupted' }));

      expect(transcript.snapshot().turns[0]).toMatchObject({
        startedAt,
        status: 'interrupted',
      });
    });
  });

  describe('assistant text', () => {
    it('opens an entry on the first delta and appends to it thereafter', () => {
      const transcript = new ProviderTranscript('session-1');
      const first = transcript.apply(
        event({ type: 'content.delta', turnId: 't1', itemId: 'p1', delta: 'Hel' })
      );
      expect(first[0]).toMatchObject({
        type: 'entry',
        entry: { kind: 'assistant', text: 'Hel', streaming: true },
      });

      const second = transcript.apply(
        event({ type: 'content.delta', turnId: 't1', itemId: 'p1', delta: 'lo' })
      );
      expect(second).toEqual([{ type: 'delta', entryId: 'assistant:p1', delta: 'lo' }]);

      const entry = transcript.snapshot().entries[0];
      expect(entry).toMatchObject({ kind: 'assistant', text: 'Hello' });
    });

    it('stops streaming when the message item completes', () => {
      const transcript = new ProviderTranscript('session-1');
      transcript.apply(event({ type: 'content.delta', turnId: 't1', itemId: 'p1', delta: 'hi' }));
      transcript.apply(
        event({
          type: 'item.completed',
          turnId: 't1',
          item: item({ id: 'p1', type: 'assistant_message', status: 'completed', title: 'msg' }),
        })
      );

      expect(transcript.snapshot().entries[0]).toMatchObject({
        kind: 'assistant',
        streaming: false,
      });
    });

    /**
     * The reply is already an entry of its own, built from deltas. Adding the
     * message item as an activity row would draw every answer twice.
     */
    it('does not add an activity row for the assistant message item', () => {
      const transcript = new ProviderTranscript('session-1');
      transcript.apply(event({ type: 'content.delta', turnId: 't1', itemId: 'p1', delta: 'hi' }));
      transcript.apply(
        event({
          type: 'item.started',
          turnId: 't1',
          item: item({ id: 'p1', type: 'assistant_message', title: 'msg' }),
        })
      );

      expect(transcript.snapshot().entries.filter((e) => e.kind === 'item')).toHaveLength(0);
    });
  });

  it('replaces an item entry in place as it progresses', () => {
    const transcript = new ProviderTranscript('session-1');
    transcript.apply(event({ type: 'item.started', turnId: 't1', item: item() }));
    transcript.apply(
      event({
        type: 'item.completed',
        turnId: 't1',
        item: item({ status: 'completed', text: 'total 0' }),
      })
    );

    const entries = transcript.snapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'item',
      item: { status: 'completed', text: 'total 0', toolName: 'bash' },
    });
  });

  describe('requests and questions', () => {
    it('lists an open approval as pending and clears it when resolved', () => {
      const transcript = new ProviderTranscript('session-1');
      transcript.apply(
        event({
          type: 'request.opened',
          turnId: 't1',
          requestId: 'r1',
          requestType: 'command_execution_approval',
          title: 'rm -rf build',
          options: [{ decision: 'accept', label: 'Allow once' }],
        })
      );
      expect(transcript.snapshot().pendingInputIds).toEqual(['r1']);

      transcript.apply(event({ type: 'request.resolved', requestId: 'r1', decision: 'accept' }));
      expect(transcript.snapshot().pendingInputIds).toEqual([]);
      expect(transcript.snapshot().entries[0]).toMatchObject({
        kind: 'request',
        state: 'resolved',
        decision: 'accept',
      });
    });

    it('ignores a resolution for a request it never saw opened', () => {
      const transcript = new ProviderTranscript('session-1');
      expect(
        transcript.apply(
          event({ type: 'request.resolved', requestId: 'ghost', decision: 'cancel' })
        )
      ).toEqual([]);
    });

    it('records the answers given to a question', () => {
      const transcript = new ProviderTranscript('session-1');
      transcript.apply(
        event({
          type: 'user-input.requested',
          turnId: 't1',
          requestId: 'q1',
          questions: [
            {
              id: '0',
              question: 'Which colour?',
              options: [{ label: 'green', value: 'green' }],
              multiSelect: false,
              allowCustomAnswer: true,
            },
          ],
        })
      );
      transcript.noteAnswers('q1', { '0': 'green' });
      transcript.apply(event({ type: 'user-input.resolved', requestId: 'q1' }));

      expect(transcript.snapshot().entries[0]).toMatchObject({
        kind: 'question',
        state: 'resolved',
        answers: { '0': 'green' },
      });
    });
  });

  it('files a user turn under the turn it belongs to, with its source', () => {
    const transcript = new ProviderTranscript('session-1');
    transcript.recordUserTurn({ turnId: 't1', text: 'do the thing', source: 'room' });

    expect(transcript.snapshot().entries[0]).toMatchObject({
      kind: 'user',
      turnId: 't1',
      text: 'do the thing',
      source: 'room',
    });
  });

  it('turns a runtime error into both an error state and a notice', () => {
    const transcript = new ProviderTranscript('session-1');
    const updates = transcript.apply(event({ type: 'runtime.error', message: 'server died' }));

    expect(updates[0]).toEqual({ type: 'state', state: 'error' });
    expect(transcript.snapshot().entries[0]).toMatchObject({
      kind: 'notice',
      level: 'error',
      text: 'server died',
    });
  });

  /**
   * The cap is a view bound, not a record: the vendor keeps the conversation
   * and `resume` reads it back. What must not happen is losing the beginning
   * without saying so.
   */
  it('trims past the cap and says once that it did', () => {
    const transcript = new ProviderTranscript('session-1');
    for (let i = 0; i < 5010; i += 1) {
      transcript.recordUserTurn({ turnId: `t${i}`, text: 'x', source: 'console' });
    }

    const entries = transcript.snapshot().entries;
    expect(entries.length).toBeLessThanOrEqual(5001);
    expect(entries.filter((e) => e.kind === 'notice')).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'notice', level: 'info' });
  });
});
