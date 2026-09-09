import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
    const file = await open(path, 'a', 0o600);
    await file.close();
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
    const copy = structuredClone(value);
    const pending = this.tail.then(async () => {
      if (this.poisoned) throw new Error('Journal write failed; reload before continuing.');
      const file = await open(this.path, 'a', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(copy)}\n`);
        await file.sync();
        this.records.push(copy);
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
}
