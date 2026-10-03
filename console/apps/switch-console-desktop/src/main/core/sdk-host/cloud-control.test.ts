import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  operations: new Map<string, { id: string; session_id: string; action: string }>(),
  sessions: new Set<string>(),
  restarts: 0,
  loseNextResponse: false,
  refuseNext: null as { status: number; detail: string; code?: string } | null,
  launches: [] as { request_id: string }[],
  machines: [] as { machine_id: string; revision: number }[],
  machineActions: [] as unknown[],
  wakeRace: false,
  relayClients: 0,
  relayList: (async () => []) as () => Promise<unknown[]>,
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
    constructor() {
      server.relayClients += 1;
    }
    isClosed = false;
    onClose() {}
    list() {
      return server.relayList();
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

vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: FakeGatewayError,
  gatewayRequest: vi.fn(),
  gatewayFetch: vi.fn(
    async (_server: unknown, path: string, init: { method?: string; body?: unknown }) => {
      if (path === '/hosted-launches') return { json: async () => server.launches };
      if (path === '/hosted-machines') return { json: async () => ({ machines: server.machines }) };
      const [, kind, id, rest] = path.split('/');
      if (kind === 'hosted-launches' && rest === undefined)
        return { json: async () => server.launches.find((each) => each.request_id === id) };
      if (kind === 'hosted-machines') {
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
          throw new FakeGatewayError(
            'http',
            'Switch gateway returned 409',
            409,
            'revision mismatch'
          );
        }
        const started = {
          ...machine,
          desired_state: 'running',
          stop_reason: null,
          sleeping: false,
          revision: machine.revision + 1,
        };
        return { json: async () => ({ machine: started }) };
      }
      if (server.refuseNext) {
        const { status, detail, code } = server.refuseNext;
        server.refuseNext = null;
        throw new FakeGatewayError(
          'http',
          `Switch gateway returned ${status}`,
          status,
          detail,
          code
        );
      }
      const body = init.body as { id: string; session_id: string; action: string };
      let operation = server.operations.get(body.id);
      if (!operation) {
        operation = body;
        server.operations.set(body.id, operation);
        if (body.action === 'start') server.sessions.add(body.session_id);
        else server.restarts += 1;
      }
      if (server.loseNextResponse) {
        server.loseNextResponse = false;
        throw new FakeGatewayError('network', 'Could not reach the gateway: socket hang up');
      }
      return { json: async () => ({ ...operation, state: 'applied', error: null }) };
    }
  ),
}));

const { CloudRelayError } = await import('@switch-console/agent-providers');
const { listCloudAgents, listCloudSessions, runCloudSessionOperation, wakeCloudAgent } =
  await import('./cloud-control');

const agent = 'cloud:server:00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-0000000000aa';
const restartId = '00000000-0000-4000-8000-0000000000bb';

beforeEach(() => {
  server.operations.clear();
  server.sessions.clear();
  server.restarts = 0;
  server.loseNextResponse = false;
  server.refuseNext = null;
  server.launches = [];
  server.machines = [];
  server.machineActions = [];
  server.wakeRace = false;
  server.relayClients = 0;
});

const machineId = '3f1c2b4a-0000-4000-8000-000000000001';

function launch(requestId: string, overrides: Record<string, unknown>) {
  return {
    request_id: requestId,
    name: 'reviewer',
    provider: 'claude',
    state: 'ready',
    desired_state: 'running',
    revision: 1,
    agent_id: 'agent',
    error: null,
    error_code: null,
    sleeping: false,
    machine_id: null,
    process_state: null,
    process_restarts: 0,
    oom_kills: 0,
    ...overrides,
  };
}

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
    disk: null,
    memory: null,
    agents: [],
    ...overrides,
  };
}

it('lists cloud agents from the launch list without asking any worker', async () => {
  server.launches = [
    launch('00000000-0000-4000-8000-000000000001', {}),
    launch('00000000-0000-4000-8000-000000000002', { sleeping: true, state: 'stopped' }),
  ];
  const agents = await listCloudAgents('server');
  expect(server.relayClients).toBe(0);
  expect(agents?.map((each) => [each.sessions, each.problem?.code ?? null])).toEqual([
    [null, null],
    [null, 'worker_sleeping'],
  ]);
});

