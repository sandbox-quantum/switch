import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type Command, serverEventSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import {
  type CutoverItem,
  HOSTED_STATE_VERSION,
  PREFLIGHT_BLOCKED_FILE,
  readStateVersion,
  writeCutoverManifest,
  writeJsonAtomically,
  writeStateVersion,
} from './cutover-manifest';
import { PLACEMENTS_FILE } from './placements';
import { hostInboxRecordSchema } from './session-host';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';
import { deliveryRecordSchema } from './shared-delivery';
import { sharedStateRecordSchema } from './shared-state';
import { assignmentRecordSchema } from './shared-watcher';

/**
 * Moves a retained hosted volume from the layout the session-table worker
 * (one room connection per session, Switch holding each session's commands)
 * left to the watcher's, before the watcher first runs on it, and lists what
 * its journals still hold for Switch to decide once. Every step is safe to
 * repeat: a volume whose preflight stopped part way is finished by the next
 * boot, and a finished one is left alone.
 */

const PLAN_FILE = 'hosted-deployment.json';
const CONFIG_FILE = 'config.json';
const ASSIGNMENTS_FILE = 'assignments.jsonl';
const LEGACY_ROOM_INBOX = 'room-inbox.jsonl';
const PRE_CUTOVER = '.pre-cutover';
const CREDENTIAL_FILES = new Set(['opencode/auth.json', 'antigravity-acp/acp_token.json']);
const OWNER_FILES = ['shared-owner.lock', join('supervisor', 'owner.json')];
const TICKET_DIRECTORIES = ['ownership', join('supervisor', 'ownership')];

type Step =
  | 'plan'
  | 'sessions'
  | 'assignments'
  | 'placements'
  | 'owners'
  | 'provider-homes'
  | 'manifest';

class Blocked extends Error {
  constructor(
    readonly step: Step,
    readonly file: string,
    readonly line: number | null,
    detail: string
  ) {
    super(detail);
  }
}

export class PreflightBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightBlockedError';
  }
}

const legacyPlanSchema = z.object({
  version: z.literal(1),
  spec: z
    .object({
      session: z.object({ sessionId: z.string().min(1), agentId: z.string().min(1) }),
      watch: z.boolean().optional(),
    })
    .refine((spec) => !('revision' in spec)),
  config: z.object({
    session: z.object({ hostId: z.string().min(1), epoch: z.string().min(1) }),
    roomConnection: z.object({ connectionId: z.string().min(1) }),
  }),
});

const legacyGapSchema = z
  .strictObject({ fromSequence: z.number().int().nonnegative(), reason: z.string().min(1) })
  .nullable();
const legacyRoomInboxSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('failure-notified'),
    identity: z.string().min(1),
    reason: z.enum(['startup', 'conversation', 'delivery']),
  }),
  z.strictObject({
    type: z.literal('received'),
    sequence: z.number().int().positive(),
    roomId: z.string().min(1),
    messageId: z.string().min(1),
    missed: z.number().int().nonnegative().default(0),
    gap: legacyGapSchema.default(null),
  }),
  z.strictObject({
    type: z.literal('ack'),
    sequence: z.number().int().positive(),
    identity: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('cursor'),
    sequence: z.number().int().nonnegative(),
    reset: z.boolean(),
    gap: legacyGapSchema,
  }),
  z.strictObject({ type: z.literal('rooms'), rooms: z.array(z.string()) }),
]);

const HOST_RANK = { accepted: 1, dispatched: 2, finished: 3 } as const;

/** A delivery that is not a room message: a join or task event, named by the digest of its payload. */
const NOT_A_MESSAGE = /^(room_join|task_[a-z_]+):[0-9a-f]{64}$/;

