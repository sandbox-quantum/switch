import { execFile } from 'node:child_process';
import { access, constants, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getWindowsEnvValue } from '@switch-console/core/exec';
import { findExecutableOnPath } from '@main/core/utils/resolve-executable';
import { log } from '@main/lib/logger';
import { installPinnedArchive } from './download';
import { exe, type NativeLayout } from './native-paths';
import {
  currentNativePlatform,
  POSTGRES_MAJOR,
  POSTGRES_VERSION,
  postgresArchive,
} from './toolchain-pins';

const execFileAsync = promisify(execFile);

/**
 * The oldest and newest PostgreSQL majors an installed copy may be. 16 is what
 * the Docker stack runs and switch-core's migrations are tested on; older
 * majors lack syntax they use (a column list on `ON DELETE SET NULL` is 15+).
 */
export const MIN_POSTGRES_MAJOR = 16;
export const MAX_POSTGRES_MAJOR = 18;

export type PostgresBinaries = {
  /** Directory holding `initdb`, `pg_ctl` and `postgres`. */
  binDir: string;
  major: number;
  source: 'installed' | 'downloaded';
};

const REQUIRED = ['initdb', 'pg_ctl', 'postgres'] as const;
const CHOICE_FILE = 'postgres.json';

export function postgresBin(binaries: Pick<PostgresBinaries, 'binDir'>, name: string): string {
  return path.join(binaries.binDir, exe(name));
}

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

/** The major the data directory was initialised by, or null when there is no
 * cluster yet. A cluster only ever runs under the major that created it. */
export async function clusterMajor(pgdata: string): Promise<number | null> {
  try {
    const raw = (await readFile(path.join(pgdata, 'PG_VERSION'), 'utf8')).trim();
    const major = Number(raw);
    if (!Number.isInteger(major)) {
      throw new Error(`${path.join(pgdata, 'PG_VERSION')} holds "${raw}", not a major version.`);
    }
    return major;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readChoice(layout: NativeLayout): Promise<PostgresBinaries | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(layout.run, CHOICE_FILE), 'utf8')
    ) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as PostgresBinaries).binDir === 'string' &&
      typeof (parsed as PostgresBinaries).major === 'number'
    ) {
      return parsed as PostgresBinaries;
    }
    return null;
  } catch {
    return null;
  }
}

async function recordChoice(layout: NativeLayout, binaries: PostgresBinaries): Promise<void> {
  await mkdir(layout.run, { recursive: true });
  await writeFile(path.join(layout.run, CHOICE_FILE), `${JSON.stringify(binaries, null, 2)}\n`);
}

/**
 * The PostgreSQL that can run the existing cluster, found without downloading
 * anything: the one used last, an installed copy of the cluster's major, or
 * the portable build already unpacked. Null when there is no cluster, or none
 * of those is here any more.
 */
export async function findPostgresForCluster(
  layout: NativeLayout
): Promise<PostgresBinaries | null> {
  const required = await clusterMajor(layout.pgdata);
  if (required === null) return null;
  const previous = await readChoice(layout);
  if (
    previous &&
    previous.major === required &&
    (await probeBinDir(previous.binDir)) === required
  ) {
    return previous;
  }
  const installed = (await detectInstalledPostgres()).find((c) => c.major === required);
  if (installed) return installed;
  const portable = path.join(layout.toolchain, `postgres-${POSTGRES_VERSION}`, 'bin');
  if ((await probeBinDir(portable)) === required) {
    return { binDir: portable, major: required, source: 'downloaded' };
  }
  return null;
}

/**
 * Recreate the shared-library symlinks the portable build lists in
 * `pg-symlinks.json`, which npm packaging cannot carry. Paths in the list are
 * relative to the package, under `native/`, which extraction stripped.
 */
