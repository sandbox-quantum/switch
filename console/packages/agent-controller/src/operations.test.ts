import { describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { silentLogger } from './log';
import { executeOperation, type OperationDeps, processPendingOperations } from './operations';
import type { AgentAssignment, Operation, OperationResult, ProviderStatus } from './schemas';

function entry(desired: 'running' | 'stopped' = 'running'): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision: 1,
    desired_state: desired,
    definition: {
      name: 'scout',
      display_name: null,
      icon_url: null,
      provider: 'claude',
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

function operation(overrides: Partial<Operation>): Operation {
  return {
    id: 'op-1',
    kind: 'agent.restart',
    agent_id: 'agent-1',
    params: {},
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const claudeStatus: ProviderStatus = {
  provider: 'claude',
  installed: true,
  version: '2.0.0',
  auth: 'ok',
  auth_source: 'local',
  checked_at: '2026-01-01T00:00:00Z',
};

function deps(overrides: Partial<OperationDeps> = {}) {
  const restarted: string[] = [];
  const rechecked: string[] = [];
  const results = new Map<string, OperationResult>();
  const value: OperationDeps = {
    client: {
      pendingOperations: async () => [],
      claimOperation: async (id) => operation({ id }),
      operationResult: async (id, result) => {
        results.set(id, result);
      },
    },
    assignment: () => ({ revision: 1, agents: [entry()] }),
    restartAgent: async (agent) => {
      restarted.push(agent.agent_id);
      return null;
    },
    recheckProvider: async (provider) => {
      rechecked.push(provider);
      return claudeStatus;
    },
    takeUpLogin: async () => ({ status: claudeStatus, problem: null }),
    signInWithBrowser: async () => ({ outcome: 'succeeded' }),
    restartController: () => null,
    log: silentLogger,
    ...overrides,
  };
  return { deps: value, restarted, rechecked, results };
}

describe('executeOperation', () => {
  it('restarts an assigned running agent', async () => {
    const { deps: d, restarted } = deps();
    expect(await executeOperation(operation({}), d)).toEqual({ outcome: 'succeeded' });
    expect(restarted).toEqual(['agent-1']);
  });

  it('reports why a restart failed', async () => {
    const { deps: d } = deps({
      restartAgent: async () => ({ reason: 'provider_not_installed', detail: 'no claude' }),
    });
    expect(await executeOperation(operation({}), d)).toEqual({
      outcome: 'failed',
      error: { code: 'provider_not_installed', message: 'no claude' },
    });
  });

  it('refuses to restart an agent that is not assigned, not running, or not named', async () => {
    const { deps: d, restarted } = deps();
    expect(await executeOperation(operation({ agent_id: 'agent-9' }), d)).toMatchObject({
      outcome: 'failed',
      error: { code: 'not_assigned' },
    });
    expect(await executeOperation(operation({ agent_id: null }), d)).toMatchObject({
      error: { code: 'validation_error' },
    });
    const stopped = deps({ assignment: () => ({ revision: 1, agents: [entry('stopped')] }) });
    expect(await executeOperation(operation({}), stopped.deps)).toMatchObject({
      error: { code: 'validation_error' },
    });
    expect(restarted).toEqual([]);
  });

  it('rechecks a provider and returns its status', async () => {
    const { deps: d, rechecked } = deps();
    expect(
      await executeOperation(
        operation({ kind: 'provider.recheck', agent_id: null, params: { provider: 'claude' } }),
        d
      )
    ).toEqual({ outcome: 'succeeded', output: { provider: claudeStatus } });
    expect(rechecked).toEqual(['claude']);
    expect(
      await executeOperation(
        operation({ kind: 'provider.recheck', agent_id: null, params: { provider: 'gemini' } }),
        d
      )
    ).toMatchObject({ outcome: 'failed', error: { code: 'validation_error' } });
  });

  it('takes up a login given to the machine, and says why when it cannot', async () => {
    const login = (params: Record<string, unknown>) =>
      operation({ kind: 'provider.login', agent_id: null, params });
    const sealedStatus = { ...claudeStatus, auth_source: 'sealed' as const };
    const ok = deps({ takeUpLogin: async () => ({ status: sealedStatus, problem: null }) });
    expect(
      await executeOperation(login({ provider: 'claude', method: 'sealed', revision: 2 }), ok.deps)
    ).toEqual({ outcome: 'succeeded', output: { provider: sealedStatus } });
    const expired = deps({
      takeUpLogin: async () => ({
        status: { ...claudeStatus, auth: 'expired', auth_source: 'sealed' },
        problem: { code: 'provider_login_expired', message: 'It does not sign in.' },
      }),
    });
    expect(
      await executeOperation(login({ provider: 'claude', method: 'sealed' }), expired.deps)
    ).toEqual({
      outcome: 'failed',
      error: { code: 'provider_login_expired', message: 'It does not sign in.' },
    });
    expect(
      await executeOperation(login({ provider: 'claude', method: 'device_code' }), ok.deps)
    ).toMatchObject({ error: { code: 'operation_unsupported' } });
    expect(await executeOperation(login({ method: 'sealed' }), ok.deps)).toMatchObject({
      error: { code: 'validation_error' },
    });
  });

  it('signs Claude Code, Codex, Cursor, Antigravity and OpenCode in through a browser, and no other provider', async () => {
    const started: string[] = [];
    const { deps: d } = deps({
      signInWithBrowser: async (operationId, provider) => {
        started.push(`${operationId}:${provider}`);
        return { outcome: 'succeeded', output: { provider: claudeStatus } };
      },
    });
    const login = (provider: string) =>
      operation({
        kind: 'provider.login',
        agent_id: null,
        params: { provider, method: 'browser' },
      });
    expect(await executeOperation(login('claude'), d)).toEqual({
      outcome: 'succeeded',
      output: { provider: claudeStatus },
    });
    for (const provider of ['cursor', 'antigravity', 'opencode'])
      expect(await executeOperation(login(provider), d)).toMatchObject({ outcome: 'succeeded' });
    expect(await executeOperation(login('pi'), d)).toMatchObject({
      error: { code: 'operation_unsupported' },
    });
    expect(started).toEqual(['op-1:claude', 'op-1:cursor', 'op-1:antigravity', 'op-1:opencode']);
  });

  it('answers any other kind with operation_unsupported', async () => {
    const { deps: d } = deps();
    for (const kind of ['agent.start', 'session.send', 'something.new'])
      expect(await executeOperation(operation({ kind }), d)).toMatchObject({
        outcome: 'failed',
        error: { code: 'operation_unsupported' },
      });
  });
});

describe('processPendingOperations', () => {
  it('runs a browser sign-in beside the operations after it, not before them', async () => {
    let finishSignIn: (result: OperationResult) => void = () => {};
    const browser = operation({
      id: 'op-browser',
      kind: 'provider.login',
      agent_id: null,
      params: { provider: 'codex', method: 'browser' },
    });
    const { deps: d, results } = deps({
      client: {
        pendingOperations: async () => [browser, operation({ id: 'op-2' })],
        claimOperation: async (id) => (id === 'op-browser' ? browser : operation({ id })),
        operationResult: async (id, result) => {
          results.set(id, result);
        },
      },
      signInWithBrowser: () =>
        new Promise((resolve) => {
          finishSignIn = resolve;
        }),
    });
    expect(await processPendingOperations(d)).toBe(2);
    expect([...results.keys()]).toEqual(['op-2']);
    finishSignIn({ outcome: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(results.get('op-browser')).toEqual({ outcome: 'succeeded' });
  });

  it('claims, runs and reports each pending operation, skipping ones lost to others', async () => {
    const { deps: d, results } = deps({
      client: {
        pendingOperations: async () => [
          operation({ id: 'op-1' }),
          operation({ id: 'op-2' }),
          operation({ id: 'op-3', kind: 'machine.collect_diagnostics', agent_id: null }),
          operation({ id: 'op-4' }),
        ],
        claimOperation: async (id) => {
          if (id === 'op-2')
            throw new ControllerApiError(409, 'already_claimed', 'taken', false, null);
          if (id === 'op-4') throw new ControllerApiError(410, 'cancelled', 'gone', false, null);
          return id === 'op-3'
            ? operation({ id, kind: 'machine.collect_diagnostics', agent_id: null })
            : operation({ id });
        },
        operationResult: async (id, result) => {
          results.set(id, result);
        },
      },
    });
    expect(await processPendingOperations(d)).toBe(2);
    expect([...results.keys()]).toEqual(['op-1', 'op-3']);
    expect(results.get('op-1')).toEqual({ outcome: 'succeeded' });
    expect(results.get('op-3')).toMatchObject({ error: { code: 'operation_unsupported' } });
  });

  it('reports an operation that throws as failed, internal', async () => {
    const { deps: d, results } = deps({
      client: {
        pendingOperations: async () => [operation({})],
        claimOperation: async (id) => operation({ id }),
        operationResult: async (id, result) => {
          results.set(id, result);
        },
      },
      restartAgent: async () => {
        throw new Error('disk on fire');
      },
    });
    await processPendingOperations(d);
    expect(results.get('op-1')).toEqual({
      outcome: 'failed',
      error: { code: 'internal', message: 'disk on fire' },
    });
  });

  it('lets a claim refused for another reason propagate', async () => {
    const { deps: d } = deps({
      client: {
        pendingOperations: async () => [operation({})],
        claimOperation: async () => {
          throw new ControllerApiError(401, 'controller_revoked', 'revoked', false, null);
        },
        operationResult: async () => {},
      },
    });
    await expect(processPendingOperations(d)).rejects.toMatchObject({ code: 'controller_revoked' });
  });
});

describe('controller.restart', () => {
  it('succeeds when whatever runs the controller will start it again', async () => {
    let asked = 0;
    const { deps: value } = deps({
      restartController: () => {
        asked += 1;
        return null;
      },
    });
    const result = await executeOperation(
      operation({ kind: 'controller.restart', agent_id: null }),
      value
    );
    expect(result).toEqual({ outcome: 'succeeded' });
    expect(asked).toBe(1);
  });

  it('fails, saying why, when nothing would start it again', async () => {
    const { deps: value } = deps({
      restartController: () => ({ reason: 'not_supervised', detail: 'runs outside a service' }),
    });
    const result = await executeOperation(
      operation({ kind: 'controller.restart', agent_id: null }),
      value
    );
    expect(result).toEqual({
      outcome: 'failed',
      error: { code: 'not_supervised', message: 'runs outside a service' },
    });
  });
});
