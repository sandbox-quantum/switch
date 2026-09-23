import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Following agents another account runs on a shared host (CHOO-2893): their
 * identity comes from the server, their directories are never read, and
 * nothing is started on the host for them.
 */

const exec = vi.hoisted(() => vi.fn());
const getServer = vi.hoisted(() => vi.fn());
const fetchAgents = vi.hoisted(() => vi.fn());
const getAgents = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const ensureObservedLocation = vi.hoisted(() => vi.fn());
const createAgent = vi.hoisted(() => vi.fn());
const emit = vi.hoisted(() => vi.fn());
const startRemoteDiscovery = vi.hoisted(() => vi.fn(async () => {}));
const resolveWorkspaceFsFor = vi.hoisted(() => vi.fn());

vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: async () => ({}),
}));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    exec = exec;
    dispose = vi.fn();
  },
}));
vi.mock('@main/core/locations/location-transport', () => ({
  sshConnectionIdForHost: (host: string) => `ssh:${host}`,
}));
vi.mock('@main/core/locations/store', () => ({ ensureObservedLocation }));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  fetchAgents,
  GatewayError: class GatewayError extends Error {
    constructor(
      readonly kind: string,
      message: string
    ) {
      super(message);
    }
  },
}));
vi.mock('./getAgents', () => ({ getAgents }));
vi.mock('./createAgent', () => ({ createAgent }));
vi.mock('./agent-events', () => ({ agentEvents: { _emit: emit } }));
vi.mock('./remote-watcher', () => ({ startRemoteDiscovery }));
// Present only to prove it is never used: an observed agent's directory is
// another account's.
vi.mock('./agent-workspace-fs', () => ({ resolveWorkspaceFsFor }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

const { attachObservedAgents, probeDirAccess } = await import('./observed-agents');
const { accountOwning, parseHomes, repoDirOf } = await import('./observed-agent-paths');
const { GatewayError } = await import('@main/core/switch-servers/gateway-client');

const SERVER = {
  id: 'srv-1',
  name: 'Team server',
  gatewayUrl: 'http://localhost:41000',
  apiUrl: 'http://localhost:41001',
};

function summary(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `agent-${id}`,
    displayName: null,
    description: 'Reviews pull requests',
    connectorType: 'known',
    ownerId: 'admin-id',
    ownerName: 'Admin',
    knownAgentType: 'claude-code',
    knownAgentOptions: { repo_dir: '/home/alice/reviewer' },
    addressingPolicy: null,
    iconUrl: null,
    createdAt: '',
    ...overrides,
  };
}

const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
  'alice:x:1001:1001:Alice:/home/alice:/bin/bash',
  'alicia:x:1003:1003::/home/alice/shared:/bin/bash',
  'bob:x:1002:1002:Bob:/home/bob/:/bin/bash',
].join('\n');

/** Answer the two host commands the attach runs: the access probe, per
 * directory in order, and the account listing. */