export function legacySessionsBase(root: string): string {
  return join(root, 'home', '.local', 'state', 'switch', 'sdk-sessions');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonFile(step: Step, path: string): Promise<unknown> {
  const text = await optionalText(path);
  if (text === null) throw new Blocked(step, path, null, 'the file is missing');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Blocked(step, path, null, `not JSON: ${String(error)}`);
  }
}

/** Each record of a journal, parsed as the watcher will parse it; a torn tail blocks as it would. */
async function readJournal<T>(
  step: Step,
  path: string,
  parse: (value: unknown) => T
): Promise<T[]> {
  const text = await optionalText(path);
  if (text === null) return [];
  if (text && !text.endsWith('\n'))
    throw new Blocked(step, path, null, 'the journal ends in an incomplete write');
  const records: T[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    try {
      records.push(parse(JSON.parse(lines[index]!)));
    } catch (error) {
      throw new Blocked(
        step,
        path,
        index + 1,
        error instanceof z.ZodError ? z.prettifyError(error) : String(error)
      );
    }
  }
  return records;
}

async function writeTextAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  await rename(temporary, path);
}

/** Keeps the file as the session-table worker left it, once, beside the migrated one. */
async function keepOriginal(path: string): Promise<void> {
  const original = `${path}${PRE_CUTOVER}`;
  if (await exists(original)) return;
  const text = await optionalText(path);
  if (text === null) return;
  await writeTextAtomically(original, text);
}

/**
 * A config the session-table worker wrote, in the watcher's shape: its own
 * room connection's rooms and cursor are no session's to hold now, the runtime
 * path it baked in is not how the Switch tools reach a session, and the
 * provider homes are the watcher's.
 */
function currentConfig(
  step: Step,
  file: string,
  line: number | null,
  raw: unknown,
  environment: Record<string, string>
): SharedHostConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Blocked(step, file, line, 'the configuration is not an object');
  const value = structuredClone(raw) as Record<string, unknown>;
  const execution = value.execution as Record<string, unknown> | undefined;
  if (execution && typeof execution === 'object') delete execution.mcpRuntimePath;
  const connection = value.roomConnection as Record<string, unknown> | undefined;
  if (connection && typeof connection === 'object') {
    const rooms = connection.rooms;
    delete connection.rooms;
    delete connection.startCursor;
    if (Array.isArray(rooms) && rooms.length === 1 && connection.restoreRoomId === undefined)
      connection.restoreRoomId = rooms[0];
  }
  const start = value.start as { input?: { env?: Record<string, string> } } | undefined;
  if (start?.input?.env && typeof start.input.env === 'object')
    Object.assign(start.input.env, environment);
  const parsed = sharedConfigSchema.safeParse(value);
  if (!parsed.success) throw new Blocked(step, file, line, z.prettifyError(parsed.error));
  return parsed.data;
}

async function migrateConfig(
  path: string,
  environment: Record<string, string>
): Promise<SharedHostConfig> {
  const raw = await readJsonFile('sessions', path);
  const config = currentConfig('sessions', path, null, raw, environment);
  if (!isDeepStrictEqual(raw, config)) {
    await keepOriginal(path);
    await writeJsonAtomically(path, config);
  }
  return config;
}

type HostState = keyof typeof HOST_RANK;
type RoomState = {
  roomId: string;
  messageId: string;
  threadId: string | null;
  pending: boolean;
  notified: boolean;
  host: HostState | null;
};

