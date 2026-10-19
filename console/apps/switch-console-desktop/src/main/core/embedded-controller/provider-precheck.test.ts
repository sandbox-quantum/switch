import { describe, expect, it, vi } from 'vitest';
import { ProviderPrecheck, type ProviderPrecheckDeps } from './provider-precheck';

function precheck(overrides: Partial<ProviderPrecheckDeps> = {}) {
  let clock = 1_000_000;
  const execute = vi.fn(async () => {});
  const warn = vi.fn();
  const service = new ProviderPrecheck({
    execPath: '/app/electron',
    bundles: {
      controller: () => '/app/agent-controller.mjs',
      sharedHost: () => '/app/shared-host.mjs',
    },
    env: () => ({ PATH: '/usr/bin' }),
    seedFile: () => '/data/provider-precheck.json',
    probeDir: () => '/data/provider-precheck',
    execute,
    log: { warn },
    read: async () => null,
    now: () => clock,
    ...overrides,
  });
  return { service, execute, warn, advance: (ms: number) => (clock += ms) };
}

describe('ProviderPrecheck', () => {
  it("runs the controller's own precheck, on Electron as Node, and offers its file after", async () => {
    const { service, execute } = precheck();
    expect(service.seedFile()).toBeNull();
    service.start();
    expect(execute).toHaveBeenCalledWith(
      '/app/electron',
      [
        '/app/agent-controller.mjs',
        'precheck',
        '--out',
        '/data/provider-precheck.json',
        '--probe-dir',
        '/data/provider-precheck',
        '--shared-host-bundle',
        '/app/shared-host.mjs',
      ],
      { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', SWITCH_CONTROLLER_LOG_LEVEL: 'warn' }
    );
    expect(service.seedFile()).toBe('/data/provider-precheck.json');
  });

  it('runs once while running or fresh, and again once stale', async () => {
    const { service, execute, advance } = precheck();
    service.start();
    service.start();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    service.start();
    expect(execute).toHaveBeenCalledTimes(1);
    advance(10 * 60 * 1000);
    service.start();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('says so in the log when it fails, leaving the checks to the controller', async () => {
    const { service, warn } = precheck({
      execute: async () => {
        throw new Error('spawn failed');
      },
    });
    service.start();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('Could not check the providers ahead of the controller', {
        error: 'spawn failed',
      })
    );
  });

  it('offers what it has found so far, fresh and from this session', async () => {
    const at = (offset: number) => new Date(1_000_000 + offset).toISOString();
    const file = JSON.stringify({
      providers: [
        { status: { provider: 'claude', installed: true, auth: 'ok', checked_at: at(500) } },
        { status: { provider: 'codex', installed: true, auth: 'missing', checked_at: at(600) } },
        {
          status: {
            provider: 'cursor',
            installed: false,
            auth: 'unknown',
            checked_at: at(-60_000),
          },
        },
      ],
    });
    const { service, advance } = precheck({ read: async () => file });
    expect(await service.results()).toBeNull();
    service.start();
    expect(await service.results()).toEqual([
      { provider: 'claude', installed: true, auth: 'ok' },
      { provider: 'codex', installed: true, auth: 'missing' },
    ]);
    advance(10 * 60 * 1000 + 1_000);
    expect(await service.results()).toEqual([]);
  });
});
