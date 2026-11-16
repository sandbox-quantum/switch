import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  FILES_CHUNK_MAX,
  FILES_PAGE_MAX,
  filesPath,
  LAUNCHER_LINE_MAX,
  type ReplyCode,
} from './launcher-protocol';

/**
 * The file explorer's reader, in the launcher (the agent user, uid 2000): the
 * owner's Console reads the box's workspaces through it, and nothing else.
 *
 * Every request is untrusted. A path is relative and made of plain names; its
 * real path must stay under the one root, `/data/agents/workspaces`, so a link
 * counts only where its real target is inside; the deny list is checked on
 * every part of both the asked and the real path, at any depth. Files and
 * folders are opened without following a final link, checked to be a regular
 * file or folder, and checked again through `/proc/self/fd`, so a link swapped
 * in after the check is caught (Node has no `openat`). A folder is listed
 * through its open descriptor, so the folder listed is the one checked.
 *
 * Refusals are fixed codes. Nothing here logs a path or a name.
 */

export const WORKSPACES_ROOT = '/data/agents/workspaces';
/** The largest file `read` serves, in v1. */
export const FILE_MAX = 25 * 1024 * 1024;
/** More entries than this in one folder is answered `too_large`, never read into a reply. */
export const FOLDER_ENTRIES_MAX = 100_000;

/**
 * Never readable, at any depth: logins, keys and caches of tokens.
 */
export const DENIED_NAMES: ReadonlySet<string> = new Set([
  'credentials.json',
  '.cache',
  '.tmp',
  '.retired',
  '.ssh',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.claude',
  '.codex',
  '.aws',
  'provider-home',
  'provider-data',
  'google-credentials.json',
  'application_default_credentials.json',
  'auth.json',
  'acp_token.json',
  '.gemini',
  '.cursor',
  '.opencode',
]);
/** Never readable as a folder inside the first: `.config/gh`, `.config/gcloud`. */
export const DENIED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['.config', 'gh'],
  ['.config', 'gcloud'],
];
export const DENIED_SUFFIXES: readonly string[] = ['.switch-credential', '.switch-new'];

/** Cache folders: shown closed, and left out of a zip unless asked. */
export const CACHE_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
]);
export const CACHE_PAIRS: ReadonlyArray<readonly [string, string]> = [['.next', 'cache']];

