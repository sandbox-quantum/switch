import { access, constants, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@main/lib/logger';
import { bundleCopyHolding, type LocalServerBundle } from './bundle';
import { installPinnedArchive } from './download';
import {
  detectInstalledPostgres,
  MAX_POSTGRES_MAJOR,
  MIN_POSTGRES_MAJOR,
  probeBinDir,
} from './installed-postgres';
import { exe, type NativeLayout } from './native-paths';
import {
  currentNativePlatform,
  POSTGRES_MAJOR,
  POSTGRES_VERSION,
  postgresArchive,
  VC_RUNTIME_DLLS,
} from './toolchain-pins';

export type PostgresBinaries = {
  /** Directory holding `initdb`, `pg_ctl` and `postgres`. */
  binDir: string;
  major: number;
  source: 'installed' | 'bundled' | 'downloaded';
};

const CHOICE_FILE = 'postgres.json';

export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/** The VC++ runtime DLLs neither `binDir` nor System32 has, which is where
 * Windows looks for them when loading `binDir`'s binaries. */
export async function missingVcRuntimeDlls(
  binDir: string,
  systemRoot: string | undefined = process.env.SystemRoot
): Promise<string[]> {
  const searched = [binDir];
  if (systemRoot) searched.push(path.join(systemRoot, 'System32'));
  const missing: string[] = [];
  for (const dll of VC_RUNTIME_DLLS) {
    let found = false;
    for (const dir of searched) {
      try {
        await access(path.join(dir, dll), constants.F_OK);
        found = true;
        break;
      } catch {
        // Not in this folder; Windows looks in the next.
      }
    }
    if (!found) missing.push(dll);
  }
  return missing;
}

/** Throw a fix-it error when PostgreSQL in `binDir` cannot run because the
 * VC++ runtime is missing, instead of a bare "does not run". */
async function assertVcRuntime(binDir: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const missing = await missingVcRuntimeDlls(binDir);
  if (missing.length === 0) return;
  throw new Error(
    `PostgreSQL cannot start because this computer is missing the Microsoft Visual C++ ` +
      `Redistributable (${missing.join(', ')} not found). Install it from ${VC_REDIST_URL}, ` +
      `then start the server again.`
  );
}

export function postgresBin(binaries: Pick<PostgresBinaries, 'binDir'>, name: string): string {
  return path.join(binaries.binDir, exe(name));
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

/** The PostgreSQL the app ships, when it ships one that runs. */
async function bundledPostgres(bundle: LocalServerBundle | null): Promise<PostgresBinaries | null> {
  if (bundle?.postgresBinDir == null) return null;
  const major = await probeBinDir(bundle.postgresBinDir);
  if (major === null) {
    log.warn('local-switch-server: the bundled PostgreSQL does not run', {
      binDir: bundle.postgresBinDir,
    });
    return null;
  }
  return { binDir: bundle.postgresBinDir, major, source: 'bundled' };
}

/**
 * The PostgreSQL that can run the existing cluster, found without downloading
 * anything: the one used last, an installed copy of the cluster's major, or
 * the portable build already unpacked. Null when there is no cluster, or none
 * of those is here any more.
 */
export async function findPostgresForCluster(
  layout: NativeLayout,
  bundle: LocalServerBundle | null
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
  const bundled = await bundledPostgres(bundle);
  if (bundled !== null && bundled.major === required) return bundled;
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

/** Whether a portable PostgreSQL build is published for this platform. */
function portableArchiveAvailable(): boolean {
  const platform = currentNativePlatform();
  return platform !== null && postgresArchive(platform) !== null;
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
      await assertVcRuntime(binDir);
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
 * under the major that created it. The one used last time is kept while it
 * still works — an installed copy a server was created on stays its
 * PostgreSQL — except a copy from an older bundle, which gives way to this
 * build's copy of the same major: older bundles are removed once a start
 * succeeds, and a server left running from one would lose its files.
 *
 * A new cluster runs on the PostgreSQL the app ships, whatever is installed,
 * so that upgrading or removing someone's own PostgreSQL never strands the
 * server. A build that ships none (a dev build) downloads the same pinned
 * portable build instead; only where neither exists is an installed copy used.
 */
export async function resolvePostgres(
  layout: NativeLayout,
  bundle: LocalServerBundle | null,
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
  const bundled = await bundledPostgres(bundle);
  const fits = (major: number) => required === null || major === required;
  const previous = await readChoice(layout);
  const supported = (major: number) => major >= MIN_POSTGRES_MAJOR && major <= MAX_POSTGRES_MAJOR;
  if (previous && supported(previous.major) && fits(previous.major)) {
    const fromOlderBundle =
      bundled !== null &&
      bundled.major === previous.major &&
      bundled.binDir !== previous.binDir &&
      bundleCopyHolding(layout.toolchain, previous.binDir) !== null;
    if (fromOlderBundle) {
      log.info(
        `local-switch-server: moving PostgreSQL ${previous.major} from ${previous.binDir} to ` +
          `this build's copy in ${bundled.binDir}`
      );
      await recordChoice(layout, bundled);
      return bundled;
    }
    if ((await probeBinDir(previous.binDir)) === previous.major) return previous;
    log.warn('local-switch-server: the PostgreSQL used last time is gone; looking again', {
      binDir: previous.binDir,
    });
  }

  onMessage('Looking for PostgreSQL…');
  let chosen: PostgresBinaries | null = bundled !== null && fits(bundled.major) ? bundled : null;
  if (chosen === null && bundled === null && bundle?.postgresBinDir != null) {
    // The app ships PostgreSQL, but it does not run: on Windows, say what is
    // missing rather than fall back to something else in silence.
    await assertVcRuntime(bundle.postgresBinDir);
  }
  const portable = portableArchiveAvailable();
  if (chosen === null && (required === null || required === POSTGRES_MAJOR) && portable) {
    chosen = await downloadPostgres(layout, onMessage);
  }
  if (chosen === null) {
    const installed = (await detectInstalledPostgres()).filter((c) => fits(c.major));
    chosen = installed[0] ?? null;
  }
  if (chosen === null) {
    if (required === null) {
      throw new Error(
        `No PostgreSQL ${MIN_POSTGRES_MAJOR}–${MAX_POSTGRES_MAJOR} was found on this computer, and ` +
          `there is no portable build to download for ${process.platform}-${process.arch}. ` +
          `Install PostgreSQL ${POSTGRES_MAJOR}, then start the server again.`
      );
    }
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
