import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, realpath, unlink, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Attachment } from '@switch-console/shared/session-v1';
import type { TurnAttachment } from '../adapter';

export const ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/octet-stream',
];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export async function stageAttachment(
  root: string,
  attachment: Attachment,
  download: () => Promise<{ data: Uint8Array; sha256: string }>
): Promise<TurnAttachment> {
  if (
    !attachment.name ||
    basename(attachment.name) !== attachment.name ||
    /[\\\x00-\x1f]/.test(attachment.name) ||
    attachment.name === '.' ||
    attachment.name === '..'
  )
    throw new Error('Invalid attachment filename.');
  if (
    !ATTACHMENT_MIME_TYPES.includes(attachment.mimeType) ||
    attachment.bytes < 1 ||
    attachment.bytes > MAX_ATTACHMENT_BYTES
  )
    throw new Error('Unsupported attachment type or size.');
  let downloaded: Awaited<ReturnType<typeof download>> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      downloaded = await download();
      break;
    } catch (error) {
      if (
        attempt === 2 ||
        !(error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError'))
      )
        throw error;
      await delay(250 * (attempt + 1));
    }
  }
  if (!downloaded) throw new Error('Attachment download did not complete.');
  const { data, sha256 } = downloaded;
  if (
    data.byteLength !== attachment.bytes ||
    createHash('sha256').update(data).digest('hex') !== sha256
  )
    throw new Error('Attachment download failed its integrity check.');
  const directory = join(
    root,
    'attachments',
    createHash('sha256').update(attachment.attachmentId).digest('hex')
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (
    (await realpath(directory)) !==
    join(
      await realpath(root),
      'attachments',
      createHash('sha256').update(attachment.attachmentId).digest('hex')
    )
  )
    throw new Error('Attachment directory must not contain symbolic links.');
  const path = join(directory, attachment.name);
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Attachment file must not be a symbolic link.');
    if (
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== sha256
    )
      throw new Error('The staged attachment was modified.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const temporary = join(directory, randomUUID());
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary);
      throw error;
    }
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  return { path, mimeType: attachment.mimeType };
}
