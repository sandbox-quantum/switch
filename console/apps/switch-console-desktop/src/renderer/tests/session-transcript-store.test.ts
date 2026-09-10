import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTranscriptStore } from '@renderer/features/sessions/stores/session-transcript-store';
import type {
  SessionTranscript,
  TranscriptEntry,
  TranscriptTurn,
} from '@shared/core/sessions/session-transcript';

const get = vi.hoisted(() => vi.fn());
const sendTurn = vi.hoisted(() => vi.fn());
const interrupt = vi.hoisted(() => vi.fn());
const respondToRequest = vi.hoisted(() => vi.fn());
const respondToUserInput = vi.hoisted(() => vi.fn());

const eventHandlers = vi.hoisted(() => new Map<string, Array<(payload: unknown) => void>>());

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (channel: { name: string }, handler: (payload: unknown) => void, topic?: string) => {
      const key = topic ? `${channel.name}.${topic}` : channel.name;
      const forChannel = eventHandlers.get(key) ?? [];
      forChannel.push(handler);
      eventHandlers.set(key, forChannel);
      return () => {
        eventHandlers.set(
          key,
          (eventHandlers.get(key) ?? []).filter((h) => h !== handler)
        );
      };
    },
  },
  rpc: {
    sessionTranscript: { get, sendTurn, interrupt, respondToRequest, respondToUserInput },
  },
}));

const SESSION_ID = 'session-1';

function emit(update: unknown): void {
  for (const handler of eventHandlers.get(`session:transcript.${SESSION_ID}`) ?? []) {
    handler({ sessionId: SESSION_ID, update });
  }
}

const turn = (turnId: string, status: TranscriptTurn['status']): TranscriptTurn => ({
  turnId,
  status,
  startedAt: '2026-01-01T00:00:00.000Z',
});

