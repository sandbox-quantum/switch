import { execFile, type ExecFileOptions } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

/** Bound when called, so a test that mocks `node:child_process` without it can still import this. */
function execute(file: string, args: string[], options: ExecFileOptions = {}) {
  return promisify(execFile)(file, args, { ...options, encoding: 'utf8' }) as Promise<{
    stdout: string;
    stderr: string;
  }>;
}

/** One process as Windows reports it. `createdAt` is epoch milliseconds. */
export type WindowsProcess = {
  pid: number;
  ppid: number;
  createdAt: number;
  commandLine: string | null;
};

const rowSchema = z.object({
  p: z.number().int(),
  pp: z.number().int(),
  c: z.string().nullable(),
  l: z.string().nullable(),
});

/**
 * How far a process's recorded start may sit from the creation time Windows
 * reports for it: Node takes its time origin a little after the process is
 * created, and a supervisor records a spawn just before.
 */
export const START_TOLERANCE_MS = 5_000;

const PROCESS_QUERY_TIMEOUT_MS = 30_000;

function powershell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * The processes Windows reports, through PowerShell's CIM cmdlets: every
 * Windows 10 and 11 has them, where `wmic` is gone from current builds and
 * `tasklist` reports neither parents nor command lines. `filter` is a WQL
 * condition; omitted, every process is listed.
 */
export async function listWindowsProcesses(filter?: string): Promise<WindowsProcess[]> {
  const query = filter
    ? `Get-CimInstance Win32_Process -Filter '${filter}'`
    : 'Get-CimInstance Win32_Process';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$rows = @(${query} | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; c = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); l = $_.CommandLine } })`,
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ');
  const { stdout } = await execute(
    powershell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: PROCESS_QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  const text = stdout.trim();
  if (!text) return [];
  return z
    .array(rowSchema)
    .parse(JSON.parse(text))
    .map((row) => ({
      pid: row.p,
      ppid: row.pp,
      createdAt: row.c === null ? 0 : Date.parse(row.c),
      commandLine: row.l,
    }));
}

/** One process by id, or null when none has it. */
export async function windowsProcess(pid: number): Promise<WindowsProcess | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process id ${pid}.`);
  return (await listWindowsProcesses(`ProcessId = ${pid}`))[0] ?? null;
}

/**
 * The processes descended from `root`, parents before children, `root`
 * excluded.
 *
 * Windows keeps a process's parent id after the parent exits, so an orphan
 * still names it, and it reuses ids. A process counts as a child only when it
 * was created after its parent was: `rootStartedAt` stands in for a root that
 * is gone, and when its id has since gone to a newer process, what that
 * newer process started is left alone.
 */
export function descendants(
  processes: readonly WindowsProcess[],
  root: number,
  rootStartedAt: number | null
): WindowsProcess[] {
  const byParent = new Map<number, WindowsProcess[]>();
  for (const entry of processes) {
    if (entry.pid === entry.ppid) continue;
    byParent.set(entry.ppid, [...(byParent.get(entry.ppid) ?? []), entry]);
  }
  const current = processes.find((entry) => entry.pid === root) ?? null;
  const rootStart =
    current && (rootStartedAt === null || !reused(current, rootStartedAt))
      ? current.createdAt
      : rootStartedAt;
  const successor =
    current && rootStartedAt !== null && reused(current, rootStartedAt) ? current : null;
  const found: WindowsProcess[] = [];
  const seen = new Set<number>([root]);
  const visit = (parent: number, parentStart: number | null, before: number | null) => {
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      if (parentStart !== null && child.createdAt < parentStart - START_TOLERANCE_MS) continue;
      if (before !== null && child.createdAt >= before) continue;
      seen.add(child.pid);
      found.push(child);
      visit(child.pid, child.createdAt, null);
    }
  };
  visit(root, rootStart, successor ? successor.createdAt : null);
  return found;
}

/** `entry` holds the id now, but is not the process recorded as starting at `startedAt`. */
export function reused(entry: WindowsProcess, startedAt: number): boolean {
  return Math.abs(entry.createdAt - startedAt) > START_TOLERANCE_MS;
}
