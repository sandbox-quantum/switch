import { describe, expect, it, vi } from 'vitest';
import { composeUp } from './compose';
import type { ServerHost } from './host/types';

vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

function hostSpy() {
  const streamCommand = vi.fn<
    (bin: string, args: string[], onLog: (line: string) => void) => Promise<void>
  >(() => Promise.resolve());
  const host = {
    label: 'this computer',
    dockerBin: '/usr/local/bin/docker',
    composeProjectName: 'switch-managed',
    streamCommand,
  } as unknown as ServerHost;
  return { host, streamCommand };
}

describe('composeUp', () => {
  /**
   * `--progress` is a flag of `docker compose`, not of `up`. Passing it after
   * the subcommand makes compose exit with "unknown flag" and takes the whole
   * local-server install with it, so the position is the thing worth pinning.
   */
  it('asks for plain progress before the subcommand, where compose accepts it', async () => {
    const { host, streamCommand } = hostSpy();

    await composeUp(host, () => {});

    const args = streamCommand.mock.calls[0]![1];
    const progressAt = args.indexOf('--progress');

    expect(args[progressAt + 1]).toBe('plain');
    expect(progressAt).toBeGreaterThan(args.indexOf('compose'));
    expect(progressAt).toBeLessThan(args.indexOf('up'));
  });

  it('still brings the stack up detached', async () => {
    const { host, streamCommand } = hostSpy();

    await composeUp(host, () => {});

    expect(streamCommand.mock.calls[0]![1]).toEqual(expect.arrayContaining(['up', '-d']));
  });
});
