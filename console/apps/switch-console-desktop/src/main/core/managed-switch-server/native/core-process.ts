import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isProcessAlive } from '@switch-console/agent-providers';
import { log } from '@main/lib/logger';
import { waitForHealth } from '../health';
import type { NativeLayout } from './native-paths';
import type { SwitchCoreInstall } from './switch-core-install';

const PID_FILE = 'switch-core.json';
/** How the switch-core this Console started last exited, written as it exits. */
const EXIT_FILE = 'switch-core-exit.json';
/** The environment the running switch-core was started with, so what it is
 * doing (its telemetry gate, its version) can be read back off it. */
export const CORE_ENV_FILE = 'switch-core.env';
const STOP_GRACE_MS = 20_000;

export type CoreProcessRecord = {
  pid: number;
  version: string;
  startedAt: string;
};

/**
 * Variables passed through from Console's own environment. switch-core gets
 * its settings from the environment, so inheriting everything would let a
 * stray `DB_HOST` or `SERVER_PORT` in the user's shell reconfigure the server;
 * only what a process needs to run at all is carried over.
 */
const PASSTHROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'COMSPEC',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
];

export function coreProcessEnv(settings: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, PYTHONUNBUFFERED: '1', ...settings };
}

/** Render settings as `KEY=value` lines. */
export function renderEnv(settings: Record<string, string>): string {
  return [
    '# The environment Switch Console started switch-core with — do not edit.',
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
}

export async function readCoreRecord(layout: NativeLayout): Promise<CoreProcessRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(layout.run, PID_FILE), 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as CoreProcessRecord).pid === 'number' &&
      typeof (parsed as CoreProcessRecord).version === 'string' &&
      typeof (parsed as CoreProcessRecord).startedAt === 'string'
    ) {
      return parsed as CoreProcessRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The switch-core process this Console started, when it is still alive. A
 * record from before the machine last booted names a pid that may since have
 * been handed to an unrelated process, so it is never taken as ours.
 */
export async function runningCore(layout: NativeLayout): Promise<CoreProcessRecord | null> {
  const record = await readCoreRecord(layout);
  if (record === null) return null;
  const bootedAt = Date.now() - os.uptime() * 1000;
  if (Date.parse(record.startedAt) < bootedAt) return null;
  return isProcessAlive(record.pid, 'recorded') ? record : null;
}

/**
 * The interpreter that runs switch-core. On Windows that is the environment's
 * `pythonw.exe`, not `python.exe`: a detached console program gets a console
 * window of its own, which Node's `windowsHide` does not hide for a detached
 * child, and closing that window kills the server. `pythonw.exe` is the same
 * interpreter built as a GUI program, so it gets no console at all; its output
 * still reaches the log through the file handles it is given. The workers
 * switch-core starts itself run on `sys.executable`, so they get none either.
 */
export function coreInterpreter(
  python: string,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync
): string {
  if (platform !== 'win32') return python;
  const pythonw = path.win32.join(path.win32.dirname(python), 'pythonw.exe');
  return exists(pythonw) ? pythonw : python;
}

export type CoreExit = {
  pid: number;
  code: number | null;
  signal: string | null;
};

/**
 * Start switch-core detached from Switch Console, with its output appended to a
 * log file. Detached so that nothing but an explicit stop ends it — Console
 * stops it as it quits — and a Console that crashed leaves it running for the
 * next launch to adopt. Migrations run inside it on boot, as in the container.
 */
export async function startCore(
  layout: NativeLayout,
  install: SwitchCoreInstall,
  settings: Record<string, string>
): Promise<CoreProcessRecord> {
  await mkdir(layout.logs, { recursive: true });
  await mkdir(layout.run, { recursive: true });
  await writeFile(path.join(layout.run, CORE_ENV_FILE), renderEnv(settings), { mode: 0o600 });
  await rm(path.join(layout.run, EXIT_FILE), { force: true });
  const logFd = openSync(path.join(layout.logs, 'switch-core.log'), 'a', 0o600);
  try {
    const child = spawn(coreInterpreter(install.python), ['-m', 'switch_core.main'], {
      cwd: install.projectDir,
      env: coreProcessEnv(settings),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        if (child.pid === undefined) reject(new Error('switch-core started without a pid.'));
        else resolve(child.pid);
      });
    });
    // While this Console runs, keep how the server exited: that, not whatever
    // error its log last mentioned, is why it stopped. A core adopted from an
    // earlier Console is not our child, so its exit goes unrecorded.
    child.once('exit', (code, signal) => {
      const exit: CoreExit = { pid, code, signal };
      try {
        writeFileSync(path.join(layout.run, EXIT_FILE), `${JSON.stringify(exit)}\n`);
      } catch (error) {
        log.warn('local-switch-server: could not record how switch-core exited', {
          error: String(error),
        });
      }
    });
    child.unref();
    const record = { pid, version: install.version, startedAt: new Date().toISOString() };
    await writeFile(path.join(layout.run, PID_FILE), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    closeSync(logFd);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stop switch-core: ask, then insist after a grace period. */
export async function stopCore(layout: NativeLayout): Promise<void> {
  const record = await runningCore(layout);
  if (record !== null) {
    process.kill(record.pid, 'SIGTERM');
    const deadline = Date.now() + STOP_GRACE_MS;
    while (isProcessAlive(record.pid, 'recorded') && Date.now() < deadline) await sleep(250);
    if (isProcessAlive(record.pid, 'recorded')) {
      log.warn('local-switch-server: switch-core did not stop in time; killing it', {
        pid: record.pid,
      });
      process.kill(record.pid, 'SIGKILL');
      while (isProcessAlive(record.pid, 'recorded')) await sleep(250);
    }
  }
  await rm(path.join(layout.run, PID_FILE), { force: true });
}

/** How the switch-core this Console started last exited, when it saw it. */
export async function readCoreExit(layout: NativeLayout): Promise<CoreExit | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(layout.run, EXIT_FILE), 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as CoreExit).pid === 'number'
    ) {
      const { pid, code, signal } = parsed as CoreExit;
      return {
        pid,
        code: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** `exited with code 1`, `was ended by SIGKILL`. Windows status codes such as
 * 0xC000013A (its console was closed) read better in hex. */
export function describeExit(exit: Pick<CoreExit, 'code' | 'signal'>): string {
  if (exit.signal !== null) return `was ended by ${exit.signal}`;
  if (exit.code === null) return 'exited';
  const code =
    exit.code > 0xffff || exit.code < 0
      ? `0x${(exit.code >>> 0).toString(16).toUpperCase()}`
      : String(exit.code);
  return `exited with code ${code}`;
}

/**
 * Why switch-core stopped, for an error the UI shows on one line: how it
 * exited, when this Console saw it, then the exception it died of when its
 * log ends in one. An error further up the log is not a reason — a bridge
 * that keeps failing logs one every minute while the server runs on — and a
 * server ended by a signal or exiting cleanly died of nothing it wrote.
 */
export async function coreFailureLine(layout: NativeLayout): Promise<string | null> {
  const record = await readCoreRecord(layout);
  // A process that has just died may still be handing its last output to the
  // file, and its exit to the handler that records it; a few short retries
  // let both land before they are read.
  let exit: CoreExit | null = null;
  let line: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500);
    const recorded = await readCoreExit(layout);
    exit = recorded !== null && (record === null || recorded.pid === record.pid) ? recorded : null;
    try {
      line = failureLine(await readFile(path.join(layout.logs, 'switch-core.log'), 'utf8'));
    } catch {
      line = null;
    }
    if (exit !== null && (line !== null || exit.signal !== null || exit.code === 0)) break;
  }
  if (exit === null) return line;
  const how = describeExit(exit);
  const diedOfIt = exit.signal === null && exit.code !== 0;
  return diedOfIt && line !== null ? `${how}: ${line}` : how;
}

