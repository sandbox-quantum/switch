import {
  type ChatView,
  SessionChatClient,
  type SessionTransport,
} from '@switch-console/shared/session-v1';
import { makeAutoObservable, observable, runInAction } from 'mobx';
import { failureText } from '@renderer/lib/errors/describe-failure';
import {
  activityKeyString,
  type ChatActivityKey,
  type ChatActivityTarget,
} from '@shared/core/chats/activity';
import type { ChatMessage } from '@shared/core/chats/chats';
import { roomCommandId } from '@shared/core/chats/room-command-id';
import type { ReasoningList, ReasoningTurn } from '@shared/core/sessions/reasoning';
import { ActivityBindings, bindTurns, type TurnActivity } from '../activity-join';

/**
 * What one agent is doing in one chat, from its session on this machine, its
 * SSH host or its controller: the session found for the room, a client on the
 * session's journal, and its turns joined to the room messages that started
 * them.
 *
 * Read-only toward the agent's work: nothing here sends the person's message
 * (that is only ever a post to the room), and nothing starts a session. The
 * client is used for the controls the session itself offers — Stop, model,
 * approvals — aimed at exactly the session and epoch shown.
 */

export type ActivityApi = {
  resolve: (serverId: string, agentId: string, roomId: string) => Promise<ChatActivityTarget>;
  transport: (target: Extract<ChatActivityTarget, { kind: 'session' }>) => SessionTransport;
  reasoning: (
    hostAgentKey: string,
    sessionId: string,
    turnIds: string[] | null
  ) => Promise<ReasoningList | null>;
  /** Call `onChange` whenever the server's local or SSH placements change. */
  watchPlacements: (serverId: string, onChange: () => void) => () => void;
};

type SessionTarget = Extract<ChatActivityTarget, { kind: 'session' }>;

const sameSession = (a: ChatActivityTarget | null, b: ChatActivityTarget): boolean =>
  a?.kind === 'session' &&
  b.kind === 'session' &&
  a.hostAgentKey === b.hostAgentKey &&
  a.sessionId === b.sessionId &&
  a.target === b.target &&
  a.controllerId === b.controllerId &&
  a.generation === b.generation;

export class AgentActivity {
  target: ChatActivityTarget | null = null;
  resolveError: string | null = null;
  client: SessionChatClient | null = null;
  view: ChatView | null = null;
  /** Room message id → the command id its turn runs under, for the session's agent. */
  commandIds = new Map<string, string>();
  reasoning = new Map<string, ReasoningTurn>();
  private readonly bindings = new ActivityBindings();
  private lastKnownKey: ChatActivityKey | null = null;
  private lastKnownCommandIds = new Map<string, string>();
  private offView: (() => void) | null = null;
  private resolving = false;

  constructor(
    readonly serverId: string,
    readonly tenantId: string | null,
    readonly roomId: string,
    readonly agentId: string,
    private readonly api: ActivityApi
  ) {
    makeAutoObservable<
      AgentActivity,
      'api' | 'bindings' | 'lastKnownKey' | 'lastKnownCommandIds' | 'offView' | 'resolving'
    >(this, {
      api: false,
      bindings: false,
      lastKnownKey: false,
      lastKnownCommandIds: false,
      offView: false,
      resolving: false,
      client: observable.ref,
      view: observable.ref,
      target: observable.ref,
    });
  }

  /** The identity bindings are kept under; null until the session's epoch is known. */
  get key(): ChatActivityKey | null {
    const target = this.target;
    const epoch = this.view?.snapshot?.session.epoch;
    if (target?.kind !== 'session' || !epoch) return null;
    return {
      serverId: this.serverId,
      tenantId: this.tenantId,
      roomId: this.roomId,
      agentId: this.agentId,
      target: target.target,
      controllerId: target.controllerId,
      generation: target.generation,
      sessionId: target.sessionId,
      epoch,
    };
  }

  get session() {
    return this.view?.snapshot?.session ?? null;
  }

  /** The turn running now in this session, which Stop interrupts. */
  get runningTurn() {
    return this.view?.snapshot?.turns.find((turn) => turn.status === 'running') ?? null;
  }

  get working(): boolean {
    return Boolean(
      this.view?.snapshot?.turns.some(
        (turn) => turn.status === 'running' || turn.status === 'queued'
      )
    );
  }

  /** Turns joined to room messages, under the current key only. */
  turns(): Map<string, TurnActivity> {
    const key = this.key;
    const snapshot = this.view?.snapshot;
    if (!key || !snapshot) {
      if (this.lastKnownKey) {
        return this.bindings.lastKnown();
      }
      return new Map();
    }
    const bound = this.bindings.update(
      activityKeyString(key),
      bindTurns(snapshot, this.roomId, this.commandIds)
    );
    this.lastKnownKey = key;
    this.lastKnownCommandIds = new Map(this.commandIds);
    return bound;
  }

