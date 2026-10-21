import { randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { replaceFile } from './replace-file';

export const PLACEMENTS_FILE = 'placements.json';

const fileSchema = z.strictObject({
  placements: z.record(z.string().min(1), z.string().min(1)),
  /** Shared room → the session answering it from its home room. */
  shares: z.record(z.string().min(1), z.string().min(1)).optional(),
});

/** Placements as sent to Switch and written to disk: session id → room id. */
export type PlacementMap = Record<string, string>;

/** Shares as written to disk: shared room id → session id. */
export type ShareMap = Record<string, string>;

/**
 * Which of an agent's local sessions attends which room.
 *
 * The watcher holding the agent's connection is the authority: it routes each
 * room's messages to the session placed there, and restates the whole map to
 * Switch after every change. At most one session per room and one room per
 * session, except that a session placed in its agent's home room also answers
 * for that agent's shared rooms (its shares, `switch_core.shared_session`).
 * A room is covered once: by a placement or a share. Kept in memory and written whole to `placements.json` in the
 * watcher's root after every change, and read back only when the watcher
 * starts, so a restart routes where the last run did.
 */
export class SessionPlacements {
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(placements: PlacementMap) => void>();

  private constructor(
    private readonly path: string,
    private readonly rooms: Map<string, string>,
    /** Shared room → the session answering it from its home room. */
    private readonly shared: Map<string, string> = new Map()
  ) {}

  /**
   * The placements saved under `root`. A root that has none yet (a watcher
   * that predates this file) is seeded once from `seed`, and that is written
   * straight away so it is never derived again.
   */
  static async open(
    root: string,
    seed: () => Iterable<[sessionId: string, roomId: string]>
  ): Promise<SessionPlacements> {
    const path = join(root, PLACEMENTS_FILE);
    let saved: PlacementMap | null;
    let savedShares: ShareMap = {};
    try {
      const file = fileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      saved = file.placements;
      savedShares = file.shares ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`${path} cannot be read as session placements: ${String(error)}`);
      saved = null;
    }
    const placements = new SessionPlacements(path, new Map());
    if (saved) {
      for (const [sessionId, roomId] of Object.entries(saved)) {
        const holder = placements.sessionIn(roomId);
        if (holder)
          throw new Error(
            `${path} places room ${roomId} with two sessions (${holder} and ${sessionId}).`
          );
        placements.rooms.set(sessionId, roomId);
      }
      for (const [roomId, sessionId] of Object.entries(savedShares))
        if (placements.rooms.has(sessionId) && !placements.sessionIn(roomId))
          placements.shared.set(roomId, sessionId);
      return placements;
    }
    for (const [sessionId, roomId] of seed()) placements.apply(sessionId, roomId);
    await placements.persist();
    return placements;
  }

  /** Room → session. */
  get byRoom(): ReadonlyMap<string, string> {
    return new Map([...this.rooms].map(([sessionId, roomId]) => [roomId, sessionId]));
  }

  /** Session → room. */
  get bySession(): ReadonlyMap<string, string> {
    return new Map(this.rooms);
  }

  /** The session attending this room, placed there or sharing it, or null. */
  sessionIn(roomId: string): string | null {
    return this.placedIn(roomId) ?? this.shared.get(roomId) ?? null;
  }

  /** The session placed in this room, leaving shares out, or null. */
  placedIn(roomId: string): string | null {
    for (const [sessionId, placed] of this.rooms) if (placed === roomId) return sessionId;
    return null;
  }

  /** The session answering this room from its home room, or null. */
  sharerOf(roomId: string): string | null {
    return this.shared.get(roomId) ?? null;
  }

  /** The rooms this session answers for from its home room. */
  sharesOf(sessionId: string): string[] {
    return [...this.shared].filter(([, holder]) => holder === sessionId).map(([room]) => room);
  }

  /** Shares as sent to Switch: session id → the rooms it answers from its home room. */
  sharesBySession(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [roomId, sessionId] of [...this.shared].sort(([a], [b]) => a.localeCompare(b)))
      (out[sessionId] ??= []).push(roomId);
    return out;
  }

  sharesSnapshot(): ShareMap {
    return Object.fromEntries(this.shared);
  }

  /** The room this session attends, or null. */
  roomOf(sessionId: string): string | null {
    return this.rooms.get(sessionId) ?? null;
  }

  /**
   * Whether this session answers for this room: where its replies may go
   * without it moving there.
   */
  serves(sessionId: string, roomId: string): boolean {
    return this.roomOf(sessionId) === roomId || this.shared.get(roomId) === sessionId;
  }

  snapshot(): PlacementMap {
    return Object.fromEntries(this.rooms);
  }

  /** Called with the whole map after every change; the returned function stops it. */
  onChange(listener: (placements: PlacementMap) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Put the session in the room. `previous` is the room it leaves, and
   * `displaced` the session that attended the room until now; either is null
   * when there was none.
   */
  async place(
    sessionId: string,
    roomId: string
  ): Promise<{ previous: string | null; displaced: string | null }> {
    const outcome = this.apply(sessionId, roomId);
    this.changed();
    await this.persist();
    return outcome;
  }

  /**
   * Have the session, placed in its home room, also answer for this room.
   * `displaced` is the session placed in the room until now, or null.
   */
  async share(sessionId: string, roomId: string): Promise<{ displaced: string | null }> {
    if (!this.rooms.has(sessionId))
      throw new Error(
        `Session ${sessionId} is placed in no room, so it cannot share room ${roomId}.`
      );
    if (this.rooms.get(sessionId) === roomId) return { displaced: null };
    const holder = this.placedIn(roomId);
    if (holder) this.drop(holder);
    this.shared.set(roomId, sessionId);
    this.changed();
    await this.persist();
    return { displaced: holder };
  }

  /** Stop answering this room from a home room; answers the session that did, or null. */
  async unshare(roomId: string): Promise<string | null> {
    const sessionId = this.shared.get(roomId) ?? null;
    if (sessionId === null) return null;
    this.shared.delete(roomId);
    this.changed();
    await this.persist();
    return sessionId;
  }

  /** Take the session out of whatever room it attends, and its shares; answers that room, or null. */
  async unplace(sessionId: string): Promise<string | null> {
    const roomId = this.rooms.get(sessionId) ?? null;
    if (roomId === null) return null;
    this.drop(sessionId);
    this.changed();
    await this.persist();
    return roomId;
  }

  /** The room is no longer this connection's; answers the session that attended it, or null. */
  async roomLost(roomId: string): Promise<string | null> {
    const sharer = this.shared.get(roomId);
    if (sharer !== undefined) {
      this.shared.delete(roomId);
      this.changed();
      await this.persist();
      return sharer;
    }
    const sessionId = this.placedIn(roomId);
    if (sessionId === null) return null;
    this.drop(sessionId);
    this.changed();
    await this.persist();
    return sessionId;
  }

  /** Put every placement (and share) back as `snapshot` had it: undoing a change Switch refused. */
  async restore(snapshot: PlacementMap, shares: ShareMap = this.sharesSnapshot()): Promise<void> {
    this.rooms.clear();
    for (const [sessionId, roomId] of Object.entries(snapshot)) this.rooms.set(sessionId, roomId);
    this.shared.clear();
    for (const [roomId, sessionId] of Object.entries(shares))
      if (this.rooms.has(sessionId)) this.shared.set(roomId, sessionId);
    this.changed();
    await this.persist();
  }

  /** Forget the session's placement and every room it shared from there. */
  private drop(sessionId: string): void {
    this.rooms.delete(sessionId);
    for (const [roomId, holder] of [...this.shared])
      if (holder === sessionId) this.shared.delete(roomId);
  }

  private changed(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private apply(
    sessionId: string,
    roomId: string
  ): { previous: string | null; displaced: string | null } {
    const previous = this.rooms.get(sessionId) ?? null;
    const holder = this.sessionIn(roomId);
    const displaced = holder !== null && holder !== sessionId ? holder : null;
    if (displaced && this.shared.get(roomId) === displaced) this.shared.delete(roomId);
    else if (displaced) this.drop(displaced);
    // A room it shared is placed now; rooms it shared from a room it leaves go.
    this.shared.delete(roomId);
    if (previous !== null && previous !== roomId)
      for (const [shared, holder_] of [...this.shared])
        if (holder_ === sessionId) this.shared.delete(shared);
    this.rooms.set(sessionId, roomId);
    return { previous: previous === roomId ? null : previous, displaced };
  }

  /** Writes what is held now, after any write already under way, whole or not at all. */
  private persist(): Promise<void> {
    const write = async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            placements: this.snapshot(),
            ...(this.shared.size ? { shares: this.sharesSnapshot() } : {}),
          })
        );
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await replaceFile(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    };
    this.writing = this.writing.then(write, write);
    return this.writing;
  }
}
