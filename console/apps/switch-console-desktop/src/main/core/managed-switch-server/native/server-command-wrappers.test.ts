import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeLayout } from './native-paths';
import {
  OPERATOR_COMMANDS,
  removeServerCommandWrappers,
  renderPosixCommandWrapper,
  renderPosixMasterWrapper,
  renderWindowsCommandWrapper,
  renderWindowsMasterWrapper,
  writeServerCommandWrappers,
} from './server-command-wrappers';

describe('server-command-wrappers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'switch-wrappers-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('renders POSIX master wrapper containing error handling and env sourcing', () => {
    const script = renderPosixMasterWrapper();
    expect(script).toContain('#!/usr/bin/env sh');
    expect(script).toContain('switch-core.env');
    expect(script).toContain('deployed.json');
    expect(script).toContain('switch-core.json');
    expect(script).toContain('export "$key=$val"');
    expect(script).toContain('exec "$TARGET" "$@"');
  });

  it('renders POSIX individual command wrapper forwarding to master wrapper', () => {
    const script = renderPosixCommandWrapper('switch-accounts');
    expect(script).toContain('#!/usr/bin/env sh');
    expect(script).toContain('exec "$DIR/switch-server-exec" "switch-accounts" "$@"');
  });

  it('renders Windows master wrapper containing batch env parser and execution', () => {
    const script = renderWindowsMasterWrapper();
    expect(script).toContain('@echo off');
    expect(script).toContain('switch-core.env');
    expect(script).toContain('deployed.json');
    expect(script).toContain('switch-core.json');
    expect(script).toContain('"%TARGET%" %*');
  });

  it('renders Windows individual command wrapper forwarding to master wrapper', () => {
    const script = renderWindowsCommandWrapper('switch-accounts');
    expect(script).toContain('@echo off');
    expect(script).toContain('"%~dp0switch-server-exec.cmd" switch-accounts %*');
  });

  it('writes all operator command wrappers to layout.bin and cleans them up', async () => {
    const layout = nativeLayout(tempDir);

    expect(existsSync(layout.bin)).toBe(false);

    await writeServerCommandWrappers(layout);

    expect(existsSync(layout.bin)).toBe(true);
    expect(existsSync(path.join(layout.bin, 'switch-server-exec'))).toBe(true);
    expect(existsSync(path.join(layout.bin, 'switch-server-exec.cmd'))).toBe(true);

    for (const cmd of OPERATOR_COMMANDS) {
      expect(existsSync(path.join(layout.bin, cmd))).toBe(true);
      expect(existsSync(path.join(layout.bin, `${cmd}.cmd`))).toBe(true);

      const posixContent = await readFile(path.join(layout.bin, cmd), 'utf8');
      expect(posixContent).toContain(`"${cmd}"`);

      const winContent = await readFile(path.join(layout.bin, `${cmd}.cmd`), 'utf8');
      expect(winContent).toContain(`${cmd}`);
    }

    await removeServerCommandWrappers(layout);
    expect(existsSync(layout.bin)).toBe(false);
  });

  it('embeds activeVersion when provided', async () => {
    const layout = nativeLayout(tempDir);
    await writeServerCommandWrappers(layout, '0.41.1');

    const posixMaster = await readFile(path.join(layout.bin, 'switch-server-exec'), 'utf8');
    expect(posixMaster).toContain('VERSION="0.41.1"');

    const winMaster = await readFile(path.join(layout.bin, 'switch-server-exec.cmd'), 'utf8');
    expect(winMaster).toContain('set "VERSION=0.41.1"');
  });
});
