import type {
  CommandStatus,
  Item,
  SessionTransport,
  Snapshot,
} from '@switch-console/shared/session-v1';
import { describe, expect, it, vi } from 'vitest';
import {
  ActivityBindings,
  bindTurns,
  isThinking,
  toolState,
  turnTools,
} from '@renderer/features/chats/activity-join';
import {
  type ActivityApi,
  AgentActivities,
} from '@renderer/features/chats/stores/chat-activity-store';
import type { ChatActivityTarget } from '@shared/core/chats/activity';

function item(turnId: string, kind: Item['kind'], extra: Partial<Item> = {}): Item {
  return {
    itemId: `${turnId}-${kind}-${extra.title ?? ''}`,
    turnId,
    revision: 1,
    kind,
    status: 'completed',
    title: '',
    text: '',
    attachments: [],
    origin: null,
    ...extra,
  };
}

function snapshot(sessionId: string, epoch: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    contractVersion: 1,
    throughSequence: 1,
    session: {
      sessionId,
      agentId: `agent-of-${sessionId}`,
      provider: 'claude',
      hostId: 'host',
      epoch,
      status: 'running',
      connectivity: 'online',
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
      pendingRequestIds: [],
    },
    turns: [],
    items: [],
    requests: [],
    commandStatuses: [],
    notices: [],
    nextPageToken: null,
    ...overrides,
  };
}

const origin = (messageId: string, roomId = 'room-1') => ({
  surface: 'switch-web' as const,
  actorId: 'person',
  roomId,
  threadId: null,
  messageId,
});

describe('bindTurns', () => {
  it('joins a turn to its room message by origin or by command id', () => {
    const snap = snapshot('s1', 'e1', {
      turns: [
        { type: 'turn.upsert', turnId: 't1', status: 'completed', commandId: 't1' },
        { type: 'turn.upsert', turnId: 't2', status: 'running', commandId: 'cmd-m2' },
        { type: 'turn.upsert', turnId: 't3', status: 'running', commandId: 'other' },
      ],
      items: [
        item('t1', 'user-message', { origin: origin('m1') }),
        item('t1', 'tool-activity', { title: 'grep' }),
        item('t1', 'assistant-message', { text: 'done' }),
        item('t3', 'user-message', { origin: origin('m9', 'room-2') }),
      ],
    });
    const bound = bindTurns(
      snap,
      'room-1',
      new Map([
        ['m1', 'cmd-m1'],
        ['m2', 'cmd-m2'],
      ])
    );
    expect([...bound.keys()]).toEqual(['m1', 'm2']);
    expect(bound.get('m1')!.items.map((each) => each.kind)).toEqual([
      'tool-activity',
      'assistant-message',
    ]);
    expect(isThinking(bound.get('m2')!)).toBe(true);
    expect(isThinking(bound.get('m1')!)).toBe(false);
  });

  it('keeps a turn thinking while it has written text but run no tool', () => {
    const turn = {
      turnId: 't1',
      status: 'running' as const,
      items: [item('t1', 'assistant-message', { text: 'draft' })],
      requests: [],
    };
    expect(isThinking(turn)).toBe(true);
    expect(isThinking({ ...turn, items: [item('t1', 'tool-activity')] })).toBe(false);
  });

  it("shows tools only, with Switch's own tools set apart", () => {
    const turn = {
      turnId: 't1',
      status: 'completed' as const,
      items: [
        item('t1', 'tool-activity', { title: 'mcp__switch__read_context' }),
        item('t1', 'tool-activity', { title: 'ls -la' }),
        item('t1', 'assistant-message', { text: 'the answer' }),
        item('t1', 'tool-activity', { title: 'mcp__switch__post_message' }),
      ],
      requests: [],
    };
    const { work, switchActions } = turnTools(turn);
    expect(work.map((each) => each.title)).toEqual(['ls -la']);
    expect(switchActions.map((each) => each.title)).toEqual([
      'mcp__switch__read_context',
      'mcp__switch__post_message',
    ]);
  });

  it('shows an unfinished tool of an interrupted turn as failed', () => {
    const tool = item('t', 'tool-activity', { status: 'in-progress' });
    expect(toolState(tool, 'running')).toBe('running');
    expect(toolState(tool, 'interrupted')).toBe('failed');
    expect(toolState({ ...tool, status: 'completed' }, 'running')).toBe('done');
  });
});

describe('ActivityBindings', () => {
  it('drops every binding when the epoch (the key) changes', () => {
    const bindings = new ActivityBindings();
    const turn = { turnId: 't1', status: 'completed' as const, items: [], requests: [] };
    bindings.update('session:e1', new Map([['m1', turn]]));
    expect([...bindings.update('session:e1', new Map()).keys()]).toEqual(['m1']);
    expect([...bindings.update('session:e2', new Map()).keys()]).toEqual([]);
  });
});

function fakeTransport(snap: Snapshot) {
  const submitted: unknown[] = [];
  const transport: SessionTransport = {
    snapshot: async () => snap,
    subscribe: () => () => {},
    submit: async (command) => {
      submitted.push(command);
      return {
        type: 'command.status',
        commandId: command.commandId,
        status: 'applied',
        code: null,
        message: null,
      } satisfies CommandStatus;
    },
    commandStatus: async () => {
      throw new Error('unused');
    },
  };
  return { transport, submitted };
}

