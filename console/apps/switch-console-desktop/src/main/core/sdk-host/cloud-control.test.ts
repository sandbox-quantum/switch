import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  machines: [] as { machine_id: string; revision: number }[],
  hostedMachinesMissing: false,
  machineActions: [] as unknown[],
  wakeRace: false,
  relayClients: 0,
  relayBasePaths: [] as string[],
  relayRequests: [] as { path: string; init: unknown }[],
  management: true,
  controllers: [] as { id: string; kind: string }[],
  managedAgents: [] as Record<string, unknown>[],
  relayList: (async () => []) as () => Promise<unknown[]>,
  relayEnsures: [] as unknown[],
  relayEnsure: (async () => ({ created: true })) as () => Promise<unknown>,
}));
const kvRows = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@main/db/kv', () => ({
  KV: class {
    get = async (key: string) => kvRows.get(key) ?? null;
    set = async (key: string, value: unknown) => void kvRows.set(key, structuredClone(value));
    del = async (key: string) => void kvRows.delete(key);
    getAll = async () => Object.fromEntries(kvRows);
  },
}));

const { FakeGatewayError } = vi.hoisted(() => ({
  FakeGatewayError: class extends Error {
    constructor(
      readonly kind: 'unauthorized' | 'http' | 'network',
      message: string,
      readonly status?: number,
      readonly detail?: string,
      readonly code?: string
    ) {
      super(message);
    }
  },
}));

vi.mock('@switch-console/agent-providers', () => ({
  CloudRelayClient: class {
    constructor(
      readonly fetchRelay: (path: string, init: unknown) => Promise<unknown>,
      basePath: string
    ) {
      server.relayClients += 1;
      server.relayBasePaths.push(basePath);
    }
    isClosed = false;
    onClose() {}
    list() {
      return server.relayList();
    }
    ensure(input: unknown) {
      server.relayEnsures.push(input);
      return server.relayEnsure();
    }
  },
  CloudRelayError: class extends Error {
    constructor(
      readonly relayCode: string,
      message: string,
      readonly status: number,
      readonly wakeAvailable: boolean
    ) {
      super(message);
    }
  },
  RELAY_TIMEOUT_MS: 1000,
}));

vi.mock('@main/core/switch-servers/servers-store', () => ({
  getServer: async () => ({ id: 'server' }),
}));

vi.mock('@main/core/workspaces/workspace-session', () => ({
  withServerWorkspaceSession: async (serverId: string, fn: (server: unknown) => unknown) =>
    fn({ id: serverId }),
}));

const { FakeManagementUnavailable } = vi.hoisted(() => ({
  FakeManagementUnavailable: class extends Error {},
}));

vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: FakeGatewayError,
  AgentManagementUnavailableError: FakeManagementUnavailable,
  fetchManagementControllers: vi.fn(async () => {
    if (!server.management) throw new FakeManagementUnavailable('no management');
    return server.controllers;
  }),
  fetchManagedAgents: vi.fn(async () => server.managedAgents),
  fetchManagedAgent: vi.fn(
    async (_server: unknown, agentId: string) =>
      server.managedAgents.find((each) => each.agentId === agentId) ?? null
  ),
  gatewayRequest: vi.fn(async (_server: unknown, path: string, init: unknown) => {
    server.relayRequests.push({ path, init });
    return {};
  }),
  gatewayFetch: vi.fn(async (_server: unknown, path: string, init: { body?: unknown }) => {
    if (path === '/hosted-machines') {
      if (server.hostedMachinesMissing)
        throw new FakeGatewayError('http', 'Switch gateway returned 404', 404, 'Not Found');
      return { json: async () => ({ machines: server.machines }) };
    }
    const [, kind, id, rest] = path.split('/');
    if (kind !== 'hosted-machines') throw new Error(`unexpected gateway call ${path}`);
    const machine = server.machines.find((each) => each.machine_id === id)!;
    if (rest === undefined) return { json: async () => machine };
    server.machineActions.push(init.body);
    if (server.wakeRace) {
      server.wakeRace = false;
      Object.assign(machine, {
        state: 'provisioning',
        desired_state: 'running',
        stop_reason: null,
        sleeping: false,
        revision: machine.revision + 1,
      });
      throw new FakeGatewayError('http', 'Switch gateway returned 409', 409, 'revision mismatch');
    }
    const started = {
      ...machine,
      desired_state: 'running',
      stop_reason: null,
      sleeping: false,
      revision: machine.revision + 1,
    };
    return { json: async () => ({ machine: started }) };
  }),
}));

const { CloudRelayError } = await import('@switch-console/agent-providers');
const {
  cloudControl,
  cloudRelayBasePath,
  listCloudAgents,
  listCloudSessions,
  runCloudSessionOperation,
  wakeCloudAgent,
} = await import('./cloud-control');

const agent = 'cloud:server:agent=agent';
const sessionId = '00000000-0000-4000-8000-0000000000aa';
const machineId = '3f1c2b4a-0000-4000-8000-000000000001';

