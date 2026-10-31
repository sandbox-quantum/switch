import type { ChatUser, ConsoleChatClient } from '../clients/console-chat-client.ts';
import type { RegisteredAgent, RoomDetail, SwitchClient } from '../clients/switch-client.ts';
import type { HarnessAgentType, HarnessEnv } from '../core/env.ts';
import type { NameScope } from '../core/run.ts';

/**
 * What a scenario stands up, and the teardown that removes it.
 *
 * Every artefact is named through the run context and registered for teardown
 * the moment it exists, so a scenario that fails halfway still cleans up what it
 * made. Teardown runs newest first — rooms before the agents in them — and
 * reports every failure rather than stopping at the first, because one leaked
 * room should not hide another.
 */
export class Fixtures {
  readonly env: HarnessEnv;
  readonly names: NameScope;
  readonly switchClient: SwitchClient;
  readonly chat: ConsoleChatClient;
  private readonly cleanups: { label: string; run: () => Promise<void> }[] = [];
  private readonly agentCleanups = new Map<string, { label: string; run: () => Promise<void> }>();

  constructor(
    env: HarnessEnv,
    names: NameScope,
    switchClient: SwitchClient,
    chat: ConsoleChatClient
  ) {
    this.env = env;
    this.names = names;
    this.switchClient = switchClient;
    this.chat = chat;
  }

  /**
   * Register an agent named for `role` in this scope.
   *
   * `autoSession` is off unless asked for: with it on, Switch expects a
   * connector to spawn a session when the agent is addressed, and an operator's
   * Console watching the same server could fight the harness for the room.
   */
  async agent(
    role: string,
    options: {
      autoSession?: boolean;
      agentType?: HarnessAgentType;
      repoDir?: string;
    } = {}
  ): Promise<RegisteredAgent> {
    const name = this.names.name(role);
    const agent = await this.switchClient.registerKnownAgent({
      agentType: options.agentType ?? 'opencode',
      name,
      description: `Switch end-to-end harness agent (run ${this.names.runId}). Safe to delete.`,
      options: {
        auto_session: options.autoSession ?? false,
        ...(options.repoDir ? { repo_dir: options.repoDir } : {}),
      },
    });
    const cleanup = {
      label: `agent ${name} (${agent.id})`,
      run: () => this.switchClient.deleteAgent(agent),
    };
    this.cleanups.push(cleanup);
    this.agentCleanups.set(agent.id, cleanup);
    await this.switchClient.openAddressing(agent.id);
    return agent;
  }

  /** A room with no platform channel: agents only, no bridge involved. */
  async internalRoom(role: string, agents: RegisteredAgent[]): Promise<RoomDetail> {
    const name = this.names.name(role);
    const room = await this.switchClient.createRoom({
      name,
      description: `Switch end-to-end harness (run ${this.names.runId}). Safe to delete.`,
      bridgeId: null,
      agentNames: agents.map((agent) => agent.name),
      userNames: [],
    });
    this.defer(`room ${name} (${room.id})`, () => this.switchClient.deleteRoom(room.id));
    if (room.externalChannelId !== null) {
      throw new Error(`Internal-only room ${room.id} came back with a platform channel.`);
    }
    return room;
  }

  /**
   * An in-Console group chat with `agents`: a Switch room with no bridge, with
   * the gateway admin the harness posts as in it, made the way Switch Console
   * makes one. A message reaches an agent only when it names it, as in a
   * shared channel.
   */
  async consoleRoom(role: string, agents: RegisteredAgent[]): Promise<ConsoleRoom> {
    const human = await this.chat.me();
    const name = this.names.name(role);
    const roomId = await this.chat.createGroupChat({
      name,
      agentIds: agents.map((agent) => agent.id),
    });
    this.defer(`room ${name} (${roomId})`, () => this.switchClient.deleteRoom(roomId));
    const room = await this.switchClient.getRoom(roomId);
    if (room.externalChannelId !== null) {
      throw new Error(`Console room ${room.id} came back with a platform channel.`);
    }
    return { room, human };
  }

  /**
   * The scenario deleted `agent` itself, and checked that it is gone, so
   * teardown has nothing left to remove for it.
   */
  removed(agent: RegisteredAgent): void {
    const cleanup = this.agentCleanups.get(agent.id);
    if (cleanup === undefined) throw new Error(`Agent ${agent.id} was not registered here.`);
    this.agentCleanups.delete(agent.id);
    this.cleanups.splice(this.cleanups.indexOf(cleanup), 1);
  }

  /** Register a cleanup step for something created outside these helpers. */
  defer(label: string, run: () => Promise<void>): void {
    this.cleanups.push({ label, run });
  }

  /**
   * Undo everything, newest first. Never throws: a teardown failure must not
   * mask the scenario's result. Returns what could not be removed, so the
   * caller can print it and an operator can clean up by hand.
   */
  async teardown(): Promise<string[]> {
    if (this.env.keepArtifacts) {
      const kept = this.cleanups.map((cleanup) => cleanup.label);
      this.cleanups.length = 0;
      return kept.map((label) => `kept (SWITCH_E2E_KEEP=1): ${label}`);
    }
    const failures: string[] = [];
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop()!;
      try {
        await cleanup.run();
      } catch (error) {
        failures.push(
          `could not remove ${cleanup.label}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return failures;
  }
}

export interface ConsoleRoom {
  room: RoomDetail;
  /** The human the harness posts as: the gateway admin. */
  human: ChatUser;
}
