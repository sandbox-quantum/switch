import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { BoxValveStatus } from '@switch-console/agent-providers-box';
import { z } from 'zod';
import { ConfigurationError } from './errors';
import { EVENT_KINDS, type LiveEvent } from './live-events';
import type { Logger } from './log';
import { anonymousBytesIn, readBoxMemory } from './memory-guard';
import { listProcesses, type OwnerMarkers, ProcReader } from './owner-marker';
import type { DataLayout } from './paths';
import { PROCESS_STATES, type ProcessState, type StatusReport } from './schemas';

/**
 * What the running controller is doing, for operators' scripts and an
 * operator to read inside the box with `switch-agent-controller status --json`
 * (or `--live` for a person).
 *
 * The controller writes it to a file, from the status it already collects
 * every few seconds for Core, so reading it starts nothing and opens no port.
 * Counts, states, times and ids cut to 8 characters only: never a file's
 * contents, a log line, an environment value or a message.
 *
 * Off unless `SWITCH_CONTROLLER_LIVE_STATUS_DIR` names a folder for it. Never
 * the data folder: a controller running on a handed-over identity writes
 * nothing there but its database.
 */

export const LIVE_STATUS_DIR_ENV = 'SWITCH_CONTROLLER_LIVE_STATUS_DIR';
/** The box image's digest, which the template passes in: the controller can't see its own image. */
export const IMAGE_DIGEST_ENV = 'SWITCH_IMAGE_DIGEST';
export const LIVE_STATUS_FILE = 'live-status.json';
/** The shape's version: operators' scripts refuse one they don't know. */
export const LIVE_STATUS_VERSION = 1;
/** How often, at most, the file is rewritten. */
export const LIVE_STATUS_EVERY_MS = 10_000;
/** Older than this, the reader calls it stale: the controller has stopped writing. */
export const LIVE_STATUS_STALE_MS = 60_000;
/** The file stays small; anything bigger is not ours. */
const LIVE_STATUS_LIMIT_BYTES = 256 * 1024;
/** At most this many conversations per agent are listed; the rest are counted, not listed. */
export const MAX_CONVERSATIONS_PER_AGENT = 50;
const LISTABLE_ID = /^[A-Za-z0-9_-]+$/;
/** Agents and conversations are named by this much of their id. */
export const SHORT_ID_LENGTH = 8;
/** Of a process's `cmdline`, only this much is read: enough to tell a host. */
const CMDLINE_READ_BYTES = 4096;

/** The folder `SWITCH_CONTROLLER_LIVE_STATUS_DIR` names, or null (off). Must be absolute. */
export function liveStatusDirFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env[LIVE_STATUS_DIR_ENV]?.trim();
  if (!raw) return null;
  if (!isAbsolute(raw))
    throw new ConfigurationError(`${LIVE_STATUS_DIR_ENV} must be an absolute path.`);
  return raw;
}

/**
 * The live status folder the controller may write to, checked at start: it
 * exists, is a folder, is not the data folder or inside it, belongs to this
 * user, and no one else can write to it, so no one else can swap a status
 * file in between writes. Null when the live status is off.
 */