/** What one session root still holds for Switch, read from its journals. */
async function sessionItems(
  sessionRoot: string,
  sessionId: string
): Promise<{
  items: CutoverItem[];
  rooms: string[] | null;
}> {
  const rooms = new Map<string, RoomState>();
  const room = (roomId: string, messageId: string): RoomState => {
    const key = JSON.stringify([roomId, messageId]);
    let state = rooms.get(key);
    if (!state) {
      state = { roomId, messageId, threadId: null, pending: false, notified: false, host: null };
      rooms.set(key, state);
    }
    return state;
  };

  const inboxPath = join(sessionRoot, LEGACY_ROOM_INBOX);
  const keptPath = `${inboxPath}${PRE_CUTOVER}`;
  const legacyPath = (await exists(inboxPath)) ? inboxPath : keptPath;
  const outstanding = new Map<string, { roomId: string; messageId: string }>();
  const notified = new Set<string>();
  const sequences = new Map<number, string>();
  let cursor: number | null = null;
  let served: string[] | null = null;
  const legacy = await readJournal('sessions', legacyPath, (value) =>
    legacyRoomInboxSchema.parse(value)
  );
  for (const [index, record] of legacy.entries()) {
    if (record.type === 'failure-notified') notified.add(record.identity);
    else if (record.type === 'received') {
      if (record.gap && cursor !== null && record.sequence < cursor) sequences.clear();
      const key = JSON.stringify([record.roomId, record.messageId]);
      outstanding.set(key, { roomId: record.roomId, messageId: record.messageId });
      sequences.set(record.sequence, key);
      cursor = record.sequence;
    } else if (record.type === 'ack') {
      const key = record.identity ?? sequences.get(record.sequence);
      if (!key)
        throw new Blocked(
          'sessions',
          legacyPath,
          index + 1,
          'the room inbox acknowledges a delivery it never received'
        );
      outstanding.delete(key);
    } else if (record.type === 'cursor') {
      if (record.reset) sequences.clear();
      cursor = record.sequence;
    } else served = record.rooms;
  }
  for (const [key, delivery] of outstanding) {
    if (NOT_A_MESSAGE.test(delivery.messageId)) continue;
    const state = room(delivery.roomId, delivery.messageId);
    state.pending = true;
    state.notified = notified.has(key);
  }

  const inboxRecords = await readJournal('sessions', join(sessionRoot, 'inbox.jsonl'), (value) =>
    hostInboxRecordSchema.parse(value)
  );
  const commands = new Map<string, { origin: Command['origin']; host: HostState }>();
  let resetPending = false;
  for (const record of inboxRecords) {
    if (record.type === 'accepted')
      commands.set(record.command.commandId, { origin: record.command.origin, host: 'accepted' });
    else if (record.type === 'dispatched' || record.type === 'finished') {
      const command = commands.get(record.commandId);
      if (command && HOST_RANK[record.type] > HOST_RANK[command.host]) command.host = record.type;
    } else if (record.type === 'reset-started') resetPending = true;
    else if (record.type === 'reset-completed') resetPending = false;
  }
  const items: CutoverItem[] = [];
  for (const [commandId, command] of commands) {
    const { origin } = command;
    if (origin.roomId !== null && origin.messageId !== null) {
      const state = room(origin.roomId, origin.messageId);
      if (state.host === null || HOST_RANK[command.host] > HOST_RANK[state.host])
        state.host = command.host;
      state.threadId ??= origin.threadId;
    } else if (origin.roomId === null && origin.surface === 'console')
      items.push({
        kind: 'console_command',
        session_id: sessionId,
        command_id: commandId,
        host: command.host,
      });
  }

  const events = await readJournal('sessions', join(sessionRoot, 'events.jsonl'), (value) =>
    serverEventSchema.parse(value)
  );
  const turns = new Map<string, string | null>();
  const open = new Map<string, string>();
  for (const event of events) {
    const body = event.body;
    if (body.type === 'turn.upsert') turns.set(body.turnId, body.commandId);
    else if (body.type === 'request.opened') open.set(body.request.requestId, body.request.turnId);
    else if (body.type === 'request.settled') open.delete(body.requestId);
  }
  for (const [requestId, turnId] of open) {
    const commandId = turns.get(turnId) ?? null;
    const origin = commandId ? commands.get(commandId)?.origin : undefined;
    items.push({
      kind: 'request_open',
      session_id: sessionId,
      request_id: requestId,
      room_id: origin?.roomId ?? null,
      thread_id: origin?.roomId ? origin.threadId : null,
    });
  }
  if (resetPending) items.push({ kind: 'reset_pending', session_id: sessionId });
  for (const state of rooms.values())
    items.push({
      kind: 'room_message',
      session_id: sessionId,
      room_id: state.roomId,
      message_id: state.messageId,
      thread_id: state.threadId,
      room_pending: state.pending,
      failure_notified: state.notified,
      host: state.host,
    });
  return { items, rooms: served };
}

