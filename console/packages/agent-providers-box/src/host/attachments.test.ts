import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { stageAttachment } from './attachments';

it('stages real bytes under the execution root and verifies retries and local changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-stage-test-'));
  try {
    const data = Buffer.from('File from a different machine');
    const file = {
      attachmentId: randomUUID(),
      name: 'report.txt',
      mimeType: 'text/plain',
      bytes: data.length,
    };
    const download = async () => ({
      data,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    const staged = await stageAttachment(root, file, download);
    expect(staged.path.startsWith(root)).toBe(true);
    expect(await readFile(staged.path)).toEqual(data);
    expect(await stageAttachment(root, file, download)).toEqual(staged);
    await expect(stageAttachment(root, { ...file, name: '../escape' }, download)).rejects.toThrow(
      'filename'
    );
    await expect(
      stageAttachment(root, file, async () => ({ data, sha256: 'incorrect' }))
    ).rejects.toThrow('integrity');
    await unlink(staged.path);
    const outside = join(root, 'outside.txt');
    await writeFile(outside, data);
    await symlink(outside, staged.path);
    await expect(stageAttachment(root, file, download)).rejects.toThrow('symbolic link');
    await unlink(staged.path);
    const retry = vi.fn(download).mockRejectedValueOnce(new TypeError('Connection lost'));
    await stageAttachment(root, file, retry);
    expect(retry).toHaveBeenCalledTimes(2);
    await writeFile(staged.path, 'changed');
    await expect(stageAttachment(root, file, download)).rejects.toThrow('modified');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
