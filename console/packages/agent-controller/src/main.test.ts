import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CONFIGURATION, EXIT_OK } from './exit-codes';
import { main } from './main';
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

  it('exits 2 when it is not enrolled', async () => {
    expect(await main(['run', '--data-dir', dir, '--shared-host-bundle', bundle])).toBe(
      EXIT_CONFIGURATION
    );
    expect(lastLine()).toMatch(/not enrolled/);
  });
});
