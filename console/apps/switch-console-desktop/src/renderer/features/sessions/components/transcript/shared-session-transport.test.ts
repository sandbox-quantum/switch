import { expect, it, vi } from 'vitest';
import { sharedSessionTransport } from './shared-session-transport';

const upload = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', () => ({ rpc: { sdkHost: { uploadAttachment: upload } } }));

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
    await sharedSessionTransport('server').uploadAttachment!('session', {
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
    sharedSessionTransport('server').uploadAttachment!('session', {
      attachmentId: 'attachment',
      name: 'example.txt',
      mimeType: 'text/plain',
      data: 'ZGF0YQ==',
    })
  ).rejects.toThrow();
});
