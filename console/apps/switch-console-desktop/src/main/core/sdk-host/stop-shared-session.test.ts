import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  tail: vi.fn(),
  submit: vi.fn(),
  status: vi.fn(),
}));

class Unavailable extends Error {}
class NotRecorded extends Error {}
class FakeGatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}
vi.mock('@main/core/switch-servers/gateway-client', () => ({ GatewayError: FakeGatewayError }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./host-journal', () => ({
  JournalUnavailableError: Unavailable,
  hostJournals: { tail: mocks.tail },
}));
vi.mock('./session-commands', () => ({
  CommandNotRecordedError: NotRecorded,
  submitSessionCommand: mocks.submit,
  sessionCommandStatus: mocks.status,
}));

const { stopSharedSession } = await import('./stop-shared-session');

function session(overrides: Record<string, unknown>) {
  return { session: { status: 'ready', connectivity: 'online', epoch: 'epoch-1', ...overrides } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tail.mockResolvedValue({ snapshot: mocks.snapshot });
  mocks.submit.mockResolvedValue({});
});

it('stops a running session through its host and waits for it to say so', async () => {
  mocks.snapshot.mockReturnValue(session({}));
  mocks.status
    .mockRejectedValueOnce(new NotRecorded('not yet'))
    .mockResolvedValue({ commandId: 'stop-epoch-1', status: 'applied' });
  await stopSharedSession('agent', 'session-1');
  expect(mocks.submit).toHaveBeenCalledWith(
    'agent',
    expect.objectContaining({ commandId: 'stop-epoch-1', body: { type: 'session.stop' } })
  );
});

it('sends nothing to a host that is not running', async () => {
  mocks.snapshot.mockReturnValue(session({ connectivity: 'offline' }));
  await stopSharedSession('agent', 'session-1');
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('sends nothing for a session whose host is not reachable from here', async () => {
  mocks.tail.mockRejectedValue(new Unavailable('not on this host'));
  await stopSharedSession('agent', 'session-1');
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('fails when Switch cannot relay the stop', async () => {
  mocks.snapshot.mockReturnValue(session({}));
  mocks.submit.mockRejectedValue(new FakeGatewayError('HOST_OFFLINE', 409));
  await expect(stopSharedSession('agent', 'session-1')).rejects.toThrow('HOST_OFFLINE');
});

it('fails when the host refuses the stop', async () => {
  mocks.snapshot.mockReturnValue(session({}));
  mocks.status.mockResolvedValue({ status: 'rejected', message: 'Busy resetting' });
  await expect(stopSharedSession('agent', 'session-1')).rejects.toThrow('Busy resetting');
});
