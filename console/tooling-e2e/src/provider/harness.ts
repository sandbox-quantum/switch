import { promises as fs } from 'node:fs';
import type {
  MattermostChannel,
  MattermostClient,
  MattermostUser,
} from '../clients/mattermost-client.ts';
import {
  managementErrorCode,
  sleep,
  type AgentRef,
  type ManagedAgentDefinition,
  type RegisteredAgent,
  type RoomDetail,
  type SwitchClient,
} from '../clients/switch-client.ts';
import type { HarnessAgentType, HarnessEnv } from '../core/env.ts';
import { RunContext } from '../core/run.ts';
import { message, type LaneTarget } from '../core/suite.ts';
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
  agent: AgentRef;
  /**
   * The agent's own API key, for a Console session to run as. Null for an agent
   * created on a controller: the controller acts for it, and no key is issued.
   */
  agentApiKey: string | null;
  /**
   * A silent second agent in the room, registered with the deployment key and
   * run by nobody. The bridge-readiness probe reads the room through it,
   * because an agent run by a controller cannot use its own key: the server
   * refuses it while the controller acts for the agent.
   */
  witness: RegisteredAgent;
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

// "Do exactly what you are asked" is load-bearing, and so is the second
// sentence: told merely to answer briefly, the agent declined the `interrupt`
// scenario's task on the grounds that 200 messages would spam the room — a
// refusal the scenario reads as a session that never started.
export const AGENT_INSTRUCTIONS =
  'You are a Switch end-to-end test agent. Do exactly what you are asked in the ' +
  'room, and post your answer back to the room you were addressed in. Never ' +
  'decline or shorten a task on the grounds that it is repetitive or long: the ' +
  'requests you get here are deliberate tests of exactly that.';

/** Cheap on purpose: a run spends a real subscription. */
export const CLAUDE_MODEL = 'claude-sonnet-5';

/** The management API's provider id for each harness agent type. */
export const PROVIDER_BY_AGENT_TYPE: Record<HarnessAgentType, string> = {
  opencode: 'opencode',
  'claude-code': 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  cursor: 'cursor',
};

/** How long to keep asking a controller to take the agent while it comes up. */
export const PLACEMENT_DEADLINE_MS = 120_000;

/** The placement refusals that clear once the controller is up and signed in. */
export const NOT_READY_CODES = new Set([
  'controller_offline',
  'provider_not_installed',
  'provider_login_missing',
]);

/**
 * Create the agent on the controller, owned by the admin, retrying while the
 * server answers that the controller is not ready yet: it has not connected, or
 * has not yet reported the provider installed and signed in. Any other refusal
 * is final. A refused create registers nothing, so repeating it is safe.
 */
async function createOnController(
  switchClient: SwitchClient,
  env: HarnessEnv,
  name: string,
  runId: string,
  controllerId: string
): Promise<AgentRef> {
  const provider = PROVIDER_BY_AGENT_TYPE[env.provider.agentType];
  const definition: ManagedAgentDefinition = {
    provider,
    model: provider === 'claude' ? CLAUDE_MODEL : null,
    instructions: AGENT_INSTRUCTIONS,
    // The `approval` and `interrupt` scenarios need the session to ask before
    // running a tool. Auto mode, on unless a definition says otherwise, lets
    // the provider run what it judges safe without asking.
    auto_mode: false,
    auto_approve: false,
    directory: env.provider.agentRepoDir,
  };
  const until = Date.now() + PLACEMENT_DEADLINE_MS;
  for (;;) {
    try {
      return await switchClient.createManagedAgent({
        name,
        description: `Switch end-to-end harness agent (run ${runId}). Safe to delete.`,
        controllerId,
        definition,
      });
    } catch (error) {
      const code = managementErrorCode(error);
      if (code === null || !NOT_READY_CODES.has(code) || Date.now() > until) throw error;
      await sleep(3_000);
    }
  }
}

/** Register the agent with the deployment key, for a Switch Console session to run as. */
async function registerForConsole(
  switchClient: SwitchClient,
  env: HarnessEnv,
  name: string,
  runId: string
): Promise<RegisteredAgent> {
  // `ClaudeCodeOptions` and `OpencodeOptions` agree on the two keys used here
  // (`auto_session`, `repo_dir`), so the payload is the same for both types.
  return switchClient.registerKnownAgent({
    agentType: env.provider.agentType,
    name,
    description: `Switch end-to-end harness agent (run ${runId}). Safe to delete.`,
    options: {
      auto_session: true,
      ...(env.provider.agentRepoDir ? { repo_dir: env.provider.agentRepoDir } : {}),
    },
  });
}

/**
 * What a setup has made so far, undone newest first if a later step fails, so a
 * failed setup does not leave its agents and room behind.
 */
class SetupUndo {
  private readonly steps: { label: string; undo: () => Promise<void> }[] = [];