async function validateSessionJournals(sessionRoot: string): Promise<void> {
  await readJournal('sessions', join(sessionRoot, 'shared-state.jsonl'), (value) =>
    sharedStateRecordSchema.parse(value)
  );
  for (const name of await readdir(sessionRoot))
    if (/^delivery-[0-9a-f]{64}\.jsonl$/.test(name))
      await readJournal('sessions', join(sessionRoot, name), (value) =>
        deliveryRecordSchema.parse(value)
      );
}

/**
 * Owner records the session-table worker stamped with its machine: every
 * process that wrote one is gone with the machine it ran on, and the watcher
 * reads these strictly.
 */
async function clearMachineOwners(root: string): Promise<void> {
  const candidates = [...OWNER_FILES.map((file) => join(root, file))];
  for (const directory of TICKET_DIRECTORIES) {
    let names: string[];
    try {
      names = await readdir(join(root, directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names)
      if (name.endsWith('.json')) candidates.push(join(root, directory, name));
  }
  for (const path of candidates) {
    const text = await optionalText(path);
    if (text === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Blocked('owners', path, null, 'the owner record is not JSON');
    }
    if (value && typeof value === 'object' && 'machine' in value) await unlink(path);
  }
}

/**
 * Moves what a session's provider kept in its own home into the watcher's.
 * A file already there with the same bytes stays; one that differs blocks,
 * since neither copy can be chosen for the provider. The credential is
 * written fresh by the bootstrap and never moved. What is left is kept under
 * the source's name with `.pre-cutover`.
 */
async function mergeInto(source: string, destination: string): Promise<void> {
  const walk = async (relativePath: string): Promise<void> => {
    const from = join(source, relativePath);
    const to = join(destination, relativePath);
    const entry = await lstat(from);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const name of (await readdir(from)).sort()) await walk(join(relativePath, name));
      return;
    }
    if (CREDENTIAL_FILES.has(relativePath)) return;
    if (!(await exists(to))) {
      await rename(from, to);
      return;
    }
    const existing = await lstat(to);
    const same = entry.isSymbolicLink()
      ? existing.isSymbolicLink() && (await readlink(from)) === (await readlink(to))
      : existing.isFile() && (await readFile(from)).equals(await readFile(to));
    if (!same)
      throw new Blocked(
        'provider-homes',
        from,
        null,
        `${to} already exists with different content; move one of them aside and boot again`
      );
  };
  if (!(await exists(source))) return;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(source)).sort()) await walk(name);
  await rename(source, `${source}${PRE_CUTOVER}`);
}

async function migrateProviderHome(
  root: string,
  sessionRoot: string,
  provider: SharedHostConfig['start']['provider']
): Promise<void> {
  if (provider === 'opencode')
    await mergeInto(join(sessionRoot, 'provider-data'), join(root, 'provider-data'));
  else if (provider === 'antigravity')
    await mergeInto(join(sessionRoot, 'provider-home'), join(root, 'provider-home'));
}

