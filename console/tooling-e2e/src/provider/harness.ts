import { promises as fs } from 'node:fs';
import type { ChatUser, ConsoleChatClient } from '../clients/console-chat-client.ts';
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
import {
  removeAgentCredentials,
  removeClaudeAgentDefinition,
  writeAgentCredentials,
  writeClaudeAgentDefinition,
} from './console-credentials.ts';

/**
 * Everything a scenario needs: the two clients, the throwaway agent, and the
 * in-Console group chat (a Switch room with no bridge) it is in.
 */
export interface Harness {
  env: HarnessEnv;
  switch: SwitchClient;
  /** The human side: the in-Console chat, as the gateway admin. */
  chat: ConsoleChatClient;
  agent: AgentRef;
  /**
   * The agent's own API key, for a Console session to run as. Null for an agent
   * created on a controller: the controller acts for it, and no key is issued.
   */
  agentApiKey: string | null;
  /**
   * A silent second agent in the room, registered with the deployment key and
   * run by nobody. Scenarios read the room's history through it, because an
   * agent run by a controller cannot use its own key: the server refuses it
   * while the controller acts for the agent.
   */
  witness: RegisteredAgent;
  room: RoomDetail;
  /** The human user the harness posts as: the gateway admin. */
  human: ChatUser;
  runId: string;
  /** Where the agent's credentials were written, when `SWITCH_E2E_AGENT_DIR` is set. */
  credentialsPath?: string;
}

/**
 * The agent-name role per agent type. The full name is
 * `e2e-<runId><scope>-<role>`, which caps at 22 characters (see
 * `isValidArtifactName`) — so a role can be at most ten.
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
 * Register a throwaway agent and open an in-Console group chat with it, as
 * Switch Console does.
 *
 * Unlike the fast lane's fixtures this setup outlives a single test: the
 * provider scenarios share one agent and one room, and the agent may have
 * been registered by an earlier process (see {@link HarnessManifest}).
 */
export async function setupHarness(target: LaneTarget): Promise<Harness> {
  const { env } = target;
  const reused = await readManifest(env.provider.manifestPath);
  if (reused) return reuseHarness(target, reused);

  const undo = new SetupUndo();
  try {
    const harness = await buildHarness(target, undo);
    await writeManifest(env.provider.manifestPath, harness);
    return harness;
  } catch (error) {
    await undo.run(console.warn);
    throw error;
  }
}

async function buildHarness(target: LaneTarget, undo: SetupUndo): Promise<Harness> {
  const { env, switchClient, chat } = target;
  const run = new RunContext();
  const runId = run.runId;
  const names = run.scope();
  const agentName = names.name(ROLE_BY_AGENT_TYPE[env.provider.agentType]);
  const human = await chat.me();
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

  // Owner-only by default, and the agent has no owner the harness posts as; a
  // chat can only be opened with an agent the person may address.
  await switchClient.openAddressing(agent.id);

  const witness = await switchClient.registerKnownAgent({
    agentType: 'opencode',
    name: names.name('witness'),
    description: `Switch end-to-end harness witness (run ${runId}). Safe to delete.`,
    options: { auto_session: false },
  });
  undo.add(`agent ${witness.name} (${witness.id})`, deleteByName(witness.name));
  await switchClient.openAddressing(witness.id);

  const roomId = await chat.createGroupChat({
    name: names.name('room'),
    agentIds: [agent.id, witness.id],
  });
  undo.add(`room ${roomId}`, () => switchClient.deleteRoom(roomId));
  const room = await switchClient.getRoom(roomId);

  const harness: Harness = {
    env,
    switch: switchClient,
    chat,
    agent,
    agentApiKey,
    witness,
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
}

async function writeManifest(path: string | null, harness: Harness): Promise<void> {
  if (!path) return;
  const manifest: HarnessManifest = {
    runId: harness.runId,
    agent: harness.agent,
    agentApiKey: harness.agentApiKey,
    witness: harness.witness,
    roomId: harness.room.id,
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
  return problems;
}

/** Rebuild a harness around an agent and room a previous process created. */
async function reuseHarness(target: LaneTarget, manifest: HarnessManifest): Promise<Harness> {
  const { env, switchClient, chat } = target;
  return {
    env,
    switch: switchClient,
    chat,
    agent: manifest.agent,
    agentApiKey: manifest.agentApiKey,
    witness: manifest.witness,
    room: await switchClient.getRoom(manifest.roomId),
    human: await chat.me(),
    runId: manifest.runId,
  };
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
 * Delete the agent and its room. Never throws: teardown failures are
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
        `room '${harness.room.name}' (${harness.room.id}) in place.`
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
  const { env, agent, witness, room } = harness;

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

  await attempt(`room ${room.name} (${room.id})`, () => harness.switch.deleteRoom(room.id));

  // By name, as the admin: an agent run by a controller cannot delete itself
  // with its own key, which the server refuses while the controller acts for it.
  for (const each of [agent, witness]) {
    await attempt(`agent ${each.name} (${each.id})`, () =>
      harness.switch.deleteAgentByName(each.name)
    );
  }
}
