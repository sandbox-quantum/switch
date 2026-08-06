import { readFile } from 'node:fs/promises';
import path from 'node:path';
import z from 'zod';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';
import { atomicWriteFile } from './atomic-file';
import type { WatcherLogger } from './notification-watcher';
import { sidecarStateRelPath } from './sidecar-paths';

/**
 * The sidecar's durable state.
 *
 * Everything the sidecar knew used to live in process memory, so a restart made
 * it forget which panes on the host were its own. That mattered more than it
 * sounds: `/sessions` only reports a pane the sidecar has "seen", and it only
 * sees one when that session posts a hook — which an idle agent never does. So
 * a restarted sidecar reported no sessions at all, and every client, unable to
 * tell "gone" from "not yet re-seen", deleted its rows for sessions whose panes
 * were alive and healthy.
 *
 * Persisting the registry closes that window: the sidecar knows its sessions
 * from the moment it boots, before any agent says anything.
 */

const sessionEntry = z.object({
  sessionId: z.string(),
  /** The Switch room this session attends, or null for a bare session. */
  roomId: z.string().nullable(),
  /** Needed to rebuild the session's prompt injector and control adapter when
   * its room connection is restored after a restart. */
  providerId: z.string(),
  tmuxTarget: z.string(),
});

const stateV1 = z.object({
  version: z.literal('1'),
  /**
   * Incremented on every start. Clients tag their `/events` cursor with it so a
   * restarted sidecar — whose sequence numbers begin again at zero — is not
   * mistaken for the same stream continuing.
   */
  epoch: z.number().int().nonnegative(),
  sessions: z.array(sessionEntry),
});

export const sidecarStateSchema = defineVersionedSchema().initial('1', stateV1).build();

export type SidecarSessionEntry = z.infer<typeof sessionEntry>;
export type SidecarState = z.infer<typeof stateV1>;

const EMPTY_STATE: SidecarState = { version: '1', epoch: 0, sessions: [] };

/** Raised when the state on disk was written by a NEWER sidecar than this one. */
export class SidecarStateTooNewError extends Error {
  constructor(readonly foundVersion: string) {
    super(
      `sidecar: state file was written by a newer sidecar (schema version ${foundVersion}); ` +
        'refusing to start rather than discard its sessions — deploy the matching sidecar version'
    );
    this.name = 'SidecarStateTooNewError';
  }
}

/**
 * Load durable state, upgrading older schema versions forward.
 *
 * A missing file is a first run, and a corrupt one is logged and treated as
 * empty — in both cases the sidecar can rebuild by observation. A *newer*
 * version is different in kind: the state belongs to a sidecar that understands
 * more than this one, and quietly starting empty would delete its sessions from
 * every client. That one throws.
 */
export async function loadSidecarState(
  repoDir: string,
  slug: string,
  log: WatcherLogger
): Promise<SidecarState> {
  const file = path.join(repoDir, sidecarStateRelPath(slug));
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { ...EMPTY_STATE };
  }

  // `parseJson` collapses every failure to null, which loses the one
  // distinction that matters here: unreadable (rebuild by observation) versus
  // written-by-a-newer-sidecar (stop). Parse and dispatch on the status.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('sidecar: state file is not valid JSON — starting with empty state', { file });
    return { ...EMPTY_STATE };
  }

  const result = sidecarStateSchema.safeParse(parsed);
  switch (result.status) {
    case 'ok':
      return result.data;
    case 'future-version':
      throw new SidecarStateTooNewError(result.version);
    default:
      log.warn('sidecar: state file unreadable — starting with empty state', {
        file,
        status: result.status,
      });
      return { ...EMPTY_STATE };
  }
}

/**
 * Persist state atomically. Callers mutate through `SidecarStateStore`, which
 * coalesces bursts — a session connecting touches this several times in a row.
 */
async function writeSidecarState(
  repoDir: string,
  slug: string,
  state: SidecarState
): Promise<void> {
  const file = path.join(repoDir, sidecarStateRelPath(slug));
  await atomicWriteFile(file, sidecarStateSchema.serialize(state));
}