async function migrateAssignments(
  root: string,
  environment: Record<string, string>
): Promise<Map<string, string>> {
  const path = join(root, ASSIGNMENTS_FILE);
  const text = await optionalText(path);
  const placements = new Map<string, string>();
  if (text === null) return placements;
  if (text && !text.endsWith('\n'))
    throw new Blocked('assignments', path, null, 'the journal ends in an incomplete write');
  const lines = text.split('\n').filter(Boolean);
  const migrated: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Blocked('assignments', path, index + 1, `not JSON: ${String(error)}`);
    }
    const record =
      'config' in raw
        ? { ...raw, config: currentConfig('assignments', path, index + 1, raw.config, environment) }
        : raw;
    const parsed = assignmentRecordSchema.safeParse(record);
    if (!parsed.success)
      throw new Blocked('assignments', path, index + 1, z.prettifyError(parsed.error));
    if ('config' in parsed.data) {
      const sessionId = parsed.data.config.session.sessionId;
      for (const [placed, roomId] of placements)
        if (roomId === parsed.data.roomId) placements.delete(placed);
      placements.set(sessionId, parsed.data.roomId);
    }
    migrated.push(record);
  }
  const next = migrated.map((record) => `${JSON.stringify(record)}\n`).join('');
  if (next !== text) {
    await keepOriginal(path);
    await writeTextAtomically(path, next);
  }
  return placements;
}

export interface PreflightPlan {
  version: 1;
  spec: { session: { sessionId: string; agentId: string } };
  config: SharedHostConfig;
}

async function migratePlan(root: string, candidate: PreflightPlan): Promise<boolean> {
  const planPath = join(root, PLAN_FILE);
  const kept = `${planPath}${PRE_CUTOVER}`;
  const text = await optionalText(planPath);
  if (text === null) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Blocked('plan', planPath, null, `not JSON: ${String(error)}`);
  }
  const legacy = legacyPlanSchema.safeParse(raw);
  if (!legacy.success) return exists(kept);
  if (legacy.data.spec.session.agentId !== candidate.spec.session.agentId)
    throw new Blocked(
      'plan',
      planPath,
      null,
      `the saved deployment belongs to agent ${legacy.data.spec.session.agentId}, not ${candidate.spec.session.agentId}`
    );
  if (legacy.data.spec.watch === undefined)
    throw new Blocked(
      'plan',
      planPath,
      null,
      'the saved deployment is a single room session, which has no watcher layout to move to; delete the launch and start it again'
    );
  const config = structuredClone(candidate.config);
  config.session.hostId = legacy.data.config.session.hostId;
  config.session.epoch = legacy.data.config.session.epoch;
  config.roomConnection = { connectionId: legacy.data.config.roomConnection.connectionId };
  await keepOriginal(planPath);
  await keepOriginal(join(root, CONFIG_FILE));
  await writeJsonAtomically(join(root, CONFIG_FILE), config);
  await writeJsonAtomically(planPath, { ...candidate, config });
  return true;
}

