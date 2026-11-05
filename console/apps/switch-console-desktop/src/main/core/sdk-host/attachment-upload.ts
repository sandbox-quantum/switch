import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ATTACHMENT_MIME_TYPES,
  attachmentChunkSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_BYTES,
  sharedSessionRoot,
  stageAttachment,
} from '@switch-console/agent-providers';
import type { Attachment, AttachmentUpload } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgentById } from '@main/core/agents/getAgentById';
import { log } from '@main/lib/logger';
import { withSidecar } from './sidecar-control';

const uploadSchema = z.strictObject({
  attachmentId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  data: z.string(),
});
const transferResultSchema = z.union([
  z.object({ next: z.number().int().positive() }),
  z.object({ staged: z.object({ transferId: z.string(), ref: z.string().min(1) }) }),
]);
type UploadedAttachment = Attachment & { sha256: string };

async function assertLocalSessionOwner(
  root: string,
  sessionId: string,
  agentId: string
): Promise<void> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('This session is not available on the local host.');
    throw error;
  }
  const session = z
    .object({ session: z.object({ sessionId: z.string(), agentId: z.string() }) })
    .parse(config).session;
  if (session.sessionId !== sessionId || session.agentId !== agentId)
    throw new Error('This session does not belong to this agent.');
}

function decodeUpload(input: AttachmentUpload): {
  file: Buffer;
  attachment: UploadedAttachment;
} {
  const upload = uploadSchema.parse(input);
  if (!ATTACHMENT_MIME_TYPES.includes(upload.mimeType))
    throw new Error('This file type is not supported.');
  if (
    upload.data.length === 0 ||
    upload.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(upload.data)
  )
    throw new Error('Attachment data is invalid or exceeds 10 MiB.');
  const file = Buffer.from(upload.data, 'base64');
  if (
    file.byteLength === 0 ||
    file.byteLength > MAX_ATTACHMENT_BYTES ||
    file.toString('base64') !== upload.data
  )
    throw new Error('Attachment data is invalid or exceeds 10 MiB.');
  const sha256 = createHash('sha256').update(file).digest('hex');
  return {
    file,
    attachment: {
      attachmentId: upload.attachmentId,
      name: upload.name,
      mimeType: upload.mimeType,
      bytes: file.byteLength,
      sha256,
    },
  };
}

async function uploadToRemoteHost(
  agentId: string,
  sessionId: string,
  attachment: UploadedAttachment,
  file: Buffer
): Promise<string> {
  const transferId = attachment.attachmentId;
  const count = Math.ceil(file.byteLength / MAX_CHUNK_BYTES);
  let index = 0;
  try {
    while (index < count) {
      const start = index * MAX_CHUNK_BYTES;
      const chunk = attachmentChunkSchema.parse({
        transferId,
        sessionId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.bytes,
        sha256: attachment.sha256,
        index,
        count,
        chunk: file.subarray(start, start + MAX_CHUNK_BYTES).toString('base64'),
      });
      const result = transferResultSchema.parse(
        await withSidecar(agentId, (client) => client.uploadAttachment(chunk))
      );
      if ('staged' in result) {
        if (result.staged.transferId !== transferId)
          throw new Error('The session host completed a different attachment transfer.');
        return result.staged.ref;
      }
      if (result.next <= index || result.next > count)
        throw new Error('The session host returned an invalid attachment transfer position.');
      index = result.next;
    }
    throw new Error('The session host did not finish staging the attachment.');
  } catch (error) {
    await withSidecar(agentId, (client) => client.cancelAttachment(transferId)).catch(
      (cleanupError: unknown) =>
        log.warn('Could not cancel an incomplete session attachment upload', {
          sessionId,
          error: String(cleanupError),
        })
    );
    throw error;
  }
}

/** Stage a Console upload where this agent's shared session host can consume it. */
export async function uploadSessionAttachment(
  agentId: string,
  sessionId: string,
  input: AttachmentUpload
): Promise<Attachment> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  const { file, attachment } = decodeUpload(input);
  const location = await getAgentLocation(agent);
  if (location.sshHost) {
    attachment.attachmentId = await uploadToRemoteHost(agentId, sessionId, attachment, file);
    return attachment;
  }

  const root = sharedSessionRoot(sessionId);
  await assertLocalSessionOwner(root, sessionId, agent.switchAgentId);
  const { sha256 } = attachment;
  await stageAttachment(root, attachment, async () => ({
    data: file,
    sha256,
  }));
  return attachment;
}
