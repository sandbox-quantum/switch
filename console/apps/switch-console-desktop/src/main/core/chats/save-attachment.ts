import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import { getMainWindow } from '@main/app/window';
import { markDownloaded } from '@main/core/fs/download-quarantine';
import { attachmentFilename } from '@shared/core/chats/attachment-filename';

/**
 * Save a room attachment where the person picks, under the name the chat shows
 * for it, and mark it as downloaded so the OS checks it before it first runs.
 * The bytes go straight to disk: whatever the file is (a page, a script, an
 * app), Console never renders or opens it.
 *
 * The dialog comes first, so cancelling costs no download. Returns the saved
 * path, or null when the person cancels.
 */
export async function saveChatAttachment(
  filename: string,
  readBytes: () => Promise<Uint8Array>
): Promise<string | null> {
  const win = getMainWindow();
  if (!win) throw new Error('Switch Console has no window to ask where to save the file.');
  const result = await dialog.showSaveDialog(win, {
    title: 'Save attachment',
    defaultPath: join(app.getPath('downloads'), attachmentFilename(filename)),
  });
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, await readBytes());
  await markDownloaded(result.filePath);
  return result.filePath;
}
