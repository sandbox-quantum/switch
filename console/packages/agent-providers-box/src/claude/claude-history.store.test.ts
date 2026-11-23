import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude-adapter';
import { configDirSessionStore } from './cli-conversations';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ID = '11111111-2222-4333-8444-555555555555';
const U1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const A1 = 'aaaaaaaa-0000-4000-8000-000000000002';
const M1 = 'aaaaaaaa-0000-4000-8000-000000000003';
const U2 = 'aaaaaaaa-0000-4000-8000-000000000004';
const A2 = 'aaaaaaaa-0000-4000-8000-000000000005';

function line(
  type: string,
  uuid: string,
  parentUuid: string | null,
  content: unknown,
  extra: object = {}
): string {
  const role = type === 'user' ? 'user' : 'assistant';
  return JSON.stringify({
    type,
    uuid,
    parentUuid,
    sessionId: ID,
    isSidechain: false,
    timestamp: '2026-10-28T12:00:00.000Z',
    message: { role, content },
    ...extra,
  });
}

async function savedConversation(
  lines: string[] = [
    line('user', U1, null, 'Fix the build'),
    line('assistant', A1, U1, [{ type: 'text', text: 'Done.' }]),
    '{"type":"assistant","uuid":"cut sho',
  ]
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-config-'));
  roots.push(dir);
  await mkdir(join(dir, 'projects', '-work'), { recursive: true });
  await writeFile(join(dir, 'projects', '-work', `${ID}.jsonl`), lines.join('\n'));
  return dir;
}

it('finds a saved conversation by its id in any project, leaving out a line cut short', async () => {
  const dir = await savedConversation();
  const store = configDirSessionStore(dir);
  const entries = await store.load({ projectKey: 'anything', sessionId: ID });
  expect(entries?.map((e) => e.uuid)).toEqual([U1, A1]);
  expect(await store.load({ projectKey: 'anything', sessionId: 'missing' })).toBeNull();
  expect(
    await configDirSessionStore(join(dir, 'none')).load({ projectKey: 'x', sessionId: ID })
  ).toBeNull();
});

it('reads a conversation from the session’s config directory without touching this process’s environment', async () => {
  const dir = await savedConversation();
  const before = process.env.CLAUDE_CONFIG_DIR;
  const turns = await new ClaudeAdapter().conversationHistory(ID, '/work', {
    CLAUDE_CONFIG_DIR: dir,
  });
  expect(turns.map((turn) => turn.items.map((item) => item.text))).toEqual([
    ['Fix the build', 'Done.'],
  ]);
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
});

it('refuses a conversation with a line that is not JSON before its last', async () => {
  const dir = await savedConversation([
    line('user', U1, null, 'Fix the build'),
    '{"type":"assistant","uuid":"cut sho',
    line('assistant', A1, U1, [{ type: 'text', text: 'Done.' }]),
    '',
  ]);
  await expect(
    configDirSessionStore(dir).load({ projectKey: 'anything', sessionId: ID })
  ).rejects.toThrow(/Line 2 of Claude Code's saved conversation .* is not JSON/);
});

it('leaves out what Claude Code adds as a hidden user entry, keeping the turns around it whole', async () => {
  // Loading a skill records its instructions as a user entry marked `isMeta`,
  // in the chain between the prompt and the reply.
  const dir = await savedConversation([
    line('user', U1, null, 'Use the release skill'),
    line(
      'user',
      M1,
      U1,
      [{ type: 'text', text: 'Base directory for this skill: /work/.claude/skills/release' }],
      { isMeta: true }
    ),
    line('assistant', A1, M1, [{ type: 'text', text: 'Releasing.' }]),
    line('user', U2, A1, 'Thanks'),
    line('assistant', A2, U2, [{ type: 'text', text: 'Any time.' }]),
  ]);
  const turns = await new ClaudeAdapter().conversationHistory(ID, '/work', {
    CLAUDE_CONFIG_DIR: dir,
  });
  expect(turns.map((turn) => turn.items.map((item) => item.text))).toEqual([
    ['Use the release skill', 'Releasing.'],
    ['Thanks', 'Any time.'],
  ]);
});
