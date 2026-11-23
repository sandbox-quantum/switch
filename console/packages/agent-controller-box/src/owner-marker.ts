import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, link, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { OWNER_MARKER_ENV } from '@switch-console/agent-providers-box';
import type { Logger } from './log';
import { readOptional } from './runtime';

/**
 * Proof that a process belongs to an agent, for stopping it.
 *
 * The controller puts a per-agent marker in the environment of each agent
 * host it starts (`environmentFor`), and everything that host starts inherits
 * it: the session hosts, the provider CLI, and what the CLI runs, including a
 * process that detaches and is reparented to pid 1, which no tree walk from
 * the host finds. Reading `/proc/<pid>/environ` then says whose a process is,
 * by a value the agent's processes were given rather than by a name, a
 * command line or a parent, any of which a process can take on.
 *
 * The marker is an HMAC of the agent id under a key kept in the controller's
 * data directory, so it is the same after the controller restarts and a host
 * started before then still proves whose it is. A process that carries no
 * marker, or one that matches no agent asked about, has no owner: it is
 * reported, never stopped. On a box where every agent runs as one user, an
 * agent's code can read another's environment and copy its marker; the
 * marker rules out guessing and stopping by name, not that.
 */

const KEY_FILE = 'owner-marker.key';
const KEY_BYTES = 32;
const DOMAIN = 'switch-owner-marker:v1:';
/** A temporary key file older than this was left by a start that was cut off. */
const LEFT_KEY_AGE_MS = 60_000;

export class OwnerMarkers implements MarkerProof {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error('The owner marker key has the wrong length.');
  }

  /** The agent's marker, as hex. Never logged. */
  markerFor(agentId: string): string {
    return createHmac('sha256', this.key)
      .update(DOMAIN + agentId)
      .digest('hex');
  }

  /**
   * The marker for one launch of an agent: a launcher holds only the
   * current one, so a copied marker stops proving anything at the agent's next
   * launch. Never logged.
   */
  markerForLaunch(agentId: string, launchId: number): string {
    return createHmac('sha256', this.key)
      .update(`${DOMAIN}${agentId}:launch:${launchId}`)
      .digest('hex');
  }

  /** What to add to the environment an agent host is started with. */
  environmentFor(agentId: string): Record<string, string> {
    return { [OWNER_MARKER_ENV]: this.markerFor(agentId) };
  }

  /** Which of `agentIds` `marker` proves, or null for none. */
  ownerOf(marker: string, agentIds: Iterable<string>): string | null {
    return this.matcher(agentIds)(marker);
  }

  /**
   * A lookup for many processes against the same agents: each agent's
   * marker is worked out once, then compared in constant time.
   */
  matcher(agentIds: Iterable<string>): (marker: string) => string | null {
    const expected = [...agentIds].map(
      (agentId) => [agentId, Buffer.from(this.markerFor(agentId), 'utf8')] as const
    );
    return (marker) => {
      const given = Buffer.from(marker, 'utf8');
      for (const [agentId, bytes] of expected)
        if (given.length === bytes.length && timingSafeEqual(given, bytes)) return agentId;
      return null;
    };
  }
}

/**
 * What proves whose a process is, from the marker in its environment: the
 * controller's `OwnerMarkers` (which holds the key), or a launcher's
 * `MarkerTable` (which holds only each agent's current marker, never the key).
 */
export interface MarkerProof {
  /** A lookup for many processes against the same agents. */
  matcher(agentIds: Iterable<string>): (marker: string) => string | null;
  /** Which of `agentIds` `marker` proves, or null for none. */
  ownerOf(marker: string, agentIds: Iterable<string>): string | null;
}

/**
 * The markers a launcher holds (on a split box, the agents container): each agent's
 * marker for its current launch, as the controller sent it, in memory only.
 * It proves processes exactly as `OwnerMarkers` does, without the key, so a
 * launcher taken over by a tool gives away nothing beyond the markers its
 * agents' processes already carry.
 */
