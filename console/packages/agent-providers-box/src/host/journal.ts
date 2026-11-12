import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * An error as a code for the log, never its message: a file error's message
 * names paths, and a journal's path is inside the agent's home.
 * The same rule as the controller's `errorCode`.
 */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown error';
}

/** Where a compaction writes the journal's replacement before it takes its place. */
export const compactingPath = (path: string): string => `${path}.compacting`;

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** A single host owns each journal. Never publish an entry before append resolves. */
export class Journal<T> {
  private tail: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private constructor(
    private readonly path: string,
    readonly records: T[]
  ) {}

  static async load<T>(path: string, parse: (input: unknown) => T): Promise<Journal<T>> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // A compaction cut off before its rename leaves its replacement behind,
    // unused: the journal itself is still whole, so the copy only goes.
    await rm(compactingPath(path), { force: true });
    const file = await open(path, 'a', 0o600);
    await file.sync();
    await file.close();
    await syncDirectory(path);
    const text = await readFile(path, 'utf8');
    if (text && !text.endsWith('\n'))
      throw new Error('Journal has an incomplete write; explicit recovery is required.');
    return new Journal(
      path,
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => parse(JSON.parse(line)))
    );
  }

  append(value: T): Promise<void> {
    return this.appendAll([value]);
  }

  /** Appends several entries with one write and one flush to disk. */
  appendAll(values: T[]): Promise<void> {
    const copies = structuredClone(values);
    const pending = this.tail.then(async () => {
      if (this.poisoned) throw new Error('Journal write failed; reload before continuing.');
      const file = await open(this.path, 'a', 0o600);
      try {
        await file.writeFile(copies.map((copy) => `${JSON.stringify(copy)}\n`).join(''));
        await file.sync();
        this.records.push(...copies);
      } catch (error) {
        this.poisoned = true;
        throw error;
      } finally {
        await file.close();
      }
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  /**
   * Replaces the journal with `keep(records)`, the records it still needs, so
   * what it has finished with (a held message's text once delivered or let
   * go) leaves the disk. Queued behind any append, and crash-safe: the
   * replacement is written to a file of its own, created 0600, synced, then
   * renamed over the journal and the folder synced. Cut off at any point, the
   * journal is either the old one whole or the new one whole; a leftover
   * replacement is removed at the next load. Resolves to how many records
   * were dropped.
   */
  compact(keep: (records: readonly T[]) => T[]): Promise<number> {
    const pending = this.tail.then(async () => {
      if (this.poisoned) throw new Error('Journal write failed; reload before continuing.');
      const kept = keep(this.records).map((record) => structuredClone(record));
      const dropped = this.records.length - kept.length;
      if (dropped <= 0) return 0;
      const temporary = compactingPath(this.path);
      await rm(temporary, { force: true });
      // Exclusive and 0600 from the start: nothing can open it wider in between.
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(kept.map((record) => `${JSON.stringify(record)}\n`).join(''));
        await file.sync();
      } catch (error) {
        await file.close();
        await rm(temporary, { force: true });
        throw error;
      }
      await file.close();
      try {
        await rename(temporary, this.path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      // Renamed: from here the file is the compacted one, whatever happens next.
      this.records.splice(0, this.records.length, ...kept);
      try {
        await syncDirectory(this.path);
      } catch (error) {
        // The rename may not survive a power cut; the next append's write and
        // sync, or the next load, decide. Either file is a whole journal.
        console.warn(
          `A journal was compacted but its folder could not be synced (${errorCode(error)}).`
        );
      }
      return dropped;
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
}
