import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  brokerScript,
  quoteWindowsArgument,
  runnerScript,
  runOutsideConsole,
  type BrokerSpawner,
  windowsCommandLine,
} from './windows-install-launch';

describe('quoteWindowsArgument', () => {
  it('quotes as libuv does for spawn', () => {
    expect(quoteWindowsArgument('plain')).toBe('plain');
    expect(quoteWindowsArgument('')).toBe('""');
    expect(quoteWindowsArgument('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    expect(quoteWindowsArgument('powershell -c "irm https://example.com/i.ps1 | iex"')).toBe(
      '"powershell -c \\"irm https://example.com/i.ps1 | iex\\""'
    );
    expect(quoteWindowsArgument('a\\\\"b')).toBe('"a\\\\\\\\\\"b"');
    expect(quoteWindowsArgument('ends with\\')).toBe('"ends with\\\\"');
  });

  it('joins verbatim arguments as they are', () => {
    expect(windowsCommandLine(['/d', '/s', '/c', '"a b"'], true)).toBe('/d /s /c "a b"');
    expect(windowsCommandLine(['-Command', 'a b'], false)).toBe('-Command "a b"');
  });
});

describe('the launch scripts', () => {
  it("escapes single quotes in what they embed, such as a user's folder", () => {
    const runner = runnerScript({
      executable: 'C:\\x.exe',
      commandLine: "-c 'hi'",
      cwd: "C:\\Users\\O'Brien",
      dir: "C:\\Temp\\O'Brien",
    });
    expect(runner).toContain("'-c ''hi'''");
    expect(runner).toContain("$info.WorkingDirectory = 'C:\\Users\\O''Brien'");
    const broker = brokerScript({ runnerCommandLine: "a 'b'", cwd: 'C:\\', dir: 'C:\\T' });
    expect(broker).toContain("CommandLine = 'a ''b'''");
    expect(broker).toContain('Win32_Process -MethodName Create');
  });
});

/** Stands in for the broker and the runner, writing what they would. */
function fakeSpawner(files: Record<string, string>, exitCode = 0): BrokerSpawner {
  return async (_powershell, args) => {
    const dir = path.dirname(args.at(-1)!);
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content);
    }
    return { exitCode, output: exitCode === 0 ? '' : 'Access denied' };
  };
}

const command = { executable: 'C:\\x.exe', args: ['a'], verbatim: false, cwd: 'C:\\' };

describe('runOutsideConsole', () => {
  it('returns what the command printed and its exit code, and leaves nothing behind', async () => {
    let dir = '';
    const spawner: BrokerSpawner = async (powershell, args) => {
      dir = path.dirname(args.at(-1)!);
      return fakeSpawner({ launched: '42', 'output.log': 'hello\n', 'exit-code': '3' })(
        powershell,
        args
      );
    };
    expect(await runOutsideConsole(command, { spawner })).toEqual({
      kind: 'ran',
      exitCode: 3,
      output: 'hello\n',
    });
    expect(existsSync(dir)).toBe(false);
  });

  it('says it was not launched when WMI did not start it', async () => {
    expect(await runOutsideConsole(command, { spawner: fakeSpawner({}, 2) })).toEqual({
      kind: 'not-launched',
      reason: 'Access denied',
    });
  });

  it('reports a command that could not be started', async () => {
    const spawner = fakeSpawner({
      launched: '42',
      'output.log': 'The system cannot find the file specified',
      'exit-code': 'start-failed',
    });
    expect(await runOutsideConsole(command, { spawner })).toEqual({
      kind: 'start-failed',
      message: 'The system cannot find the file specified',
    });
  });

  it('fails a run that ended without an exit code', async () => {
    const spawner = fakeSpawner({ launched: '42', 'output.log': 'partial' });
    expect(await runOutsideConsole(command, { spawner })).toEqual({
      kind: 'ran',
      exitCode: undefined,
      output: 'partial\nThe install process ended without reporting its exit code.',
    });
  });
});

describe.runIf(process.platform === 'win32')('runOutsideConsole on Windows', () => {
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

  it('runs a command with quotes through WMI and returns its output and exit code', async () => {
    const result = await runOutsideConsole({
      executable: powershell,
      args: ['-NoProfile', '-Command', 'powershell -NoProfile -c "Write-Output \'a b\'; exit 4"'],
      verbatim: false,
      cwd: process.env.USERPROFILE ?? 'C:\\',
    });
    expect(result).toMatchObject({ kind: 'ran', exitCode: 4 });
    expect(result.kind === 'ran' && result.output.trim()).toBe('a b');
  }, 60_000);

  it('follows a junction the command has just created', async () => {
    const script = [
      '$d = Join-Path $env:TEMP ("switch-junction-" + [guid]::NewGuid())',
      'New-Item -ItemType Directory (Join-Path $d "target\\bin") | Out-Null',
      'New-Item -ItemType Junction -Path (Join-Path $d "link") -Target (Join-Path $d "target") | Out-Null',
      'New-Item -ItemType Junction -Path (Join-Path $d "bin") -Target (Join-Path $d "link\\bin") | Out-Null',
      'Write-Output (Test-Path (Join-Path $d "bin"))',
      'Remove-Item -LiteralPath $d -Recurse -Force',
    ].join('; ');
    const result = await runOutsideConsole({
      executable: powershell,
      args: ['-NoProfile', '-Command', script],
      verbatim: false,
      cwd: process.env.USERPROFILE ?? 'C:\\',
    });
    expect(result).toMatchObject({ kind: 'ran', exitCode: 0 });
    expect(result.kind === 'ran' && result.output.trim()).toBe('True');
  }, 60_000);
});
