import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execProvider, findOnPath, spawnProvider, stopProvider } from './provider-process';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-process-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('on macOS and Linux', () => {
  it('finds the first executable on PATH', async () => {
    const empty = join(dir, 'empty');
    const bin = join(dir, 'bin');
    for (const [path, mode] of [
      [join(dir, 'tool'), 0o644],
      [join(dir, 'bin-tool'), 0o755],
    ] as const) {
      writeFileSync(path, '#!/bin/sh\n');
      chmodSync(path, mode);
    }
    expect(await findOnPath('tool', [empty, dir].join(delimiter))).toBeNull();
    expect(await findOnPath('bin-tool', [empty, bin, dir].join(delimiter))).toBe(
      join(dir, 'bin-tool')
    );
  });
});

/** A `.cmd` CLI like npm's shims: it runs node on a script beside it with its arguments. */
function writeCmdCli(name: string, script: string): string {
  writeFileSync(join(dir, `${name}.js`), script);
  writeFileSync(
    join(dir, `${name}.cmd`),
    `@ECHO off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
  );
  return join(dir, `${name}.cmd`);
}

describe.runIf(process.platform === 'win32')('on Windows', () => {
  it('finds a .cmd CLI by its bare name, and not npm’s extensionless shell script', async () => {
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
    writeCmdCli('tool', '');
    expect((await findOnPath('tool', dir))?.toLowerCase()).toBe(
      join(dir, 'tool.cmd').toLowerCase()
    );
  });

  it('runs a .cmd CLI with its arguments intact', async () => {
    const cli = writeCmdCli('echo-args', 'console.log(JSON.stringify(process.argv.slice(2)))');
    const args = ['plain', 'with space', 'quote"inside', '100%', 'a&b'];
    const { stdout } = await execProvider(cli, args, { timeout: 30_000 });
    expect(JSON.parse(stdout)).toEqual(args);
  }, 60_000);

  it('stops a .cmd CLI and the process it runs, not just cmd.exe', async () => {
    const cli = writeCmdCli(
      'long-running',
      'console.log(process.pid); setInterval(() => {}, 1000)'
    );
    const child = spawnProvider(cli, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    const [line] = await once(child.stdout!, 'data');
    const node = Number(String(line).trim());
    const exited = once(child, 'exit');
    stopProvider(child, 'SIGTERM');
    await exited;
    for (let waited = 0; waited < 10_000; waited += 200) {
      try {
        process.kill(node, 0);
      } catch {
        return;
      }
      await delay(200);
    }
    process.kill(node);
    throw new Error('The CLI behind cmd.exe was left running.');
  }, 60_000);
});
