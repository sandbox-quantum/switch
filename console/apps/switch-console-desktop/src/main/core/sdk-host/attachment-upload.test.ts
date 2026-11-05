import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agent: { switchAgentId: 'switch-agent' },
  location: { sshHost: null as string | null },
  readFile: vi.fn(),
  stageAttachment: vi.fn(),
  withSidecar: vi.fn(),
  uploadChunk: vi.fn(),
  cancelAttachment: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('@switch-console/agent-providers', () => ({
  ATTACHMENT_MIME_TYPES: ['text/plain'],
  attachmentChunkSchema: { parse: (value: unknown) => value },
  MAX_ATTACHMENT_BYTES: 20,
  MAX_CHUNK_BYTES: 4,
  sharedSessionRoot: () => '/session/root',
  stageAttachment: mocks.stageAttachment,
}));
vi.mock('@main/core/agents/agent-location', () => ({
  getAgentLocation: async () => mocks.location,
}));
vi.mock('@main/core/agents/getAgentById', () => ({
  getAgentById: async () => mocks.agent,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./sidecar-control', () => ({
  withSidecar: async (_agentId: string, call: (client: unknown) => unknown) =>
    call({
      uploadAttachment: mocks.uploadChunk,
      cancelAttachment: mocks.cancelAttachment,
    }),
}));

const { uploadSessionAttachment } = await import('./attachment-upload');

const upload = {
  attachmentId: 'attachment-1',
  name: 'file.txt',
  mimeType: 'text/plain',
  data: Buffer.from('abcdefghij').toString('base64'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.location.sshHost = null;
  mocks.readFile.mockResolvedValue(
    JSON.stringify({ session: { sessionId: 'session', agentId: 'switch-agent' } })
  );
  mocks.uploadChunk.mockImplementation(async (chunk: { index: number }) =>
    chunk.index === 2
      ? { staged: { transferId: 'attachment-1', ref: 'host-ref' } }
      : { next: chunk.index + 1 }
  );
});

it('stages local uploads in the owning session before it is sent', async () => {
  mocks.stageAttachment.mockResolvedValue({ path: '/session/root/attachments/file.txt' });
  const attachment = await uploadSessionAttachment('agent', 'session', upload);

  expect(attachment).toMatchObject({
    attachmentId: 'attachment-1',
    name: 'file.txt',
    mimeType: 'text/plain',
    bytes: 10,
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(mocks.stageAttachment).toHaveBeenCalledWith(
    '/session/root',
    attachment,
    expect.any(Function)
  );
  const download = mocks.stageAttachment.mock.calls[0]![2] as () => Promise<{
    data: Buffer;
    sha256: string;
  }>;
  await expect(download()).resolves.toMatchObject({ data: Buffer.from('abcdefghij') });
});

it('uploads remote files in ordered chunks and returns the host-staged reference', async () => {
  mocks.location.sshHost = 'agent-host';
  const attachment = await uploadSessionAttachment('agent', 'session', upload);

  expect(mocks.uploadChunk).toHaveBeenCalledTimes(3);
  expect(mocks.uploadChunk.mock.calls.map(([chunk]) => chunk.index)).toEqual([0, 1, 2]);
  expect(mocks.uploadChunk.mock.calls.map(([chunk]) => chunk.chunk)).toEqual([
    Buffer.from('abcd').toString('base64'),
    Buffer.from('efgh').toString('base64'),
    Buffer.from('ij').toString('base64'),
  ]);
  expect(attachment.attachmentId).toBe('host-ref');
});

it('refuses unsupported types, malformed data, and uploads over the size limit', async () => {
  await expect(
    uploadSessionAttachment('agent', 'session', { ...upload, mimeType: 'application/x-exe' })
  ).rejects.toThrow('This file type is not supported.');
  await expect(
    uploadSessionAttachment('agent', 'session', { ...upload, data: 'not base64' })
  ).rejects.toThrow('Attachment data is invalid');
  await expect(
    uploadSessionAttachment('agent', 'session', {
      ...upload,
      data: Buffer.from('more than twenty bytes').toString('base64'),
    })
  ).rejects.toThrow('10 MiB');
});