const FLUSH_DEBOUNCE_MS = 250;

/**
 * In-memory view of the durable state, flushed on a short debounce.
 *
 * Reads are synchronous because the hot paths (`/sessions`, hook handling) run
 * on every event and must not wait on the disk.
 */
export class SidecarStateStore {
  private readonly sessions = new Map<string, SidecarSessionEntry>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private stopped = false;

  private constructor(
    private readonly repoDir: string,
    private readonly slug: string,
    readonly epoch: number,
    private readonly log: WatcherLogger
  ) {}

  /**
   * Load state, drop entries whose pane no longer exists, and bump the epoch.
   *
   * The reconcile against tmux is the point: replaying the file verbatim would
   * resurrect sessions that died while the sidecar was down, and a ghost row is
   * how a client ends up re-attaching into a blank pane.
   */
  static async open(opts: {
    repoDir: string;
    slug: string;
    isPaneAlive: (tmuxTarget: string) => Promise<boolean>;
    log: WatcherLogger;
  }): Promise<SidecarStateStore> {
    const { repoDir, slug, isPaneAlive, log } = opts;
    const loaded = await loadSidecarState(repoDir, slug, log);
    const store = new SidecarStateStore(repoDir, slug, loaded.epoch + 1, log);

    const alive = await Promise.all(
      loaded.sessions.map(async (s) => ((await isPaneAlive(s.tmuxTarget)) ? s : null))
    );
    for (const entry of alive) if (entry) store.sessions.set(entry.sessionId, entry);

    const dropped = loaded.sessions.length - store.sessions.size;
    if (dropped > 0) {
      log.info('sidecar: dropped restored sessions whose pane is gone', { dropped });
    }
    log.info('sidecar: restored durable state', {
      epoch: store.epoch,
      sessions: store.sessions.size,
    });
    store.scheduleFlush();
    return store;
  }

  /** Every session this sidecar owns, whether or not it has posted a hook yet. */
  knownSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  entries(): SidecarSessionEntry[] {
    return [...this.sessions.values()];
  }

  roomIdFor(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.roomId ?? null;
  }

  /**
   * Record (or update) a session. A null `roomId` means "no room information",
   * not "left its room" — a bare hook from a session that is already attending
   * one must not erase that, so the known room is kept.
   */
  record(entry: SidecarSessionEntry): void {
    const prev = this.sessions.get(entry.sessionId);
    const merged: SidecarSessionEntry = { ...entry, roomId: entry.roomId ?? prev?.roomId ?? null };
    if (
      prev &&
      prev.roomId === merged.roomId &&
      prev.providerId === merged.providerId &&
      prev.tmuxTarget === merged.tmuxTarget
    ) {
      return;
    }
    this.sessions.set(entry.sessionId, merged);
    this.scheduleFlush();
  }

  /**
   * Drop a session's room, keeping the session itself.
   *
   * The counterpart `record` cannot express: there a null room means "no room
   * information" and the known room is kept, which is right for a bare hook but
   * wrong for a session that genuinely left. Without this the last known room
   * outlives the connection that held it, and `/sessions` keeps reporting a
   * session under a room somebody else now holds.
   */
  clearRoom(sessionId: string): void {
    const prev = this.sessions.get(sessionId);
    if (!prev || prev.roomId === null) return;
    this.sessions.set(sessionId, { ...prev, roomId: null });
    this.scheduleFlush();
  }

  forget(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.stopped || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushing = this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const state: SidecarState = {
      version: '1',
      epoch: this.epoch,
      sessions: this.entries(),
    };
    try {
      await writeSidecarState(this.repoDir, this.slug, state);
    } catch (error) {
      // Losing a write degrades restart fidelity but must not take the sidecar
      // down while it is serving live sessions.
      this.log.warn('sidecar: failed to persist state', { error: String(error) });
    }
  }

  /** Flush any pending change and stop scheduling new ones. */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flushing = this.flush();
    }
    this.stopped = true;
    await this.flushing;
  }
}