/** Whether a name is never readable, given the folder name it sits in. */
export function deniedName(name: string, parent: string | undefined): boolean {
  if (DENIED_NAMES.has(name)) return true;
  if (DENIED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return DENIED_PAIRS.some(([first, second]) => parent === first && name === second);
}

/** Whether any part of a relative path (`a/b/c` as parts) is never readable. */
export function deniedPath(parts: readonly string[]): boolean {
  return parts.some((part, at) => deniedName(part, at > 0 ? parts[at - 1] : undefined));
}

export function cacheName(name: string, parent: string | undefined): boolean {
  if (CACHE_NAMES.has(name)) return true;
  return CACHE_PAIRS.some(([first, second]) => parent === first && name === second);
}

export type Refusal = { ok: false; code: ReplyCode };
export type Entry = {
  name: string;
  kind: 'file' | 'folder';
  size: number;
  mtime: number;
  collapsed?: true;
};
export type Listing = { entries: Entry[]; cursor?: string };

/** A file or folder checked and opened, held by its descriptor. */
export type Opened = {
  handle: FileHandle;
  /** Its real path, as the descriptor confirmed. */
  real: string;
  /** Its parts under the root (none for the root itself). */
  parts: string[];
  size: number;
  mtime: number;
};

export type FilesReaderDeps = {
  root?: string;
  /** Where the process's open descriptors are named: `/proc/self/fd`. Tests may point it elsewhere. */
  procFd?: string;
  /** The agents' data folder, where the secrets the hard-link backstop knows sit. */
  dataRoot?: string;
  /** How old the secrets' set may get before a request rebuilds it. */
  secretsRefreshMs?: number;
  now?: () => number;
};

/** The agents' data folder: the workspaces folder sits in it, beside the secrets. */
export const AGENTS_DATA_ROOT = '/data/agents';
export const SECRETS_REFRESH_MS = 60_000;
/** The most files the secrets' set takes in: a bound on the walk, never reached on a box. */
export const SECRETS_FILES_MAX = 50_000;

/**
 * A hard-link backstop: the identity (`dev:ino`) of every known
 * secret file under the agents' data folder. A hard link in a workspace to one
 * of them has a workspace path, so the path checks pass it; its identity is
 * the secret's own, so it is refused. A hard link between two workspace files
 * (pnpm's `node_modules`) is not a secret and reads as before.
 *
 * The known secrets: each agent's `credentials.json` (and its `.new`), all of
 * `secrets/`, the launcher's database, and each agent's `provider-home` and
 * `provider-data`. Walked with `lstat`, never through a link.
 */
export class SecretInodes {
  private ids: Set<string> | null = null;
  private builtAt = 0;
  private building: Promise<void> | null = null;

  constructor(
    private readonly dataRoot: string,
    private readonly refreshMs: number,
    private readonly now: () => number
  ) {}

  /** Whether `dev:ino` is a known secret's; null when the set could never be built (refuse then). */
  async has(dev: number, ino: number): Promise<boolean | null> {
    if (this.ids === null || this.now() - this.builtAt >= this.refreshMs) await this.rebuild();
    return this.ids === null ? null : this.ids.has(`${dev}:${ino}`);
  }

  private rebuild(): Promise<void> {
    this.building ??= this.collect()
      .then((ids) => {
        this.ids = ids;
        this.builtAt = this.now();
      })
      .catch(() => {
        // Kept as it was: a set built before still counts; none yet refuses every read.
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  private async collect(): Promise<Set<string>> {
    const ids = new Set<string>();
    const root = this.dataRoot;
    const add = async (path: string, whole: boolean): Promise<void> => {
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') return;
        throw error;
      }
      if (info.isFile()) {
        if (ids.size >= SECRETS_FILES_MAX) throw new Error('too many');
        ids.add(`${info.dev}:${info.ino}`);
      } else if (info.isDirectory() && whole) {
        for (const name of await readdir(path)) await add(join(path, name), true);
      }
    };
    const each = async (folder: string): Promise<string[]> => {
      try {
        return await readdir(folder);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') return [];
        throw error;
      }
    };
    for (const id of await each(join(root, 'agents'))) {
      await add(join(root, 'agents', id, 'credentials.json'), false);
      await add(join(root, 'agents', id, 'credentials.json.new'), false);
    }
    await add(join(root, 'secrets'), true);
    for (const name of ['controller.db', 'controller.db-wal', 'controller.db-shm'])
      await add(join(root, name), false);
    for (const id of await each(join(root, 'watchers'))) {
      await add(join(root, 'watchers', id, 'provider-home'), true);
      await add(join(root, 'watchers', id, 'provider-data'), true);
    }
    return ids;
  }
}

const refuse = (code: ReplyCode): Refusal => ({ ok: false, code });

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Room left on the line for one listing reply: its size in JSON stays under the line cap. */
const LISTING_BYTES_MAX = LAUNCHER_LINE_MAX - 16 * 1024;

export class FilesReader {
  readonly root: string;
  private readonly procFd: string;

  private readonly secrets: SecretInodes;

  constructor(deps: FilesReaderDeps = {}) {
    this.root = deps.root ?? WORKSPACES_ROOT;
    this.procFd = deps.procFd ?? '/proc/self/fd';
    this.secrets = new SecretInodes(
      deps.dataRoot ?? AGENTS_DATA_ROOT,
      deps.secretsRefreshMs ?? SECRETS_REFRESH_MS,
      deps.now ?? Date.now
    );
  }

  /** The real root, or null if it isn't a folder. */
  private async realRoot(): Promise<string | null> {
    try {
      const real = await realpath(this.root);
      return (await stat(real)).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }

  /** The parts of `real` under `rootReal`, or null when it isn't there. */
  private partsUnder(rootReal: string, real: string): string[] | null {
    if (real === rootReal) return [];
    if (!real.startsWith(rootReal + sep)) return null;
    return relative(rootReal, real).split(sep);
  }

  /**
   * Resolves an asked path to a real path under the root, refusing anything
   * outside it or never readable. Checks only: `openChecked` opens and checks
   * again.
   */
  async resolve(path: string): Promise<{ ok: true; real: string; rootReal: string } | Refusal> {
    if (!filesPath.safeParse(path).success) return refuse('outside_root');
    const asked = path === '' ? [] : path.split('/');
    if (deniedPath(asked)) return refuse('denied');
    const rootReal = await this.realRoot();
    if (rootReal === null) return refuse('not_found');
    let real: string;
    try {
      real = await realpath(join(rootReal, ...asked));
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ELOOP') return refuse('outside_root');
      return refuse('not_found');
    }
    const parts = this.partsUnder(rootReal, real);
    if (parts === null) return refuse('outside_root');
    if (deniedPath(parts)) return refuse('denied');
    return { ok: true, real, rootReal };
  }

  /**
   * Opens what `path` names as a `file` or a `folder`: no final link followed,
   * never blocking on a pipe, the type checked on the descriptor, and the
   * descriptor's own path checked again against the root and the deny list.
   */
  async openChecked(
    path: string,
    want: 'file' | 'folder'
  ): Promise<({ ok: true } & Opened) | Refusal> {
    const resolved = await this.resolve(path);
    if (!resolved.ok) return resolved;
    return this.openReal(resolved.real, resolved.rootReal, want);
  }

  /** `openChecked` from a real path already under the root (the zip's walk). */
  async openReal(
    real: string,
    rootReal: string,
    want: 'file' | 'folder'
  ): Promise<({ ok: true } & Opened) | Refusal> {
    const flags =
      constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (want === 'folder' ? constants.O_DIRECTORY : 0);
    let handle: FileHandle;
    try {
      handle = await open(real, flags);
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ELOOP') return refuse('outside_root'); // swapped for a link since the check
      // ENOTDIR: a file asked for as a folder; ENXIO and EOPNOTSUPP: a socket or a device.
      if (code === 'ENOTDIR' || code === 'ENXIO' || code === 'EOPNOTSUPP')
        return refuse('not_regular');
      return refuse('not_found');
    }
    try {
      const info = await handle.stat();
      const right = want === 'file' ? info.isFile() : info.isDirectory();
      if (!right) {
        await handle.close();
        return refuse('not_regular');
      }
      if (want === 'file') {
        // A hard link to a known secret: the secret's own identity (the backstop).
        const secret = await this.secrets.has(info.dev, info.ino);
        if (secret !== false) {
          await handle.close();
          return refuse(secret === null ? 'failed' : 'denied');
        }
      }
      let named: string;
      try {
        named = await readlink(join(this.procFd, String(handle.fd)));
      } catch {
        await handle.close();
        return refuse('failed'); // no /proc: never open without the check
      }
      const parts = this.partsUnder(rootReal, named);
      if (named !== real || parts === null) {
        await handle.close();
        return refuse('outside_root');
      }
      if (deniedPath(parts)) {
        await handle.close();
        return refuse('denied');
      }
      return { ok: true, handle, real, parts, size: info.size, mtime: Math.floor(info.mtimeMs) };
    } catch {
      await handle.close().catch(() => {});
      return refuse('failed');
    }
  }

  /** The folder's own path through its descriptor, so what is read is what was checked. */
  fdPath(handle: FileHandle): string {
    return join(this.procFd, String(handle.fd));
  }

  /**
   * One page of a folder: names after `cursor`, in order, up to 1,000 or what
   * fits on one line. Never-readable names, links leading out and anything
   * but files and folders are left out.
   */
  async list(path: string, cursor?: string): Promise<{ ok: true; listing: Listing } | Refusal> {
    const opened = await this.openChecked(path, 'folder');
    if (!opened.ok) return opened;
    const { handle, parts } = opened;
    try {
      const rootReal = await this.realRoot();
      if (rootReal === null) return refuse('not_found');
      const at = this.fdPath(handle);
      const names = await readdir(at);
      if (names.length > FOLDER_ENTRIES_MAX) return refuse('too_large');
      const parent = parts.length > 0 ? parts[parts.length - 1] : undefined;
      const wanted = names
        .filter((name) => !deniedName(name, parent))
        .filter((name) => cursor === undefined || name > cursor)
        .sort();
      const entries: Entry[] = [];
      let used = 64;
      let more = false;
      for (const name of wanted) {
        if (entries.length >= FILES_PAGE_MAX) {
          more = true;
          break;
        }
        const entry = await this.entry(at, name, parent, rootReal);
        if (entry === null) continue;
        const cost = JSON.stringify(entry).length + 1;
        if (used + cost > LISTING_BYTES_MAX) {
          more = true;
          break;
        }
        used += cost;
        entries.push(entry);
      }
      const last = entries.at(-1)?.name;
      return {
        ok: true,
        listing: more && last !== undefined ? { entries, cursor: last } : { entries },
      };
    } catch {
      return refuse('failed');
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** One listed entry, or null to leave it out. */
  private async entry(
    folder: string,
    name: string,
    parent: string | undefined,
    rootReal: string
  ): Promise<Entry | null> {
    const path = join(folder, name);
    let info;
    try {
      info = await lstat(path);
      if (info.isSymbolicLink()) {
        // Shown only when it leads to a file or folder inside the root, never denied.
        const target = await realpath(path);
        const parts = this.partsUnder(rootReal, target);
        if (parts === null || deniedPath(parts)) return null;
        info = await stat(target);
      }
    } catch {
      return null;
    }
    const kind = info.isFile() ? 'file' : info.isDirectory() ? 'folder' : null;
    if (kind === null) return null;
    return {
      name,
      kind,
      size: kind === 'file' ? info.size : 0,
      mtime: Math.floor(info.mtimeMs),
      ...(kind === 'folder' && cacheName(name, parent) ? { collapsed: true as const } : {}),
    };
  }

  /** Up to `length` bytes of a file from `offset`, and its whole size. */
  async read(
    path: string,
    offset: number,
    length: number
  ): Promise<{ ok: true; data: Buffer; size: number } | Refusal> {
    if (length < 1 || length > FILES_CHUNK_MAX) return refuse('too_large');
    const opened = await this.openChecked(path, 'file');
    if (!opened.ok) return opened;
    const { handle, size } = opened;
    try {
      if (size > FILE_MAX) return refuse('too_large');
      if (offset >= size) return { ok: true, data: Buffer.alloc(0), size };
      const data = Buffer.alloc(Math.min(length, size - offset));
      const { bytesRead } = await handle.read(data, 0, data.length, offset);
      return { ok: true, data: data.subarray(0, bytesRead), size };
    } catch {
      return refuse('failed');
    } finally {
      await handle.close().catch(() => {});
    }
  }
}
