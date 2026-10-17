import type {
  MattermostChannel,
  MattermostClient,
  MattermostUser,
} from '../clients/mattermost-client.ts';
import {
  sleep,
  type RegisteredAgent,
  type RoomDetail,
  type SwitchClient,
} from '../clients/switch-client.ts';
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
  readonly mattermost: MattermostClient | null;
  private readonly cleanups: { label: string; run: () => Promise<void> }[] = [];

  constructor(
    env: HarnessEnv,
    names: NameScope,
    switchClient: SwitchClient,
    mattermost: MattermostClient | null
  ) {
    this.env = env;
    this.names = names;
    this.switchClient = switchClient;
    this.mattermost = mattermost;
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
    options: { autoSession?: boolean; agentType?: HarnessAgentType; repoDir?: string } = {}
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
    this.defer(`agent ${name} (${agent.id})`, () => this.switchClient.deleteAgent(agent));
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
   * A room on the Mattermost bridge, with the human the harness posts as in its
   * channel, and the bridge proven live in both directions' first hop.
   *
   * Created from the gateway so Switch provisions the channel and adds the bots
   * itself. The other route — make a channel, add a bot — creates no room when
   * the bot is the first in a new channel, because nobody's websocket witnesses
   * the join.
   */
  async mattermostRoom(role: string, agents: RegisteredAgent[]): Promise<BridgedRoom> {
    const mattermost = this.requireMattermost();
    const human = await mattermost.me();
    const bridgeId = await this.switchClient.defaultBridgeId('mattermost');
    // Resolved even though room creation does not need it: it fails fast and
    // clearly when MATTERMOST_TEAM names a team that does not exist.
    await mattermost.findTeam(this.mattermostTeam());

    // Registration mints each agent's bot; wait for them so the room's members
    // and any later `@name` mention have accounts to resolve to.
    const bots = new Map<string, MattermostUser>();
    for (const agent of agents) {
      bots.set(agent.id, await mattermost.waitForBotUser(agent.name, 60_000));
    }

    const name = this.names.name(role);
    const room = await this.switchClient.createRoom({
      name,
      description: `Switch end-to-end harness (run ${this.names.runId}). Safe to delete.`,
      bridgeId,
      agentNames: agents.map((agent) => agent.name),
      userNames: [human.username],
    });
    const channelId = room.externalChannelId;
    // One step, in order: the room first, then its channel only if deleting the
    // room did not already archive it.
    this.defer(`room ${name} (${room.id}) and channel ${channelId ?? 'none'}`, async () => {
      await this.switchClient.deleteRoom(room.id);
      if (channelId === null) return;
      const left = await mattermost.getChannel(channelId);
      if (!left.delete_at) await mattermost.archiveChannel(channelId);
    });
    if (channelId === null) {
      throw new Error(
        `Switch room ${room.id} was created without a Mattermost channel — ` +
          `the collaboration bridge did not provision one.`
      );
    }

    const channel = await mattermost.getChannel(channelId);
    const bridged: BridgedRoom = { room, channel, human, bots };
    const witness = agents[0];
    if (!witness) throw new Error('A bridged room needs at least one agent.');
    await waitForBridgeReady({
      switchClient: this.switchClient,
      mattermost,
      agent: witness,
      room,
      channel,
      runId: this.names.runId,
    });
    return bridged;
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

  private requireMattermost(): MattermostClient {
    if (!this.mattermost) {
      throw new Error(
        'This scenario needs Mattermost but none is configured — declare ' +
          "`requires: ['mattermost']` in its header so it is skipped or failed up front."
      );
    }
    return this.mattermost;
  }

  private mattermostTeam(): string {
    if (!this.env.mattermost) throw new Error('No Mattermost configured.');
    return this.env.mattermost.team;
  }
}

export interface BridgedRoom {
  room: RoomDetail;
  channel: MattermostChannel;
  /** The human the harness posts as. */
  human: MattermostUser;
  /** Each agent's Mattermost bot, by agent id. A bot's username is the agent's name. */
  bots: Map<string, MattermostUser>;
}

/**
 * Block until a plain channel message actually reaches Switch.
 *
 * This is not belt-and-braces. The Mattermost adapter delivers inbound posts off
 * the *agent bot's own websocket*, and that socket is opened on a background
 * thread after the bot account is created — the server log shows
 * `Websocket authentification OK` arriving after the room already exists. A
 * message posted in that window is silently dropped, which shows up later as a
 * scenario that times out for no visible reason.
 *
 * The probe is deliberately **unaddressed**: it proves Mattermost → Switch
 * delivery without putting an `@agent` mention on the wire, so it cannot spawn a
 * console session or consume a turn. It is read back through the agent's room
 * history, which carries ordinary chatter, rather than the notification stream,
 * which by design carries only addressed messages.
 */
export async function waitForBridgeReady(params: {
  switchClient: SwitchClient;
  mattermost: MattermostClient;
  agent: RegisteredAgent;
  room: RoomDetail;
  channel: MattermostChannel;
  runId: string;
  deadlineMs?: number;
}): Promise<void> {
  const deadlineMs = params.deadlineMs ?? 120_000;
  const probe = `switch-e2e-bridge-probe ${params.runId}`;
  const until = Date.now() + deadlineMs;

  while (Date.now() < until) {
    // Re-post rather than only re-read: if the socket was down when the last
    // one went out, that message is gone for good and no amount of polling
    // will produce it.
    await params.mattermost.post({ channelId: params.channel.id, message: probe });
    const history = await params.switchClient.roomHistory(params.agent, params.room.id, 50);
    if (history.some((event) => event.body.includes(probe))) return;
    await sleep(5_000);
  }

  throw new Error(
    `Mattermost -> Switch delivery never came up for room ${params.room.id} ` +
      `(channel ${params.channel.id}) within ${deadlineMs}ms: a plain channel message ` +
      `never reached the agent's room history. The agent bot's websocket is probably not connected.`
  );
}
