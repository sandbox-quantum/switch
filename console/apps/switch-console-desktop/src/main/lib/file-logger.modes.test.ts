import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const logsDir = vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'switch-console-logs-'));
});

vi.mock('electron', async () => {
  const dir = await logsDir;
  return { app: { exit: vi.fn(), getPath: vi.fn(() => dir), setAppLogsPath: vi.fn() } };
});

const logs = await logsDir;
const { flushLogWrites, getLogFilePath, initializeFileLogger, writeLogEntry } =
  await import('./file-logger');

const mode = (path: string) => statSync(path).mode & 0o777;

afterAll(() => {
  rmSync(logs, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('the application log is its owner’s alone', () => {
  it('narrows a log and its rotated copies left by an earlier build', async () => {
    initializeFileLogger();
    const path = getLogFilePath()!;
    expect(path.startsWith(logs)).toBe(true);
    for (const file of [path, `${path}.1`]) {
      writeFileSync(file, 'earlier\n');
      chmodSync(file, 0o644);
    }

    writeLogEntry({ level: 'info', input: ['started'] });
    await flushLogWrites();

    expect(mode(path)).toBe(0o600);
    expect(mode(`${path}.1`)).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('started');
  });

  it('creates a new log 0600', async () => {
    const path = getLogFilePath()!;
    rmSync(path);

    writeLogEntry({ level: 'info', input: ['again'] });
    await flushLogWrites();

    expect(mode(path)).toBe(0o600);
  });
});