it('attaches each launch’s machine and reads it first', async () => {
  server.machines = [machine({})];
  server.launches = [launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId })];
  const [listed] = (await listCloudAgents('server'))!;
  expect(listed?.machine?.machine_id).toBe(machineId);
  expect(listed?.problem).toBeNull();
});

it.each([
  [
    'worker_sleeping',
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'idle', sleeping: true }),
    {},
    true,
  ],
  [
    'machine_stopped',
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' }),
    {},
    false,
  ],
  ['worker_waking', machine({ state: 'provisioning' }), {}, false],
  ['worker_waking', machine({ state: 'retained' }), {}, false],
  ['agent_stopped', machine({}), { desired_state: 'stopped', state: 'stopped' }, false],
  [
    'agent_stopped',
    machine({ state: 'provisioning' }),
    { desired_state: 'stopped', state: 'stopped' },
    false,
  ],
  [
    'agent_crashed',
    machine({ state: 'provisioning' }),
    { state: 'error', error_code: 'agent_crashed', error: 'The agent crashed 5 times.' },
    false,
  ],
  [
    'worker_sleeping',
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'idle', sleeping: true }),
    { desired_state: 'stopped', state: 'stopped' },
    false,
  ],
  [
    'worker_sleeping',
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'idle', sleeping: true }),
    { state: 'error', error_code: 'agent_crashed', error: 'The agent crashed 5 times.' },
    false,
  ],
  ['machine_error', machine({ state: 'error', error: 'The machine did not connect.' }), {}, false],
  [
    'agent_crashed',
    machine({}),
    { state: 'error', error_code: 'agent_crashed', error: 'The agent crashed 5 times.' },
    false,
  ],
])('reports %s', async (code, onMachine, overrides, wakeAvailable) => {
  server.machines = [onMachine];
  server.launches = [
    launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId, ...overrides }),
  ];
  const [listed] = (await listCloudAgents('server'))!;
  expect(listed?.problem).toMatchObject({ code, wakeAvailable });
});

it('lists a launch whose identity registration failed, so it can be retried or removed', async () => {
  server.machines = [machine({})];
  server.launches = [
    launch('00000000-0000-4000-8000-000000000001', {
      machine_id: machineId,
      agent_id: null,
      state: 'error',
      error: 'registration failed',
      error_code: 'identity_failed',
    }),
  ];
  const [listed] = (await listCloudAgents('server'))!;
  expect(listed?.launch).toMatchObject({ agent_id: null, error_code: 'identity_failed' });
  expect(listed?.problem?.code).toBe('worker_not_attached');
});

it('lists a removal left halfway so it can be finished, and hides a finished one', async () => {
  server.machines = [machine({})];
  server.launches = [
    launch('00000000-0000-4000-8000-000000000001', {
      machine_id: machineId,
      state: 'deleting',
      desired_state: 'deleted',
    }),
    launch('00000000-0000-4000-8000-000000000002', {
      machine_id: machineId,
      state: 'deleted',
      desired_state: 'deleted',
    }),
  ];
  const agents = (await listCloudAgents('server'))!;
  expect(agents.map((each) => [each.launch.request_id, each.problem?.code])).toEqual([
    ['00000000-0000-4000-8000-000000000001', 'worker_not_attached'],
  ]);
});

it('wakes an agent by starting its machine at the machine’s revision', async () => {
  server.machines = [
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'idle', sleeping: true }),
  ];
  server.launches = [launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId })];
  const woken = await wakeCloudAgent(agent);
  expect(server.machineActions).toEqual([{ action: 'start', revision: 4 }]);
  expect(woken).toMatchObject({ desired_state: 'running', revision: 5 });
});

it('does not start a machine already asked to run', async () => {
  server.machines = [machine({ state: 'provisioning' })];
  server.launches = [launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId })];
  expect(await wakeCloudAgent(agent)).toMatchObject({ state: 'provisioning', revision: 4 });
  expect(server.machineActions).toEqual([]);
});

it('reports a start whose response was lost as unknown, and the same id again starts one session', async () => {
  server.loseNextResponse = true;
  const first = await runCloudSessionOperation(agent, sessionId, sessionId, 'start');
  expect(first.state).toBe('unknown');
  expect(await runCloudSessionOperation(agent, sessionId, sessionId, 'start')).toEqual({
    state: 'applied',
  });
  expect([...server.sessions]).toEqual([sessionId]);
});

