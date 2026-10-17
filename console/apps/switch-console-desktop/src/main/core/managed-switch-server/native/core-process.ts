import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log } from "@main/lib/logger";
import { waitForHealth } from "../health";
import type { NativeLayout } from "./native-paths";
import type { SwitchCoreInstall } from "./switch-core-install";

const PID_FILE = "switch-core.json";
/** The environment the running switch-core was started with, so what it is
 * doing (its telemetry gate, its version) can be read back off it. */
export const CORE_ENV_FILE = "switch-core.env";
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
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
];

export function coreProcessEnv(settings: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, PYTHONUNBUFFERED: "1", ...settings };
}

/** Render settings as `KEY=value` lines. */
export function renderEnv(settings: Record<string, string>): string {
  return [
    "# The environment Switch Console started switch-core with — do not edit.",
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the pid now belongs to another account's process.
    return false;
  }
}

export async function readCoreRecord(layout: NativeLayout): Promise<CoreProcessRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(layout.run, PID_FILE), "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as CoreProcessRecord).pid === "number" &&
      typeof (parsed as CoreProcessRecord).version === "string" &&
      typeof (parsed as CoreProcessRecord).startedAt === "string"
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
  return isAlive(record.pid) ? record : null;
}

/**
 * Start switch-core in the background, detached from Switch Console so it keeps
 * serving after the app quits, with its output appended to a log file.
 * Migrations run inside it on boot, as in the container.
 */
export async function startCore(
  layout: NativeLayout,
  install: SwitchCoreInstall,
  settings: Record<string, string>,
): Promise<CoreProcessRecord> {
  await mkdir(layout.logs, { recursive: true });
  await mkdir(layout.run, { recursive: true });
  await writeFile(path.join(layout.run, CORE_ENV_FILE), renderEnv(settings), { mode: 0o600 });
  const logFd = openSync(path.join(layout.logs, "switch-core.log"), "a", 0o600);
  try {
    const child = spawn(install.python, ["-m", "switch_core.main"], {
      cwd: install.projectDir,
      env: coreProcessEnv(settings),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        if (child.pid === undefined) reject(new Error("switch-core started without a pid."));
        else resolve(child.pid);
      });
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
    process.kill(record.pid, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (isAlive(record.pid) && Date.now() < deadline) await sleep(250);
    if (isAlive(record.pid)) {
      log.warn("local-switch-server: switch-core did not stop in time; killing it", {
        pid: record.pid,
      });
      process.kill(record.pid, "SIGKILL");
      while (isAlive(record.pid)) await sleep(250);
    }
  }
  await rm(path.join(layout.run, PID_FILE), { force: true });
}

/**
 * The line of switch-core's log that says why it stopped, for an error the UI
 * shows on one line: the last exception or error in the final stretch of the
 * log, or else its last line.
 */
export async function coreFailureLine(layout: NativeLayout): Promise<string | null> {
  // A process that has just died may still be handing its last output to the
  // file; a few short retries let a traceback land before it is read.
  let line: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(500);
    let text: string;
    try {
      text = await readFile(path.join(layout.logs, "switch-core.log"), "utf8");
    } catch {
      continue;
    }
    line = failureLine(text);
    if (line !== null && /(Error|Exception|FATAL)\b/.test(line)) return line;
  }
  return line;
}

export function failureLine(log: string): string | null {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-60);
  const reason =
    [...lines].reverse().find((line) => /(Error|Exception|FATAL)\b.*:/.test(line)) ?? lines.at(-1);
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
  signal: AbortSignal,
): Promise<boolean> {
  const exited = new AbortController();
  const watch = setInterval(() => {
    void runningCore(layout).then((record) => {
      if (record === null) exited.abort(new Error("switch-core exited"));
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
