import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const PLACEMENTS_FILE = 'placements.json';

const fileSchema = z.strictObject({
  placements: z.record(z.string().min(1), z.string().min(1)),
});

/** Placements as sent to Switch and written to disk: session id → room id. */
export type PlacementMap = Record<string, string>;

/**
 * Which of an agent's local sessions attends which room.
 *
 * The watcher holding the agent's connection is the authority: it routes each
 * room's messages to the session placed there, and restates the whole map to
 * Switch after every change. At most one session per room and one room per
 * session. Kept in memory and written whole to `placements.json` in the
 * watcher's root after every change, and read back only when the watcher
 * starts, so a restart routes where the last run did.
 */
export class SessionPlacements {
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly rooms: Map<string, string>
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
    try {
      saved = fileSchema.parse(JSON.parse(await readFile(path, 'utf8'))).placements;
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

  /** The session attending this room, or null. */
  sessionIn(roomId: string): string | null {
    for (const [sessionId, placed] of this.rooms) if (placed === roomId) return sessionId;
    return null;
  }

  /** The room this session attends, or null. */
  roomOf(sessionId: string): string | null {
    return this.rooms.get(sessionId) ?? null;
  }

  snapshot(): PlacementMap {
    return Object.fromEntries(this.rooms);
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
    await this.persist();
    return outcome;
  }

  /** Take the session out of whatever room it attends; answers that room, or null. */
  async unplace(sessionId: string): Promise<string | null> {
    const roomId = this.rooms.get(sessionId) ?? null;
    if (roomId === null) return null;
    this.rooms.delete(sessionId);
    await this.persist();
    return roomId;
  }

  /** The room is no longer this connection's; answers the session that attended it, or null. */
  async roomLost(roomId: string): Promise<string | null> {
    const sessionId = this.sessionIn(roomId);
    if (sessionId === null) return null;
    this.rooms.delete(sessionId);
    await this.persist();
    return sessionId;
  }

  /** Put every placement back as `snapshot` had it: undoing a change Switch refused. */
  async restore(snapshot: PlacementMap): Promise<void> {
    this.rooms.clear();
    for (const [sessionId, roomId] of Object.entries(snapshot)) this.rooms.set(sessionId, roomId);
    await this.persist();
  }

  private apply(
    sessionId: string,
    roomId: string
  ): { previous: string | null; displaced: string | null } {
    const previous = this.rooms.get(sessionId) ?? null;
    const holder = this.sessionIn(roomId);
    const displaced = holder !== null && holder !== sessionId ? holder : null;
    if (displaced) this.rooms.delete(displaced);
    this.rooms.set(sessionId, roomId);
    return { previous: previous === roomId ? null : previous, displaced };
  }

  /** Writes what is held now, after any write already under way, whole or not at all. */
  private persist(): Promise<void> {
    const write = async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ placements: this.snapshot() }));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    };
    this.writing = this.writing.then(write, write);
    return this.writing;
  }
}