export class MarkerTable implements MarkerProof {
  private readonly current = new Map<string, Buffer>();

  /** `agentId`'s marker for its new launch; the previous one stops proving anything. */
  set(agentId: string, marker: string): void {
    if (!/^[0-9a-f]{64}$/.test(marker)) throw new Error('An owner marker is 64 hex characters.');
    this.current.set(agentId, Buffer.from(marker, 'utf8'));
  }

  forget(agentId: string): void {
    this.current.delete(agentId);
  }

  /** The environment a host for `agentId` is started with, or none if it has no marker. */
  environmentFor(agentId: string): Record<string, string> {
    const marker = this.current.get(agentId);
    return marker ? { [OWNER_MARKER_ENV]: marker.toString('utf8') } : {};
  }

  ownerOf(marker: string, agentIds: Iterable<string>): string | null {
    return this.matcher(agentIds)(marker);
  }

  matcher(agentIds: Iterable<string>): (marker: string) => string | null {
    const expected = [...agentIds].flatMap((agentId) => {
      const bytes = this.current.get(agentId);
      return bytes ? [[agentId, bytes] as const] : [];
    });
    return (marker) => {
      const given = Buffer.from(marker, 'utf8');
      for (const [agentId, bytes] of expected)
        if (given.length === bytes.length && timingSafeEqual(given, bytes)) return agentId;
      return null;
    };
  }
}

/**
 * The controller's owner markers, from the key in `dataDir`. The key is made
 * the first time, owner-only (0600) and exclusively: written whole to a file
 * of its own, then linked into place, which fails if another got there first,
 * so two starts never end up with different keys. One found with looser
 * permissions is tightened, and said. A key file that cannot be read as one
 * is an error, not replaced: a new key would leave every running host
 * unprovable. Temporary files a start cut off left behind are removed.
 */
export async function openOwnerMarkers(
  dataDir: string,
  log?: Pick<Logger, 'warn'>
): Promise<OwnerMarkers> {
  const path = join(dataDir, KEY_FILE);
  // Only ones old enough to be a cut-off start's: a fresh one may be another
  // start's, still being written, and removing it would fail that start.
  for (const name of await readdir(dataDir).catch(() => [] as string[]))
    if (name.startsWith(`${KEY_FILE}.`)) {
      const left = join(dataDir, name);
      const made = await stat(left).catch(() => null);
      if (made && Date.now() - made.mtimeMs > LEFT_KEY_AGE_MS) await unlink(left).catch(() => {});
    }
  if ((await readOptional(path)) === null) await createKey(path);
  if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077) !== 0) {
    log?.warn('The owner marker key was readable by others; made it owner-only', {
      file: KEY_FILE,
    });
    await chmod(path, 0o600);
  }
  const hex = (await readFile(path, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new Error(`The owner marker key in ${KEY_FILE} is not 32 bytes of hex.`);
  return new OwnerMarkers(Buffer.from(hex, 'hex'));
}

async function createKey(path: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${randomBytes(KEY_BYTES).toString('hex')}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary);
  }
}

/** One process as `listProcesses` found it. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** When it started, in clock ticks since boot: with `pid`, names this process and no later one. */
  startTicks: number;
  /** The agent its marker proves, or null: then it is reported, never stopped. */
  owner: string | null;
}

/**
 * The parent and start time in a `/proc/<pid>/stat` line, or null if it is
 * not one. The command name sits in parentheses and may hold spaces or
 * parentheses itself, so the fields are read after the last `)`.
 */
export function parseStat(text: string): { ppid: number; startTicks: number } | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  // From the state (field 3): the parent is field 4, the start time field 22.
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const startTicks = Number(fields[19]);
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null;
  if (!Number.isSafeInteger(startTicks) || startTicks < 0) return null;
  return { ppid, startTicks };
}

const MARKER_PREFIX = Buffer.from(`${OWNER_MARKER_ENV}=`);

