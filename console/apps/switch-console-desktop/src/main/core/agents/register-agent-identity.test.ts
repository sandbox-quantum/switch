import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerKnownAgent = vi.hoisted(() => vi.fn());
const fetchAgents = vi.hoisted(() => vi.fn());

vi.mock('@main/core/switch-servers/gateway-client', () => {
  class GatewayError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      readonly status?: number
    ) {
      super(message);
      this.name = 'GatewayError';
    }
  }
  class GatewayTimeoutError extends GatewayError {
    readonly timedOut = true;
    constructor(message: string) {
      super('network', message);
    }
  }
  return {
    GatewayError,
    GatewayTimeoutError,
    isGatewayTimeout: (error: unknown) => error instanceof GatewayTimeoutError,
    registerKnownAgent,
    fetchAgents,
  };
});

const { GatewayTimeoutError } =
  (await import('@main/core/switch-servers/gateway-client')) as unknown as {
    GatewayTimeoutError: new (message: string) => Error;
  };
const { registerAgentIdentity } = await import('./register-agent-identity');

const SERVER = { id: 's', name: 'S', url: 'http://localhost:8000' } as never;
const INPUT = {
  name: 'notes-helper',
  description: 'Takes notes',
  repoDir: '/repo',
  agentType: 'claude-code' as const,
  iconUrl: null,
  displayName: null,
};

describe('registering an agent the server answers too late for', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finishes with a fresh key when the server made the agent after all', async () => {
    registerKnownAgent
      .mockRejectedValueOnce(
        new GatewayTimeoutError('http://localhost:8000 did not answer in time')
      )
      .mockResolvedValueOnce({ id: 'sw-1', apiKey: 'tok-2' });
    fetchAgents.mockResolvedValue([{ name: 'notes-helper', createdAt: new Date().toISOString() }]);

    const result = await registerAgentIdentity(SERVER, INPUT);

    expect(result).toEqual({ kind: 'created', id: 'sw-1', apiKey: 'tok-2' });
    expect(registerKnownAgent.mock.calls.map(([, params]) => params.overwrite)).toEqual([
      false,
      true,
    ]);
  });

  it('says it timed out, not that nothing was created, when the agent is not there yet', async () => {
    registerKnownAgent.mockRejectedValueOnce(
      new GatewayTimeoutError('http://localhost:8000 did not answer in time')
    );
    fetchAgents.mockResolvedValue([]);

    const result = await registerAgentIdentity(SERVER, INPUT);

    expect(result.kind).toBe('timed-out');
    expect(registerKnownAgent).toHaveBeenCalledTimes(1);
  });

  it('never takes over an older agent of the same name', async () => {
    registerKnownAgent.mockRejectedValueOnce(
      new GatewayTimeoutError('http://localhost:8000 did not answer in time')
    );
    fetchAgents.mockResolvedValue([{ name: 'notes-helper', createdAt: '2020-01-01T00:00:00Z' }]);

    const result = await registerAgentIdentity(SERVER, INPUT);

    expect(result.kind).toBe('timed-out');
    expect(registerKnownAgent).toHaveBeenCalledTimes(1);
  });
});
