import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Starting a Windows install command through Windows itself (WMI's
 * `Win32_Process.Create`) rather than as a child of Switch Console.
 *
 * Every process Console starts on Windows inherits a policy that refuses to
 * follow a junction created by the user: measured on a Windows 10 22H2 machine,
 * a junction made in a fresh folder reads as missing from any process Console
 * started (agents included) and works from a PowerShell window. The official
 * Codex installer selects its release with junctions it has just created, so
 * it failed from Console ("Cannot find path …\current\bin", or "The path
 * cannot be traversed because it contains an untrusted mount point") and
 * succeeded by hand. A process WMI creates is not Console's descendant, so it
 * inherits none of Console's process policies, and starts with the user's
 * own environment, as a new terminal would.
 *
 * WMI cannot hand back output, so the command runs under a small PowerShell
 * script that writes what it printed and its exit code to files in a fresh
 * temporary folder, and a second script, run as Console's child, starts that
 * one through WMI and waits for it to end.
 */

export type WindowsInstallLaunch =
  | { kind: 'ran'; exitCode: number | undefined; output: string }
  | { kind: 'start-failed'; message: string }
  | { kind: 'not-launched'; reason: string };

/** Runs the broker script and resolves with its exit code and what it printed. */
export type BrokerSpawner = (
  powershell: string,
  args: string[]
) => Promise<{ exitCode: number | null; output: string }>;

const OUTPUT_FILE = 'output.log';
const EXIT_CODE_FILE = 'exit-code';
const LAUNCHED_FILE = 'launched';
const START_FAILED = 'start-failed';

/**
 * One argument as the Microsoft C runtime parses a command line, quoted the
 * way libuv quotes it for `spawn`, so the command line built here is the one
 * Console would have run directly.
 */
export function quoteWindowsArgument(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += '\\'.repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

export function windowsCommandLine(args: string[], verbatim: boolean): string {
  return (verbatim ? args : args.map(quoteWindowsArgument)).join(' ');
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The script WMI starts: runs the command and records its output and exit code. */
export function runnerScript({
  executable,
  commandLine,
  cwd,
  dir,
}: {
  executable: string;
  commandLine: string;
  cwd: string;
  dir: string;
}): string {
  const output = psString(path.join(dir, OUTPUT_FILE));
  const exitCode = psString(path.join(dir, EXIT_CODE_FILE));
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $info = New-Object System.Diagnostics.ProcessStartInfo ${psString(executable)}, ${psString(commandLine)}`,
    '  $info.UseShellExecute = $false',
    '  $info.CreateNoWindow = $true',
    '  $info.RedirectStandardOutput = $true',
    '  $info.RedirectStandardError = $true',
    `  $info.WorkingDirectory = ${psString(cwd)}`,
    '  $process = [System.Diagnostics.Process]::Start($info)',
    '  $stdout = $process.StandardOutput.ReadToEndAsync()',
    '  $stderr = $process.StandardError.ReadToEndAsync()',
    '  $process.WaitForExit()',
    `  [IO.File]::WriteAllText(${output}, $stdout.Result + $stderr.Result)`,
    `  [IO.File]::WriteAllText(${exitCode}, [string]$process.ExitCode)`,
    '} catch {',
    `  [IO.File]::WriteAllText(${output}, $_.Exception.Message)`,
    `  [IO.File]::WriteAllText(${exitCode}, '${START_FAILED}')`,
    '}',
    '',
  ].join('\r\n');
}

/** The script Console runs: starts the runner through WMI and waits for it to end. */
export function brokerScript({
  runnerCommandLine,
  cwd,
  dir,
}: {
  runnerCommandLine: string;
  cwd: string;
  dir: string;
}): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psString(runnerCommandLine)}; CurrentDirectory = ${psString(cwd)}; ProcessStartupInformation = $startup }`,
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 2',
    '}',
    'if ($result.ReturnValue -ne 0) {',
    '  [Console]::Error.WriteLine("Win32_Process.Create returned $($result.ReturnValue)")',
    '  exit 2',
    '}',
    `[IO.File]::WriteAllText(${psString(path.join(dir, LAUNCHED_FILE))}, [string]$result.ProcessId)`,
    'Wait-Process -Id $result.ProcessId -ErrorAction SilentlyContinue',
    'exit 0',
    '',
  ].join('\r\n');
}

export function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const spawnBroker: BrokerSpawner = (powershell, args) =>
  new Promise((resolve) => {
    const child = spawn(powershell, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ exitCode: null, output: error.message }));
    child.on('close', (code) => resolve({ exitCode: code, output }));
  });

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** PowerShell 5.1 reads a script without a byte-order mark in the ANSI code page. */
const UTF8_BOM = '\ufeff';

/**
 * Runs `executable` with `args` outside Console's process tree and waits for
 * it. `not-launched` means WMI could not start it, so nothing ran and the
 * caller may run the command its usual way.
 */
export async function runOutsideConsole(
  {
    executable,
    args,
    verbatim,
    cwd,
  }: { executable: string; args: string[]; verbatim: boolean; cwd: string },
  {
    env = process.env,
    spawner = spawnBroker,
  }: { env?: NodeJS.ProcessEnv; spawner?: BrokerSpawner } = {}
): Promise<WindowsInstallLaunch> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'switch-console-install-'));
  try {
    const powershell = windowsPowerShellPath(env);
    const runnerPath = path.join(dir, 'run.ps1');
    const brokerPath = path.join(dir, 'launch.ps1');
    const fileArgs = (script: string) => [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
    ];
    await writeFile(
      runnerPath,
      UTF8_BOM +
        runnerScript({
          executable,
          commandLine: windowsCommandLine(args, verbatim),
          cwd,
          dir,
        })
    );
    await writeFile(
      brokerPath,
      UTF8_BOM +
        brokerScript({
          runnerCommandLine: windowsCommandLine([powershell, ...fileArgs(runnerPath)], false),
          cwd,
          dir,
        })
    );
    const broker = await spawner(powershell, fileArgs(brokerPath));
    if ((await readIfPresent(path.join(dir, LAUNCHED_FILE))) === null) {
      return {
        kind: 'not-launched',
        reason: broker.output.trim() || `exit code ${String(broker.exitCode)}`,
      };
    }
    const output = (await readIfPresent(path.join(dir, OUTPUT_FILE))) ?? '';
    const exitCode = (await readIfPresent(path.join(dir, EXIT_CODE_FILE)))?.trim();
    if (exitCode === START_FAILED) return { kind: 'start-failed', message: output.trim() };
    if (exitCode === undefined || !/^-?\d+$/.test(exitCode)) {
      return {
        kind: 'ran',
        exitCode: undefined,
        output: `${output}\nThe install process ended without reporting its exit code.`.trim(),
      };
    }
    return { kind: 'ran', exitCode: Number(exitCode), output };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