async function sessionRoots(root: string): Promise<string[]> {
  const base = legacySessionsBase(root);
  let names: string[];
  try {
    names = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const roots: string[] = [];
  for (const name of names.sort())
    if (/^[0-9a-f]{64}$/.test(name) && (await lstat(join(base, name))).isDirectory())
      roots.push(join(base, name));
  return roots;
}

function placementsFrom(
  served: Map<string, string[]>,
  assigned: Map<string, string>
): Record<string, string> {
  const placements = new Map<string, string>();
  const holder = new Map<string, string>();
  for (const [sessionId, rooms] of served) {
    if (rooms.length > 1)
      throw new Blocked(
        'placements',
        sessionId,
        null,
        `session ${sessionId} served ${rooms.length} rooms; a session attends one`
      );
    const roomId = rooms[0];
    if (roomId === undefined) continue;
    const other = holder.get(roomId);
    if (other)
      throw new Blocked(
        'placements',
        sessionId,
        null,
        `room ${roomId} was served by two sessions (${other} and ${sessionId})`
      );
    placements.set(sessionId, roomId);
    holder.set(roomId, sessionId);
  }
  for (const [sessionId, roomId] of assigned)
    if (!placements.has(sessionId) && !holder.has(roomId)) {
      placements.set(sessionId, roomId);
      holder.set(roomId, sessionId);
    }
  return Object.fromEntries([...placements].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function itemKey(item: CutoverItem): string {
  return JSON.stringify(item);
}

async function migrate(root: string, candidate: PreflightPlan): Promise<boolean> {
  if (!(await migratePlan(root, candidate))) return false;
  const environment = candidate.config.start.input.env;
  const items: CutoverItem[] = [];
  const served = new Map<string, string[]>();
  await clearMachineOwners(root);
  for (const sessionRoot of await sessionRoots(root)) {
    const configPath = join(sessionRoot, CONFIG_FILE);
    if (!(await exists(configPath)) && !(await exists(`${configPath}${PRE_CUTOVER}`))) continue;
    const config = await migrateConfig(configPath, environment);
    if (config.session.agentId !== candidate.spec.session.agentId)
      throw new Blocked(
        'sessions',
        configPath,
        null,
        `the session belongs to agent ${config.session.agentId}`
      );
    const sessionId = config.session.sessionId;
    if (createHash('sha256').update(sessionId).digest('hex') !== sessionRoot.split('/').at(-1))
      throw new Blocked(
        'sessions',
        configPath,
        null,
        'the session id does not name this directory'
      );
    await validateSessionJournals(sessionRoot);
    const held = await sessionItems(sessionRoot, sessionId);
    items.push(...held.items);
    if (held.rooms) served.set(sessionId, held.rooms);
    const legacyInbox = join(sessionRoot, LEGACY_ROOM_INBOX);
    if (await exists(legacyInbox)) await rename(legacyInbox, `${legacyInbox}${PRE_CUTOVER}`);
    await clearMachineOwners(sessionRoot);
    await migrateProviderHome(root, sessionRoot, config.start.provider);
  }
  const assigned = await migrateAssignments(root, environment);
  const placementsPath = join(root, PLACEMENTS_FILE);
  if (!(await exists(placementsPath)))
    await writeJsonAtomically(placementsPath, { placements: placementsFrom(served, assigned) });
  items.sort((a, b) => (itemKey(a) < itemKey(b) ? -1 : itemKey(a) > itemKey(b) ? 1 : 0));
  await writeCutoverManifest(root, {
    manifest_sha256: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    items,
  });
  return true;
}

/**
 * Brings the volume at `root` to this worker's layout before anything reads
 * it, or refuses to: a volume it cannot migrate stops at the step that failed, with
 * `preflight-blocked.json` naming the step, file and line, and the worker does
 * not start. Answers whether a pre-cutover plan was replaced.
 */
export async function runHostedPreflight(root: string, candidate: PreflightPlan): Promise<boolean> {
  const blockedPath = join(root, PREFLIGHT_BLOCKED_FILE);
  const version = await readStateVersion(root);
  if (version !== null && version > HOSTED_STATE_VERSION)
    throw new PreflightBlockedError(
      `This volume is at layout version ${version}, newer than this worker's ${HOSTED_STATE_VERSION}; run a current worker image.`
    );
  if (version === HOSTED_STATE_VERSION) return false;
  let migrated: boolean;
  try {
    migrated = await migrate(root, candidate);
  } catch (error) {
    const blocked =
      error instanceof Blocked
        ? { step: error.step, file: error.file, line: error.line, error: error.message }
        : {
            step: 'manifest' as const,
            file: root,
            line: null,
            error: error instanceof Error ? error.message : String(error),
          };
    await writeJsonAtomically(blockedPath, { version: HOSTED_STATE_VERSION, ...blocked });
    throw new PreflightBlockedError(
      `The hosted preflight could not migrate this volume at step ${blocked.step} (${blocked.file}${blocked.line === null ? '' : `:${blocked.line}`}): ${blocked.error}. Details are in ${blockedPath}.`
    );
  }
  await writeStateVersion(root);
  if (await exists(blockedPath)) await unlink(blockedPath);
  return migrated;
}