function machine(overrides: Record<string, unknown>) {
  return {
    machine_id: machineId,
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    revision: 4,
    instance_type: null,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: null,
    controller_id: 'cloud-controller',
    disk: null,
    memory: null,
    agents: [],
    ...overrides,
  };
}

function managed(overrides: Record<string, unknown>) {
  return {
    agentId: 'agent',
    name: 'reviewer',
    provider: 'claude',
    controllerId: 'cloud-controller',
    desiredState: 'running',
    status: { process: 'running', attached: true, reason: null, detail: null, directory: null },
    ...overrides,
  };
}

const asleep = () =>
  machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'idle', sleeping: true });
const ownerStopped = () =>
  machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' });

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv('SWITCH_CLOUD_ENABLED', 'true');
  server.machines = [machine({})];
  server.hostedMachinesMissing = false;
  server.machineActions = [];
  server.wakeRace = false;
  server.relayClients = 0;
  server.relayBasePaths = [];
  server.relayRequests = [];
  server.management = true;
  server.controllers = [{ id: 'cloud-controller', kind: 'ec2' }];
  server.managedAgents = [managed({})];
  server.relayEnsures = [];
  server.relayEnsure = async () => ({ created: true });
});

it('relays through the agent’s control routes, and refuses an id that is not an agent id', () => {
  expect(cloudRelayBasePath({ serverId: 'server', agentId: 'agent_1-a' })).toBe(
    '/management/agents/agent_1-a/control'
  );
  expect(() => cloudRelayBasePath({ serverId: 'server', agentId: '../agent' })).toThrow(
    /not a Switch agent id/
  );
});

it('hands the relay client the base path its key names, and sends its calls to the gateway as given', async () => {
  const client = (await cloudControl(agent)) as unknown as {
    fetchRelay: (path: string, init: unknown) => Promise<unknown>;
  };
  expect(server.relayBasePaths).toEqual(['/management/agents/agent/control']);
  await client.fetchRelay('/management/agents/agent/control/stream?subscribe=one', {
    method: 'GET',
    body: undefined,
    signal: undefined,
  });
  expect(server.relayRequests.map((each) => each.path)).toEqual([
    '/management/agents/agent/control/stream?subscribe=one',
  ]);
});

it('lists the managed agents an ec2 controller runs, each with its controller’s machine, without asking any machine', async () => {
  const agents = (await listCloudAgents('server'))!;
  expect(server.relayClients).toBe(0);
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({
    key: agent,
    agentId: 'agent',
    name: 'reviewer',
    provider: 'claude',
    machine: { machine_id: machineId },
    controller: {
      controllerId: 'cloud-controller',
      desiredState: 'running',
      process: 'running',
      detail: null,
    },
    sessions: null,
    problem: null,
  });
});

it('refuses every cloud call while Switch Cloud is turned off', async () => {
  vi.stubEnv('SWITCH_CLOUD_ENABLED', 'false');
  await expect(listCloudAgents('server')).rejects.toThrow('Switch Cloud is turned off');
  await expect(cloudControl(agent)).rejects.toThrow('Switch Cloud is turned off');
  expect(server.relayClients).toBe(0);
});

it('leaves out agents on other controllers, and lists none without agent management', async () => {
  server.controllers = [
    { id: 'cloud-controller', kind: 'ec2' },
    { id: 'laptop', kind: 'console' },
  ];
  server.managedAgents = [managed({}), managed({ agentId: 'local', controllerId: 'laptop' })];
  expect((await listCloudAgents('server'))!.map((each) => each.agentId)).toEqual(['agent']);
  server.management = false;
  expect(await listCloudAgents('server')).toEqual([]);
});

it('lists no cloud agents on a server without cloud machines', async () => {
  server.hostedMachinesMissing = true;
  expect(await listCloudAgents('server')).toBeNull();
});

it.each([
  ['worker_sleeping', asleep(), {}, true],
  ['machine_stopped', ownerStopped(), {}, false],
  ['worker_waking', machine({ state: 'provisioning' }), {}, false],
  ['worker_waking', machine({ state: 'retained' }), {}, false],
  ['agent_stopped', machine({}), { desiredState: 'stopped' }, false],
  ['agent_stopped', machine({ state: 'provisioning' }), { desiredState: 'stopped' }, false],
  [
    'agent_crashed',
    machine({}),
    { status: { process: 'crashed', attached: false, reason: null, detail: 'Exited 1.' } },
    false,
  ],
  [
    'worker_sleeping',
    asleep(),
    { status: { process: 'crashed', attached: false, reason: null, detail: 'Exited 1.' } },
    true,
  ],
  ['machine_error', machine({ state: 'error', error: 'The machine did not connect.' }), {}, false],
])('reports %s', async (code, onMachine, overrides, wakeAvailable) => {
  server.machines = [onMachine];
  server.managedAgents = [managed(overrides)];
  const [listed] = (await listCloudAgents('server'))!;
  expect(listed?.problem).toMatchObject({ code, wakeAvailable });
});

