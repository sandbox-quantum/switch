import { describe, expect, it, vi } from 'vitest';
import {
  bindTurns,
  foldTurnEndNotices,
  groupTurns,
  isThinking,
  placeTurns,
  toolState,
  type TurnActivity,
  turnTools,
} from '@renderer/features/chats/activity-join';
import {
  type ActivityApi,
  AgentActivities,
} from '@renderer/features/chats/stores/chat-activity-store';
import {
  type ChatActivityItem,
  type ChatApproval,
  type RoomActivity,
  SERVER_TOO_OLD_FOR_ACTIVITY,
} from '@shared/core/chats/activity';
import type { ChatMessage } from '@shared/core/chats/chats';
import { RpcError } from '@shared/lib/ipc/rpc-error';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@renderer/utils/logger', () => ({ log: { warn } }));

let clock = 0;
function row(
  turnId: string,
  itemId: string,
  extra: Partial<ChatActivityItem> = {}
): ChatActivityItem {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
  return {
    agentId: 'agent-a',
    sessionId: 's1',
    turnId,
    itemId,
    kind: itemId === 'turn' ? 'turn' : 'tool-activity',
    revision: 1,
    status: itemId === 'turn' ? 'running' : 'completed',
    title: '',
    text: '',
    commandId: null,
    roomId: 'room-1',
    threadId: null,
    messageId: `m-${turnId}`,
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

function approval(turnId: string, extra: Partial<ChatApproval> = {}): ChatApproval {
  return {
    agentId: 'agent-a',
    sessionId: 's1',
    requestId: `req-${turnId}`,
    turnId,
    kind: 'approval',
    roomId: 'room-1',
    threadId: null,
    title: 'Run tests?',
    detail: null,
    options: [{ id: 'yes', label: 'Yes', decision: 'accept' }],
    questions: [],
    state: 'open',
    expiresAt: null,
    answer: null,
    answers: null,
    answeredBy: null,
    answeredAt: null,
    ...extra,
  };
}

function turnOf(items: ChatActivityItem[], status: TurnActivity['status']): TurnActivity {
  return {
    sessionId: 's1',
    turnId: 't1',
    status,
    roomId: 'room-1',
    messageId: 'm1',
    items,
    requests: [],
  };
}

describe('placeTurns', () => {
  const said = (messageId: string, agentId: string | null): ChatMessage =>
    ({
      messageId,
      body: messageId,
      sender: { kind: agentId ? 'agent' : 'human', agentId, clientId: agentId ?? 'me' },
    }) as unknown as ChatMessage;
  const turn = (turnId: string, status: TurnActivity['status'] = 'completed'): TurnActivity => ({
    sessionId: 's1',
    turnId,
    status,
    roomId: 'room-1',
    messageId: null,
    items: [],
    requests: [],
  });
  const ids = (placed: Map<string, TurnActivity[]>) =>
    Object.fromEntries([...placed].map(([at, turns]) => [at, turns.map((each) => each.turnId)]));

  it('shows a turn under the message that started it', () => {
    const messages = [said('q1', null), said('r1', 'helper'), said('q2', null)];
    const bound = new Map([
      ['q1', turn('t1')],
      ['q2', turn('t2', 'running')],
    ]);
    expect(ids(placeTurns(messages, 'helper', bound))).toEqual({ q1: ['t1'], q2: ['t2'] });
  });

  it('shows a queued turn under the reply to the turn it waited for', () => {
    const bound = new Map([
      ['q1', turn('t1', 'running')],
      ['q2', turn('t2', 'queued')],
    ]);
    expect(ids(placeTurns([said('q1', null), said('q2', null)], 'helper', bound))).toEqual({
      q1: ['t1'],
      q2: ['t2'],
    });
    const replied = [said('q1', null), said('q2', null), said('r1', 'helper')];
    expect(ids(placeTurns(replied, 'helper', bound))).toEqual({ q1: ['t1'], r1: ['t2'] });
  });

  it('chains turns queued one after another under each reply in turn', () => {
    const messages = [
      said('q1', null),
      said('q2', null),
      said('q3', null),
      said('r1', 'helper'),
      said('other', 'reviewer'),
      said('r2', 'helper'),
    ];
    const bound = new Map([
      ['q1', turn('t1')],
      ['q2', turn('t2')],
      ['q3', turn('t3', 'running')],
    ]);
    expect(ids(placeTurns(messages, 'helper', bound))).toEqual({
      q1: ['t1'],
      r1: ['t2'],
      r2: ['t3'],
    });
  });

  it("shows a turn after the agent's messages sent before its first step", () => {
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const timed = (message: ChatMessage, second: number) =>
      ({ ...message, sentAt: at(second) }) as ChatMessage;
    const messages = [
      timed(said('q1', null), 0),
      timed(said('ack', 'helper'), 1),
      timed(said('r1', 'helper'), 5),
    ];
    const started = {
      ...turn('t1'),
      items: [row('t1', 'tool', { createdAt: at(3) })],
    };
    expect(ids(placeTurns(messages, 'helper', new Map([['q1', started]])))).toEqual({
      ack: ['t1'],
    });
    // Before its first step, or another agent's message, it stays under the question.
    expect(ids(placeTurns(messages, 'helper', new Map([['q1', turn('t1')]])))).toEqual({
      q1: ['t1'],
    });
    expect(ids(placeTurns(messages, 'reviewer', new Map([['q1', started]])))).toEqual({
      q1: ['t1'],
    });
  });

  it('never shows a turn under a Retry’s acknowledgement, which the chat leaves out', () => {
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const messages = [
      { ...said('q1', null), sentAt: at(0) },
      {
        ...said('failed', 'helper'),
        body: 'I finished without replying. The turn failed: model',
        sentAt: at(2),
      },
      { ...said('retry', null), body: '!retry @helper q1', sentAt: at(3) },
      {
        ...said('ack', 'helper'),
        body: 'Trying that message again.',
        threadRootId: 'retry',
        sentAt: at(4),
      },
    ] as ChatMessage[];
    const retried = {
      ...turn('t2', 'error'),
      items: [row('t2', 'tool', { createdAt: at(5) })],
    };
    expect(ids(placeTurns(messages, 'helper', new Map([['q1', retried]])))).toEqual({
      q1: ['t2'],
    });
  });

  it('does not wait on a reply from a turn that ended with an error', () => {
    const messages = [said('q1', null), said('q2', null), said('r2', 'helper')];
    const bound = new Map([
      ['q1', turn('t1', 'error')],
      ['q2', turn('t2')],
    ]);
    expect(ids(placeTurns(messages, 'helper', bound))).toEqual({ q1: ['t1'], q2: ['t2'] });
  });
});

describe('foldTurnEndNotices', () => {
  const said = (messageId: string, agentId: string | null, body = messageId): ChatMessage =>
    ({
      messageId,
      body,
      sender: { kind: agentId ? 'agent' : 'human', agentId, clientId: agentId ?? 'me' },
    }) as unknown as ChatMessage;
  const turn = (turnId: string, status: TurnActivity['status']): TurnActivity => ({
    sessionId: 's1',
    turnId,
    status,
    roomId: 'room-1',
    messageId: null,
    items: [],
    requests: [],
  });
  const interrupted = 'I finished without replying. The turn was interrupted: Claude turn ended';

  it("folds a notice into the agent's last turn when that turn shows the same ending", () => {
    const messages = [
      said('q1', null),
      said('q2', null),
      said('r1', 'helper'),
      said('n2', 'helper', interrupted),
    ];
    const bound = new Map([
      ['q1', turn('t1', 'completed')],
      ['q2', turn('t2', 'interrupted')],
    ]);
    expect(foldTurnEndNotices(messages, 'helper', bound)).toEqual(new Map([['n2', 't2']]));
  });

  it('folds the notice of a stopped turn that a queued turn followed', () => {
    const messages = [
      said('what means second', null),
      said('actually', null),
      said('n1', 'helper', 'I finished without replying. The turn was interrupted: error'),
    ];
    const bound = new Map([
      ['what means second', turn('t1', 'interrupted')],
      ['actually', turn('t2', 'running')],
    ]);
    expect(foldTurnEndNotices(messages, 'helper', bound)).toEqual(new Map([['n1', 't1']]));
  });

  it('gives each stopped turn one notice at most', () => {
    const messages = [
      said('q1', null),
      said('n1', 'helper', interrupted),
      said('q2', null),
      said('n2', 'helper', interrupted),
      said('n3', 'helper', interrupted),
    ];
    const bound = new Map([
      ['q1', turn('t1', 'interrupted')],
      ['q2', turn('t2', 'interrupted')],
    ]);
    expect(foldTurnEndNotices(messages, 'helper', bound)).toEqual(
      new Map([
        ['n1', 't1'],
        ['n2', 't2'],
      ])
    );
  });

  it('folds the last failure into a turn run again for the same message, leaving the first shown', () => {
    const failed = 'I finished without replying. The turn failed: model not supported';
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const messages = [
      { ...said('q1', null), sentAt: at(0) },
      { ...said('n1', 'helper', failed), sentAt: at(2) },
      { ...said('n2', 'helper', failed), sentAt: at(9) },
    ] as ChatMessage[];
    const retried = { ...turn('t2', 'error'), items: [row('t2', 'tool', { createdAt: at(5) })] };
    const bound = new Map([['q1', retried]]);
    expect(foldTurnEndNotices(messages, 'helper', bound)).toEqual(new Map([['n2', 't2']]));
  });

  it('keeps a notice whose turn shows no such ending, or is not known', () => {
    const messages = [said('q1', null), said('n1', 'helper', interrupted)];
    expect(
      foldTurnEndNotices(messages, 'helper', new Map([['q1', turn('t1', 'running')]]))
    ).toEqual(new Map());
    expect(foldTurnEndNotices(messages, 'helper', new Map())).toEqual(new Map());
    expect(
      foldTurnEndNotices(messages, 'reviewer', new Map([['q1', turn('t1', 'interrupted')]]))
    ).toEqual(new Map());
  });

  it('does not take a notice as the reply a queued turn waits for', () => {
    const messages = [
      said('q1', null),
      said('q2', null),
      said('n1', 'helper', 'I finished without replying.'),
      said('r2', 'helper'),
    ];
    const bound = new Map([
      ['q1', turn('t1', 'completed')],
      ['q2', turn('t2', 'running')],
    ]);
    expect([...placeTurns(messages, 'helper', bound).keys()]).toEqual(['q1', 'r2']);
  });
});

describe('bindTurns', () => {
  it('joins each turn to the room message its rows name, with its steps and requests', () => {
    const turns = groupTurns(
      [
        row('t1', 'turn', { status: 'completed' }),
        row('t1', 'grep', { title: 'grep' }),
        row('t1', 'reply', { kind: 'assistant-message', text: 'done' }),
        row('t2', 'turn'),
        row('t3', 'turn', { roomId: 'room-2' }),
        row('t4', 'turn', { messageId: null, commandId: 'cmd' }),
        row('t5', 'orphan'),
      ],
      [approval('t2')]
    );
    const bound = bindTurns(turns, 'room-1');
    expect([...bound.keys()]).toEqual(['m-t1', 'm-t2']);
    expect(bound.get('m-t1')!.items.map((each) => each.kind)).toEqual([
      'tool-activity',
      'assistant-message',
    ]);
    expect(bound.get('m-t2')!.requests.map((each) => each.requestId)).toEqual(['req-t2']);
    expect(isThinking(bound.get('m-t2')!)).toBe(true);
    expect(isThinking(bound.get('m-t1')!)).toBe(false);
  });

  it('keeps a turn thinking while it has written text but run no tool', () => {
    const turn = turnOf(
      [row('t1', 'draft', { kind: 'assistant-message', text: 'draft' })],
      'running'
    );
    expect(isThinking(turn)).toBe(true);
  });

  it('shows a running subagent as work, so the turn is not thinking', () => {
    const turn = turnOf(
      [row('t1', 'child', { kind: 'subagent', status: 'in-progress', title: 'Audit parser' })],
      'running'
    );
    expect(turnTools(turn).map((each) => each.title)).toEqual(['Audit parser']);
    expect(isThinking(turn)).toBe(false);
  });

  it('thinks between tools and not while a visible tool runs', () => {
    const tool = row('t1', 'tool', { status: 'in-progress' });
    expect(isThinking(turnOf([tool], 'running'))).toBe(false);
    const done = { ...tool, status: 'completed' };
    expect(isThinking(turnOf([done], 'running'))).toBe(true);
    expect(isThinking(turnOf([done], 'completed'))).toBe(false);
    const streaming = row('t1', 'msg', { kind: 'assistant-message', status: 'in-progress' });
    expect(isThinking(turnOf([streaming], 'running'))).toBe(true);
  });

  it('is thinking when only hidden tools are running', () => {
    const postMessage = row('t1', 'post', {
      title: 'mcp__switch__post_message',
      status: 'in-progress',
    });
    expect(isThinking(turnOf([postMessage], 'running'))).toBe(true);
    const sendTargeted = row('t1', 'send', {
      title: 'mcp__switch__send_targeted_message',
      status: 'in-progress',
    });
    expect(isThinking(turnOf([sendTargeted], 'running'))).toBe(true);
    const toolSearch = row('t1', 'search', { title: 'ToolSearch', status: 'in-progress' });
    expect(isThinking(turnOf([toolSearch], 'running'))).toBe(true);
    const listBridges = row('t1', 'list', {
      title: 'mcp__switch__list_bridges',
      status: 'in-progress',
    });
    expect(isThinking(turnOf([listBridges], 'running'))).toBe(false);
  });

  it('returns only visible tools, filtering out post_message, send_targeted_message, ToolSearch and assistant text', () => {
    const turn = turnOf(
      [
        row('t1', 'a', { title: 'mcp__switch__read_context' }),
        row('t1', 'b', { title: 'ToolSearch' }),
        row('t1', 'c', { title: 'ls -la' }),
        row('t1', 'd', { kind: 'assistant-message', text: 'the answer' }),
        row('t1', 'e', { title: 'mcp__switch__post_message' }),
        row('t1', 'f', { title: 'mcp__switch__send_targeted_message' }),
        row('t1', 'g', { title: 'mcp__switch__list_bridges' }),
      ],
      'completed'
    );
    const work = turnTools(turn);
    expect(work.map((each) => each.title)).toEqual([
      'mcp__switch__read_context',
      'ls -la',
      'mcp__switch__list_bridges',
    ]);
  });

  it('shows an unfinished tool of an interrupted turn as failed', () => {
    const tool = row('t', 'tool', { status: 'in-progress' });
    expect(toolState(tool, 'running')).toBe('running');
    expect(toolState(tool, 'interrupted')).toBe('failed');
    expect(toolState({ ...tool, status: 'completed' }, 'running')).toBe('done');
  });

  it('keeps thinking when only hidden post_message is complete and assistant text is streaming', () => {
    const turn = turnOf(
      [
        row('t1', 'post', { title: 'mcp__switch__post_message', status: 'completed' }),
        row('t1', 'msg', { kind: 'assistant-message', status: 'in-progress' }),
      ],
      'running'
    );
    expect(isThinking(turn)).toBe(true);
  });
});

function rpcError(code: string, message: string, data: Record<string, unknown>): RpcError {
  return new RpcError({ code, message, data } as unknown as ConstructorParameters<
    typeof RpcError
  >[0]);
}

function memoryStorage() {
  const held = new Map<string, string>();
  return {
    held,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
  };
}

function fakeApi(snapshots: RoomActivity[], messages: ChatMessage[] = []) {
  const reads: string[] = [];
  const controls: unknown[] = [];
  const api: ActivityApi = {
    resolve: async () => ({
      kind: 'unavailable',
      reason: 'not-on-this-machine',
      message: 'Activity not available on this machine.',
    }),
    reasoning: async () => null,
    watchPlacements: () => () => {},
    roomActivity: async (_server, roomId) => {
      reads.push(roomId);
      return snapshots.shift() ?? { items: [], approvals: [] };
    },
    roomMessages: () => messages,
    retrySupport: async () => 'yes' as const,
    control: async (input) => {
      controls.push(input);
      return 'cmd-1';
    },
    answerApproval: async (input) =>
      approval('t1', { requestId: input.requestId, state: 'answered', answer: 'yes' }),
  };
  return { api, reads, controls };
}

describe('AgentActivities', () => {
  it('reads one snapshot for the agents of a room and keeps them apart', async () => {
    const { api, reads } = fakeApi([
      {
        items: [row('ta', 'turn'), row('tb', 'turn', { agentId: 'agent-b', status: 'completed' })],
        approvals: [],
      },
    ]);
    const activities = new AgentActivities(api, memoryStorage());
    const a = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
    const b = activities.acquire('server', 'tenant', 'room-1', 'agent-b');
    await vi.waitFor(() => expect(b.turns().size).toBe(1));
    expect(reads).toEqual(['room-1']);
    expect(a.working).toBe(true);
    expect(a.runningTurn?.turnId).toBe('ta');
    expect(b.working).toBe(false);
    activities.release(a);
    activities.release(b);
  });

  it('ends a turn the host said failed, though the feed still has it running, after a reopen too', async () => {
    const said = (messageId: string, agentId: string | null, body = messageId) =>
      ({
        messageId,
        body,
        sender: { kind: agentId ? 'agent' : 'human', agentId, clientId: agentId ?? 'me' },
      }) as unknown as ChatMessage;
    const failed =
      'I finished without replying. The turn failed: {"type":"error","status":400,"error":"model_not_found"}';
    const messages = [said('m-t1', null), said('n1', 'agent-a', failed)];
    // The feed lost the turn's last update: every read still has it running.
    const running = { items: [row('t1', 'turn')], approvals: [] };
    const { api } = fakeApi([running, running], messages);
    const activities = new AgentActivities(api, memoryStorage());

    let activity = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    expect(activity.working).toBe(false);
    expect(activity.runningTurn).toBeNull();
    expect(activity.turns().get('m-t1')?.status).toBe('error');
    // The notice folds into the ended turn, which shows the provider's reason.
    expect(foldTurnEndNotices(messages, 'agent-a', activity.turns())).toEqual(
      new Map([['n1', 't1']])
    );

    activities.release(activity);
    activity = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    expect(activity.working).toBe(false);
    activities.release(activity);
  });

  it('keeps a turn running when no notice says it ended', async () => {
    const { api } = fakeApi([{ items: [row('t1', 'turn')], approvals: [] }]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    expect(activity.working).toBe(true);
    activities.release(activity);
  });

  it('asks for a retry of a failed turn once, however often it is pressed', async () => {
    const { api, controls } = fakeApi([
      { items: [row('t1', 'turn', { status: 'error' })], approvals: [] },
    ]);
    let answer: (commandId: string) => void = () => {};
    api.control = (input) => {
      controls.push(input);
      return new Promise((resolve) => (answer = resolve));
    };
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    const turn = activity.turns().get('m-t1')!;

    const first = activity.retry(turn);
    void activity.retry(turn);
    expect(activity.retries.get('t1')?.state).toBe('sending');
    answer('cmd-retry');
    await first;
    void activity.retry(turn);
    expect(controls).toEqual([
      expect.objectContaining({ command: 'retry', messageId: 'm-t1', agentId: 'agent-a' }),
    ]);
    expect(activity.retries.get('t1')).toMatchObject({ state: 'requested', error: null });
    activities.release(activity);
  });

  it('sends a retry whose answer was lost again under the same request id, and says why one failed', async () => {
    const { api, controls } = fakeApi([
      { items: [row('t1', 'turn', { status: 'error' })], approvals: [] },
    ]);
    const outcomes = [
      () => Promise.reject(rpcError('GatewayError', 'socket hang up', { kind: 'network' })),
      () =>
        Promise.reject(
          rpcError('ChatApiError', 'helper took no turn for that message.', {
            status: 409,
            code: 'NOTHING_TO_RETRY',
          })
        ),
    ];
    api.control = (input) => {
      controls.push(input);
      return outcomes.shift()!();
    };
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    const turn = activity.turns().get('m-t1')!;
    await activity.retry(turn);
    await activity.retry(turn);
    const [lost, again] = controls as { requestId: string }[];
    expect(again!.requestId).toBe(lost!.requestId);
    expect(activity.retries.get('t1')?.state).toBe('failed');
    expect(activity.retries.get('t1')?.error).toBeTruthy();
    activities.release(activity);
  });

  it('merges live rows with the snapshot by revision, dropping stale ones', async () => {
    const snapshotTool = row('t1', 'tool', { revision: 5, title: 'from snapshot' });
    const { api } = fakeApi([{ items: [row('t1', 'turn'), snapshotTool], approvals: [] }]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    // A newer row arrives over the feed before the snapshot is read.
    activities.applyItem('server', { ...snapshotTool, revision: 7, title: 'live' });
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    expect(activity.turns().get('m-t1')!.items[0].title).toBe('live');
    activities.applyItem('server', { ...snapshotTool, revision: 7, title: 'replayed' });
    activities.applyItem('server', { ...snapshotTool, revision: 6, title: 'stale' });
    expect(activity.turns().get('m-t1')!.items[0].title).toBe('live');
    activities.applyItem('server', { ...snapshotTool, revision: 8, title: 'newer' });
    expect(activity.turns().get('m-t1')!.items[0].title).toBe('newer');
    activities.applyItem('server', row('t1', 'other-room', { roomId: 'room-2' }));
    expect(activity.turns().get('m-t1')!.items).toHaveLength(1);
    activities.release(activity);
  });

  it('reads every shown room again on resync, and says when a read fails', async () => {
    const { api, reads } = fakeApi([
      { items: [], approvals: [] },
      { items: [row('t1', 'turn', { status: 'completed' })], approvals: [] },
    ]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(reads).toEqual(['room-1']));
    activities.resync('server');
    activities.resync('other-server');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    expect(reads).toEqual(['room-1', 'room-1']);
    api.roomActivity = async () => {
      throw new Error('Switch did not answer.');
    };
    await activities.loadRoom('server', 'room-1');
    expect(activity.feedError).toContain('Switch did not answer.');
    activities.release(activity);
  });

  it('never reopens an answered request from an older copy', async () => {
    const { api } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await activities.loadRoom('server', 'room-1');
    activities.applyItem('server', row('t1', 'turn'));
    activities.applyApproval('server', approval('t1'));
    await activity.answer(approval('t1'), { answer: 'yes' });
    activities.applyApproval('server', approval('t1'));
    expect(activity.turns().get('m-t1')!.requests[0]).toMatchObject({
      state: 'answered',
      answer: 'yes',
    });
    activities.release(activity);
  });

  it('keeps a settled request settled when a resync snapshot still has it open', async () => {
    const { api } = fakeApi([
      { items: [row('t1', 'turn')], approvals: [] },
      { items: [row('t1', 'turn')], approvals: [approval('t1'), approval('t2')] },
    ]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    activities.applyApproval('server', approval('t1', { state: 'expired' }));
    await activities.loadRoom('server', 'room-1');
    expect(activity.turns().get('m-t1')!.requests[0].state).toBe('expired');
    expect(activity.approvals.size).toBe(2);
    activities.applyApproval('server', approval('t1', { state: 'closed' }));
    expect(activity.turns().get('m-t1')!.requests[0].state).toBe('closed');
    activities.release(activity);
  });

  it('posts Stop to the room and holds its command id as requested', async () => {
    const { api, controls } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await activity.control('interrupt');
    expect(controls).toEqual([
      {
        serverId: 'server',
        roomId: 'room-1',
        requestId: activity.controls[0].requestId,
        agentId: 'agent-a',
        command: 'interrupt',
        messageId: null,
      },
    ]);
    expect(activity.controls[0]).toMatchObject({ state: 'requested', commandId: 'cmd-1' });
    api.control = async () => {
      throw rpcError('ChatApiError', 'That agent is not in this chat.', {
        apiCode: 'NOT_A_MEMBER',
      });
    };
    await activity.control('reset');
    expect(activity.controls).toHaveLength(1);
    expect(activity.controls[0]).toMatchObject({ command: 'reset', state: 'failed' });
    expect(activity.controls[0].error).toContain('That agent is not in this chat.');
    activities.release(activity);
  });

  it('keeps the request id of a command whose answer was lost until a retry settles it', async () => {
    const { api, controls } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    const sent = () => (controls as { requestId: string }[]).map((input) => input.requestId);
    api.control = async (input) => {
      controls.push(input);
      throw rpcError('GatewayError', 'socket hang up', { kind: 'network' });
    };
    await activity.control('reset');
    expect(activity.controls[0]).toMatchObject({ state: 'unknown' });
    // A second click, the Retry button and a feed reconnect all reuse the request id.
    await activity.control('reset');
    await activity.retryControl(activity.controls[0].requestId);
    activity.dismissControl(activity.controls[0].requestId);
    expect(activity.controls).toHaveLength(1);
    api.control = async (input) => {
      controls.push(input);
      return 'cmd-1';
    };
    activities.resync('server');
    await vi.waitFor(() => expect(activity.controls[0]).toMatchObject({ state: 'requested' }));
    expect(new Set(sent()).size).toBe(1);
    expect(sent()).toHaveLength(4);
    // Settled: the next Reset is a new request.
    await activity.control('reset');
    expect(new Set(sent()).size).toBe(2);
    activities.release(activity);
  });

  it('keeps the request id of a lost command across leaving and reopening the chat', async () => {
    const { api, controls } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    const sent = () => (controls as { requestId: string }[]).map((input) => input.requestId);
    api.control = async (input) => {
      controls.push(input);
      throw rpcError('GatewayError', 'socket hang up', { kind: 'network' });
    };
    const first = activities.acquire('server', null, 'room-1', 'agent-a');
    await first.control('reset');
    activities.release(first);
    const reopened = activities.acquire('server', null, 'room-1', 'agent-a');
    expect(reopened.controls[0]).toMatchObject({ state: 'unknown' });
    await reopened.control('reset');
    expect(new Set(sent()).size).toBe(1);
    activities.release(reopened);
  });

  it('keeps the request id of a command still sending when the chat closes', async () => {
    const { api, controls } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    const sent = () => (controls as { requestId: string }[]).map((input) => input.requestId);
    let fail!: (error: unknown) => void;
    api.control = (input) => {
      controls.push(input);
      return new Promise((_resolve, reject) => (fail = reject));
    };
    const first = activities.acquire('server', null, 'room-1', 'agent-a');
    const pending = first.control('reset');
    activities.release(first);
    fail(rpcError('GatewayError', 'socket hang up', { kind: 'network' }));
    await pending;
    const reopened = activities.acquire('server', null, 'room-1', 'agent-a');
    expect(reopened.controls[0]).toMatchObject({ state: 'unknown' });
    api.control = async (input) => {
      controls.push(input);
      return 'cmd-1';
    };
    await reopened.control('reset');
    expect(new Set(sent()).size).toBe(1);
    activities.release(reopened);
  });

  it('does not bring back a parked command that settled after the chat closed', async () => {
    const { api } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    let answer!: (commandId: string) => void;
    api.control = () => new Promise((resolve) => (answer = resolve));
    const first = activities.acquire('server', null, 'room-1', 'agent-a');
    const pending = first.control('reset');
    activities.release(first);
    answer('cmd-1');
    await pending;
    const reopened = activities.acquire('server', null, 'room-1', 'agent-a');
    expect(reopened.controls).toHaveLength(0);
    activities.release(reopened);
  });

  it('settles a lost command after a reload, and forgets it on drop', async () => {
    const { api, controls } = fakeApi([]);
    const storage = memoryStorage();
    const sent = () => (controls as { requestId: string }[]).map((input) => input.requestId);
    let fail!: (error: unknown) => void;
    api.control = async (input) => {
      controls.push(input);
      if (input.command === 'compact') return new Promise((_resolve, reject) => (fail = reject));
      throw rpcError('GatewayError', 'socket hang up', { kind: 'network' });
    };
    const before = new AgentActivities(api, storage);
    const first = before.acquire('server', 't', 'room-1', 'agent-a');
    await first.control('reset');
    void first.control('compact');
    await vi.waitFor(() => expect(first.controls).toHaveLength(2));

    // The window reloads: Reset is still unknown and Compact, mid-send, comes back unknown.
    const after = new AgentActivities(api, storage);
    const reopened = after.acquire('server', 't', 'room-1', 'agent-a');
    expect(reopened.controls.map((control) => [control.command, control.state])).toEqual([
      ['reset', 'unknown'],
      ['compact', 'unknown'],
    ]);
    api.control = async (input) => {
      controls.push(input);
      return 'cmd-1';
    };
    await reopened.control('reset');
    expect(new Set(sent()).size).toBe(2);
    expect(storage.held.get('switch-console.chat-controls')).not.toContain('reset');

    after.drop('server', null);
    expect(storage.held.get('switch-console.chat-controls')).toBe('[]');
    fail(rpcError('GatewayError', 'socket hang up', { kind: 'network' }));
  });

  it('shows only the outcome of the command settled last', async () => {
    const { api } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await activity.control('interrupt');
    await activity.control('interrupt');
    expect(activity.controls).toHaveLength(1);
    api.control = async () => {
      throw rpcError('GatewayError', 'socket hang up', { kind: 'network' });
    };
    await activity.control('reset');
    expect(activity.controls.map((control) => control.state)).toEqual(['requested', 'unknown']);
    activities.release(activity);
  });

  it('says plainly when the server predates chat activity', async () => {
    const { api } = fakeApi([]);
    const tooOld = () =>
      rpcError('GatewayError', 'Switch gateway returned 404', {
        kind: 'http',
        status: 404,
      });
    api.roomActivity = async () => {
      throw tooOld();
    };
    api.control = async () => {
      throw tooOld();
    };
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.feedError).toBe(SERVER_TOO_OLD_FOR_ACTIVITY));
    await activity.control('reset');
    expect(activity.controls[0]).toMatchObject({
      state: 'failed',
      error: SERVER_TOO_OLD_FOR_ACTIVITY,
    });
    activities.release(activity);
  });

  it('forgets a lost command when the server or room is dropped', async () => {
    const { api } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    api.control = async () => {
      throw rpcError('GatewayError', 'socket hang up', { kind: 'network' });
    };
    for (const drop of [
      () => activities.drop('server', null),
      () => activities.drop('server', 'room-1'),
    ]) {
      const first = activities.acquire('server', null, 'room-1', 'agent-a');
      await first.control('reset');
      activities.release(first);
      drop();
      const reopened = activities.acquire('server', null, 'room-1', 'agent-a');
      expect(reopened.controls).toHaveLength(0);
      activities.release(reopened);
    }
  });

  it('ignores the answer of a snapshot read that a newer read or a drop superseded', async () => {
    const { api } = fakeApi([]);
    const activities = new AgentActivities(api, memoryStorage());
    const running: RoomActivity = { items: [row('t1', 'turn')], approvals: [] };
    const empty: RoomActivity = { items: [], approvals: [] };
    const first = activities.acquire('server', null, 'room-1', 'agent-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending: { resolve: (a: RoomActivity) => void; reject: (e: unknown) => void }[] = [];
    api.roomActivity = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));

    // A newer read answers first: the older one's answer and error are both ignored.
    const older = activities.loadRoom('server', 'room-1');
    const failing = activities.loadRoom('server', 'room-1');
    const newer = activities.loadRoom('server', 'room-1');
    pending[2].resolve(empty);
    await newer;
    pending[0].resolve(running);
    pending[1].reject(new Error('late failure'));
    await Promise.all([older, failing]);
    expect(first.working).toBe(false);
    expect(first.feedError).toBeNull();

    // A read from before a drop never reaches the activity acquired after it.
    const beforeDrop = activities.loadRoom('server', 'room-1');
    activities.drop('server', null);
    api.roomActivity = async () => empty;
    const current = activities.acquire('server', null, 'room-1', 'agent-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[3].resolve(running);
    await beforeDrop;
    expect(current.items.size).toBe(0);
    activities.release(current);
  });

  it('drops rows and settled requests a snapshot no longer has, keeping live ones from during the read', async () => {
    const { api } = fakeApi([
      { items: [row('t1', 'turn')], approvals: [approval('t1', { state: 'answered' })] },
    ]);
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.working).toBe(true));
    expect(activity.approvals.size).toBe(1);
    let release!: (snapshot: RoomActivity) => void;
    api.roomActivity = () => new Promise((resolve) => (release = resolve));
    const load = activities.loadRoom('server', 'room-1');
    // Arrives over the live feed while the snapshot is read; the snapshot predates it.
    activities.applyItem('server', row('t2', 'turn'));
    activities.applyApproval('server', approval('t2'));
    release({ items: [], approvals: [] });
    await load;
    expect(activity.allTurns.map((turn) => turn.turnId)).toEqual(['t2']);
    expect([...activity.approvals.values()].map((each) => each.turnId)).toEqual(['t2']);
    activities.release(activity);
  });

  it('says the activity feed is down until it is live again', () => {
    const activities = new AgentActivities(fakeApi([]).api, memoryStorage());
    activities.feedState('server', 'offline', 'The server closed the activity feed.');
    expect(activities.feedDown.get('server')).toBe('The server closed the activity feed.');
    activities.feedState('server', 'live', null);
    expect(activities.feedDown.has('server')).toBe(false);
  });

  it('reads reasoning and tool details from a local host for its own session only', async () => {
    const tool = {
      itemId: '["t1","tool"]',
      type: 'tool_call',
      toolName: 'Read',
      input: { file_path: '/a.ts' },
      output: 'x',
      truncated: false,
      exitCode: null,
    };
    const asked: string[][] = [];
    const { api } = fakeApi([]);
    api.resolve = async () => ({
      kind: 'session',
      target: 'local',
      hostAgentKey: 'console-a',
      sessionId: 's1',
    });
    api.reasoning = async (_key, _session, turnIds) => {
      asked.push(turnIds ?? []);
      return { epoch: 'e1', turns: [], tools: [{ turnId: 't1', tools: [tool] }] };
    };
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.target?.kind).toBe('session'));
    await activity.readReasoning([
      { ...turnOf([], 'completed'), turnId: 't1' },
      { ...turnOf([], 'completed'), turnId: 't0', sessionId: 'older-session' },
    ]);
    expect(asked).toEqual([['t1']]);
    expect(activity.toolDetails.get(tool.itemId)).toEqual(tool);
    activities.release(activity);
  });

  it('shows a failed reasoning read once, warning once, until a read succeeds', async () => {
    let fail = true;
    const { api } = fakeApi([]);
    api.resolve = async () => ({
      kind: 'session',
      target: 'local',
      hostAgentKey: 'console-a',
      sessionId: 's1',
    });
    api.reasoning = async () => {
      if (fail) throw new Error('Host unreachable');
      return { epoch: 'e1', turns: [] };
    };
    const activities = new AgentActivities(api, memoryStorage());
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.target?.kind).toBe('session'));
    const turns = [{ ...turnOf([], 'running'), turnId: 't1' }];
    warn.mockClear();
    await activity.readReasoning(turns);
    await activity.readReasoning(turns);
    expect(activity.reasoningError).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    fail = false;
    await activity.readReasoning(turns);
    expect(activity.reasoningError).toBeNull();
    activities.release(activity);
  });
});