/**
 * The marker in a `/proc/<pid>/environ` block (`NAME=value` entries split by
 * NULs), or null when it has none. One set more than once with different
 * values proves nothing: which a reader takes depends on the reader.
 */
export function markerIn(environ: Buffer): string | null {
  let found: string | null = null;
  let start = 0;
  while (start < environ.length) {
    let end = environ.indexOf(0, start);
    if (end < 0) end = environ.length;
    const entry = environ.subarray(start, end);
    if (
      entry.length > MARKER_PREFIX.length &&
      entry.subarray(0, MARKER_PREFIX.length).equals(MARKER_PREFIX)
    ) {
      const value = entry.subarray(MARKER_PREFIX.length).toString('utf8');
      if (found !== null && found !== value) return null;
      found = value;
    }
    start = end + 1;
  }
  return found;
}

/** Where a `ProcReader`'s buffer starts, and what it goes back to after growing past `SHRINK_ABOVE`. */
const READER_START = 64 * 1024;
/** A buffer grown past this is shrunk back to `READER_START` at `settle()`, so one big read is not held for good. */
const SHRINK_ABOVE = 1024 * 1024;
/**
 * The most a `status`, `stat` or `environ` may hold: a larger one is not read
 * on, and proves nothing. Above `execve`'s limit for arguments and
 * environment together (about 6 MiB), so no process can start past it.
 */
export const PROC_FILE_MAX = 8 * 1024 * 1024;
const LINE_FEED = 0x0a;

/**
 * Reads `/proc` files into one buffer it keeps, doubled when a file fills it
 * (up to `PROC_FILE_MAX`), and reads `smaps` in buffer-sized chunks, adding
 * up as it goes, never as one whole-file string.
 *
 * `readFile` on a `/proc` file (whose size reads as 0) allocates fresh,
 * growing native buffers on every read. The guard reads four files a process
 * every 2 s, and glibc kept that churn: the controller sat at 276-300 MB on
 * the 27 Oct boxes against about 90 MB with one reused buffer.
 *
 * One reader per scan, never shared by two at once: what `read` returns is a
 * view into the buffer, good only until the next read.
 */
export class ProcReader {
  private buffer: Buffer;
  /** The process whose file was the largest read since the last `settle()`: for the guard's slow-tick log. */
  private biggest: { pid: number | null; bytes: number } | null = null;

  constructor(private readonly startBytes = READER_START) {
    this.buffer = Buffer.allocUnsafe(startBytes);
  }

  /**
   * The whole file, as a view into the reader's buffer, valid until the next
   * read. A file longer than `maxBytes` fails with `EFBIG` and is not read on.
   */
  async read(path: string, maxBytes = PROC_FILE_MAX): Promise<Buffer> {
    const handle = await open(path, 'r');
    try {
      let length = 0;
      for (;;) {
        if (length === this.buffer.length) {
          const bigger = Buffer.allocUnsafe(Math.min(this.buffer.length * 2, maxBytes + 1));
          this.buffer.copy(bigger, 0, 0, length);
          this.buffer = bigger;
        }
        const { bytesRead } = await handle.read(
          this.buffer,
          length,
          this.buffer.length - length,
          null
        );
        if (bytesRead === 0) {
          this.saw(path, length);
          return this.buffer.subarray(0, length);
        }
        length += bytesRead;
        if (length > maxBytes) throw tooLarge(path);
      }
    } finally {
      await handle.close();
    }
  }

  /** The whole file as text: a copy, safe to keep. Fails with `EFBIG` past `maxBytes`. */
  async text(path: string, maxBytes = PROC_FILE_MAX): Promise<string> {
    return (await this.read(path, maxBytes)).toString('utf8');
  }

  /**
   * Feeds `onLine` each line of the file, read a buffer at a time, with no
   * whole-file copy: for `smaps`, which runs to megabytes for a Node or
   * Claude process. A line longer than the buffer grows it. Past `maxBytes`
   * it stops with `EFBIG`, after the lines it has given.
   */
  async eachLine(
    path: string,
    onLine: (line: string) => void,
    maxBytes = Number.POSITIVE_INFINITY
  ): Promise<void> {
    await this.eachLineBytes(
      path,
      (line, start, end) => onLine(line.toString('latin1', start, end)),
      maxBytes
    );
  }

