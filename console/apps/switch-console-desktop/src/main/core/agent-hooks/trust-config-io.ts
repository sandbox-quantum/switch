import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The logging surface the trust writers need.
 *
 * Injected rather than imported so they can run in the sidecar bundle, which
 * must not pull in the Electron-bound main-process file logger — the same
 * reason the hook-event parser takes its logger as a parameter. The sidecar
 * writes these same files on the VM before it spawns a session there.
 */
export interface TrustLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface TrustServiceDeps {
  getSessionSettings: () => Promise<{ autoTrustWorktrees: boolean }>;
  log: TrustLogger;
}

/**
 * The path an agent CLI will recognise as its own working directory.
 *
 * Symlinks have to be resolved, not just relative segments: a process asks the
 * kernel where it is and gets the real path back, so a CLI comparing its cwd
 * against a trust entry never sees the link. Verified against Claude Code
 * 2.1.234 and codex-cli 0.146.0 — running in a symlinked directory, an entry
 * written under the link is ignored and the prompt appears, while the same
 * entry under the resolved path clears it.
 *
 * Falls back to the unresolved path only when the directory does not exist
 * yet, which is not a case a session can be launched into anyway.
 */
export async function canonicalTrustPath(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd);
  try {
    return await fs.realpath(resolved);
  } catch (error: unknown) {
    if (isNodeNotFound(error)) return resolved;
    throw error;
  }
}

export async function readLocalConfig(configPath: string): Promise<string | null> {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeNotFound(error)) return null;
    throw error;
  }
}

export async function writeLocalConfigAtomic(configPath: string, content: string): Promise<void> {
  const tmpPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, configPath);
  } catch (error: unknown) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {}
    throw error;
  }
}

export function isNodeNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serialises writes to one config file across the trust services.
 *
 * The agent CLIs' config files are shared between providers and between
 * concurrently starting sessions, and every write is read-modify-write over
 * the whole document, so two unserialised spawns lose one of the two entries.
 */
class ConfigWriteLock {
  private readonly locks = new Map<string, Promise<void>>();

  run(configPath: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(configPath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(configPath, next);
    return next;
  }
}

export const configWriteLock = new ConfigWriteLock();
