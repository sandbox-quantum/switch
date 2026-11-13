import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sharedSessionRoot } from '@switch-console/agent-providers-box';
import { z } from 'zod';
import type { Logger } from './log';
import { type DataLayout, isSafeSegment } from './paths';

/**
 * What removing an agent from this machine deletes, so nothing of it is left
 * on the box: its login copies at once, then, once its agent host is proven
 * gone, its folders and its sessions' folders (a box once
 * kept 55 removed agents' folders, because removal deleted only the relay token).
 *
 * Every path is built from an id `isSafeSegment` accepts (no separator, no
 * `..`), under the controller's own `agents/` and `watchers/` folders or the
 * shared sessions folder, and deleted without following a link: `rm` removes a
 * symbolic link itself, never what it points at, so an agent that planted a
 * link in its folder cannot get anything outside it deleted.
 */

/**
 * The login copies under an agent host's root: Claude's Vertex AI login,
 * Codex's and Antigravity's homes (`provider-home`), and OpenCode's data
 * folder (`provider-data`), with the fingerprints written beside them.
 */
const LOGIN_FOLDERS = ['provider-home', 'provider-data'];

/** A session folder's name: the SHA-256 of its session id (`sharedSessionRoot`). */
const SESSION_FOLDER = /^[0-9a-f]{64}$/;
/** More than any session's `config.json`; a bigger one is not read. */
const SESSION_CONFIG_LIMIT_BYTES = 1024 * 1024;

/** Only what says whose a session is; the rest of the file is left unread. */
const sessionOwnerSchema = z.object({
  session: z.object({ agentId: z.string().min(1) }),
  execution: z.object({ credentialsPath: z.string().min(1) }),
});

export interface AgentRemovalDeps {
  layout: DataLayout;
  /** Where the agents' session folders are; the shared host's by default (`sessionsFolder`). */
  sessionsBase?: string;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface RemovalResult {
  /** Paths deleted, relative to the controller's data folder or the sessions folder. */
  deleted: string[];
  /** Paths that could not be deleted (the error code only). */
  failed: { path: string; code: string }[];
}

/** The shared host's sessions folder: the parent of every `sharedSessionRoot`. */
function sessionsFolder(): string {
  return dirname(sharedSessionRoot('any'));
}

/**
 * True when `path` is a folder itself, not a link to one: what is deleted
 * under it is then where it says, even if something in the box replaced it.
 */
async function realFolder(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Deletes `path` without following a link, when its parent is a real folder;
 * a path already gone is nothing to do. `label` is what the log may show.
 */
async function remove(path: string, label: string, result: RemovalResult): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    result.failed.push({ path: label, code: (error as NodeJS.ErrnoException).code ?? 'unknown' });
    return;
  }
  if (!(await realFolder(dirname(path)))) {
    result.failed.push({ path: label, code: 'parent_not_a_folder' });
    return;
  }
  try {
    await rm(path, { recursive: true, force: true });
    result.deleted.push(label);
  } catch (error) {
    result.failed.push({ path: label, code: (error as NodeJS.ErrnoException).code ?? 'unknown' });
  }
}

/**
 * Deletes the agent's login copies: its relay token and any provider login in
 * `credentials.json`, and the login files under its agent host's root. Done
 * first and whatever else fails, before its agent host has stopped. Each
 * delete is tried on its own, so one failing leaves the others done.
 */
export async function deleteLoginCopies(
  deps: AgentRemovalDeps,
  agentId: string
): Promise<RemovalResult> {
  const result: RemovalResult = { deleted: [], failed: [] };
  if (!isSafeSegment(agentId)) return result;
  await remove(deps.layout.agentCredentials(agentId), `agents/${agentId}/credentials.json`, result);
  for (const folder of LOGIN_FOLDERS)
    await remove(
      join(deps.layout.watcherRoot(agentId), folder),
      `watchers/${agentId}/${folder}`,
      result
    );
  return result;
}

/**
 * The agent's session folders in the shared sessions folder: those whose
 * `config.json` names this agent and this controller's credentials file for
 * it, so a session of Switch Console's own agents, or of another controller
 * sharing the home folder, is never one of them. A folder, file or link that
 * does not fit is passed over.
 */
export async function sessionFoldersOf(deps: AgentRemovalDeps, agentId: string): Promise<string[]> {
  const base = deps.sessionsBase ?? sessionsFolder();
  const credentialsPath = deps.layout.agentCredentials(agentId);
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    if (!SESSION_FOLDER.test(name)) continue;
    const folder = join(base, name);
    try {
      if (!(await lstat(folder)).isDirectory()) continue;
      const owner = await readSessionOwner(join(folder, 'config.json'));
      if (owner?.session.agentId === agentId && owner.execution.credentialsPath === credentialsPath)
        found.push(name);
    } catch {
      // Gone meanwhile, or not readable: not this agent's to delete.
    }
  }
  return found;
}

