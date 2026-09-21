import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  submit: vi.fn(),
  status: vi.fn(),
  retire: vi.fn(),
}));

vi.mock('@switch-console/shared/session-v1', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  snapshotSchema: { parse: (value: unknown) => value },
  commandStatusSchema: { parse: (value: unknown) => value },
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  fetchSdkSnapshot: mocks.snapshot,
  submitSdkCommand: mocks.submit,
  fetchSdkCommandStatus: mocks.status,
  retireSdkSession: mocks.retire,
}));

const { stopSharedSession } = await import('./stop-shared-session');
const server = { id: 'server' } as never;

function session(overrides: Record<string, unknown>) {
  return {
    session: {
      status: 'ready',
      retired: false,
      connectivity: 'online',
      epoch: 'epoch-1',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.retire.mockResolvedValue({});
  mocks.submit.mockResolvedValue({});
});

it('stops a connected session through its host', async () => {
  mocks.snapshot.mockResolvedValue(session({}));
  mocks.status.mockResolvedValue({ commandId: 'stop-epoch-1', status: 'applied' });
  await stopSharedSession(server, 'session-1');
  expect(mocks.submit).toHaveBeenCalledWith(
    server,
    expect.objectContaining({ body: { type: 'session.stop' } })
  );
  expect(mocks.retire).not.toHaveBeenCalled();
});

// The reported bug: a session discovered from the server and never opened has
// no host, so a stop command could never be applied and delete failed forever.
it('retires a session whose host is not connected instead of awaiting a host', async () => {
  mocks.snapshot.mockResolvedValue(session({ connectivity: 'offline' }));
  await stopSharedSession(server, 'session-1');
  expect(mocks.retire).toHaveBeenCalledWith(server, 'session-1', 'epoch-1');
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.status).not.toHaveBeenCalled();
});

it('reports the server refusing to retire while a host still holds the session', async () => {
  mocks.snapshot.mockResolvedValue(session({ connectivity: 'offline' }));
  mocks.retire.mockRejectedValue(new Error('Stop the active host before retiring this session.'));
  await expect(stopSharedSession(server, 'session-1')).rejects.toThrow('Stop the active host');
});

it.each([{ status: 'stopped' }, { retired: true }])(
  'leaves a finished session alone (%o)',
  async (overrides) => {
    mocks.snapshot.mockResolvedValue(session({ connectivity: 'offline', ...overrides }));
    await stopSharedSession(server, 'session-1');
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  }
);

it('still refuses to report a connected session stopped without a receipt', async () => {
  mocks.snapshot.mockResolvedValue(session({}));
  mocks.status.mockResolvedValue({ commandId: 'stop-epoch-1', status: 'rejected' });
  await expect(stopSharedSession(server, 'session-1')).rejects.toThrow();
});
