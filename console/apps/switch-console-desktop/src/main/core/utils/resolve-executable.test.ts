import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExecutableOnPath, resolveExecutable, windowsInstallPath } from './resolve-executable';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-console-resolve-exe-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeExecutable(directory: string, filename: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return filePath;
}

describe('findExecutableOnPath', () => {
  it('reads PATH case-insensitively', () => {
    const tool = makeExecutable(path.join(tempDir, 'bin'), 'sometool');

    expect(findExecutableOnPath('sometool', { Path: path.dirname(tool) })).toBe(tool);
  });

  it('returns null when PATH is unset', () => {
    expect(findExecutableOnPath('sometool', {})).toBeNull();
  });
});

describe('resolveExecutable', () => {
  it('prefers the override, then PATH, then the candidate list', () => {
    const onPath = makeExecutable(path.join(tempDir, 'bin'), 'sometool');
    const candidate = makeExecutable(path.join(tempDir, 'opt'), 'sometool');
    const override = makeExecutable(path.join(tempDir, 'override'), 'sometool');
    const env = { PATH: path.dirname(onPath) };

    expect(
      resolveExecutable('sometool', { overridePath: override, candidates: [candidate], env })
    ).toBe(override);
    expect(resolveExecutable('sometool', { candidates: [candidate], env })).toBe(onPath);
    expect(
      resolveExecutable('sometool', {
        candidates: [candidate],
        env: { PATH: path.join(tempDir, 'empty') },
      })
    ).toBe(candidate);
  });

  it('falls back to the bare name so the OS loader gets the last word', () => {
    expect(
      resolveExecutable('sometool', { candidates: [], env: { PATH: path.join(tempDir, 'empty') } })
    ).toBe('sometool');
  });
});

describe('windowsInstallPath', () => {
  it('expands a Windows install root', () => {
    expect(
      windowsInstallPath(
        { ProgramFiles: 'C:\\Program Files' },
        'ProgramFiles',
        'Docker',
        'Docker',
        'resources',
        'bin',
        'docker.exe'
      )
    ).toBe('C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe');
  });

  it('returns null when the root variable is unset', () => {
    expect(windowsInstallPath({}, 'LOCALAPPDATA', 'Programs')).toBeNull();
  });
});
