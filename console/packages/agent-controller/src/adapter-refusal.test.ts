import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from './log';
import type { ReconcileDeps } from './reconcile';
import type { AgentAssignment } from './schemas';
import { ControllerStore } from './store';
import { FakeRuntime } from './testing/fake-runtime';

// A provider whose adapter refuses to be built, as one not yet implemented
// does: the refusal has to surface while the template is built, before
// anything is launched. The template module caches each provider's
// capabilities once built, and test files may share modules (`--no-isolate`):
// every case loads its own copy of the template, reconcile and the provider
// registry the spy sits on, so no earlier test's cache answers for the adapter.
const REFUSING = 'cursor';
const REFUSAL = 'This provider cannot run sessions in this build.';

let providerRuntime: typeof import('@switch-console/agent-providers').providerRuntime;
let reconcile: typeof import('./reconcile').reconcile;
let buildWatcherTemplate: typeof import('./template').buildWatcherTemplate;

function refuseAdapter() {
  return vi.spyOn(providerRuntime(REFUSING), 'createAdapter').mockImplementation(() => {
    throw new Error(REFUSAL);
  });
}

function agent(agentId: string, provider: string): AgentAssignment {
  return {
    agent_id: agentId,
    revision: 1,
    desired_state: 'running',
    definition: {
      name: agentId,
      display_name: null,
      icon_url: null,
      provider,
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      auto_mode: false,
      directory: null,
      isolation: 'shared',
    },
  };
}

let dir: string;
let store: ControllerStore;
let runtime: FakeRuntime;

function deps(): ReconcileDeps {
  return {
    store,
    runtime,
    ensureCredentials: async () => false,
    givenLogin: async () => null,
    forgetAgent: () => {},
    binaryPath: async (provider) => `/usr/bin/${provider}`,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    log: silentLogger,
  };
}

beforeEach(async () => {
  vi.resetModules();
  ({ providerRuntime } = await import('@switch-console/agent-providers'));
  ({ reconcile } = await import('./reconcile'));
  ({ buildWatcherTemplate } = await import('./template'));
  dir = mkdtempSync(join(tmpdir(), 'controller-adapter-refusal-'));
  store = ControllerStore.open(join(dir, 'controller.db'));
  runtime = new FakeRuntime();
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a provider whose adapter refuses to be built', () => {
  it('fails building the watcher template with the refusal', () => {
    const createAdapter = refuseAdapter();
    expect(() =>
      buildWatcherTemplate({
        agentId: 'agent-1',
        provider: REFUSING,
        definition: agent('agent-1', REFUSING).definition,
        cwd: '/data/workspaces/agent-1',
        credentialsPath: '/data/agents/agent-1/credentials.json',
        binaryPath: `/usr/bin/${REFUSING}`,
      })
    ).toThrow(REFUSAL);
    expect(createAdapter).toHaveBeenCalled();
  });

  it('is recorded on the agent before anything is launched, and the next agent still starts', async () => {
    const createAdapter = refuseAdapter();
    const launch = vi.spyOn(runtime, 'launch');
    await reconcile(
      { revision: 2, agents: [agent('agent-1', REFUSING), agent('agent-2', 'claude')] },
      deps()
    );
    expect(createAdapter).toHaveBeenCalled();
    expect(store.agent('agent-1')?.failure).toMatchObject({
      reason: 'internal',
      revision: 1,
      detail: REFUSAL,
    });
    expect(launch).not.toHaveBeenCalledWith('agent-1', expect.anything(), expect.anything());
    expect(runtime.launches('agent-1')).toEqual([]);
    expect(runtime.launches('agent-2')).toHaveLength(1);
    expect(store.agent('agent-2')).toMatchObject({ appliedRevision: 1, failure: null });
  });
});
