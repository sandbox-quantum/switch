import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Switch Console's server page asks for Docker every few seconds while it is
 * down, so a log line per failed check would fill the log file with the same
 * sentence for as long as the page stays open.
 */

type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;
const execFile = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('@main/lib/logger', () => ({ log: { info, warn: vi.fn(), error: vi.fn() } }));

const { detectDocker } = await import('./docker');

function daemon(state: 'down' | 'up'): void {
  execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, done: Callback) => {
    if (state === 'down')
      done(new Error('Cannot connect to the Docker daemon. Is the docker daemon running?'));
    else done(null, { stdout: '28.0.0\n', stderr: '' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectDocker', () => {
  it('logs Docker being down once, not on every check', async () => {
    daemon('down');
    for (let i = 0; i < 5; i += 1) {
      expect(await detectDocker()).toMatchObject({ available: false, reason: 'daemon-down' });
    }
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('logs it again when Docker goes down after it was up', async () => {
    daemon('up');
    expect(await detectDocker()).toEqual({ available: true, version: '28.0.0' });
    daemon('down');
    await detectDocker();
    await detectDocker();
    daemon('up');
    await detectDocker();
    daemon('down');
    await detectDocker();

    expect(info).toHaveBeenCalledTimes(2);
  });
});
