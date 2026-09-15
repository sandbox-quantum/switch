import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { protectGeminiRollout } from './resume';

it('preserves the original rollout when same-minute load initializes a second recorder', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gemini-resume-test-'));
  const id = '12345678-0000-4000-8000-000000000001';
  try {
    const chats = join(home, '.gemini', 'tmp', 'project', 'chats');
    await mkdir(chats, { recursive: true });
    const path = join(chats, 'session-2026-01-01T12-00-12345678.jsonl');
    const original =
      JSON.stringify({ sessionId: id }) +
      '\n' +
      JSON.stringify({ type: 'user', content: 'Remember the word pelican' }) +
      '\n';
    await writeFile(path, original);
    await protectGeminiRollout(home, id);
    const preserved = path.replace('.jsonl', '-switch-resume.jsonl');
    expect(await readFile(preserved, 'utf8')).toBe(original);
    await writeFile(path, JSON.stringify({ sessionId: id }) + '\n');
    await protectGeminiRollout(home, id);
    expect(await readFile(preserved, 'utf8')).toBe(original);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
