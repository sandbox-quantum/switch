import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCommandPath } from '@switch-console/core/deps/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalExecutionContext } from './local-execution-context';

// Against the real `where`, which refuses a path given as it is ("Invalid
// pattern is specified in path:pattern"): an installed CLI read as missing.
describe.runIf(process.platform === 'win32')('resolving a CLI with where.exe', () => {
  let bin: string;
  let root: string;
  beforeEach(() => {
    // The long form: `where` prints it, where TEMP may be an 8.3 short name.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'where resolution ')));
    bin = join(root, 'KRISHNA ASWANI T', 'AppData', 'Roaming', 'npm');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\n');
    writeFileSync(join(bin, 'opencode.cmd'), '@ECHO off\r\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('confirms a CLI given by its full path', async () => {
    const ctx = new LocalExecutionContext();
    const cli = join(bin, 'opencode.cmd');
    expect((await resolveCommandPath(cli, ctx))?.toLowerCase()).toBe(cli.toLowerCase());
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    expect((await resolveCommandPath(system, ctx))?.toLowerCase()).toBe(system.toLowerCase());
  });

  it('takes the .cmd, not npm’s extensionless script, for a path without an extension', async () => {
    const ctx = new LocalExecutionContext();
    expect((await resolveCommandPath(join(bin, 'opencode'), ctx))?.toLowerCase()).toBe(
      join(bin, 'opencode.cmd').toLowerCase()
    );
  });

  it('reads a CLI that is not there as missing', async () => {
    const ctx = new LocalExecutionContext();
    await expect(resolveCommandPath(join(bin, 'absent.cmd'), ctx)).resolves.toBeNull();
  });
});
