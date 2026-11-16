import { readFile } from 'node:fs/promises';
import {
  formatKnownHostsLine,
  lineMatchesHost,
  parseKnownHosts,
  type KnownHostsLine,
} from './known-hosts';

export type ConsoleKnownHostsFs = {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
};

const nodeReadFile: ConsoleKnownHostsFs['readFile'] = (path) => readFile(path, 'utf-8');

async function readIfPresent(fs: ConsoleKnownHostsFs, path: string): Promise<string> {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * The host keys the user trusted from Switch Console, kept in a known_hosts
 * file of Console's own. The user's `~/.ssh/known_hosts` is never written:
 * it is theirs, and OpenSSH keeps editing it too.
 */
export class ConsoleKnownHosts {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: () => string,
    private readonly fs: ConsoleKnownHostsFs
  ) {}

  get path(): string {
    return this.filePath();
  }

  async read(): Promise<KnownHostsLine[]> {
    const path = this.filePath();
    return parseKnownHosts(await readIfPresent(this.fs, path), path);
  }

  /**
   * Record `key` as the key for `name`, replacing whatever Console had
   * recorded for it. Writes run one at a time, so two trusts at once cannot
   * drop each other's line.
   */
  trust(name: string, key: Buffer): Promise<void> {
    const run = this.queue.then(async () => {
      const path = this.filePath();
      const kept = (await readIfPresent(this.fs, path)).split(/\r?\n/).filter((raw) => {
        if (!raw.trim()) return false;
        const [line] = parseKnownHosts(raw, path);
        return !line || line.marker !== null || !lineMatchesHost(line, name);
      });
      await this.fs.writeFile(path, [...kept, formatKnownHostsLine(name, key), ''].join('\n'));
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

export function createConsoleKnownHosts(
  filePath: () => string,
  writeFile: ConsoleKnownHostsFs['writeFile']
): ConsoleKnownHosts {
  return new ConsoleKnownHosts(filePath, { readFile: nodeReadFile, writeFile });
}
