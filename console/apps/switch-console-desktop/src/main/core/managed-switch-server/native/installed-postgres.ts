import { execFile } from 'node:child_process';
import { access, constants, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getWindowsEnvValue } from '@switch-console/core/exec';
import { findExecutableOnPath } from '@main/core/utils/resolve-executable';
import { log } from '@main/lib/logger';
import { exe } from './native-paths';
import type { PostgresBinaries } from './postgres-binaries';

/**
 * Finding and probing a PostgreSQL server install: the ones on this computer
 * (Homebrew, Postgres.app, distribution packages, the EDB installer), and the
 * bin directory of any other copy.
 */

const execFileAsync = promisify(execFile);

/**
 * The oldest and newest PostgreSQL majors an installed copy may be. 16 is what
 * the Docker stack runs and switch-core's migrations are tested on; older
 * majors lack syntax they use (a column list on `ON DELETE SET NULL` is 15+).
 */
export const MIN_POSTGRES_MAJOR = 16;
export const MAX_POSTGRES_MAJOR = 18;

const REQUIRED = ['initdb', 'pg_ctl', 'postgres'] as const;

/** `postgres (PostgreSQL) 16.4` → 16. */
export function parsePostgresMajor(versionOutput: string): number | null {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput);
  return match ? Number(match[1]) : null;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Directories an installed PostgreSQL commonly puts its server binaries in. */
async function candidateBinDirs(env: NodeJS.ProcessEnv): Promise<string[]> {
  const dirs: string[] = [];
  const onPath = findExecutableOnPath('pg_ctl', env);
  if (onPath) dirs.push(path.dirname(onPath));
  if (process.platform === 'darwin') {
    for (let major = MAX_POSTGRES_MAJOR; major >= MIN_POSTGRES_MAJOR; major--) {
      dirs.push(
        `/opt/homebrew/opt/postgresql@${major}/bin`,
        `/usr/local/opt/postgresql@${major}/bin`
      );
    }
    dirs.push('/opt/homebrew/opt/postgresql/bin', '/usr/local/opt/postgresql/bin');
    for (const version of await subdirectories('/Applications/Postgres.app/Contents/Versions')) {
      dirs.push(path.join(version, 'bin'));
    }
  } else if (process.platform === 'linux') {
    // Debian and Ubuntu keep the server binaries off PATH, one directory per major.
    for (const version of await subdirectories('/usr/lib/postgresql')) {
      dirs.push(path.join(version, 'bin'));
    }
    for (const version of (await subdirectories('/usr')).filter((d) =>
      path.basename(d).startsWith('pgsql-')
    )) {
      dirs.push(path.join(version, 'bin'));
    }
    dirs.push('/usr/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'));
  } else if (process.platform === 'win32') {
    const programFiles = getWindowsEnvValue(env, 'ProgramFiles');
    if (programFiles) {
      for (const version of await subdirectories(path.join(programFiles, 'PostgreSQL'))) {
        dirs.push(path.join(version, 'bin'));
      }
    }
  }
  return [...new Set(dirs)];
}

/** The major version of the server in `binDir`, or null when it is not a
 * complete, runnable PostgreSQL server install. */
export async function probeBinDir(binDir: string): Promise<number | null> {
  for (const name of REQUIRED) {
    if (!(await isExecutable(path.join(binDir, exe(name))))) return null;
  }
  try {
    const { stdout } = await execFileAsync(path.join(binDir, exe('postgres')), ['--version'], {
      timeout: 15_000,
      windowsHide: true,
    });
    return parsePostgresMajor(stdout);
  } catch (error) {
    log.warn('local-switch-server: found a PostgreSQL install that does not run', {
      binDir,
      error: String(error),
    });
    return null;
  }
}

/** Installed PostgreSQL servers this machine has, newest major first. */
export async function detectInstalledPostgres(
  env: NodeJS.ProcessEnv = process.env
): Promise<PostgresBinaries[]> {
  const found: PostgresBinaries[] = [];
  for (const binDir of await candidateBinDirs(env)) {
    const major = await probeBinDir(binDir);
    if (major === null) continue;
    if (major < MIN_POSTGRES_MAJOR || major > MAX_POSTGRES_MAJOR) {
      log.info(
        `local-switch-server: skipping PostgreSQL ${major} at ${binDir} (unsupported major)`
      );
      continue;
    }
    found.push({ binDir, major, source: 'installed' });
  }
  return found.sort((a, b) => b.major - a.major);
}
