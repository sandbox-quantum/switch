import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { LoginSourceRecord, RepairPressNote } from '@shared/core/managed-agents/repair';

// V3b (design v1.2): the two small notes Console keeps for Repair my cloud. Neither ever holds a
// login, a key or a token: only ids, provider names, the kind of source, Vertex's project and
// region, an account hash, and times. Kept under user data, in the user's own profile folder,
// written 0600 in a 0700 folder.

const sourceSchema = z.object({
  source: z.enum(['this-computer', 'typed', 'vertex-this-computer', 'vertex-key']),
  project: z.string().max(200).optional(),
  region: z.string().max(100).optional(),
  accountHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const pressSchema = z.object({
  revokedControllerId: z.string().min(1),
  revokedAt: z.string().nullable(),
  pressedAt: z.number(),
  copiedControllerId: z.string().nullable(),
});

const fileSchema = z.object({
  version: z.literal(1),
  /** By controller id, then provider. */
  sources: z.record(z.string(), z.record(z.string(), sourceSchema)),
  /** By cloud machine id: it stays the same across the controllers a repair replaces. */
  presses: z.record(z.string(), pressSchema),
});
type RepairNotesFile = z.infer<typeof fileSchema>;

const EMPTY: RepairNotesFile = { version: 1, sources: {}, presses: {} };

async function writeAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // `mkdir` sets the mode only on a folder it creates: one that already exists with looser
  // rights is brought down to 0700 too (security).
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

/** `managed-agents/repair-notes.json` under user data, read whole and written whole, one change at a time. */
export class RepairNotes {
  private tail: Promise<unknown> = Promise.resolve();

  /** `path` is resolved on first use: the user-data directory is not settled at import time. */
  constructor(private readonly path: () => string) {}

  async source(controllerId: string, provider: string): Promise<LoginSourceRecord | null> {
    await this.tail.catch(() => {});
    return (await this.read()).sources[controllerId]?.[provider] ?? null;
  }

  async sources(controllerId: string): Promise<Record<string, LoginSourceRecord>> {
    await this.tail.catch(() => {});
    return { ...((await this.read()).sources[controllerId] ?? {}) };
  }

  setSource(controllerId: string, provider: string, record: LoginSourceRecord): Promise<void> {
    return this.change((file) => {
      // Parsed on the way in, so a field the record has no place for is never written.
      file.sources[controllerId] = {
        ...(file.sources[controllerId] ?? {}),
        [provider]: sourceSchema.parse(record),
      };
    });
  }

  async press(machineId: string): Promise<RepairPressNote | null> {
    await this.tail.catch(() => {});
    return (await this.read()).presses[machineId] ?? null;
  }

  setPress(machineId: string, note: RepairPressNote): Promise<void> {
    return this.change((file) => {
      file.presses[machineId] = pressSchema.parse(note);
    });
  }

  /**
   * Records `controllerId` as the one controller this press copies to, before anything is sent.
   * True when it is now that controller; false when another one already took the press.
   */
  async claimPress(machineId: string, controllerId: string): Promise<boolean> {
    let claimed = false;
    await this.change((file) => {
      const note = file.presses[machineId];
      if (!note) return;
      if (note.copiedControllerId === null) note.copiedControllerId = controllerId;
      claimed = note.copiedControllerId === controllerId;
    });
    return claimed;
  }

  /**
   * Drops what no longer matters: presses past the window, and source records of controllers
   * the owner no longer has live, unless a live press still needs them to copy from. So a
   * removed machine's notes go the next time Console looks at the owner's machines.
   */
  prune(liveControllerIds: ReadonlySet<string>, now: number, windowMs: number): Promise<void> {
    return this.change((file) => {
      for (const [machineId, note] of Object.entries(file.presses))
        if (now - note.pressedAt > windowMs) delete file.presses[machineId];
      const needed = new Set(Object.values(file.presses).map((note) => note.revokedControllerId));
      for (const id of Object.keys(file.sources))
        if (!liveControllerIds.has(id) && !needed.has(id)) delete file.sources[id];
    });
  }

  /** Forgets a machine's notes, with the machine (`controllerIds`: every controller it had). */
  forget(machineId: string | null, controllerIds: readonly string[]): Promise<void> {
    return this.change((file) => {
      if (machineId !== null) delete file.presses[machineId];
      for (const id of controllerIds) delete file.sources[id];
    });
  }

  private change(apply: (file: RepairNotesFile) => void): Promise<void> {
    const next = this.tail
      .catch(() => {})
      .then(async () => {
        const file = await this.read();
        apply(file);
        await writeAtomic(this.path(), JSON.stringify(file));
      });
    this.tail = next;
    return next;
  }

  private async read(): Promise<RepairNotesFile> {
    let text: string;
    try {
      text = await readFile(this.path(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
      throw error;
    }
    // An unreadable note only ever costs an ask instead of a copy, never a wrong copy.
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : structuredClone(EMPTY);
    } catch {
      return structuredClone(EMPTY);
    }
  }
}