  /**
   * `eachLine`, without making a string of any line: `onLine` gets the
   * reader's buffer and the line's bounds in it, valid only during the call.
   * For a file read every 2 s whose lines are mostly skipped (`smaps`), a
   * string per line was most of the controller's garbage while hosts were
   * awake.
   */
  async eachLineBytes(
    path: string,
    onLine: (buffer: Buffer, start: number, end: number) => void,
    maxBytes = Number.POSITIVE_INFINITY
  ): Promise<void> {
    const handle = await open(path, 'r');
    try {
      let kept = 0; // the start of a line the last chunk cut off, moved to the front
      let total = 0;
      for (;;) {
        if (kept === this.buffer.length) {
          const bigger = Buffer.allocUnsafe(this.buffer.length * 2);
          this.buffer.copy(bigger, 0, 0, kept);
          this.buffer = bigger;
        }
        const { bytesRead } = await handle.read(this.buffer, kept, this.buffer.length - kept, null);
        total += bytesRead;
        if (total > maxBytes) {
          this.saw(path, total);
          throw tooLarge(path);
        }
        const end = kept + bytesRead;
        const buffer = this.buffer;
        let start = 0;
        for (let at = buffer.indexOf(LINE_FEED, kept); at >= 0 && at < end;) {
          onLine(buffer, start, at);
          start = at + 1;
          at = buffer.indexOf(LINE_FEED, start);
        }
        if (bytesRead === 0) {
          if (start < end) onLine(buffer, start, end);
          this.saw(path, total);
          return;
        }
        buffer.copy(buffer, 0, start, end);
        kept = end - start;
      }
    } finally {
      await handle.close();
    }
  }

  /** After a scan: a buffer that grew past 1 MiB goes back to its starting size. */
  settle(): void {
    if (this.buffer.length > SHRINK_ABOVE) this.buffer = Buffer.allocUnsafe(this.startBytes);
    this.biggest = null;
  }

  /** The pid (from `/proc/<pid>/...`) of the largest file read since the last `settle()`, or null. */
  get largestPid(): number | null {
    return this.biggest?.pid ?? null;
  }

  private saw(path: string, bytes: number): void {
    if (this.biggest && this.biggest.bytes >= bytes) return;
    const pid = /\/(\d+)\/[^/]+$/.exec(path);
    this.biggest = { pid: pid ? Number(pid[1]) : null, bytes };
  }

  /** The buffer's size now; for tests. */
  get size(): number {
    return this.buffer.length;
  }
}