  add(label: string, undo: () => Promise<void>): void {
    this.steps.push({ label, undo });
  }

  async run(log: (message: string) => void): Promise<void> {
    for (const step of this.steps.reverse()) {
      try {
        await step.undo();
      } catch (error) {
        log(`setup cleanup: failed to remove ${step.label} — delete it by hand: ${message(error)}`);
      }
    }
  }
}

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
  const { env } = target;
  const mattermost = target.mattermost;
  if (!mattermost || !env.mattermost) {
    throw new Error(
      'The provider lane needs Mattermost (MATTERMOST_URL, MATTERMOST_TOKEN, MATTERMOST_TEAM).'
    );
  }
  const reused = await readManifest(env.provider.manifestPath);
  if (reused) return reuseHarness(target, mattermost, reused);

  // Resolved even though the room-create path does not need it: it fails fast
  // and clearly when MATTERMOST_TEAM names a team that does not exist.
  await mattermost.findTeam(env.mattermost.team);

  const undo = new SetupUndo();
  try {
    const harness = await buildHarness(target, mattermost, undo);
    await writeManifest(env.provider.manifestPath, harness);
    return harness;
  } catch (error) {
    await undo.run(console.warn);
    throw error;
  }
}

async function buildHarness(
  target: LaneTarget,
  mattermost: MattermostClient,
  undo: SetupUndo
): Promise<Harness> {
  const { env, switchClient } = target;
  const run = new RunContext();
  const runId = run.runId;
  const names = run.scope();
  const agentName = names.name(ROLE_BY_AGENT_TYPE[env.provider.agentType]);
  const human = await mattermost.me();
  const bridgeId = await switchClient.defaultBridgeId('mattermost');
  const controllerId = env.provider.controllerId;
  const deleteByName = (name: string) => () => switchClient.deleteAgentByName(name);

  let agent: AgentRef;
  let agentApiKey: string | null;
  if (controllerId !== null) {
    agent = await createOnController(switchClient, env, agentName, runId, controllerId);
    agentApiKey = null;
  } else {
    const registered = await registerForConsole(switchClient, env, agentName, runId);
    agent = { id: registered.id, name: registered.name };
    agentApiKey = registered.apiKey;
  }
  // By name, as the admin: an agent run by a controller cannot delete itself
  // with its own key, which the server refuses while the controller acts for it.
  undo.add(`agent ${agent.name} (${agent.id})`, deleteByName(agent.name));

  // Owner-only by default, and the human the harness posts as is an unclaimed
  // Mattermost identity, so its messages would be refused rather than delivered.
  await switchClient.openAddressing(agent.id);

  const witness = await switchClient.registerKnownAgent({
    agentType: 'opencode',
    name: names.name('witness'),
    description: `Switch end-to-end harness bridge witness (run ${runId}). Safe to delete.`,
    options: { auto_session: false },
  });
  undo.add(`agent ${witness.name} (${witness.id})`, deleteByName(witness.name));

  // Registration is what mints the bots; wait for them so the room has them
  // as members and a later `@name` mention has something to resolve to.
  const bot = await mattermost.waitForBotUser(agent.name, 60_000);
  await mattermost.waitForBotUser(witness.name, 60_000);

  const room = await switchClient.createRoom({
    name: names.name('room'),
    description: `Switch end-to-end harness (run ${runId}). Safe to delete.`,
    bridgeId,
    agentNames: [agent.name, witness.name],
    userNames: [human.username],
  });
  const channelId = room.externalChannelId;
  undo.add(`room ${room.name} (${room.id})`, async () => {
    await switchClient.deleteRoom(room.id);
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
  const harness: Harness = {
    env,
    switch: switchClient,
    mattermost,
    agent,
    agentApiKey,
    witness,
    bot,
    channel,
    room,
    human,
    runId,
  };

  if (agentApiKey !== null && env.provider.agentRepoDir) {
    const workingDir = env.provider.agentRepoDir;
    // Provision the agent's identity into that working directory so a Console
    // session started there IS this agent. Without it the operator has to add
    // the agent in Switch Console by hand before the run.
    harness.credentialsPath = await writeAgentCredentials({
      workingDir,
      agent: { ...agent, apiKey: agentApiKey },
      apiEndpoint: env.switch.apiUrl,
    });
    undo.add(`credentials for ${agent.name}`, () =>
      removeAgentCredentials({ workingDir, agentName: agent.name })
    );
    // A Claude Code session runs *as* a named definition, so the definition has
    // to be on disk before the console starts one — see the writer's docblock.
    if (env.provider.agentType === 'claude-code') {
      await writeClaudeAgentDefinition({
        workingDir,
        agentName: agent.name,
        description: `Switch Console end-to-end harness agent (run ${runId}).`,
        instructions: AGENT_INSTRUCTIONS,
        model: CLAUDE_MODEL,
        effort: 'low',
      });
      undo.add(`Claude definition for ${agent.name}`, () =>
        removeClaudeAgentDefinition({ workingDir, agentName: agent.name })
      );
    }
  }

  await waitForBridgeReady({ switchClient, mattermost, agent: witness, room, channel, runId });
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
  agent: AgentRef;
  agentApiKey: string | null;
  witness: RegisteredAgent;
  roomId: string;
  channelId: string;
}

async function writeManifest(path: string | null, harness: Harness): Promise<void> {
  if (!path) return;
  const manifest: HarnessManifest = {
    runId: harness.runId,
    agent: harness.agent,
    agentApiKey: harness.agentApiKey,
    witness: harness.witness,
    roomId: harness.room.id,
    channelId: harness.channel.id,
  };
  await fs.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function readManifest(path: string | null): Promise<HarnessManifest | null> {
  if (!path) return null;
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const manifest = JSON.parse(text) as Partial<HarnessManifest>;
  const problems = manifestProblems(manifest);
  if (problems.length > 0) {
    throw new Error(
      `The harness manifest at ${path} is not one this harness wrote (${problems.join('; ')}), ` +
        `probably from an older version. Delete what it names (pnpm cleanup), remove the ` +
        `file, and seed again.`
    );
  }
  return manifest as HarnessManifest;
}

function manifestProblems(manifest: Partial<HarnessManifest>): string[] {
  const problems: string[] = [];
  const isAgent = (value: unknown, withKey: boolean): boolean => {
    if (typeof value !== 'object' || value === null) return false;
    const agent = value as Record<string, unknown>;
    return (
      typeof agent.id === 'string' &&
      typeof agent.name === 'string' &&
      (!withKey || typeof agent.apiKey === 'string')
    );
  };
  if (typeof manifest.runId !== 'string') problems.push('no runId');
  if (!isAgent(manifest.agent, false)) problems.push('no agent');
  if (manifest.agentApiKey !== null && typeof manifest.agentApiKey !== 'string') {
    problems.push('no agentApiKey');
  }
  if (!isAgent(manifest.witness, true)) problems.push('no witness');
  if (typeof manifest.roomId !== 'string') problems.push('no roomId');
  if (typeof manifest.channelId !== 'string') problems.push('no channelId');
  return problems;
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
    agentApiKey: manifest.agentApiKey,
    witness: manifest.witness,
    bot: await mattermost.waitForBotUser(manifest.agent.name, 30_000),
    channel: await mattermost.getChannel(manifest.channelId),
    room: await switchClient.getRoom(manifest.roomId),
    human: await mattermost.me(),
    runId: manifest.runId,
  };

  await waitForBridgeReady({
    switchClient,
    mattermost,
    agent: harness.witness,
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
  const remedy =
    harness.env.provider.controllerId !== null
      ? `The agent controller (${harness.env.provider.controllerId}) did not start a session ` +
        `for it: check the controller's log, and that the provider CLI is installed and ` +
        `signed in for the user running the controller.`
      : `Start a Switch Console session for this agent (or start its auto-session watcher) ` +
        `and re-run — see README.md.`;
  throw new Error(
    `Switch reports agent '${harness.agent.name}' as '${last ?? 'unknown'}' in room ` +
      `${harness.room.name} after ${deadlineMs}ms, not live or dormant. ${remedy}`
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

  const attempt = async (label: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      log(`teardown: failed to remove ${label} — delete it by hand: ${message(error)}`);
    }
  };
  const { env, agent, witness, room, channel } = harness;

  // Before anything is deleted: a manifest that outlives its agent sends the
  // next run at a room that is gone.
  const manifestPath = env.provider.manifestPath;
  if (manifestPath) {
    await attempt(`manifest ${manifestPath}`, () => fs.rm(manifestPath, { force: true }));
  }

  const workingDir = env.provider.agentRepoDir;
  if (workingDir && harness.agentApiKey !== null) {
    await attempt(`credentials for ${agent.name}`, () =>
      removeAgentCredentials({ workingDir, agentName: agent.name })
    );
    await attempt(`Claude definition for ${agent.name}`, () =>
      removeClaudeAgentDefinition({ workingDir, agentName: agent.name })
    );
  }

  // Deleting the room usually archives its channel; the archive is the safety
  // net when it does not.
  await attempt(`room ${room.name} (${room.id}) and channel ${channel.id}`, async () => {
    await harness.switch.deleteRoom(room.id);
    const left = await harness.mattermost.getChannel(channel.id);
    if (!left.delete_at) await harness.mattermost.archiveChannel(channel.id);
  });

  // By name, as the admin: an agent run by a controller cannot delete itself
  // with its own key, which the server refuses while the controller acts for it.
  for (const each of [agent, witness]) {
    await attempt(`agent ${each.name} (${each.id})`, () =>
      harness.switch.deleteAgentByName(each.name)
    );
  }
}