it('reports a restart whose response was lost as unknown, and the same id again restarts once', async () => {
  server.loseNextResponse = true;
  expect((await runCloudSessionOperation(agent, sessionId, restartId, 'restart')).state).toBe(
    'unknown'
  );
  expect(await runCloudSessionOperation(agent, sessionId, restartId, 'restart')).toEqual({
    state: 'applied',
  });
  expect(server.restarts).toBe(1);
});

it('reports a refusal the server answered as a definite failure', async () => {
  server.refuseNext = { status: 409, detail: 'Start the cloud worker and wait until it is ready.' };
  expect(await runCloudSessionOperation(agent, sessionId, sessionId, 'start')).toEqual({
    state: 'failed',
    message: 'Start the cloud worker and wait until it is ready.',
    code: null,
  });
});

it.each([
  ['worker_waking', 'The cloud machine is starting. Try again in a moment.'],
  ['machine_stopped', 'The owner stopped the cloud machine. Start it in Switch Console.'],
  ['machine_error', 'The cloud machine needs attention. Retry it in Switch Console.'],
])('reports a %s refusal with its code', async (code, detail) => {
  server.refuseNext = { status: 409, detail, code };
  expect(await runCloudSessionOperation(agent, sessionId, restartId, 'restart')).toEqual({
    state: 'failed',
    message: detail,
    code,
  });
  expect(server.restarts).toBe(0);
});

it('refuses a start whose operation id is not its session id', async () => {
  await expect(runCloudSessionOperation(agent, sessionId, restartId, 'start')).rejects.toThrow(
    /identified by its session id/
  );
});

it('does not wake a machine its owner stopped', async () => {
  server.machines = [machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' })];
  server.launches = [launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId })];
  await expect(wakeCloudAgent(agent)).rejects.toThrow('The owner stopped the cloud machine');
  expect(server.machineActions).toEqual([]);
});

it('reads a wake that lost the revision race to another wake as the machine waking', async () => {
  server.machines = [
    machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'idle', sleeping: true }),
  ];
  server.launches = [launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId })];
  server.wakeRace = true;
  expect(await wakeCloudAgent(agent)).toMatchObject({ desired_state: 'running', revision: 5 });
});

describe('the sessions last read from a worker', () => {
  const session = { sessionId: 'b4105d35-0000', status: 'ready', connectivity: 'online' };
  const asleep = machine({
    state: 'stopped',
    desired_state: 'stopped',
    stop_reason: 'idle',
    sleeping: true,
  });
  const onMachine = launch('00000000-0000-4000-8000-000000000001', { machine_id: machineId });

  function relayRefuses(relayCode: string) {
    server.relayList = async () => {
      throw new CloudRelayError(relayCode, 'Refused.', 409, false);
    };
  }

  beforeEach(async () => {
    kvRows.clear();
    server.machines = [machine({})];
    server.launches = [onMachine];
    server.relayList = async () => [session];
    await expect(listCloudSessions(agent)).resolves.toEqual({
      sessions: [session],
      problem: null,
    });
  });

  it('are listed after a restart while the machine is asleep or stopped', async () => {
    vi.resetModules();
    const restarted = await import('./cloud-control');
    server.machines = [asleep];
    expect((await restarted.listCloudAgents('server'))?.[0]).toMatchObject({
      sessions: [session],
      problem: { code: 'worker_sleeping' },
    });
    server.machines = [
      machine({ state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' }),
    ];
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

  it('are not offered for a worker that is down for another reason', async () => {
    relayRefuses('agent_crashed');
    expect((await listCloudSessions(agent)).sessions).toBeNull();
    server.launches = [
      launch('00000000-0000-4000-8000-000000000001', {
        machine_id: machineId,
        state: 'error',
        error_code: 'agent_crashed',
        error: 'crashed',
      }),
    ];
    expect((await listCloudAgents('server'))?.[0]?.sessions).toBeNull();
  });

  it('are forgotten once the agent is gone', async () => {
    server.launches = [];
    await listCloudAgents('server');
    expect(kvRows.size).toBe(0);
  });
});