const assistant = (id: string, text: string, streaming = true): TranscriptEntry => ({
  kind: 'assistant',
  id,
  turnId: 't1',
  text,
  streaming,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const snapshot = (over: Partial<SessionTranscript> = {}): SessionTranscript => ({
  sessionId: SESSION_ID,
  state: 'ready',
  entries: [],
  turns: [],
  pendingInputIds: [],
  ...over,
});

async function makeStore(initial: SessionTranscript = snapshot()): Promise<SessionTranscriptStore> {
  get.mockResolvedValue(initial);
  const store = new SessionTranscriptStore(SESSION_ID);
  await vi.waitFor(() => expect(store.loading).toBe(false));
  return store;
}

describe('SessionTranscriptStore', () => {
  beforeEach(() => {
    eventHandlers.clear();
    for (const fn of [get, sendTurn, interrupt, respondToRequest, respondToUserInput]) {
      fn.mockReset();
    }
  });

  it('loads the snapshot and subscribes on the session topic', async () => {
    const store = await makeStore(
      snapshot({
        state: 'running',
        entries: [assistant('a1', 'hi')],
        turns: [turn('t1', 'running')],
      })
    );

    expect(get).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(eventHandlers.has(`session:transcript.${SESSION_ID}`)).toBe(true);
    expect(store.entries).toHaveLength(1);
    expect(store.state).toBe('running');
    store.dispose();
  });

  it('buffers updates that arrive before the snapshot, then applies them', async () => {
    let resolve: ((value: SessionTranscript) => void) | undefined;
    get.mockReturnValue(
      new Promise<SessionTranscript>((r) => {
        resolve = r;
      })
    );
    const store = new SessionTranscriptStore(SESSION_ID);

    emit({ type: 'entry', entry: assistant('a2', 'late') });
    expect(store.entries).toHaveLength(0);

    resolve?.(snapshot({ entries: [assistant('a1', 'early')] }));
    await vi.waitFor(() => expect(store.loading).toBe(false));

    expect(store.entries.map((entry) => entry.id)).toEqual(['a1', 'a2']);
    store.dispose();
  });

  it('upserts an entry by id rather than appending a second copy', async () => {
    const store = await makeStore(snapshot({ entries: [assistant('a1', 'draft')] }));

    emit({ type: 'entry', entry: assistant('a1', 'final', false) });

    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({ text: 'final', streaming: false });
    store.dispose();
  });

  it('appends a delta to the assistant entry it names', async () => {
    const store = await makeStore(snapshot({ entries: [assistant('a1', 'Hel')] }));

    emit({ type: 'delta', entryId: 'a1', delta: 'lo' });
    emit({ type: 'delta', entryId: 'a1', delta: ' there' });

    expect(store.entries[0]).toMatchObject({ text: 'Hello there' });
    store.dispose();
  });

  it('drops a delta for an entry it does not have', async () => {
    const store = await makeStore(snapshot({ entries: [assistant('a1', 'x')] }));

    emit({ type: 'delta', entryId: 'nope', delta: '!' });

    expect(store.entries[0]).toMatchObject({ text: 'x' });
    store.dispose();
  });

  it('upserts turns and reports whether one is running', async () => {
    const store = await makeStore(snapshot({ turns: [turn('t1', 'running')] }));
    expect(store.isRunning).toBe(true);

    emit({ type: 'turn', turn: turn('t1', 'completed') });
    expect(store.turns).toHaveLength(1);
    expect(store.isRunning).toBe(false);

    emit({ type: 'turn', turn: turn('t2', 'running') });
    expect(store.turns).toHaveLength(2);
    expect(store.isRunning).toBe(true);
    store.dispose();
  });

  it('sets the session state and gates the composer on it', async () => {
    const store = await makeStore(snapshot({ state: 'starting' }));
    expect(store.canSend).toBe(false);

    emit({ type: 'state', state: 'ready' });
    expect(store.state).toBe('ready');
    expect(store.canSend).toBe(true);

    emit({ type: 'state', state: 'error' });
    expect(store.canSend).toBe(false);
    store.dispose();
  });

  it('derives pending inputs from open requests and questions', async () => {
    const request: TranscriptEntry = {
      kind: 'request',
      id: 'r1',
      turnId: 't1',
      requestType: 'command_execution_approval',
      title: 'Run tests',
      options: [{ decision: 'accept', label: 'Allow' }],
      state: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const question: TranscriptEntry = {
      kind: 'question',
      id: 'q1',
      turnId: 't1',
      questions: [
        {
          id: 'which',
          question: 'Which one?',
          options: [{ label: 'A', value: 'a' }],
          multiSelect: false,
          allowCustomAnswer: false,
        },
      ],
      state: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const store = await makeStore(snapshot({ entries: [request, question] }));
    expect(store.pendingInputs.map((entry) => entry.id)).toEqual(['r1', 'q1']);

    emit({ type: 'entry', entry: { ...request, state: 'resolved', decision: 'accept' } });
    expect(store.pendingInputs.map((entry) => entry.id)).toEqual(['q1']);
    store.dispose();
  });

  it('replaces everything on reset', async () => {
    const store = await makeStore(
      snapshot({ entries: [assistant('a1', 'old')], turns: [turn('t1', 'running')] })
    );

    emit({
      type: 'reset',
      transcript: snapshot({ state: 'stopped', entries: [assistant('b1', 'new')] }),
    });

    expect(store.entries.map((entry) => entry.id)).toEqual(['b1']);
    expect(store.turns).toHaveLength(0);
    expect(store.state).toBe('stopped');
    store.dispose();
  });

  it('stops applying updates once disposed', async () => {
    const store = await makeStore();
    store.dispose();

    emit({ type: 'entry', entry: assistant('a1', 'after') });

    expect(store.entries).toHaveLength(0);
  });

  it('records the failure instead of showing an empty transcript', async () => {
    get.mockRejectedValue(new Error('no such session'));
    const store = new SessionTranscriptStore(SESSION_ID);
    await vi.waitFor(() => expect(store.loading).toBe(false));

    expect(store.error).toBe('Could not read the transcript. (no such session)');
    store.dispose();
  });

  it('passes writes through to the controller', async () => {
    const store = await makeStore();

    await store.sendTurn('hello');
    await store.interrupt();
    await store.respondToRequest('r1', 'decline');
    await store.respondToUserInput('q1', { which: ['a', 'b'] });

    expect(sendTurn).toHaveBeenCalledWith({ sessionId: SESSION_ID, text: 'hello' });
    expect(interrupt).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(respondToRequest).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestId: 'r1',
      decision: 'decline',
    });
    expect(respondToUserInput).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      requestId: 'q1',
      answers: { which: ['a', 'b'] },
    });
    store.dispose();
  });
});
