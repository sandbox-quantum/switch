import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './main';
import { dataLayout, ensureDataDir } from './paths';
import { ControllerStore } from './store';

describe('CLI prettified output and --json flag', () => {
  let dir: string;
  let stdoutChunks: string[] = [];
  let origStdoutWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = join(tmpdir(), `cli-prettify-test-${Math.random().toString(36).slice(2)}`);
    await ensureDataDir(dir);
    stdoutChunks = [];
    origStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as any;
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  });

  function getStdout(): string {
    return stdoutChunks.join('');
  }

  it('prints readable status when machine is not enrolled', async () => {
    const code = await main(['status', '--data-dir', dir]);
    expect(code).toBe(1);

    const out = getStdout();
    expect(out).toContain('Controller Machine');
    expect(out).toContain('Not enrolled');
    expect(out).not.toContain('\x1b[');
  });

  it('outputs structured JSON for status --json when machine is not enrolled', async () => {
    const code = await main(['status', '--data-dir', dir, '--json']);
    expect(code).toBe(1);

    const parsed = JSON.parse(getStdout());
    expect(parsed.enrolled).toBe(false);
    expect(parsed.dataDir).toBe(dir);
  });

  it('prints aligned sections and agent states when machine is enrolled', async () => {
    const layout = dataLayout(dir);
    const store = ControllerStore.open(layout.database);
    store.saveIdentity({
      controllerId: 'ctrl_test_99',
      server: 'https://switch.example.invalid',
      name: 'worker-node-1',
      enrolledAt: '2026-11-06T12:00:00Z',
    });
    store.saveRelayPort(39123);
    store.saveAssignment(
      {
        revision: 1,
        agents: [
          {
            agent_id: 'ag_reviewer',
            desired_state: 'running',
            revision: 1,
            definition: {
              name: 'Reviewer Agent',
              provider: 'claude',
              model: null,
              advanced_config: {},
              provider_definition: null,
              instructions: 'Review PRs',
              auto_approve: false,
              skills: [],
              tools: [],
              directory: '',
              isolation: 'shared',
            },
          },
        ] as any,
      },
      null,
      new Date().toISOString()
    );
    store.close();

    const code = await main(['status', '--data-dir', dir]);
    expect(code).toBe(0);

    const out = getStdout();
    expect(out).toContain('Controller Machine');
    expect(out).toContain('ctrl_test_99');
    expect(out).toContain('worker-node-1');
    expect(out).toContain('Assigned Agents');
    expect(out).toContain('Reviewer Agent');
    expect(out).toContain('ag_reviewer');
  });

  it('outputs full JSON document for status --json when enrolled', async () => {
    const layout = dataLayout(dir);
    const store = ControllerStore.open(layout.database);
    store.saveIdentity({
      controllerId: 'ctrl_json_01',
      server: 'https://switch.example.invalid',
      name: 'json-box',
      enrolledAt: '2026-11-06T12:00:00Z',
    });
    store.saveAssignment(
      {
        revision: 3,
        agents: [
          {
            agent_id: 'ag_json',
            desired_state: 'running',
            revision: 3,
            definition: {
              name: 'JSON Agent',
              provider: 'opencode',
              model: null,
              advanced_config: {},
              provider_definition: null,
              instructions: 'Format json',
              auto_approve: false,
              skills: [],
              tools: [],
              directory: '',
              isolation: 'shared',
            },
          },
        ] as any,
      },
      null,
      new Date().toISOString()
    );
    store.close();

    const code = await main(['status', '--data-dir', dir, '--json']);
    expect(code).toBe(0);

    const parsed = JSON.parse(getStdout());
    expect(parsed.controller.id).toBe('ctrl_json_01');
    expect(parsed.controller.name).toBe('json-box');
    expect(parsed.assignment.revision).toBe(3);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].id).toBe('ag_json');
    expect(parsed.agents[0].name).toBe('JSON Agent');
    expect(parsed.agents[0].provider).toBe('opencode');
  });

  it('formats doctor output with summary line', async () => {
    const code = await main(['doctor', '--data-dir', dir]);
    expect([0, 1]).toContain(code);

    const out = getStdout();
    expect(out).toContain('Node');
    expect(out).toContain('Platform');
    expect(out).toContain('Summary:');
    expect(out).not.toContain('\x1b[');
  });

  it('outputs JSON array of checks for doctor --json', async () => {
    const code = await main(['doctor', '--data-dir', dir, '--json']);
    expect([0, 1]).toContain(code);

    const parsed = JSON.parse(getStdout());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty('name');
    expect(parsed[0]).toHaveProperty('status');
    expect(parsed[0]).toHaveProperty('detail');
  });

  it('documents --json in help output', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);

    const out = getStdout();
    expect(out).toContain('status [--data-dir <dir>] [--shared-host-bundle <path>] [--json]');
    expect(out).toContain('doctor [--data-dir <dir>] [--shared-host-bundle <path>] [--env-file <path>] [--json]');
  });
});