export async function checkedLiveStatusDir(
  env: NodeJS.ProcessEnv,
  dataDir: string
): Promise<string | null> {
  const dir = liveStatusDirFromEnv(env);
  if (dir === null) return null;
  const real = await realpath(dir).catch(() => {
    throw new ConfigurationError(`${LIVE_STATUS_DIR_ENV} names ${dir}, which does not exist.`);
  });
  const data = await realpath(dataDir).catch(() => resolve(dataDir));
  if (real === data || real.startsWith(`${data}${sep}`))
    throw new ConfigurationError(
      `${LIVE_STATUS_DIR_ENV} must not be the controller's data folder or inside it.`
    );
  const info = await stat(real);
  if (!info.isDirectory())
    throw new ConfigurationError(`${LIVE_STATUS_DIR_ENV} names ${dir}, which is not a folder.`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    throw new ConfigurationError(`${LIVE_STATUS_DIR_ENV} names ${dir}, which another user owns.`);
  if (info.mode & 0o022)
    throw new ConfigurationError(
      `${LIVE_STATUS_DIR_ENV} names ${dir}, which others can write to; make it 0700 or 0755.`
    );
  return real;
}

/**
 * The checked live status folder, or null with one ERROR naming the check that
 * failed: an optional readout never stops the controller, and nothing is
 * written to a folder that fails (`status --live` then reports it missing).
 */
export async function liveStatusDirOrOff(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  log: Pick<Logger, 'error'>
): Promise<string | null> {
  try {
    return await checkedLiveStatusDir(env, dataDir);
  } catch (error) {
    log.error('The live status is off: its folder is not safe to write to', {
      why: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The digest `SWITCH_IMAGE_DIGEST` gives, or null when unset or not a digest. */
export function imageDigestFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env[IMAGE_DIGEST_ENV]?.trim();
  return raw && DIGEST.test(raw) ? raw : null;
}

export const shortId = (id: string) => id.slice(0, SHORT_ID_LENGTH);

const count = z.number().int().nonnegative();
const time = z.string().datetime();
const shortIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,8}$/);

const processCounts = z.strictObject(
  Object.fromEntries(PROCESS_STATES.map((state) => [state, count])) as Record<
    ProcessState,
    typeof count
  >
);

const agentSchema = z.strictObject({
  id: shortIdSchema,
  desired: z.enum(['running', 'stopped']),
  process: z.enum(PROCESS_STATES).nullable(),
  resting: z.boolean(),
  out_of_memory: z.boolean(),
  rest_after_ms: count.nullable(),
  on_hub: z.boolean(),
  on_hub_since: time.nullable(),
  /** On the hub but on its narrower fallback valve; null where the valve is off or it isn't connected. */
  valve_fallback: z.boolean().nullable(),
  sessions_active: count,
  waiting_for_room: count,
  /** Its processes, by their owner markers; null where the guard (and so the markers) is off. */
  claude_processes: count.nullable(),
  host_processes: count.nullable(),
  /** The login copies on the box for it (relay token, provider home and data), never their contents. */
  /** `null` in launcher mode, where the agents' files aren't visible to the controller. */
  login_copies: count.nullable(),
  newest_login_copy_at: time.nullable(),
});

const conversationSchema = z.strictObject({
  id: shortIdSchema,
  agent: shortIdSchema,
  state: z.enum(['waking', 'awake', 'busy', 'parked']),
  /** When the writer first saw it in this state (so within 10 s of the change). */
  since: time,
});

const eventSchema = z.strictObject({
  at: time,
  kind: z.enum(EVENT_KINDS),
  agent: shortIdSchema.nullable(),
  conversation: shortIdSchema.nullable(),
  reason: z
    .string()
    .regex(/^[a-z_]{1,16}$/)
    .nullable(),
  count: count,
});

export const liveStatusSchema = z.strictObject({
  version: z.literal(LIVE_STATUS_VERSION),
  written_at: time,
  controller: z.strictObject({
    version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
    image_digest: z.string().regex(DIGEST).nullable(),
    /** When this controller process started (the container's start, give or take its boot). */
    started_at: time,
    assignment_revision: count.nullable(),
    /** When the assignment was last pulled from Core, or null before it has been. */
    last_sync_at: time.nullable(),
    /** The controller process's own anonymous memory (its `smaps`), or null where unreadable. */
    anon_bytes: count.nullable(),
    /** `--optimize-for-size` is on the controller's own Node. */
    optimize_for_size: z.boolean(),
    /** `NODE_OPTIONS` is set for the controller (yes or no; never its value). */
    node_options_set: z.boolean(),
    /**
     * The agents run under the launcher, in a container of their own: process
     * and login-copy counts are then `null` (not visible from here), never 0.
     */
    launcher_mode: z.boolean(),
  }),
  box: z.strictObject({
    memory_limit_bytes: count.nullable(),
    /** The guard's own reading of the box (AnonPages + Shmem, or the cgroup's when higher). */
    memory_bytes: count.nullable(),
    /** `memory_bytes` as a percentage of `memory_limit_bytes`, to one decimal place. */
    memory_percent: z.number().min(0).max(1000).nullable(),
    shmem_bytes: count.nullable(),
    /** Every process on the box whose name starts `claude`, whoever's it is. */
    claude_processes: count.nullable(),
    /** Every agent host process on the box (`shared-host` or `agent-host` in its command line). */
    host_processes: count.nullable(),
  }),
  valve: z.strictObject({
    enabled: z.boolean(),
    cap: count.nullable(),
    formula_cap: count.nullable(),
    awake: count,
    /** The most awake at once in any reading since the controller started (read every 5 s). */
    peak_awake: count,
    starting: count,
    waiting: count,
    waiting_for_room: count,
    hosts: count.nullable(),
    hosts_joined: count.nullable(),
    /**
     * `unprotected` when the valve has never read the box's memory (it
     * parks and refuses nothing for memory), `failing` while readings fail
     * after good ones (new starts wait); null when readings are fine or it is off.
     */
    memory: z.enum(['unprotected', 'failing']).nullable(),
  }),
  guard: z.strictObject({
    enabled: z.boolean(),
    backstop: z.number().min(0).max(1).nullable(),
    share: z.number().min(0).max(1).nullable(),
    /** Noting memory no agent explains (the note itself goes to Core, not here). */
    noting: z.boolean(),
  }),
  /** The launcher link on split boxes (the controller's own user); null until that is built. */
  launcher: z.null(),
  /** The test-box exec exemption; null until that is built. */
  exec_exemption: z.null(),
  totals: z.strictObject({
    desired_running: count,
    desired_stopped: count,
    process: processCounts,
    resting: count,
    out_of_memory: count,
    on_hub: count,
  }),
  agents: z.array(agentSchema).max(500),
  /** Each conversation on the box, by its host's own health file. */
  conversations: z.array(conversationSchema).max(500 * MAX_CONVERSATIONS_PER_AGENT),
  /** The controller's fixed log events, newest last (`live-events.ts`). */
  events: z.array(eventSchema).max(2000),
  /** Older events than the first kept were dropped at this time; null if none were. */
  events_dropped_before: time.nullable(),
});
export type LiveStatus = z.infer<typeof liveStatusSchema>;
type LiveAgent = z.infer<typeof agentSchema>;
export type LiveConversation = z.infer<typeof conversationSchema>;

/** What the controller holds when it collects its status for Core. */
export type LiveStatusInputs = {
  report: Omit<StatusReport, 'seq'>;
  /** Every assigned agent and what its owner wants. */
  assigned: Array<{ agentId: string; desired: 'running' | 'stopped' }>;
  restKind: (agentId: string) => 'resting' | 'out_of_memory' | 'waking' | null;
  /** Each connected agent host on the hub: since when, and whether it joined the box valve. */
  hubHosts: ReadonlyMap<string, { since: number; onValve: boolean }>;
  valve: BoxValveStatus;
  formulaCap: number | null;
  guard: { boxLimit: number; backstop: number; share: number } | null;
  restAfterMs: number | null;
  lastSyncAt: number | null;
  imageDigest: string | null;
  flags: { optimizeForSize: boolean; nodeOptionsSet: boolean };
  /** Split box: the agents' processes and files aren't visible to the controller. */
  launcherMode: boolean;
};

/** What the controller reads of a host's health for its conversations. */
export type HostHealth = {
  sessions?: Record<string, 'active' | 'waking' | 'parked'>;
  busy?: string[];
};

/** What has to be read from the box itself: memory, processes, login copies. */
export type LiveStatusExtras = {
  box: { bytes: number; shmem: number | null } | null;
  controllerAnonBytes: number | null;
  /** Each conversation now: its agent, and its state from the host's health. */
  conversations: Array<{ id: string; agentId: string; state: LiveConversation['state'] }>;
  claudeProcesses: number | null;
  hostProcesses: number | null;
  byAgent: ReadonlyMap<
    string,
    {
      claudeProcesses: number | null;
      hostProcesses: number | null;
      loginCopies: number;
      newestLoginCopyAt: number | null;
    }
  >;
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const finite = (value: number | null) => (value === null || !Number.isFinite(value) ? null : value);

/**
 * The conversations that fit the shape: an id the file can hold, and no more
 * than `MAX_CONVERSATIONS_PER_AGENT` for one agent. One odd entry is left out
 * rather than stopping the whole write.
 */
function listable(
  conversations: LiveStatusExtras['conversations']
): LiveStatusExtras['conversations'] {
  const perAgent = new Map<string, number>();
  return conversations.filter((conversation) => {
    if (!LISTABLE_ID.test(conversation.id) || !LISTABLE_ID.test(conversation.agentId)) return false;
    const listed = perAgent.get(conversation.agentId) ?? 0;
    if (listed >= MAX_CONVERSATIONS_PER_AGENT) return false;
    perAgent.set(conversation.agentId, listed + 1);
    return true;
  });
}

export function liveStatusFrom(
  inputs: LiveStatusInputs,
  extras: LiveStatusExtras,
  clock: { startedAt: number; now: number; peakAwake: number },
  extra: {
    conversationSince?: (key: string, state: LiveConversation['state']) => number;
    events?: { events: LiveEvent[]; droppedBefore: number | null };
  } = {}
): LiveStatus {
  const { report, valve } = inputs;
  const reported = new Map(report.agents.map((agent) => [agent.agent_id, agent]));
  const process = Object.fromEntries(PROCESS_STATES.map((state) => [state, 0])) as Record<
    ProcessState,
    number
  >;
  const agents: LiveAgent[] = [];
  for (const { agentId, desired } of inputs.assigned) {
    const status = reported.get(agentId);
    if (status) process[status.process] += 1;
    const kind = inputs.restKind(agentId);
    const host = inputs.hubHosts.get(agentId);
    const box = extras.byAgent.get(agentId);
    agents.push({
      id: shortId(agentId),
      desired,
      process: status?.process ?? null,
      resting: kind === 'resting',
      out_of_memory: kind === 'out_of_memory',
      rest_after_ms: inputs.restAfterMs,
      on_hub: host !== undefined,
      on_hub_since: iso(host?.since ?? null),
      valve_fallback: valve.enabled && host ? !host.onValve : null,
      sessions_active: status?.sessions.active ?? 0,
      waiting_for_room: status?.waiting_for_room?.count ?? 0,
      claude_processes: inputs.launcherMode ? null : (box?.claudeProcesses ?? null),
      host_processes: inputs.launcherMode ? null : (box?.hostProcesses ?? null),
      login_copies: inputs.launcherMode ? null : (box?.loginCopies ?? 0),
      newest_login_copy_at: inputs.launcherMode ? null : iso(box?.newestLoginCopyAt ?? null),
    });
  }
  agents.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: LIVE_STATUS_VERSION,
    written_at: new Date(clock.now).toISOString(),
    controller: {
      version: report.controller.version,
      image_digest: inputs.imageDigest,
      started_at: new Date(clock.startedAt).toISOString(),
      assignment_revision: report.controller.assignment_revision,
      last_sync_at: iso(inputs.lastSyncAt),
      anon_bytes: extras.controllerAnonBytes,
      optimize_for_size: inputs.flags.optimizeForSize,
      node_options_set: inputs.flags.nodeOptionsSet,
      launcher_mode: inputs.launcherMode,
    },
    box: {
      memory_limit_bytes: inputs.guard?.boxLimit ?? null,
      memory_bytes: extras.box?.bytes ?? null,
      memory_percent:
        extras.box && inputs.guard && inputs.guard.boxLimit > 0
          ? Math.round((extras.box.bytes / inputs.guard.boxLimit) * 1000) / 10
          : null,
      shmem_bytes: extras.box?.shmem ?? null,
      claude_processes: inputs.launcherMode ? null : extras.claudeProcesses,
      host_processes: inputs.launcherMode ? null : extras.hostProcesses,
    },
    valve: {
      enabled: valve.enabled,
      cap: finite(valve.cap),
      formula_cap: finite(inputs.formulaCap),
      awake: valve.awake,
      peak_awake: Math.max(clock.peakAwake, valve.awake),
      starting: valve.starting,
      waiting: valve.waiting,
      waiting_for_room: valve.waitingForRoom,
      hosts: report.machine.valve_hosts ?? null,
      hosts_joined: report.machine.valve_hosts_joined ?? null,
      memory: report.machine.valve_memory ?? null,
    },
    guard: {
      enabled: inputs.guard !== null,
      backstop: inputs.guard?.backstop ?? null,
      share: inputs.guard?.share ?? null,
      noting: report.machine.memory_note !== undefined,
    },
    launcher: null,
    exec_exemption: null,
    totals: {
      desired_running: agents.filter((agent) => agent.desired === 'running').length,
      desired_stopped: agents.filter((agent) => agent.desired === 'stopped').length,
      process,
      resting: agents.filter((agent) => agent.resting).length,
      out_of_memory: agents.filter((agent) => agent.out_of_memory).length,
      on_hub: agents.filter((agent) => agent.on_hub).length,
    },
    agents,
    conversations: listable(extras.conversations)
      .map((conversation) => ({
        id: shortId(conversation.id),
        agent: shortId(conversation.agentId),
        state: conversation.state,
        since: new Date(
          extra.conversationSince?.(
            `${conversation.agentId}/${conversation.id}`,
            conversation.state
          ) ?? clock.now
        ).toISOString(),
      }))
      .sort((a, b) => a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id)),
    events: (extra.events?.events ?? []).map((event) => ({
      at: new Date(event.at).toISOString(),
      kind: event.kind,
      agent: event.agent,
      conversation: event.conversation,
      reason: event.reason,
      count: event.count,
    })),
    events_dropped_before: iso(extra.events?.droppedBefore ?? null),
  };
}

const isClaude = (comm: string) => comm.startsWith('claude');
const isHost = (cmdline: string) =>
  cmdline.includes('shared-host') || cmdline.includes('agent-host');

async function readCapped(path: string, bytes: number): Promise<string | null> {
  let file;
  try {
    file = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').replaceAll('\0', ' ');
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/** The newest change time among an agent's login copies, never reading one. */
async function loginCopies(
  layout: DataLayout,
  agentId: string
): Promise<{ count: number; newest: number | null }> {
  const paths = [
    layout.agentCredentials(agentId),
    join(layout.watcherRoot(agentId), 'provider-home'),
    join(layout.watcherRoot(agentId), 'provider-data'),
  ];
  let found = 0;
  let newest: number | null = null;
  for (const path of paths) {
    try {
      const entry = await lstat(path);
      found += 1;
      newest = newest === null ? entry.mtimeMs : Math.max(newest, entry.mtimeMs);
    } catch {
      // Not there: not a copy.
    }
  }
  return { count: found, newest };
}

/**
 * Reads the box for the live status: its memory as the guard reads it, its
 * Claude and agent host processes (by name and command line, read no further
 * than needed) and, where the guard's owner markers prove whose a process is,
 * each agent's share of them; and each agent's login copies, by their times.
 */
export async function gatherLiveExtras(input: {
  agentIds: string[];
  markers: OwnerMarkers | null;
  layout: DataLayout;
  /** Each agent's host health: its sessions' states and which are mid-turn. */
  health: (agentId: string) => Promise<HostHealth | null>;
  procRoot?: string;
  self?: number;
}): Promise<LiveStatusExtras> {
  const procRoot = input.procRoot ?? '/proc';
  const box = await readBoxMemory({ procRoot }).catch(() => null);
  const controllerAnonBytes = await anonymousBytesIn(
    new ProcReader(),
    join(procRoot, 'self', 'smaps')
  )
    .then((read) => read.bytes)
    .catch(() => null);
  const conversations: LiveStatusExtras['conversations'] = [];
  for (const agentId of input.agentIds) {
    const health = await input.health(agentId).catch(() => null);
    if (!health?.sessions) continue;
    const busy = new Set(health.busy ?? []);
    for (const [id, state] of Object.entries(health.sessions))
      conversations.push({
        id,
        agentId,
        state:
          state === 'parked'
            ? 'parked'
            : state === 'waking'
              ? 'waking'
              : busy.has(id)
                ? 'busy'
                : 'awake',
      });
  }
  const owners = new Map<number, string | null>();
  if (input.markers)
    for (const entry of await listProcesses(input.markers, input.agentIds, {
      procRoot,
      self: input.self,
    }).catch(() => []))
      owners.set(entry.pid, entry.owner);
  const perAgent = new Map(input.agentIds.map((id) => [id, { claude: 0, host: 0 }]));
  let claude: number | null = null;
  let hosts: number | null = null;
  let names: string[] = [];
  try {
    names = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name));
    claude = 0;
    hosts = 0;
  } catch {
    // No /proc (macOS): no process counts.
  }
  for (const name of names) {
    const comm = (await readCapped(join(procRoot, name, 'comm'), 64))?.trim() ?? '';
    const cmdline = (await readCapped(join(procRoot, name, 'cmdline'), CMDLINE_READ_BYTES)) ?? '';
    const claudeHere = isClaude(comm);
    const hostHere = isHost(cmdline);
    if (claudeHere) claude = (claude ?? 0) + 1;
    if (hostHere) hosts = (hosts ?? 0) + 1;
    const owner = owners.get(Number(name));
    const agent = owner ? perAgent.get(owner) : undefined;
    if (agent) {
      if (claudeHere) agent.claude += 1;
      if (hostHere) agent.host += 1;
    }
  }
  const byAgent = new Map<
    string,
    {
      claudeProcesses: number | null;
      hostProcesses: number | null;
      loginCopies: number;
      newestLoginCopyAt: number | null;
    }
  >();
  for (const agentId of input.agentIds) {
    const copies = await loginCopies(input.layout, agentId);
    const counts = perAgent.get(agentId)!;
    byAgent.set(agentId, {
      claudeProcesses: input.markers && claude !== null ? counts.claude : null,
      hostProcesses: input.markers && hosts !== null ? counts.host : null,
      loginCopies: copies.count,
      newestLoginCopyAt: copies.newest,
    });
  }
  return {
    box: box ? { bytes: box.bytes, shmem: box.shmem } : null,
    controllerAnonBytes,
    conversations,
    claudeProcesses: claude,
    hostProcesses: hosts,
    byAgent,
  };
}

/**
 * Writes the live status at most every `LIVE_STATUS_EVERY_MS`, whole (a new
 * file renamed over the old), readable by the controller's own user only. A
 * failed write is logged once until one succeeds again, and never stops the
 * controller: this is a window for an operator, not something it relies on.
 */
export class LiveStatusWriter {
  private lastWrite = Number.NEGATIVE_INFINITY;
  private writing = false;
  private failing = false;
  private peakAwake = 0;
  /** Each conversation's state and since when, as first seen. */
  private readonly seen = new Map<string, { state: LiveConversation['state']; since: number }>();

  constructor(
    private readonly deps: {
      dir: string;
      startedAt: number;
      now: () => number;
      gather: (agentIds: string[]) => Promise<LiveStatusExtras>;
      events?: () => { events: LiveEvent[]; droppedBefore: number | null };
      warn: (message: string, fields: Record<string, unknown>) => void;
    }
  ) {}

  get path(): string {
    return join(this.deps.dir, LIVE_STATUS_FILE);
  }

  /** Called with each status collected for Core; writes when the last write is old enough. */
  async observe(inputs: LiveStatusInputs): Promise<void> {
    this.peakAwake = Math.max(this.peakAwake, inputs.valve.awake);
    const now = this.deps.now();
    if (this.writing || now - this.lastWrite < LIVE_STATUS_EVERY_MS) return;
    this.writing = true;
    try {
      const extras = await this.deps.gather(inputs.assigned.map((entry) => entry.agentId));
      const current = new Set<string>();
      const conversationSince = (key: string, state: LiveConversation['state']) => {
        current.add(key);
        const last = this.seen.get(key);
        if (last?.state === state) return last.since;
        this.seen.set(key, { state, since: now });
        return now;
      };
      const status = liveStatusFrom(
        inputs,
        extras,
        { startedAt: this.deps.startedAt, now, peakAwake: this.peakAwake },
        { conversationSince, events: this.deps.events?.() }
      );
      for (const key of this.seen.keys()) if (!current.has(key)) this.seen.delete(key);
      await writeLiveStatus(this.path, status);
      this.lastWrite = now;
      this.failing = false;
    } catch (error) {
      if (!this.failing)
        this.deps.warn('Could not write the live status file', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      this.failing = true;
    } finally {
      this.writing = false;
    }
  }
}

export async function writeLiveStatus(path: string, status: LiveStatus): Promise<void> {
  const next = `${path}.next`;
  await unlink(next).catch(() => undefined);
  // `wx`: never follows or reuses something already at the temporary name.
  const file = await open(next, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(liveStatusSchema.parse(status))}\n`);
  } finally {
    await file.close();
  }
  await rename(next, path);
}

export type LiveStatusRead =
  | { kind: 'fresh'; status: LiveStatus; ageMs: number }
  | { kind: 'stale'; status: LiveStatus; ageMs: number }
  | { kind: 'missing' }
  | { kind: 'unreadable'; why: string };

/**
 * Reads the file as untrusted: opened without following a link, checked to
 * be a regular file and small on the open handle (so it can't change between
 * the check and the read), and exactly the shape above.
 */
export async function readLiveStatus(dir: string, now: number): Promise<LiveStatusRead> {
  let file;
  try {
    file = await open(join(dir, LIVE_STATUS_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return {
      kind: 'unreadable',
      why: code === 'ELOOP' ? 'not a regular file' : 'cannot be opened',
    };
  }
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile()) return { kind: 'unreadable', why: 'not a regular file' };
    if (info.size > LIVE_STATUS_LIMIT_BYTES) return { kind: 'unreadable', why: 'too large' };
    const buffer = Buffer.alloc(LIVE_STATUS_LIMIT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIVE_STATUS_LIMIT_BYTES) return { kind: 'unreadable', why: 'too large' };
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  let status: LiveStatus;
  try {
    status = liveStatusSchema.parse(JSON.parse(text));
  } catch {
    return { kind: 'unreadable', why: 'not the live status shape' };
  }
  const ageMs = Math.max(0, now - Date.parse(status.written_at));
  return ageMs > LIVE_STATUS_STALE_MS
    ? { kind: 'stale', status, ageMs }
    : { kind: 'fresh', status, ageMs };
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no');
const orDash = (value: number | string | null) => (value === null ? '-' : String(value));
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
const mib = (bytes: number | null) => (bytes === null ? '-' : `${Math.round(bytes / 1048576)}MiB`);

/** One line per reading, each `name: key=value …`, for a person or `grep`. */
export function formatLiveStatus(status: LiveStatus, ageMs: number, now: number): string {
  const { controller, box, valve, guard, totals } = status;
  const process = PROCESS_STATES.map((state) => `${state}=${totals.process[state]}`).join(' ');
  const lastSync =
    controller.last_sync_at === null ? 'never' : seconds(now - Date.parse(controller.last_sync_at));
  return [
    `controller: version=${controller.version} up=${seconds(now - Date.parse(controller.started_at))} file_age=${seconds(ageMs)} revision=${orDash(controller.assignment_revision)} last_sync=${lastSync} image=${controller.image_digest === null ? '-' : controller.image_digest.slice(0, 19)}`,
    `box: memory=${mib(box.memory_bytes)} (${orDash(box.memory_percent)}%) limit=${mib(box.memory_limit_bytes)} claude=${orDash(box.claude_processes)} hosts=${orDash(box.host_processes)}`,
    `controller_process: anon=${mib(controller.anon_bytes)} optimize_for_size=${yesNo(controller.optimize_for_size)} node_options_set=${yesNo(controller.node_options_set)} launcher_mode=${yesNo(controller.launcher_mode)}`,
    valve.enabled
      ? `valve: on cap=${orDash(valve.cap)} formula=${orDash(valve.formula_cap)} awake=${valve.awake} peak=${valve.peak_awake} starting=${valve.starting} waiting=${valve.waiting} waiting_for_room=${valve.waiting_for_room} hosts=${orDash(valve.hosts)} joined=${orDash(valve.hosts_joined)}${valve.memory ? ` memory=${valve.memory}` : ''}`
      : 'valve: off',
    guard.enabled
      ? `guard: on backstop=${orDash(guard.backstop)} share=${orDash(guard.share)} noting=${yesNo(guard.noting)}`
      : 'guard: off',
    `conversations: ${(['waking', 'awake', 'busy', 'parked'] as const)
      .map((state) => `${state}=${status.conversations.filter((c) => c.state === state).length}`)
      .join(' ')}`,
    `agents: desired_running=${totals.desired_running} desired_stopped=${totals.desired_stopped} ${process} resting=${totals.resting} out_of_memory=${totals.out_of_memory} on_hub=${totals.on_hub}`,
    ...status.agents.map(
      (agent) =>
        `agent ${agent.id}: desired=${agent.desired} process=${orDash(agent.process)} resting=${yesNo(agent.resting)} on_hub=${yesNo(agent.on_hub)} fallback=${agent.valve_fallback === null ? '-' : yesNo(agent.valve_fallback)} sessions=${agent.sessions_active} claude=${orDash(agent.claude_processes)} hosts=${orDash(agent.host_processes)} login_copies=${orDash(agent.login_copies)}`
    ),
  ].join('\n');
}

/** What `--since` adds: the events since a time, counted by kind, with the parks listed. */
export type EventsSince = {
  since: string;
  /** False when older events than `since` were dropped, so the counts may be short. */
  complete: boolean;
  counts: Record<(typeof EVENT_KINDS)[number], number>;
  parks: Array<{
    at: string;
    kind: 'parked_for_cap' | 'parked_for_memory';
    agent: string | null;
    conversation: string | null;
  }>;
  refused_by_reason: Record<string, number>;
};

export function eventsSince(status: LiveStatus, sinceMs: number): EventsSince {
  const counts = Object.fromEntries(EVENT_KINDS.map((kind) => [kind, 0])) as EventsSince['counts'];
  const parks: EventsSince['parks'] = [];
  const refused: Record<string, number> = {};
  for (const event of status.events) {
    if (Date.parse(event.at) < sinceMs) continue;
    counts[event.kind] += event.count;
    if (event.kind === 'parked_for_cap' || event.kind === 'parked_for_memory')
      parks.push({
        at: event.at,
        kind: event.kind,
        agent: event.agent,
        conversation: event.conversation,
      });
    if (event.kind === 'starts_refused' && event.reason)
      refused[event.reason] = (refused[event.reason] ?? 0) + event.count;
  }
  const dropped = status.events_dropped_before;
  return {
    since: new Date(sinceMs).toISOString(),
    complete: dropped === null || Date.parse(dropped) < sinceMs,
    counts,
    parks,
    refused_by_reason: refused,
  };
}

export function formatEventsSince(since: EventsSince): string {
  const counts = EVENT_KINDS.map((kind) => `${kind}=${since.counts[kind]}`).join(' ');
  const refused = Object.entries(since.refused_by_reason)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(' ');
  return [
    `since ${since.since}${since.complete ? '' : ' (INCOMPLETE: older events were dropped)'}: ${counts}`,
    ...(refused ? [`refused_by_reason: ${refused}`] : []),
    ...since.parks.map(
      (park) =>
        `park ${park.at} ${park.kind === 'parked_for_cap' ? 'cap' : 'memory'} agent=${park.agent ?? '-'} conversation=${park.conversation ?? '-'}`
    ),
  ].join('\n');
}