  async resolve(): Promise<void> {
    if (this.resolving) return;
    this.resolving = true;
    try {
      const target = await this.api.resolve(this.serverId, this.agentId, this.roomId);
      runInAction(() => {
        this.resolveError = null;
        if (sameSession(this.target, target)) {
          this.target = target;
          return;
        }
        this.closeClient();
        this.target = target;
        if (target.kind === 'session') this.openClient(target);
      });
    } catch (error) {
      runInAction(() => {
        this.resolveError = failureText(error, "The agent's session could not be looked up.");
      });
    } finally {
      this.resolving = false;
    }
  }

  /** Derive the command ids of the human messages not seen yet. */
  async learnMessages(messages: ChatMessage[]): Promise<void> {
    const agentId = this.session?.agentId;
    if (!agentId) return;
    const fresh = messages.filter(
      (message) => message.sender.kind === 'human' && !this.commandIds.has(message.messageId)
    );
    const derived = await Promise.all(
      fresh.map(
        async (message) =>
          [message.messageId, await roomCommandId(agentId, this.roomId, message.messageId)] as const
      )
    );
    runInAction(() => {
      for (const [messageId, commandId] of derived) this.commandIds.set(messageId, commandId);
    });
  }

  /** Ask the host for the reasoning of these turns; local and SSH hosts only. */
  async readReasoning(turnIds: string[]): Promise<void> {
    const target = this.target;
    if (target?.kind !== 'session' || target.target === 'controller' || !turnIds.length) return;
    const list = await this.api.reasoning(target.hostAgentKey, target.sessionId, turnIds);
    runInAction(() => {
      if (!list || list.epoch !== this.session?.epoch) return;
      for (const turn of list.turns) this.reasoning.set(turn.turnId, turn);
    });
  }

  dispose(): void {
    this.closeClient();
    this.bindings.clear();
  }

  private openClient(target: SessionTarget): void {
    const client = new SessionChatClient(target.sessionId, this.api.transport(target));
    this.client = client;
    this.view = client.getSnapshot();
    this.offView = client.subscribe(() => {
      runInAction(() => {
        const view = client.getSnapshot();
        if (view.snapshot?.session.epoch !== this.view?.snapshot?.session.epoch) {
          this.reasoning = new Map();
          this.commandIds = new Map();
        }
        this.view = view;
      });
    });
    void client.connect();
  }

  private closeClient(): void {
    this.offView?.();
    this.offView = null;
    this.client?.dispose();
    this.client = null;
    this.view = null;
  }
}

/** Activities by server, room and agent, shared by the views showing them. */
export class AgentActivities {
  /** Observable so a view that only peeks (the chat's title bar) follows the one holding it. */
  private readonly entries = observable.map<string, { activity: AgentActivity; users: number }>(
    {},
    { deep: false }
  );
  private readonly watches = new Map<string, () => void>();

  constructor(private readonly api: ActivityApi) {}

  private syncWatches(): void {
    const servers = new Set([...this.entries.values()].map(({ activity }) => activity.serverId));
    for (const serverId of servers)
      if (!this.watches.has(serverId))
        this.watches.set(
          serverId,
          this.api.watchPlacements(serverId, () => this.refresh(serverId, null))
        );
    for (const [serverId, off] of this.watches)
      if (!servers.has(serverId)) {
        off();
        this.watches.delete(serverId);
      }
  }

  acquire(
    serverId: string,
    tenantId: string | null,
    roomId: string,
    agentId: string
  ): AgentActivity {
    const key = JSON.stringify([serverId, tenantId, roomId, agentId]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        activity: new AgentActivity(serverId, tenantId, roomId, agentId, this.api),
        users: 0,
      };
      const created = entry;
      runInAction(() => this.entries.set(key, created));
      this.syncWatches();
      void entry.activity.resolve();
    }
    entry.users += 1;
    return entry.activity;
  }

  /** An activity some view already holds, without holding it. */
  peek(
    serverId: string,
    tenantId: string | null,
    roomId: string,
    agentId: string
  ): AgentActivity | null {
    return (
      this.entries.get(JSON.stringify([serverId, tenantId, roomId, agentId]))?.activity ?? null
    );
  }

  release(activity: AgentActivity): void {
    const key = JSON.stringify([
      activity.serverId,
      activity.tenantId,
      activity.roomId,
      activity.agentId,
    ]);
    const entry = this.entries.get(key);
    if (!entry || entry.activity !== activity) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    entry.activity.dispose();
    runInAction(() => this.entries.delete(key));
    this.syncWatches();
  }

  /** Look again for every activity on the server (placements changed). */
  refresh(serverId: string, agentId: string | null): void {
    for (const { activity } of this.entries.values())
      if (activity.serverId === serverId && (agentId === null || activity.agentId === agentId))
        void activity.resolve();
  }

  /** Close everything for a room the person lost, or a whole server on reset. */
  drop(serverId: string, roomId: string | null): void {
    for (const [key, { activity }] of this.entries)
      if (activity.serverId === serverId && (roomId === null || activity.roomId === roomId)) {
        activity.dispose();
        runInAction(() => this.entries.delete(key));
      }
    this.syncWatches();
  }
}