async function hydrateSymlinks(root: string): Promise<void> {
  let links: { source: string; target: string }[];
  try {
    links = JSON.parse(await readFile(path.join(root, 'pg-symlinks.json'), 'utf8')) as {
      source: string;
      target: string;
    }[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const strip = (p: string) => p.replace(/^native\//, '');
  for (const { source, target } of links) {
    const targetPath = path.join(root, strip(target));
    const relative = path.relative(path.dirname(targetPath), path.join(root, strip(source)));
    try {
      await symlink(relative, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

async function downloadPostgres(
  layout: NativeLayout,
  onMessage: (message: string) => void
): Promise<PostgresBinaries> {
  const platform = currentNativePlatform();
  const archive = platform ? postgresArchive(platform) : null;
  if (!archive) {
    throw new Error(
      `No PostgreSQL ${MIN_POSTGRES_MAJOR}–${MAX_POSTGRES_MAJOR} was found on this computer, and ` +
        `there is no portable build to download for ${process.platform}-${process.arch}. ` +
        `Install PostgreSQL ${POSTGRES_MAJOR}, then start the server again.`
    );
  }
  const root = path.join(layout.toolchain, `postgres-${POSTGRES_VERSION}`);
  const binDir = path.join(root, 'bin');
  if ((await probeBinDir(binDir)) !== POSTGRES_MAJOR) {
    onMessage(`Downloading PostgreSQL ${POSTGRES_MAJOR}…`);
    await installPinnedArchive(archive, layout.downloads, root);
    await hydrateSymlinks(root);
    const major = await probeBinDir(binDir);
    if (major !== POSTGRES_MAJOR) {
      throw new Error(
        `The downloaded PostgreSQL in ${root} does not run (it reported major ${major ?? 'none'}).`
      );
    }
  }
  return { binDir, major: POSTGRES_MAJOR, source: 'downloaded' };
}

/**
 * The PostgreSQL to run the cluster with.
 *
 * The cluster's major decides it once there is one: a data directory only runs
 * under the major that created it, so an installed copy of another major is
 * passed over, and the one used last time is preferred while it still works.
 * Without a cluster, the newest supported installed copy wins; with none
 * installed, the pinned portable build is downloaded.
 */
export async function resolvePostgres(
  layout: NativeLayout,
  onMessage: (message: string) => void
): Promise<PostgresBinaries> {
  const required = await clusterMajor(layout.pgdata);
  if (required !== null && required < MIN_POSTGRES_MAJOR) {
    throw new Error(
      `This server's database was created by PostgreSQL ${required}, and switch-core needs ` +
        `PostgreSQL ${MIN_POSTGRES_MAJOR} or newer. Reset the server to set it up again ` +
        `(this deletes its data).`
    );
  }
  const previous = await readChoice(layout);
  const supported = (major: number) => major >= MIN_POSTGRES_MAJOR && major <= MAX_POSTGRES_MAJOR;
  if (previous && supported(previous.major) && (required === null || previous.major === required)) {
    if ((await probeBinDir(previous.binDir)) === previous.major) return previous;
    log.warn('local-switch-server: the PostgreSQL used last time is gone; looking again', {
      binDir: previous.binDir,
    });
  }

  onMessage('Looking for PostgreSQL…');
  const installed = (await detectInstalledPostgres()).filter(
    (candidate) => required === null || candidate.major === required
  );
  let chosen: PostgresBinaries;
  if (installed.length > 0) {
    chosen = installed[0];
  } else if (required === null || required === POSTGRES_MAJOR) {
    chosen = await downloadPostgres(layout, onMessage);
  } else {
    throw new Error(
      `This server's database was created by PostgreSQL ${required}, which is no longer on this ` +
        `computer. Install PostgreSQL ${required} again, or reset the server (deletes its data).`
    );
  }
  log.info(
    `local-switch-server: using PostgreSQL ${chosen.major} (${chosen.source}) from ${chosen.binDir}`
  );
  await recordChoice(layout, chosen);
  return chosen;
}