function hostAnswers(access: string[]) {
  exec.mockImplementation(async (_cmd: string, args: string[]) => {
    const script = args[1] ?? '';
    if (script.includes('for d in "$@"')) return { stdout: `${access.join('\n')}\n`, stderr: '' };
    if (script.includes('getent passwd')) return { stdout: PASSWD, stderr: '' };
    throw new Error(`unexpected command ${args.join(' ')}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getServer.mockResolvedValue(SERVER);
  getAgents.mockResolvedValue([]);
  ensureObservedLocation.mockImplementation(
    async (params: { dir: string; owner: string | null }) => ({
      id: `loc:${params.dir}`,
      ...params,
    })
  );
  createAgent.mockImplementation(async (params: Record<string, unknown>) => ({ ...params }));
});

describe('whose directory it is', () => {
  it('reads the accounts with a real home out of passwd', () => {
    expect(parseHomes(PASSWD)).toEqual([
      { account: 'root', home: '/root' },
      { account: 'alice', home: '/home/alice' },
      { account: 'alicia', home: '/home/alice/shared' },
      { account: 'bob', home: '/home/bob' },
    ]);
  });

  it('names the account with the longest home holding the directory', () => {
    const homes = parseHomes(PASSWD);

    expect(accountOwning('/home/alice/reviewer', homes)).toBe('alice');
    expect(accountOwning('/home/alice/shared/proj', homes)).toBe('alicia');
    expect(accountOwning('/home/bob', homes)).toBe('bob');
    // A prefix of a name is not a home.
    expect(accountOwning('/home/bobby/proj', homes)).toBeNull();
    expect(accountOwning('/srv/app', homes)).toBeNull();
  });

  it('takes where the agent runs from what the server recorded, or nothing', () => {
    expect(repoDirOf({ knownAgentOptions: { repo_dir: '/home/alice/x' } })).toBe('/home/alice/x');
    expect(repoDirOf({ knownAgentOptions: { repo_dir: '' } })).toBeNull();
    expect(repoDirOf({ knownAgentOptions: null })).toBeNull();
  });
});

describe('probeDirAccess', () => {
  it('asks once for every directory, passing each as an argument', async () => {
    exec.mockResolvedValue({ stdout: 'readable\ndenied\nmissing\n', stderr: '' });

    const access = await probeDirAccess('vm-1', ['/a', "/b c'd", '/e']);

    expect(Object.fromEntries(access)).toEqual({
      '/a': 'readable',
      "/b c'd": 'denied',
      '/e': 'missing',
    });
    expect(exec).toHaveBeenCalledOnce();
    const [, args] = exec.mock.calls[0] as [string, string[]];
    expect(args.slice(-3)).toEqual(['/a', "/b c'd", '/e']);
    expect(args[1]).not.toContain('/b c');
  });

  it('refuses an answer it cannot line up with the directories asked about', async () => {
    exec.mockResolvedValue({ stdout: 'readable\n', stderr: '' });

    await expect(probeDirAccess('vm-1', ['/a', '/b'])).rejects.toThrow(/expected 2 answers/);
  });

  it('refuses a word it does not know rather than guessing', async () => {
    exec.mockResolvedValue({ stdout: 'maybe\n', stderr: '' });

    await expect(probeDirAccess('vm-1', ['/a'])).rejects.toThrow(/unexpected directory access/);
  });

  it('does not reach the host with nothing to ask', async () => {
    expect((await probeDirAccess('vm-1', [])).size).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('attachObservedAgents', () => {
  it('follows an agent from its server identity, at an observed location', async () => {
    fetchAgents.mockResolvedValue([summary('a1')]);
    hostAnswers(['denied']);

    const result = await attachObservedAgents({
      sshHost: 'vm-1',
      serverId: 'srv-1',
      switchAgentIds: ['a1'],
    });

    expect(result.success).toBe(true);
    expect(ensureObservedLocation).toHaveBeenCalledWith({
      sshHost: 'vm-1',
      dir: '/home/alice/reviewer',
      name: 'reviewer',
      owner: 'alice',
    });
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: 'loc:/home/alice/reviewer',
        name: 'agent-a1',
        providerId: 'claude',
        switchAgentId: 'a1',
        // The credentials file names the endpoint, and it is what cannot be read.
        apiEndpoint: 'http://localhost:41001',
        serverId: 'srv-1',
        autoApprove: false,
        ownerName: 'Admin',
      })
    );
    expect(startRemoteDiscovery).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('agent:created', expect.anything(), 'unknown');
    expect(resolveWorkspaceFsFor).not.toHaveBeenCalled();
  });

  it('sends an agent this account can read to the ordinary load instead', async () => {
    fetchAgents.mockResolvedValue([summary('a1')]);
    hostAnswers(['readable']);

    const result = await attachObservedAgents({
      sshHost: 'vm-1',
      serverId: 'srv-1',
      switchAgentIds: ['a1'],
    });

    expect(result.success).toBe(false);
    expect(!result.success && 'message' in result.error && result.error.message).toMatch(
      /loaded and run the ordinary way/
    );
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('refuses an agent that is not on this host at all', async () => {
    fetchAgents.mockResolvedValue([summary('a1')]);
    hostAnswers(['missing']);

    const result = await attachObservedAgents({
      sshHost: 'vm-1',
      serverId: 'srv-1',
      switchAgentIds: ['a1'],
    });

    expect(!result.success && 'message' in result.error && result.error.message).toMatch(
      /not on vm-1/
    );
  });

  it('refuses an agent the server does not have', async () => {
    fetchAgents.mockResolvedValue([]);

    const result = await attachObservedAgents({
      sshHost: 'vm-1',
      serverId: 'srv-1',
      switchAgentIds: ['gone'],
    });

    expect(!result.success && result.error).toMatchObject({
      type: 'switch-agent-not-on-server',
      agentId: 'gone',
    });
  });

  it('refuses an agent whose directory the server does not name', async () => {
    fetchAgents.mockResolvedValue([summary('a1', { knownAgentOptions: null })]);

    const result = await attachObservedAgents({
      sshHost: 'vm-1',
      serverId: 'srv-1',
      switchAgentIds: ['a1'],
    });

    expect(!result.success && 'message' in result.error && result.error.message).toMatch(
      /does not say where agent-a1 runs/
    );
  });

  it('refuses an agent of a type this build cannot show', async () => {
    fetchAgents.mockResolvedValue([summary('a1', { knownAgentType: 'mystery' })]);
    hostAnswers(['denied']);

    const result = await attachObservedAgents({
      sshHost: 'vm-1',
      serverId: 'srv-1',
      switchAgentIds: ['a1'],
    });

    expect(!result.success && 'message' in result.error && result.error.message).toMatch(
      /mystery agent/
    );
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('skips agents this Console already holds', async () => {
    fetchAgents.mockResolvedValue([summary('a1')]);
    getAgents.mockResolvedValue([{ serverId: 'srv-1', switchAgentId: 'a1' }]);

    const result = await attachObservedAgents({
      sshHost: 'vm-1',
      serverId: 'srv-1',
      switchAgentIds: ['a1'],
    });

    expect(!result.success && 'message' in result.error && result.error.message).toMatch(
      /already in this Console/
    );
  });

  it('says it is not signed in, rather than failing obscurely', async () => {
    fetchAgents.mockRejectedValue(new GatewayError('unauthorized', 'Not signed in'));

    const result = await attachObservedAgents({
      sshHost: 'vm-1',
      serverId: 'srv-1',
      switchAgentIds: ['a1'],
    });

    expect(!result.success && result.error).toMatchObject({
      type: 'switch-server-unauthenticated',
      serverName: 'Team server',
    });
  });
});