async function readSessionOwner(path: string): Promise<z.infer<typeof sessionOwnerSchema> | null> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > SESSION_CONFIG_LIMIT_BYTES) return null;
    const parsed = sessionOwnerSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success ? parsed.data : null;
  } finally {
    await file.close();
  }
}

/**
 * Deletes everything else of an agent whose agent host is gone: its folder in
 * `agents/`, its agent host's root in `watchers/`, and its session folders.
 * The caller proves the host stopped first; the agent's workspace (its working
 * directory, which may be a folder its owner uses) is never touched.
 */
export async function deleteAgentFolders(
  deps: AgentRemovalDeps,
  agentId: string
): Promise<RemovalResult> {
  const result: RemovalResult = { deleted: [], failed: [] };
  if (!isSafeSegment(agentId)) return result;
  const base = deps.sessionsBase ?? sessionsFolder();
  // Sessions first: their configs are how they are known to be this agent's,
  // and they name the credentials path, which goes with `agents/<id>`.
  for (const name of await sessionFoldersOf(deps, agentId))
    await remove(join(base, name), `sessions/${name}`, result);
  await remove(deps.layout.agentDir(agentId), `agents/${agentId}`, result);
  await remove(deps.layout.watcherRoot(agentId), `watchers/${agentId}`, result);
  return result;
}

/**
 * Agents with a folder in `agents/` or `watchers/` that `keep` does not name:
 * removed while this controller was not running, or before removal deleted
 * their folders. Only names `isSafeSegment` accepts, and only real folders,
 * never a link.
 */
export async function leftoverAgents(
  layout: DataLayout,
  keep: ReadonlySet<string>
): Promise<string[]> {
  const found = new Set<string>();
  for (const parent of ['agents', 'watchers']) {
    let names: string[];
    try {
      names = await readdir(join(layout.root, parent));
    } catch {
      continue;
    }
    for (const name of names) {
      if (keep.has(name) || !isSafeSegment(name)) continue;
      try {
        if ((await lstat(join(layout.root, parent, name))).isDirectory()) found.add(name);
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return [...found].sort();
}

/** How long an agent must stay missing from successful assignments before its leftovers are deleted. */
export const LEFTOVER_MIN_MISSING_MS = 10 * 60 * 1000;

/**
 * Decides when leftovers may be deleted, so a wrong assignment cannot destroy
 * an agent's history: never on an assignment that lists no agent, never after
 * a failed fetch, and only for an agent missing from two successful
 * assignments in a row at least `minMissingMs` apart. A failed fetch, or an
 * agent seen again, starts its count again. Kept in memory, so a controller
 * restart starts every count again too.
 */
export class LeftoverWatch {
  private readonly missingSince = new Map<string, number>();

  constructor(private readonly minMissingMs: number = LEFTOVER_MIN_MISSING_MS) {}

  /** Fetching the assignment failed: nothing counted so far is trusted. */
  fetchFailed(): void {
    this.missingSince.clear();
  }

  /**
   * After a successful fetch of an assignment listing `assigned` agents at
   * `nowMs`: which of `candidates` (folders no assigned or known agent owns)
   * may be deleted now.
   */
  due(candidates: readonly string[], assigned: number, nowMs: number): string[] {
    if (assigned === 0) {
      this.missingSince.clear();
      return [];
    }
    const current = new Set(candidates);
    for (const agentId of [...this.missingSince.keys()])
      if (!current.has(agentId)) this.missingSince.delete(agentId);
    const due: string[] = [];
    for (const agentId of candidates) {
      const since = this.missingSince.get(agentId);
      if (since === undefined) this.missingSince.set(agentId, nowMs);
      else if (nowMs - since >= this.minMissingMs) due.push(agentId);
    }
    return due;
  }
}

/** One log line for a removal: ids and counts, and the folder names that failed, never a full path. */
export function logRemoval(
  log: AgentRemovalDeps['log'],
  agentId: string,
  step: 'login copies' | 'folders',
  result: RemovalResult
): void {
  if (result.failed.length > 0)
    log.error(`Could not delete all of a removed agent’s ${step}`, {
      agentId,
      deleted: result.deleted.length,
      failed: result.failed,
    });
  else if (result.deleted.length > 0)
    log.info(`Deleted a removed agent’s ${step}`, { agentId, deleted: result.deleted.length });
}