it('wakes an agent by starting its controller’s machine at the machine’s revision', async () => {
  server.machines = [asleep()];
  const woken = await wakeCloudAgent(agent);
  expect(server.machineActions).toEqual([{ action: 'start', revision: 4 }]);
  expect(woken).toMatchObject({ desired_state: 'running', revision: 5 });
});

it('does not start a machine already asked to run', async () => {
  server.machines = [machine({ state: 'provisioning' })];
  expect(await wakeCloudAgent(agent)).toMatchObject({ state: 'provisioning', revision: 4 });
  expect(server.machineActions).toEqual([]);
});

it('does not wake a machine its owner stopped', async () => {
  server.machines = [ownerStopped()];
  await expect(wakeCloudAgent(agent)).rejects.toThrow('The owner stopped the cloud machine');
  expect(server.machineActions).toEqual([]);
});

it('reads a wake that lost the revision race to another wake as the machine waking', async () => {
  server.machines = [asleep()];
  server.wakeRace = true;
  expect(await wakeCloudAgent(agent)).toMatchObject({ desired_state: 'running', revision: 5 });
});

it.each([
  ['is not a managed agent', () => void (server.managedAgents = []), /not a managed agent/],
  [
    'is not placed on a controller',
    () => void (server.managedAgents = [managed({ controllerId: null })]),
    /not placed on a cloud machine/,
  ],
  [
    'has no machine for its controller',
    () => void (server.machines = [machine({ controller_id: 'other' })]),
    /no cloud machine/,
  ],
])('refuses to wake an agent that %s', async (_name, arrange, message) => {
  arrange();
  await expect(wakeCloudAgent(agent)).rejects.toThrow(message);
  expect(server.machineActions).toEqual([]);
});

it('starts and restarts a session through the agent’s relay', async () => {
  expect(await runCloudSessionOperation(agent, sessionId, 'start')).toEqual({ state: 'applied' });
  expect(await runCloudSessionOperation(agent, sessionId, 'restart')).toEqual({
    state: 'applied',
  });
  expect(server.relayEnsures).toEqual([
    { sessionId, resuming: false, restart: false, startSource: 'user' },
    { sessionId, resuming: true, restart: true, startSource: null },
  ]);
});

it('reads a refusal as failed and a lost answer as unknown', async () => {
  server.relayEnsure = async () => {
    throw new CloudRelayError('agent_not_running', 'The host is not running.', 409, false);
  };
  expect(await runCloudSessionOperation(agent, sessionId, 'start')).toEqual({
    state: 'failed',
    message: 'The host is not running.',
    code: 'agent_not_running',
  });
  server.relayEnsure = async () => {
    throw new CloudRelayError('relay_timeout', 'No answer in time.', 504, false);
  };
  expect((await runCloudSessionOperation(agent, sessionId, 'start')).state).toBe('unknown');
});

describe('the sessions last read from a cloud agent', () => {
  const session = { sessionId: 'b4105d35-0000', status: 'ready', connectivity: 'online' };

  function relayRefuses(relayCode: string) {
    server.relayList = async () => {
      throw new CloudRelayError(relayCode, 'Refused.', 409, false);
    };
  }

  beforeEach(async () => {
    kvRows.clear();
    server.relayList = async () => [session];
    await expect(listCloudSessions(agent)).resolves.toEqual({
      sessions: [session],
      problem: null,
    });
  });

  it('are listed after a restart while the machine is asleep or stopped', async () => {
    vi.resetModules();
    const restarted = await import('./cloud-control');
    server.machines = [asleep()];
    expect((await restarted.listCloudAgents('server'))?.[0]).toMatchObject({
      sessions: [session],
      problem: { code: 'worker_sleeping' },
    });
    server.machines = [ownerStopped()];
    expect((await restarted.listCloudAgents('server'))?.[0]).toMatchObject({
      sessions: [session],
      problem: { code: 'machine_stopped' },
    });
  });

  it('stay beside a relay that answers the machine is asleep', async () => {
    relayRefuses('worker_sleeping');
    await expect(listCloudSessions(agent)).resolves.toMatchObject({
      sessions: [session],
      problem: { code: 'worker_sleeping' },
    });
  });

  it('are not offered for an agent that is down for another reason', async () => {
    relayRefuses('agent_crashed');
    expect((await listCloudSessions(agent)).sessions).toBeNull();
    server.managedAgents = [
      managed({
        status: { process: 'crashed', attached: false, reason: null, detail: 'crashed' },
      }),
    ];
    expect((await listCloudAgents('server'))?.[0]?.sessions).toBeNull();
  });

  it('are forgotten once the agent is gone', async () => {
    server.managedAgents = [];
    await listCloudAgents('server');
    expect(kvRows.size).toBe(0);
  });
});
