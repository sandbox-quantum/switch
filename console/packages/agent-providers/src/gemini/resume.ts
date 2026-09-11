import { open, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Gemini 0.58 initializes its recorder before loading a session. Within the
 * same minute that appends an empty-history reset to the saved rollout. A
 * stable alternate filename lets ACP load the original record untouched;
 * subsequent turns continue in that file through Gemini's own resume logic.
 * Only the Console-owned GEMINI_CLI_HOME is eligible for this compatibility fix.
 */
export async function protectGeminiRollout(home: string, nativeId: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/i.test(nativeId)) return;
  const root = join(home, '.gemini', 'tmp');
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const project of projects) {
    const chats = join(root, project, 'chats');
    let files: string[];
    try {
      files = await readdir(chats);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    for (const file of files) {
      if (!file.startsWith('session-') || !file.endsWith(`-${nativeId.slice(0, 8)}.jsonl`))
        continue;
      const destination = join(chats, file.replace(/\.jsonl$/, '-switch-resume.jsonl'));
      try {
        await stat(destination);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const path = join(chats, file);
      const handle = await open(path, 'r');
      let header: string;
      try {
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        header = buffer.toString('utf8', 0, bytesRead).split('\n')[0] ?? '';
      } finally {
        await handle.close();
      }
      if (JSON.parse(header).sessionId !== nativeId) continue;
      await rename(path, destination);
    }
  }
}
