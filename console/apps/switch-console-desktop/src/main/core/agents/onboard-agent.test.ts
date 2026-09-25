import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What onboarding an already-configured directory reports.
 *
 * One control reaches this path — a folder dropped on the sidebar — and it
 * fails in four typed ways, none of which used to be counted at all.
 */

const { h } = vi.hoisted(() => ({
  h: {
    trackEvent: vi.fn(),
    emit: vi.fn(),
    validDirectory: true,
    detected: { agentId: 'sw-1', apiEndpoint: 'https://switch.example.com' } as {
      agentId: string;
      apiEndpoint: string;
    } | null,
    agentExists: true,
    unauthorized: false,
    server: { id: 'srv-1', name: 'Switch', apiUrl: 'https://switch.example.com' } as {
      id: string;
      name: string;
      apiUrl: string;
      managementKind?: string;
      sshHost?: string;
    } | null,
  },
}));

vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: h.trackEvent }));
vi.mock('@main/core/locations/path-utils', () => ({
  checkIsValidDirectory: () => h.validDirectory,
}));
vi.mock('@main/core/locations/store', () => ({
  ensureLocation: vi.fn(async () => ({ id: 'loc' })),
}));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: { openLocation: vi.fn(async () => {}) },
}));
vi.mock('@main/core/switch-rooms/switch-credentials', () => ({
  readSwitchAgentCredentials: vi.fn(async () => null),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: vi.fn(async () => h.server),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => {
  class GatewayError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  }
  return {
    GatewayError,
    agentExistsOnServer: vi.fn(async () => {
      if (h.unauthorized) throw new GatewayError('unauthorized');
      return h.agentExists;
    }),
  };
});
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./detect', () => ({ detectSwitchAgent: vi.fn(async () => h.detected) }));
vi.mock('./detect-remote', () => ({ detectSwitchAgentRemote: vi.fn(async () => h.detected) }));
vi.mock('./createAgent', () => ({
  createAgent: vi.fn(async (input: Record<string, unknown>) => ({ ...input })),
}));
vi.mock('./agent-events', () => ({ agentEvents: { _emit: h.emit } }));
vi.mock('./setAgentAutoSession', () => ({
  reconcileAgentAutoSessionFromGateway: vi.fn(async () => {}),
}));
vi.mock('./write-switch-settings', () => ({ writeAgentNeutralSettings: vi.fn(async () => {}) }));

const { onboardAgent } = await import('./onboard-agent');

function params(overrides: Record<string, unknown> = {}) {
  return {
    name: 'repo',
    serverId: 'srv-1',
    providerId: 'claude' as const,
    dir: '/repo',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.validDirectory = true;
  h.detected = { agentId: 'sw-1', apiEndpoint: 'https://switch.example.com' };
  h.agentExists = true;
  h.unauthorized = false;
  h.server = { id: 'srv-1', name: 'Switch', apiUrl: 'https://switch.example.com' };
});

describe('where an onboarded agent is said to have come from', () => {
  it('names the sidebar, the one control that reaches this path', async () => {
    // The first-run checklist opens the add-agent modal instead, which reports
    // `onboarding` from there. Naming this one the same pooled the two and left
    // dragging a folder onto the sidebar with no count of its own.
    const result = await onboardAgent(params());

    expect(result.success).toBe(true);
    expect(h.emit).toHaveBeenCalledWith('agent:created', expect.anything(), 'sidebar');
  });

  it('names it on a failure too', async () => {
    h.validDirectory = false;

    await onboardAgent(params());

    expect(h.trackEvent).toHaveBeenCalledWith(
      'agent_created',
      expect.objectContaining({ entry_point: 'sidebar' })
    );
  });
});

describe('what a failed onboarding reports', () => {
  it('reports nothing itself when the agent is created', async () => {
    // The success comes from the `agent:created` hook; reporting here as well
    // would double-count it.
    await onboardAgent(params());

    expect(h.trackEvent).not.toHaveBeenCalled();
  });

  it('reports a directory that is not a Switch agent', async () => {
    h.detected = null;

    await onboardAgent(params());

    expect(h.trackEvent).toHaveBeenCalledWith('agent_created', {
      agent_type: 'claude',
      location: 'local',
      outcome: 'failure',
      failure_reason: 'not_configured',
      entry_point: 'sidebar',
    });
  });

  it('reports a server this app is not signed in to as unauthenticated', async () => {
    h.unauthorized = true;

    await onboardAgent(params());

    expect(h.trackEvent).toHaveBeenCalledWith(
      'agent_created',
      expect.objectContaining({ failure_reason: 'unauthenticated' })
    );
  });

  it('reports an identity the chosen server does not have', async () => {
    h.agentExists = false;

    await onboardAgent(params());

    expect(h.trackEvent).toHaveBeenCalledWith(
      'agent_created',
      expect.objectContaining({ outcome: 'failure', failure_reason: 'agent_not_on_server' })
    );
  });

  it('describes a remote onboarding as remote', async () => {
    h.detected = null;

    await onboardAgent(params({ sshHost: 'build-box' }));

    expect(h.trackEvent).toHaveBeenCalledWith(
      'agent_created',
      expect.objectContaining({ location: 'remote' })
    );
  });

  it('never puts the directory in the payload', async () => {
    h.validDirectory = false;

    await onboardAgent(params({ dir: '/Users/someone/secret-project' }));

    expect(JSON.stringify(h.trackEvent.mock.calls)).not.toContain('secret-project');
  });
});