describe('AgentActivities', () => {
  it('keeps two agents in one room apart and stops exactly the session shown', async () => {
    const sessions: Record<string, Snapshot> = {
      'agent-a': snapshot('session-a', 'epoch-a', {
        turns: [{ type: 'turn.upsert', turnId: 'turn-a', status: 'running', commandId: null }],
      }),
      'agent-b': snapshot('session-b', 'epoch-b'),
    };
    const transports = new Map<string, ReturnType<typeof fakeTransport>>();
    const api: ActivityApi = {
      resolve: async (_server, agentId): Promise<ChatActivityTarget> => ({
        kind: 'session',
        target: 'local',
        hostAgentKey: `console-${agentId}`,
        sessionId: sessions[agentId]!.session.sessionId,
        controllerId: null,
        generation: null,
        cloud: false,
      }),
      transport: (target) => {
        const agentId = target.hostAgentKey.replace('console-', '');
        const fake = fakeTransport(sessions[agentId]!);
        transports.set(agentId, fake);
        return fake.transport;
      },
      reasoning: async () => null,
      watchPlacements: () => () => {},
    };
    const activities = new AgentActivities(api);
    const a = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
    const b = activities.acquire('server', 'tenant', 'room-1', 'agent-b');
    await vi.waitFor(() => expect(a.key?.epoch).toBe('epoch-a'));
    await vi.waitFor(() => expect(b.key?.epoch).toBe('epoch-b'));
    expect(a.key).toMatchObject({ agentId: 'agent-a', sessionId: 'session-a' });
    expect(b.key).toMatchObject({ agentId: 'agent-b', sessionId: 'session-b' });
    expect(a.working).toBe(true);
    expect(b.working).toBe(false);

    await a.client!.execute({ type: 'turn.interrupt', turnId: a.runningTurn!.turnId }, 'stop-1');
    expect(transports.get('agent-a')!.submitted).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        epoch: 'epoch-a',
        body: { type: 'turn.interrupt', turnId: 'turn-a' },
      }),
    ]);
    expect(transports.get('agent-b')!.submitted).toEqual([]);
    activities.release(a);
    activities.release(b);
  });

  it('opens a new client when the session behind the chat changes', async () => {
    let sessionId = 'session-1';
    const api: ActivityApi = {
      resolve: async () => ({
        kind: 'session',
        target: 'controller',
        hostAgentKey: 'controller:server:agent=a',
        sessionId,
        controllerId: 'ctl',
        generation: sessionId === 'session-1' ? 'g1' : 'g2',
        cloud: false,
      }),
      transport: () => fakeTransport(snapshot(sessionId, `epoch-${sessionId}`)).transport,
      reasoning: async () => null,
      watchPlacements: () => () => {},
    };
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'a');
    await vi.waitFor(() => expect(activity.key?.sessionId).toBe('session-1'));
    const first = activity.client;
    sessionId = 'session-2';
    await activity.resolve();
    await vi.waitFor(() => expect(activity.key?.sessionId).toBe('session-2'));
    expect(activity.client).not.toBe(first);
    expect(activity.key).toMatchObject({ generation: 'g2', epoch: 'epoch-session-2' });
    activities.release(activity);
  });

  it('shows nothing for an agent someone else owns', async () => {
    const api: ActivityApi = {
      resolve: async () => ({
        kind: 'unavailable',
        reason: 'not-owner',
        message: 'Agent activity is visible to its owner.',
        wakeAgentKey: null,
      }),
      transport: () => {
        throw new Error('No session should be opened.');
      },
      reasoning: async () => null,
      watchPlacements: () => () => {},
    };
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'theirs');
    await vi.waitFor(() => expect(activity.target?.kind).toBe('unavailable'));
    expect(activity.client).toBeNull();
    expect(activity.turns().size).toBe(0);
    activities.release(activity);
  });

  it('keeps last known activity visible when controller goes offline', async () => {
    let online = true;
    const api: ActivityApi = {
      resolve: async (): Promise<ChatActivityTarget> =>
        online
          ? {
              kind: 'session',
              target: 'controller',
              hostAgentKey: 'controller:agent-a',
              sessionId: 'session-a',
              controllerId: 'ctl',
              generation: 'g1',
              cloud: false,
            }
          : {
              kind: 'unavailable',
              reason: 'controller-offline',
              message: "The agent's controller is offline.",
              wakeAgentKey: null,
            },
      transport: () =>
        fakeTransport(
          snapshot('session-a', 'epoch-a', {
            turns: [{ type: 'turn.upsert', turnId: 'turn-1', status: 'completed', commandId: null }],
            items: [
              item('turn-1', 'user-message', { origin: origin('m1') }),
              item('turn-1', 'tool-activity', { title: 'test-tool' }),
            ],
          })
        ).transport,
      reasoning: async () => null,
      watchPlacements: () => () => {},
    };
    const activities = new AgentActivities(api);
    const activity = activities.acquire('server', null, 'room-1', 'agent-a');
    await vi.waitFor(() => expect(activity.key?.epoch).toBe('epoch-a'));
    await activity.learnMessages([
      { messageId: 'm1', sender: { kind: 'human', id: 'user' } } as any,
    ]);
    await vi.waitFor(() => expect(activity.turns().size).toBe(1));
    expect(activity.turns().get('m1')?.items[0].title).toBe('test-tool');

    online = false;
    await activity.resolve();
    await vi.waitFor(() => expect(activity.target?.kind).toBe('unavailable'));
    expect(activity.client).toBeNull();
    expect(activity.view).toBeNull();
    expect(activity.turns().size).toBe(1);
    expect(activity.turns().get('m1')?.items[0].title).toBe('test-tool');
    activities.release(activity);
  });
});
