import { loadEnv, shortId, type HarnessEnv } from './env.ts';
import {
  isValidMattermostUsername,
  MattermostClient,
  type MattermostChannel,
  type MattermostUser,
} from './mattermost-client.ts';
import { removeAgentCredentials, writeAgentCredentials } from './console-credentials.ts';
import { sleep, SwitchClient, type RegisteredAgent, type RoomDetail } from './switch-client.ts';

/**
 * Everything a scenario needs: the two clients, the throwaway agent, the
 * Mattermost channel it was invited into, and the Switch room the bridge created
 * for that channel.
 */
export interface Harness {
  env: HarnessEnv;
  switch: SwitchClient;
  mattermost: MattermostClient;
  agent: RegisteredAgent;
  /** The agent's Mattermost bot account — `username === agent.name`. */
  bot: MattermostUser;
  channel: MattermostChannel;
  room: RoomDetail;
  /** The human user the harness posts as. */
  human: MattermostUser;
  runId: string;
  /** Where the agent's credentials were written, when `SWITCH_E2E_AGENT_DIR` is set. */
  credentialsPath?: string;
}

export interface SetupOptions {
  /**
   * `false` registers the agent with `auto_session` off, so Switch will not
   * expect a connector to spawn a session — used by the loopback check, which
   * plays the agent itself.
   */
  autoSession?: boolean;
  /** Prefix for the agent name and channel name. Must stay short (see below). */
  prefix?: string;
}

/**
 * Why the name is built this way: the agent name becomes a **Mattermost bot
 * username** verbatim, and Mattermost caps usernames at 22 characters and allows
 * only `[a-z0-9._-]`. `e2e-opencode-` (13) + a 6-character run id fits with room
 * to spare; anything longer silently fails bot creation on the bridge side and
 * the room is then never provisioned.
 */
export function agentNameFor(runId: string, prefix = 'e2e-opencode'): string {
  const name = `${prefix}-${runId}`;
  if (!isValidMattermostUsername(name)) {
    throw new Error(
      `Derived agent name '${name}' is not a valid Mattermost bot username ` +
        `(lowercase, 3-22 chars, [a-z0-9._-]). Shorten the prefix.`
    );
  }
  return name;
}

/**
 * Reasons the suite skips rather than fails. A skip is only ever "this machine
 * isn't set up", never "the thing under test is broken".
 */
export type SkipReason = string;

export async function resolveSkip(): Promise<{ skip: SkipReason | null; env: HarnessEnv | null }> {
  if (process.env.SWITCH_E2E !== '1') {
    return { skip: 'SWITCH_E2E=1 is not set (this suite drives a real Switch server)', env: null };
  }

  let env: HarnessEnv;
  try {
    env = loadEnv();
  } catch (error) {
    return { skip: error instanceof Error ? error.message : String(error), env: null };
  }

  const client = new SwitchClient({
    apiUrl: env.switchApiUrl,
    registrationToken: env.agentRegistrationToken,
    gatewayAdminEmail: env.gatewayAdminEmail,
    gatewayAdminPassword: env.gatewayAdminPassword,
  });
  try {
    await client.health();
  } catch (error) {
    return {
      skip: `Switch server at ${env.switchApiUrl} is unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      env: null,
    };
  }

  const mattermost = new MattermostClient({ url: env.mattermostUrl, token: env.mattermostToken });
  try {
    await mattermost.me();
  } catch (error) {
    return {
      skip: `Mattermost at ${env.mattermostUrl} is unreachable or MATTERMOST_TOKEN is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      env: null,
    };
  }

  return { skip: null, env };
}

/**
 * Register a throwaway agent, create a channel, invite the agent's bot into it,
 * and wait for Switch to provision the room.
 *
 * Order matters and is not interchangeable: the bot account only exists once the
 * agent is registered (registration is what calls `create_agent_identity` on
 * every collaboration bridge), and the Switch room only exists once that bot is
 * a channel member.
 */
