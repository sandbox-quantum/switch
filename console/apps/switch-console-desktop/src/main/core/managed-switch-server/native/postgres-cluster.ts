import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '@main/lib/logger';
import type { NativeLayout } from './native-paths';
import { type PostgresBinaries, postgresBin } from './postgres-binaries';
import { runCommand, runLeavingProcess } from './run-command';

const execFileAsync = promisify(execFile);

/** The schema owner (`DB_OWNER_USER`) and the restricted runtime role
 * (`DB_USER`) switch-core serves requests as, and its database — the same
 * names the Docker stack uses. */
export const OWNER_ROLE = 'postgres';
export const RUNTIME_ROLE = 'switch_app';
export const DATABASE = 'switch';
export const MATTERMOST_DATABASE = 'mattermost';

/** Settings file the cluster includes, rewritten on every start. */
const CONSOLE_CONF = 'switch-console.conf';

export type ClusterPasswords = { owner: string; runtime: string };

/**
 * Passwords go into SQL as string literals in single-user mode, where there is
 * no parameter binding. The generated ones are base64url, which needs no
 * escaping; anything else is refused rather than escaped by hand.
 */
function literal(password: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error('Refusing a database password with characters that would need escaping.');
  }
  return `'${password}'`;
}

function pgEnv(binaries: PostgresBinaries): NodeJS.ProcessEnv {
  // The portable build finds its own shared libraries through rpath; an
  // inherited PGDATA/PGPORT must not redirect anything.
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  for (const key of ['PGDATA', 'PGPORT', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
    delete env[key];
  }
  if (process.platform === 'win32') {
    env.PATH = `${binaries.binDir}${path.delimiter}${env.PATH ?? ''}`;
  }
  return env;
}

/**
 * Feed statements to the server in single-user mode, which needs no client
 * binary, no network and no authentication — so it works with the minimal
 * portable build, before anything listens. Single-user mode reports an SQL
 * error on its output and carries on, so the output is checked for one.
 */
async function singleUser(
  binaries: PostgresBinaries,
  pgdata: string,
  statements: string[],
  onLog: (line: string) => void
): Promise<void> {
  const errors: string[] = [];
  await runCommand(postgresBin(binaries, 'postgres'), ['--single', '-D', pgdata, OWNER_ROLE], {
    cwd: pgdata,
    env: pgEnv(binaries),
    onLine: (line) => {
      if (/\b(ERROR|FATAL|PANIC):/.test(line)) errors.push(line);
      // Never echo the statements' output into the UI log: it can repeat them.
      if (!/PASSWORD/i.test(line)) onLog(line);
    },
    timeoutMs: 120_000,
    stdin: `${statements.join('\n')}\n`,
  });
  if (errors.length > 0) {
    throw new Error(`Setting up the database failed: ${errors.join(' ').slice(0, 1000)}`);
  }
}

export async function clusterExists(layout: NativeLayout): Promise<boolean> {
  try {
    await readFile(path.join(layout.pgdata, 'PG_VERSION'), 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Create the cluster: the owner role with its password, then the runtime role
 * and the `switch` database. Built in a staging directory and moved into place
 * only once complete, so a failure halfway leaves no data directory that a
 * later start would take for a working one.
 *
 * The runtime role gets no grants here, as in the Docker stack: there are no
 * tables yet. switch-core migrates as the owner on boot and grants the runtime
 * role what it needs straight after.
 */
export async function initCluster(
  binaries: PostgresBinaries,
  layout: NativeLayout,
  passwords: ClusterPasswords,
  onLog: (line: string) => void
): Promise<void> {
  const staging = `${layout.pgdata}.init`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(layout.run, { recursive: true });
  const pwfile = path.join(layout.run, 'initdb-password');
  await writeFile(pwfile, passwords.owner, { mode: 0o600 });
  try {
    await runCommand(
      postgresBin(binaries, 'initdb'),
      [
        '-D',
        staging,
        '-U',
        OWNER_ROLE,
        '--auth=scram-sha-256',
        `--pwfile=${pwfile}`,
        '-E',
        'UTF8',
        '--locale=C',
      ],
      { cwd: layout.root, env: pgEnv(binaries), onLine: onLog, timeoutMs: 300_000 }
    );
  } finally {
    await rm(pwfile, { force: true });
  }
  await appendFile(
    path.join(staging, 'postgresql.conf'),
    `\n# Written by Switch Console: listen address and port.\ninclude_if_exists = '${CONSOLE_CONF}'\n`
  );
  await singleUser(
    binaries,
    staging,
    [
      `CREATE ROLE "${RUNTIME_ROLE}" LOGIN PASSWORD ${literal(passwords.runtime)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`,
      `CREATE DATABASE "${DATABASE}";`,
      // For the optional Mattermost, which keeps its own schema here as the
      // owner, as in the Docker stack. Harmless when Mattermost never runs.
      `CREATE DATABASE "${MATTERMOST_DATABASE}";`,
    ],
    onLog
  );
  await rename(staging, layout.pgdata);
}

/**
 * Make both roles' passwords the ones in the secrets store, the source of
 * truth — as the Docker stack re-sets the runtime role's on every start. Runs
 * with the cluster stopped.
 */
export async function syncPasswords(
  binaries: PostgresBinaries,
  layout: NativeLayout,
  passwords: ClusterPasswords,
  onLog: (line: string) => void
): Promise<void> {
  await singleUser(
    binaries,
    layout.pgdata,
    [
      `ALTER ROLE "${OWNER_ROLE}" PASSWORD ${literal(passwords.owner)};`,
      `ALTER ROLE "${RUNTIME_ROLE}" PASSWORD ${literal(passwords.runtime)};`,
    ],
    onLog
  );
}

/** Listen on loopback only, on `port`, with no Unix socket: nothing but this
 * machine's switch-core is meant to reach it, and a socket path would have to
 * fit the platform's length limit. */
export async function writeClusterConfig(layout: NativeLayout, port: number): Promise<void> {
  await writeFile(
    path.join(layout.pgdata, CONSOLE_CONF),
    [
      '# Generated by Switch Console on every start — do not edit.',
      `port = ${port}`,
      "listen_addresses = '127.0.0.1'",
      "unix_socket_directories = ''",
      '',
    ].join('\n')
  );
}

export async function clusterRunning(
  binaries: PostgresBinaries,
  layout: NativeLayout
): Promise<boolean> {
  try {
    await execFileAsync(postgresBin(binaries, 'pg_ctl'), ['status', '-D', layout.pgdata], {
      env: pgEnv(binaries),
      timeout: 30_000,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    // 3: not running. 4: no accessible data directory. Anything else is a
    // failure to find out, which must not read as "stopped".
    const code = (error as { code?: unknown }).code;
    if (code === 3 || code === 4) return false;
    throw error;
  }
}

/**
 * Start the cluster in the background. `pg_ctl` detaches the server into its
 * own session, so it outlives Switch Console like the Docker stack's
 * containers do, and returns once the server accepts connections.
 */
export async function startCluster(
  binaries: PostgresBinaries,
  layout: NativeLayout,
  onLog: (line: string) => void
): Promise<void> {
  await mkdir(layout.logs, { recursive: true });
  const logFile = path.join(layout.logs, 'postgres.log');
  const ctlLog = path.join(layout.logs, 'pg_ctl.log');
  try {
    await runLeavingProcess(
      postgresBin(binaries, 'pg_ctl'),
      ['start', '-D', layout.pgdata, '-l', logFile, '-w', '-t', '90'],
      { cwd: layout.root, env: pgEnv(binaries), logFile: ctlLog, timeoutMs: 120_000 }
    );
    onLog('PostgreSQL started');
  } catch (error) {
    const detail = (await logTail(logFile)) ?? (await logTail(ctlLog));
    log.error('local-switch-server: PostgreSQL did not start', { error: String(error), detail });
    throw new Error(
      `PostgreSQL did not start. ${detail ? `Its log ends: ${detail}` : `See ${logFile}.`}`,
      { cause: error }
    );
  }
}

export async function stopCluster(
  binaries: PostgresBinaries,
  layout: NativeLayout,
  onLog: (line: string) => void
): Promise<void> {
  if (!(await clusterRunning(binaries, layout))) return;
  await runCommand(
    postgresBin(binaries, 'pg_ctl'),
    ['stop', '-D', layout.pgdata, '-m', 'fast', '-w', '-t', '60'],
    { cwd: layout.root, env: pgEnv(binaries), onLine: onLog, timeoutMs: 90_000 }
  );
}

/**
 * Stop a cluster whose binaries are gone, by signalling the postmaster named in
 * its lock file: SIGINT is PostgreSQL's fast shutdown, as `pg_ctl -m fast`
 * sends. Windows has no such signal, so there it can only report the problem.
 */
export async function stopClusterByPid(layout: NativeLayout): Promise<void> {
  let pid: number;
  try {
    const lock = await readFile(path.join(layout.pgdata, 'postmaster.pid'), 'utf8');
    pid = Number(lock.split('\n')[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  if (process.platform === 'win32') {
    throw new Error(
      `PostgreSQL (pid ${pid}) is still running, and the binaries that could stop it are gone.`
    );
  }
  process.kill(pid, 'SIGINT');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PostgreSQL (pid ${pid}) did not stop within a minute.`);
}

async function logTail(file: string): Promise<string | null> {
  try {
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    return lines.slice(-5).join(' | ').slice(-1500) || null;
  } catch {
    return null;
  }
}
