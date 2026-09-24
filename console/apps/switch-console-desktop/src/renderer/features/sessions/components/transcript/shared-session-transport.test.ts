import { expect, it, vi } from 'vitest';
import { hostJournalTransport, sharedSessionTransport } from './shared-session-transport';

const upload = vi.hoisted(() => vi.fn());
const ipc = vi.hoisted(() => ({
  journalSnapshot: vi.fn(),
  journalEvents: vi.fn(),
  sharedSnapshot: vi.fn(),
  sharedEvents: vi.fn(),
  sessionSubmit: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { sdkHost: { uploadAttachment: upload, ...ipc } } }));

it('preserves the server attachment digest for provider staging', async () => {
  const attachment = {
    attachmentId: 'attachment',
    name: 'example.txt',
    mimeType: 'text/plain',
    bytes: 4,
    sha256: 'a'.repeat(64),
  };
  upload.mockResolvedValueOnce(attachment);
  expect(
    await sharedSessionTransport('agent', 'server').uploadAttachment!('session', {
      attachmentId: 'attachment',
      name: 'example.txt',
      mimeType: 'text/plain',
      data: 'ZGF0YQ==',
    })
  ).toEqual(attachment);
});

it('rejects a malformed attachment digest before composer delivery', async () => {
  upload.mockResolvedValueOnce({
    attachmentId: 'attachment',
    name: 'example.txt',
    mimeType: 'text/plain',
    bytes: 4,
    sha256: 'invalid',
  });
  await expect(
    sharedSessionTransport('agent', 'server').uploadAttachment!('session', {
      attachmentId: 'attachment',
      name: 'example.txt',
      mimeType: 'text/plain',
      data: 'ZGF0YQ==',
    })
  ).rejects.toThrow();
});

it('reads the host journal and sends commands through the relay', async () => {
  const transport = hostJournalTransport('agent', 'server');
  ipc.journalSnapshot.mockResolvedValueOnce('snapshot');
  expect(await transport.snapshot('session', null)).toBe('snapshot');
  expect(ipc.journalSnapshot).toHaveBeenCalledWith('agent', 'session');

  ipc.journalEvents.mockResolvedValue([]);
  const cursor = vi.fn();
  const stop = transport.subscribe('session', 7, vi.fn(), vi.fn(), cursor);
  await vi.waitFor(() => expect(cursor).toHaveBeenCalledWith(7));
  stop();
  expect(ipc.journalEvents).toHaveBeenCalledWith('agent', 'session', 7);
  expect(ipc.sharedEvents).not.toHaveBeenCalled();

  ipc.sessionSubmit.mockResolvedValueOnce({
    type: 'command.status',
    commandId: 'c',
    status: 'accepted',
    code: null,
    message: null,
  });
  await transport.submit({
    contractVersion: 1,
    commandId: 'c',
    sessionId: 'session',
    epoch: 'epoch',
    body: { type: 'turn.interrupt', turnId: 'turn' },
  } as never);
  expect(ipc.sessionSubmit).toHaveBeenCalledWith(
    'agent',
    expect.objectContaining({ commandId: 'c' })
  );
});
