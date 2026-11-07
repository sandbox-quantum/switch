import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAILURE, EXIT_OK } from './exit-codes';
import { main } from './main';
import { ControllerStore } from './store';

/**
 * `--json` is read by scripts: stdout has to carry exactly one JSON document
 * and nothing else, whatever else the command has to say.
 */

let dir: string;
let bundle: string;
let emptyPath: string;
let realPath: string | undefined;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-json-'));
  bundle = join(dir, 'shared-host.mjs');
  writeFileSync(bundle, '');
  emptyPath = mkdtempSync(join(tmpdir(), 'controller-json-path-'));
  realPath = process.env.PATH;
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
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
  store.saveAssignment(
    {
      revision: 12,
      agents: [
        {
          agent_id: 'agent-1',
          revision: 5,
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
        },
      ],
    },
    null,
    '2026-01-01T00:00:00.000Z'
  );
  store.close();
}

const stdout = () => out.join('');

describe('status --json', () => {
  it('writes one JSON document with the documented keys, and no colour', async () => {
    enrol();
    expect(await main(['status', '--json', '--data-dir', dir])).toBe(EXIT_OK);
    expect(stdout()).not.toMatch(/\u001B\[/);
    const document = JSON.parse(stdout());
    expect(document.schema).toBe('switch-agent-controller/status@1');
    expect(Object.keys(document).sort()).toEqual([
      'assignment',
      'controller',
      'credential',
      'dataDir',
      'enrolled',
      'relay',
      'revokedAt',
      'schema',
      'secretStore',
      'separateUsers',
      'version',
    ]);
    expect(document.controller).toEqual({
      id: 'controller-1',
      name: 'build-box',
      server: 'https://switch.example.invalid',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    });
    expect(document.assignment.state).toBe('saved');
    expect(Object.keys(document.assignment.agents[0]).sort()).toEqual([
      'appliedRevision',
      'desiredState',
      'detail',
      'id',
      'name',
      'process',
      'provider',
      'reason',
      'revision',
    ]);
  });

  it('still writes one document, and keeps the exit code, when nothing is enrolled', async () => {
    expect(await main(['status', '--json', '--data-dir', dir])).toBe(EXIT_FAILURE);
    const document = JSON.parse(stdout());
    expect([document.enrolled, document.controller]).toEqual([false, null]);
  });
});

describe('doctor --json', () => {
  it('writes one JSON document on stdout, with every check and its fix', async () => {
    process.env.PATH = emptyPath;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    );
    expect(
      await main(['doctor', '--json', '--data-dir', dir, '--shared-host-bundle', bundle])
    ).toBe(EXIT_FAILURE);
    expect(stdout()).not.toMatch(/\u001B\[/);
    const document = JSON.parse(stdout());
    expect(document.schema).toBe('switch-agent-controller/doctor@1');
    expect(document.ok).toBe(false);
    expect(document.checks.length).toBeGreaterThan(0);
    for (const check of document.checks) {
      expect(Object.keys(check).sort()).toEqual(['detail', 'fix', 'name', 'status']);
      if (check.status !== 'ok') expect(typeof check.fix).toBe('string');
    }
    expect(err.join('')).not.toContain('switch-agent-controller/doctor@1');
  });
});
