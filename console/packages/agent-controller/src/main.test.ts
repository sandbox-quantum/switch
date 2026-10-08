import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CONFIGURATION, EXIT_FAILURE, EXIT_OK } from './exit-codes';
import { infoChange, main } from './main';
import { dataLayout } from './paths';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';
import { ControllerStore } from './store';

let dir: string;
let bundle: string;
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-main-'));
  bundle = join(dir, 'shared-host.mjs');
  writeFileSync(bundle, '');
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** The last line the CLI wrote to stderr: the reason a parent shows. */
function lastLine(): string {
  return stderr.join('').trimEnd().split('\n').at(-1) ?? '';
}

describe('main', () => {
  it('exits 2 for arguments it cannot run with, and says why last', async () => {
    expect(await main(['launch'])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe("switch-agent-controller: Unknown command 'launch'.");
    expect(await main(['run', '--no-such-flag'])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/^switch-agent-controller: Unknown option '--no-such-flag'/);
    expect(await main(['run', '--controller-id', 'controller-1'])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe(
      'switch-agent-controller: --controller-id and --server adopt an identity together; pass both.'
    );
    expect(await main(['enroll', '--server', 'https://switch.example.com'])).toBe(
      EXIT_CONFIGURATION
    );
    expect(await main([])).toBe(EXIT_CONFIGURATION);
    expect(await main(['--help'])).toBe(EXIT_OK);
  });

  it('enrolls with the name and description it is given', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ controller_id: 'controller-1', credential: 'swcc_test' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    const code = await main([
      'enroll',
      '--server',
      'https://switch.example.com',
      '--code',
      'swce_test',
      '--name',
      'build-box',
      '--description',
      '  The build box in the office ',
      '--data-dir',
      dir,
    ]);
    vi.unstubAllGlobals();
    expect(code).toBe(EXIT_OK);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      controller: { kind: 'daemon', name: 'build-box', description: 'The build box in the office' },
    });
  });

  it('enrolls without a description when none is given, and refuses an overlong one', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ controller_id: 'controller-1', credential: 'swcc_test' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    const base = ['enroll', '--server', 'https://switch.example.com', '--code', 'swce_test'];
    expect(await main([...base, '--description', 'x'.repeat(501), '--data-dir', dir])).toBe(
      EXIT_CONFIGURATION
    );
    expect(lastLine()).toBe(
      'switch-agent-controller: --description must be at most 500 characters.'
    );
    expect(await main([...base, '--name', 'box', '--data-dir', dir])).toBe(EXIT_OK);
    vi.unstubAllGlobals();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.controller).not.toHaveProperty('description');
  });

  it('exits 2 when the data directory belongs to another controller', async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.close();
    const code = await main([
      'run',
      '--data-dir',
      dir,
      '--controller-id',
      'controller-2',
      '--server',
      'https://switch.example.com',
      '--shared-host-bundle',
      bundle,
    ]);
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/already belongs to controller controller-1/);
  });

  it('exits 2 when the shared host bundle is missing, or the server URL is not one', async () => {
    expect(
      await main(['run', '--data-dir', dir, '--shared-host-bundle', join(dir, 'missing.mjs')])
    ).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/shared host bundle .*missing\.mjs does not exist/);
    expect(
      await main([
        'run',
        '--data-dir',
        dir,
        '--controller-id',
        'controller-1',
        '--server',
        'http://switch.example.com',
        '--shared-host-bundle',
        bundle,
      ])
    ).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/must use https/);
  });

  it("set-info changes the machine's name and description, and records the name", async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.close();
    await new FileSecretStore(dataLayout(dir).secrets).set(CONTROLLER_CREDENTIAL, 'swcc_test');
    const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        calls.push({
          method: String(init.method),
          url,
          body: init.body ? JSON.parse(String(init.body)) : null,
          auth: headers.get('Authorization'),
        });
        const body = url.endsWith('/token')
          ? {
              access_token: 'swct_test',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }
          : { id: 'controller-1', name: 'build-box', description: null, state: 'online' };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    const code = await main([
      'set-info',
      '--name',
      ' build-box ',
      '--description',
      '',
      '--data-dir',
      dir,
    ]);
    vi.unstubAllGlobals();
    expect(code).toBe(EXIT_OK);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://switch.example.com/v1/management/controllers/controller-1/token'],
      ['PATCH', 'https://switch.example.com/v1/management/controllers/controller-1'],
    ]);
    expect(calls[0]!.body).toEqual({ credential: 'swcc_test' });
    expect(calls[1]!.body).toEqual({ name: 'build-box', description: null });
    expect(calls[1]!.auth).toBe('Bearer swct_test');
    const reopened = ControllerStore.open(join(dir, 'controller.db'));
    expect(reopened.identity()?.name).toBe('build-box');
    reopened.close();
  });

  it('set-info refuses what it cannot send, before calling Switch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await main(['set-info', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe(
      'switch-agent-controller: set-info needs --name, --description, or both.'
    );
    expect(await main(['set-info', '--name', '  ', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toBe('switch-agent-controller: --name must not be blank.');
    expect(await main(['set-info', '--name', 'box', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(lastLine()).toMatch(/holds no enrolled controller/);
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('set-info exits 1 when Switch refuses the change', async () => {
    const store = ControllerStore.open(join(dir, 'controller.db'));
    store.saveIdentity({
      controllerId: 'controller-1',
      server: 'https://switch.example.com',
      name: 'box',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    store.close();
    await new FileSecretStore(dataLayout(dir).secrets).set(CONTROLLER_CREDENTIAL, 'swcc_test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/token')
          ? new Response(
              JSON.stringify({
                access_token: 'swct_test',
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              }),
              { status: 200 }
            )
          : new Response(
              JSON.stringify({
                error: { code: 'validation_error', message: 'name too long', retryable: false },
              }),
              { status: 422 }
            )
      )
    );
    expect(await main(['set-info', '--name', 'box', '--data-dir', dir])).toBe(EXIT_FAILURE);
    vi.unstubAllGlobals();
    expect(lastLine()).toBe('switch-agent-controller: validation_error: name too long');
    const reopened = ControllerStore.open(join(dir, 'controller.db'));
    expect(reopened.identity()?.name).toBe('box');
    reopened.close();
  });

  it('exits 2 when it is not enrolled', async () => {
    expect(await main(['run', '--data-dir', dir, '--shared-host-bundle', bundle])).toBe(
      EXIT_CONFIGURATION
    );
    expect(lastLine()).toMatch(/not enrolled/);
  });
});

describe('infoChange', () => {
  it('trims, clears a blank description, and keeps to the limits', () => {
    expect(infoChange({ name: ' box ' })).toEqual({ name: 'box' });
    expect(infoChange({ description: '  ' })).toEqual({ description: null });
    expect(infoChange({ name: 'x'.repeat(200), description: 'y'.repeat(500) })).toEqual({
      name: 'x'.repeat(200),
      description: 'y'.repeat(500),
    });
    expect(() => infoChange({ name: 'x'.repeat(201) })).toThrow(/at most 200/);
    expect(() => infoChange({ description: 'y'.repeat(501) })).toThrow(/at most 500/);
  });
});
