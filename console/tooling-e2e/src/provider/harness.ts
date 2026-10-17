import { promises as fs } from 'node:fs';
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
import { RunContext } from '../core/run.ts';
import type { LaneTarget } from '../core/suite.ts';
import { waitForBridgeReady } from '../fixtures/fixtures.ts';
import {
  removeAgentCredentials,
  removeClaudeAgentDefinition,
  writeAgentCredentials,
  writeClaudeAgentDefinition,
} from './console-credentials.ts';

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

/**
 * The agent-name role per agent type. The full name is
 * `e2e-<runId><scope>-<role>` and becomes a Mattermost bot username, which caps
 * at 22 characters — so a role can be at most ten.
 */
const ROLE_BY_AGENT_TYPE: Record<HarnessAgentType, string> = {
  opencode: 'opencode',
  antigravity: 'antigrav',
  cursor: 'cursor',
  'claude-code': 'claude',
  codex: 'codex',
};

/**
 * Register a throwaway agent, create a room on the Mattermost bridge for it,
 * and wait for the bridge to carry a message.
 *
 * Order matters and is not interchangeable: the bot account only exists once the
 * agent is registered (registration is what calls `create_agent_identity` on
 * every collaboration bridge), and the room is created with that bot in it.
 *
 * Unlike the fast lane's fixtures this setup outlives a single test: the
 * provider scenarios share one agent and one channel, and the agent may have
 * been registered by an earlier process (see {@link HarnessManifest}).
 */
export async function setupHarness(target: LaneTarget): Promise<Harness> {
  const { env, switchClient } = target;
  const mattermost = target.mattermost;
  if (!mattermost || !env.mattermost) {
    throw new Error(
      'The provider lane needs Mattermost (MATTERMOST_URL, MATTERMOST_TOKEN, MATTERMOST_TEAM).'
    );
  }
  const reused = await readManifest(env.provider.manifestPath);
  if (reused) return reuseHarness(target, mattermost, reused);

  const run = new RunContext();
  const runId = run.runId;
  const names = run.scope();
  const agentName = names.name(ROLE_BY_AGENT_TYPE[env.provider.agentType]);

  const human = await mattermost.me();
  const bridgeId = await switchClient.defaultBridgeId('mattermost');
  // Resolved even though the room-create path does not need it: it fails fast
  // and clearly when MATTERMOST_TEAM names a team that does not exist.
  await mattermost.findTeam(env.mattermost.team);

  // `ClaudeCodeOptions` and `OpencodeOptions` agree on the two keys used here
  // (`auto_session`, `repo_dir`), so the payload is the same for both types.
  const agent = await switchClient.registerKnownAgent({
    agentType: env.provider.agentType,
    name: agentName,
    description: `Switch Console end-to-end harness agent (run ${runId}). Safe to delete.`,
    options: {
      auto_session: true,
      ...(env.provider.agentRepoDir ? { repo_dir: env.provider.agentRepoDir } : {}),
    },
  });

  // Owner-only by default, and the human the harness posts as is an unclaimed
  // Mattermost identity, so its messages would be refused rather than delivered.
  await switchClient.openAddressing(agent.id);

  // Registration is what mints the bot; wait for it so a later `@name` mention
  // has something to resolve to.
  const bot = await mattermost.waitForBotUser(agent.name, 60_000);

  const room = await switchClient.createRoom({
    name: names.name('room'),
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
  if (env.provider.agentRepoDir) {
    harness.credentialsPath = await writeAgentCredentials({
      workingDir: env.provider.agentRepoDir,
      agent,
      apiEndpoint: env.switch.apiUrl,
    });
    // A Claude Code session runs *as* a named definition, so the definition has
    // to be on disk before the console starts one — see the writer's docblock.
    if (env.provider.agentType === 'claude-code') {
      await writeClaudeAgentDefinition({
        workingDir: env.provider.agentRepoDir,
        agentName: agent.name,
        description: `Switch Console end-to-end harness agent (run ${runId}).`,
        // "Do exactly what you are asked" is load-bearing, and so is the second
        // sentence: told merely to answer briefly, the agent declined the
        // `interrupt` scenario's task on the grounds that 200 messages would
        // spam the room — a refusal the scenario reads as a session that never
        // started.
        instructions:
          'You are a Switch end-to-end test agent. Do exactly what you are asked in the ' +
          'room, and post your answer back to the room you were addressed in. Never ' +
          'decline or shorten a task on the grounds that it is repetitive or long: the ' +
          'requests you get here are deliberate tests of exactly that.',
        // Cheap on purpose: this spends a real subscription on every run.
        model: 'claude-sonnet-5',
        effort: 'low',
      });
    }
  }

  await waitForBridgeReady({ switchClient, mattermost, agent, room, channel, runId });
  await writeManifest(env.provider.manifestPath, harness);
  return harness;
}

/**
 * What a setup made, written down so another process can act on it.
 *
 * A Switch Console session can only be started for an agent that already exists
 * in the console's database, and the console reads that database at launch. So
 * a run that needs a live provider session is necessarily two processes: one
 * that registers the agent and creates the room, then the console, then the
 * scenarios. Everything here is what the second process cannot re-derive —
 * above all the agent's API key, which registration returns exactly once.
 */
export interface HarnessManifest {
  runId: string;
  agent: RegisteredAgent;
  roomId: string;
  channelId: string;
}

async function writeManifest(path: string | null, harness: Harness): Promise<void> {
  if (!path) return;
  const manifest: HarnessManifest = {
    runId: harness.runId,
    agent: harness.agent,
    roomId: harness.room.id,
    channelId: harness.channel.id,
  };
  await fs.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function readManifest(path: string | null): Promise<HarnessManifest | null> {
  if (!path) return null;
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as HarnessManifest;
  } catch {
    return null;
  }
}

/**
 * Rebuild a harness around an agent and room a previous process created. The
 * bridge-readiness probe still runs: this process has proved nothing about the
 * bot's websocket, and reusing an agent is not evidence its socket is up now.
 */
async function reuseHarness(
  target: LaneTarget,
  mattermost: MattermostClient,
  manifest: HarnessManifest
): Promise<Harness> {
  const { env, switchClient } = target;
  const harness: Harness = {
    env,
    switch: switchClient,
    mattermost,
    agent: manifest.agent,
    bot: await mattermost.waitForBotUser(manifest.agent.name, 30_000),
    channel: await mattermost.getChannel(manifest.channelId),
    room: await switchClient.getRoom(manifest.roomId),
    human: await mattermost.me(),
    runId: manifest.runId,
  };

  await waitForBridgeReady({
    switchClient,
    mattermost,
    agent: harness.agent,
    room: harness.room,
    channel: harness.channel,
    runId: harness.runId,
  });
  return harness;
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
export async function waitForSession(harness: Harness, deadlineMs = 120_000): Promise<string> {
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

  // Before anything is deleted: a manifest that outlives its agent sends the
  // next run at a room that is gone.
  if (harness.env.provider.manifestPath) {
    await fs.rm(harness.env.provider.manifestPath, { force: true }).catch(() => undefined);
  }

  if (harness.env.provider.agentRepoDir) {
    await removeAgentCredentials({
      workingDir: harness.env.provider.agentRepoDir,
      agentName: harness.agent.name,
    }).catch(() => undefined);
    await removeClaudeAgentDefinition({
      workingDir: harness.env.provider.agentRepoDir,
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