function tooLarge(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${path} is larger than this reader reads`);
  error.code = 'EFBIG';
  return error;
}

/**
 * Reads one process, or null when it is gone, a thread, or its `status` or
 * `stat` cannot be read (then it is no one's, and the scan goes on). Its
 * start time is read again after its environment, so a marker read from a
 * process that ended and gave its id to another in between is not taken.
 */
async function readProcess(
  procRoot: string,
  pid: number,
  reader: ProcReader = new ProcReader(),
  onTooLarge?: ProcOptions['onTooLarge']
): Promise<{ ppid: number; startTicks: number; marker: string | null } | null> {
  const dir = join(procRoot, String(pid));
  let file: 'status' | 'stat' | 'environ' = 'status';
  try {
    const status = await reader.text(join(dir, 'status'));
    // A thread's id answers under /proc too; only a thread group's leader is a process.
    const tgid = /^Tgid:\s*(\d+)/m.exec(status);
    if (tgid && Number(tgid[1]) !== pid) return null;
    file = 'stat';
    const stat = parseStat(await reader.text(join(dir, 'stat')));
    if (!stat) return null;
    let marker: string | null = null;
    try {
      // markerIn copies the value out, so the reader's buffer may be reused after.
      marker = markerIn(await reader.read(join(dir, 'environ')));
    } catch (error) {
      // Another user's process, or a zombie's, or an environment past the
      // cap: no proof, but still a process.
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EFBIG') onTooLarge?.(pid, 'environ');
      else if (!UNREADABLE.has(code)) throw error;
    }
    file = 'stat';
    const again = parseStat(await reader.text(join(dir, 'stat')));
    if (!again || again.startTicks !== stat.startTicks) return null;
    return { ...stat, marker };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'EFBIG') onTooLarge?.(pid, file);
    if (UNREADABLE.has(code)) return null;
    throw error;
  }
}

/** Errors that mean one process cannot be read now: it ended, or it is not ours to read. */
const UNREADABLE = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EFBIG']);

export interface ProcOptions {
  /** `/proc`, or a copy of one in a test. */
  procRoot?: string;
  /** This process, never listed. */
  self?: number;
  /**
   * Told when a process's `/proc` file is past its cap: `environ`, `status`
   * or `stat` (the process then proves nothing), or `smaps` with the agent it
   * was being measured for (then it is measured from its `status`).
   */
  onTooLarge?: (
    pid: number,
    file: 'status' | 'stat' | 'environ' | 'smaps',
    agentId?: string
  ) => void;
}

/**
 * Every process under `/proc` but this one, each with the agent among
 * `agentIds` its marker proves. Orphans reparented to pid 1 are listed like
 * any other: whose a process is does not depend on its parent. Empty where
 * there is no `/proc` (macOS, Windows).
 */
export async function listProcesses(
  markers: MarkerProof,
  agentIds: Iterable<string>,
  options: ProcOptions = {},
  reader: ProcReader = new ProcReader()
): Promise<ProcessEntry[]> {
  const procRoot = options.procRoot ?? '/proc';
  const self = options.self ?? process.pid;
  const ownerOf = markers.matcher(agentIds);
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    if (pid === self) continue;
    const read = await readProcess(procRoot, pid, reader, options.onTooLarge);
    if (!read) continue;
    entries.push({
      pid,
      ppid: read.ppid,
      startTicks: read.startTicks,
      owner: read.marker === null ? null : ownerOf(read.marker),
    });
  }
  return entries.sort((a, b) => a.pid - b.pid);
}

/** `listProcesses`, narrowed to the processes proven to be `agentId`'s. */
export async function processesOf(
  markers: MarkerProof,
  agentId: string,
  options: ProcOptions = {}
): Promise<ProcessEntry[]> {
  return (await listProcesses(markers, [agentId], options)).filter(
    (entry) => entry.owner === agentId
  );
}

export type SignalResult = 'signalled' | 'gone' | 'not_proven';

/**
 * Sends `signal` to `entry`'s process only if it is still the process that
 * was listed (same start time) and still carries its owner's marker, read
 * again just before. An entry with no owner is never signalled. A process
 * that has ended, or whose id now names another, is `gone`.
 */
export async function signalProven(
  entry: ProcessEntry,
  signal: NodeJS.Signals,
  markers: MarkerProof,
  options: ProcOptions & { kill?: (pid: number, signal: NodeJS.Signals) => void } = {}
): Promise<SignalResult> {
  if (entry.owner === null) return 'not_proven';
  if (!Number.isSafeInteger(entry.pid) || entry.pid <= 1) return 'not_proven';
  const procRoot = options.procRoot ?? '/proc';
  if (entry.pid === (options.self ?? process.pid)) return 'not_proven';
  const now = await readProcess(procRoot, entry.pid);
  if (!now || now.startTicks !== entry.startTicks) return 'gone';
  if (now.marker === null || markers.ownerOf(now.marker, [entry.owner]) !== entry.owner)
    return 'not_proven';
  try {
    (options.kill ?? process.kill)(entry.pid, signal);
    return 'signalled';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    throw error;
  }
}