export async function setupHarness(
  env: HarnessEnv,
  options: SetupOptions = {}
): Promise<Harness> {
  const runId = shortId();
  const agentName = agentNameFor(runId, options.prefix);

  const switchClient = new SwitchClient({
    apiUrl: env.switchApiUrl,
    registrationToken: env.agentRegistrationToken,
    gatewayAdminEmail: env.gatewayAdminEmail,
    gatewayAdminPassword: env.gatewayAdminPassword,
  });
  const mattermost = new MattermostClient({ url: env.mattermostUrl, token: env.mattermostToken });

  const human = await mattermost.me();
  const bridgeId = await switchClient.defaultBridgeId('mattermost');
  // Resolved even though the room-create path does not need it: it fails fast
  // and clearly when MATTERMOST_TEAM names a team that does not exist.
  await mattermost.findTeam(env.mattermostTeam);

  const agent = await switchClient.registerKnownAgent({
    agentType: 'opencode',
    name: agentName,
    description: `Switch Console end-to-end harness agent (run ${runId}). Safe to delete.`,
    options: {
      auto_session: options.autoSession ?? true,
      ...(env.agentRepoDir ? { repo_dir: env.agentRepoDir } : {}),
    },
  });

  // Registration is what mints the bot; wait for it so a later `@name` mention
  // has something to resolve to.
  const bot = await mattermost.waitForBotUser(agent.name, 60_000);

  const room = await switchClient.createRoom({
    name: `e2e-${runId}`,
    description: `Switch Console end-to-end harness (run ${runId}). Safe to delete.`,
    bridgeId,
    agentNames: [agent.name],
    userNames: [human.username],
  });

  if (!room.externalChannelId) {
    throw new Error(
      `Switch room ${room.id} was created without a Mattermost channel — ` +
        `the collaboration bridge did not provision one.`
    );
  }

  const channel = await mattermost.getChannel(room.externalChannelId);
  const harness: Harness = {
    env,
    switch: switchClient,
    mattermost,
    agent,
    bot,
    channel,
    room,
    human,
    runId,
  };

  // With SWITCH_E2E_AGENT_DIR set, provision the agent's identity into that
  // working directory so a session started there IS this agent. Without it the
  // operator has to add the agent in Switch Console by hand before the run.
  if (env.agentRepoDir) {
    harness.credentialsPath = await writeAgentCredentials({
      workingDir: env.agentRepoDir,
      agent,
      apiEndpoint: env.switchApiUrl,
    });
  }

  await waitForBridgeReady(harness);
  return harness;
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
export async function waitForBridgeReady(
  harness: Harness,
  deadlineMs = 120_000
): Promise<void> {
  const probe = `switch-e2e-bridge-probe ${harness.runId}`;
  const until = Date.now() + deadlineMs;
  let posted = false;

  while (Date.now() < until) {
    if (!posted) {
      await harness.mattermost.post({ channelId: harness.channel.id, message: probe });
      posted = true;
    }
    const history = await harness.switch.roomHistory(harness.agent, harness.room.id, 50);
    if (history.some((event) => event.body.includes(probe))) return;

    // Re-post rather than only re-read: if the socket was down when the first
    // one went out, that message is gone for good and no amount of polling
    // will produce it.
    await sleep(5_000);
    posted = false;
  }

  throw new Error(
    `Mattermost -> Switch delivery never came up for room ${harness.room.id} ` +
      `(channel ${harness.channel.id}) within ${deadlineMs}ms: a plain channel message ` +
      `never reached the agent's room history. The agent bot's websocket is probably not connected.`
  );
}

/** Statuses that mean a session is attending — or is about to be spawned for — the room. */
const READY_STATUSES = new Set(['live', 'dormant']);

/**
 * Wait until Switch reports the agent as `live` (a session is attending the
 * room) or `dormant` (an auto-session connector is watching and will spawn one
 * when the agent is addressed) before any scenario runs.
 *
 * Without this the suite spends four full reply deadlines discovering the same
 * thing four times, and the report reads as four behavioural failures rather
 * than one missing session. Returns the status it settled on.
 */
export async function waitForSession(
  harness: Harness,
  deadlineMs = 120_000
): Promise<string> {
  const until = Date.now() + deadlineMs;
  let last: string | null = null;
  while (Date.now() < until) {
    last = await harness.switch.agentStatusInRoom(harness.room.id, harness.agent.id);
    if (last && READY_STATUSES.has(last)) return last;
    await sleep(5_000);
  }
  throw new Error(
    `Switch reports agent '${harness.agent.name}' as '${last ?? 'unknown'}' in room ` +
      `${harness.room.name} after ${deadlineMs}ms, not live or dormant. Start a Switch Console ` +
      `session for this agent (or start its auto-session watcher) and re-run — see README.md.`
  );
}

/**
 * Delete the agent and archive the channel. Never throws: teardown failures are
 * reported (so a leak is visible and can be cleaned up by hand) but must not
 * mask the result of the run.
 */
export async function teardownHarness(
  harness: Harness | null,
  log: (message: string) => void = console.warn
): Promise<void> {
  if (!harness) return;
  if (harness.env.keepArtifacts) {
    log(
      `SWITCH_E2E_KEEP=1 — leaving agent '${harness.agent.name}' (${harness.agent.id}) and ` +
        `channel '${harness.channel.name}' (${harness.channel.id}) in place.`
    );
    return;
  }

  if (harness.env.agentRepoDir) {
    await removeAgentCredentials({
      workingDir: harness.env.agentRepoDir,
      agentName: harness.agent.name,
    }).catch(() => undefined);
  }

  try {
    await harness.switch.deleteRoom(harness.room.id);
  } catch (error) {
    log(
      `teardown: failed to delete room ${harness.room.id} — ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await harness.switch.deleteAgent(harness.agent);
  } catch (error) {
    log(
      `teardown: failed to delete agent ${harness.agent.name} (${harness.agent.id}) — ` +
        `delete it by hand: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Deleting the room usually takes the channel with it; archive is a no-op
  // then, and the safety net when it does not.
  try {
    await harness.mattermost.archiveChannel(harness.channel.id);
  } catch {
    // Already gone — nothing to report.
  }
}
