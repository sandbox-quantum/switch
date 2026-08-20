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

    await composeUp(host, () => {}, false);

    const args = streamCommand.mock.calls[0]![1];
    const progressAt = args.indexOf('--progress');

    expect(args[progressAt + 1]).toBe('plain');
    expect(progressAt).toBeGreaterThan(args.indexOf('compose'));
    expect(progressAt).toBeLessThan(args.indexOf('up'));
  });

  it('still brings the stack up detached', async () => {
    const { host, streamCommand } = hostSpy();

    await composeUp(host, () => {}, false);

    expect(streamCommand.mock.calls[0]![1]).toEqual(expect.arrayContaining(['up', '-d']));
  });

  /** The dev-only checkout build layers the build override on top of the
   * pinned compose file and asks compose to build; without `--build` an
   * already-built image is reused and the working tree's changes never land. */
  it('layers the build override and builds when running from a checkout', async () => {
    const { host, streamCommand } = hostSpy();

    await composeUp(host, () => {}, true);

    const args = streamCommand.mock.calls[0]![1];

    expect(args).toEqual(expect.arrayContaining(['-f', 'standalone-docker-compose.build.yml']));
    expect(args.indexOf('standalone-docker-compose.yml')).toBeLessThan(
      args.indexOf('standalone-docker-compose.build.yml')
    );
    expect(args).toEqual(expect.arrayContaining(['up', '-d', '--build']));
  });

  it('does not build or override on the released path', async () => {
    const { host, streamCommand } = hostSpy();

    await composeUp(host, () => {}, false);

    const args = streamCommand.mock.calls[0]![1];

    expect(args).not.toContain('standalone-docker-compose.build.yml');
    expect(args).not.toContain('--build');
  });
});