/** A line switch-core's logging wrote (timestamped text, or JSON), as opposed
 * to one the interpreter printed as it died. */
const LOG_RECORD = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d|\{|(DEBUG|INFO|WARNING|ERROR|CRITICAL)\b)/;

/**
 * The exception switch-core died of: the last error named in what its log
 * ends with after its last logged record — the traceback an uncaught
 * exception prints. Null when the log ends in an ordinary record, so an error
 * logged earlier, which the server ran on past, is never taken for a reason.
 */
export function failureLine(log: string): string | null {
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-60);
  let lastRecord = -1;
  lines.forEach((line, i) => {
    if (LOG_RECORD.test(line)) lastRecord = i;
  });
  const reason = lines
    .slice(lastRecord + 1)
    .reverse()
    .find((line) => /(Error|Exception|FATAL)\b.*:/.test(line));
  if (!reason) return null;
  return reason.length > 400 ? `${reason.slice(0, 399)}…` : reason;
}

/**
 * Wait for the gateway to answer, giving up as soon as switch-core exits
 * rather than at the health timeout: a crash during boot (a failed migration,
 * a port taken) is over in seconds, and three minutes of "waiting" for a
 * process that is gone tells the user nothing.
 */
export async function waitForCoreHealth(
  layout: NativeLayout,
  apiUrl: string,
  signal: AbortSignal
): Promise<boolean> {
  const exited = new AbortController();
  const watch = setInterval(() => {
    void runningCore(layout).then((record) => {
      if (record === null) exited.abort(new Error('switch-core exited'));
    });
  }, 1000);
  try {
    return await waitForHealth(apiUrl, { signal: AbortSignal.any([signal, exited.signal]) });
  } catch (error) {
    if (exited.signal.aborted && !signal.aborted) return false;
    throw error;
  } finally {
    clearInterval(watch);
  }
}
