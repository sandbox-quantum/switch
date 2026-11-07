import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CONFIGURATION, EXIT_FAILURE, EXIT_OK } from './exit-codes';
import { main, VERSION } from './main';
import { type Assignment, type AgentAssignment } from './schemas';
import { ControllerStore } from './store';
import { RELEASE_TAG_PREFIX } from './update';

/**
 * The exit code of every command, pinned: the output may be reshaped, but a
 * script that branches on `$?` must keep seeing the same numbers.
 */

let dir: string;
let bundle: string;
let emptyPath: string;
let realPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-exit-'));
  bundle = join(dir, 'shared-host.mjs');
  writeFileSync(bundle, '');
  emptyPath = mkdtempSync(join(tmpdir(), 'controller-nopath-'));
  realPath = process.env.PATH;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.env.PATH = realPath;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyPath, { recursive: true, force: true });
});

function enrol(): void {
  const store = ControllerStore.open(join(dir, 'controller.db'));
  store.saveIdentity({
    controllerId: 'controller-1',
    server: 'https://switch.example.invalid',
    name: 'build-box',
    enrolledAt: '2026-01-01T00:00:00.000Z',
  });
  store.close();
}

function agent(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision: 3,
    desired_state: 'running',
    definition: {
      name: 'reviewer',
      provider: 'claude',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      auto_mode: false,
      directory: null,
      isolation: 'shared',
    },
    ...overrides,
  };
}

function saveAssignment(assignment: Assignment): void {
  const store = ControllerStore.open(join(dir, 'controller.db'));
  store.saveAssignment(assignment, null, '2026-01-01T00:00:00.000Z');
  store.close();
}

/** GitHub's releases listing, as `latestRelease` reads it. */
function releasesResponse(versions: string[]): Response {
  return new Response(
    JSON.stringify(
      versions.map((version) => ({
        tag_name: `${RELEASE_TAG_PREFIX}${version}`,
        draft: false,
        prerelease: false,
        assets: [
          {
            name: `switch-agent-controller-${version}.tgz`,
            browser_download_url: `https://example.invalid/${version}.tgz`,
          },
        ],
      }))
    ),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('exit codes the CLI ends with', () => {
  it('answers help with 0 and a bare invocation with 2', async () => {
    expect(await main(['help'])).toBe(EXIT_OK);
    expect(await main(['--help'])).toBe(EXIT_OK);
    expect(await main(['-h'])).toBe(EXIT_OK);
    expect(await main([])).toBe(EXIT_CONFIGURATION);
    expect(await main(['--version'])).toBe(EXIT_OK);
    expect(await main(['--protocol'])).toBe(EXIT_OK);
    expect(await main(['launch'])).toBe(EXIT_CONFIGURATION);
  });

  it('answers arguments it cannot run with with 2', async () => {
    expect(await main(['enroll', '--server', 'https://switch.example.invalid'])).toBe(
      EXIT_CONFIGURATION
    );
    expect(await main(['enroll', '--code', 'swce_test'])).toBe(EXIT_CONFIGURATION);
    expect(await main(['set-info', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(await main(['precheck', '--out', join(dir, 'seed.json')])).toBe(EXIT_CONFIGURATION);
    expect(await main(['status', '--no-such-flag', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(await main(['doctor', '--no-such-flag', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
  });

  it('answers status with 1 when the machine is not enrolled, 0 once it is', async () => {
    expect(await main(['status', '--data-dir', dir])).toBe(EXIT_FAILURE);
    enrol();
    expect(await main(['status', '--data-dir', dir])).toBe(EXIT_OK);
    saveAssignment({ revision: 7, agents: [agent()] });
    expect(await main(['status', '--data-dir', dir])).toBe(EXIT_OK);
  });

  it('answers doctor with 1 when a check fails', async () => {
    process.env.PATH = emptyPath;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => releasesResponse([]))
    );
    expect(await main(['doctor', '--data-dir', dir, '--shared-host-bundle', bundle])).toBe(
      EXIT_FAILURE
    );
  });

  it('answers update with 1 when nothing is published, 0 when this is the newest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => releasesResponse([]))
    );
    expect(await main(['update', '--data-dir', dir])).toBe(EXIT_FAILURE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => releasesResponse([VERSION]))
    );
    expect(await main(['update', '--data-dir', dir])).toBe(EXIT_OK);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => releasesResponse(['99.0.0']))
    );
    expect(await main(['update', '--check', '--data-dir', dir])).toBe(EXIT_OK);
  });

  it('answers install-service with 2 when the machine is not enrolled', async () => {
    expect(await main(['install-service', '--data-dir', dir])).toBe(EXIT_CONFIGURATION);
    expect(await main(['install-service', '--data-dir', dir, '--user', 'me'])).toBe(
      EXIT_CONFIGURATION
    );
    expect(await main(['uninstall-service', '--data-dir', dir, '--user', 'me'])).toBe(
      EXIT_CONFIGURATION
    );
  });

  it.skipIf(process.platform === 'win32')(
    'answers uninstall-service with 0 when no service was installed',
    async () => {
      expect(await main(['uninstall-service', '--data-dir', dir])).toBe(EXIT_OK);
    }
  );
});
