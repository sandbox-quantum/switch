import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type CliConversationDeps,
  deleteClaudeCliConversationCopies,
  forkClaudeCliConversation,
  listClaudeCliConversations,
  type ProcessInfo,
  withClaudeConfigDir,
} from './cli-conversations';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const STARTED = 'Mon Oct 26 18:02:59 2026';
const STARTED_AT = Date.parse(`${STARTED} UTC`);
const CLAUDE: ProcessInfo = { startedAt: STARTED_AT, command: '/usr/local/bin/claude --resume' };

const SESSIONS: SDKSessionInfo[] = [
  { sessionId: 'older', summary: 'Tidy the README', lastModified: 1_000, gitBranch: 'main' },
  { sessionId: 'newer', summary: 'Build fix', customTitle: 'Build fix', lastModified: 2_000 },
];

/** A Claude Code config directory, with each of `records` written as `sessions/<name>`. */
async function configDir(records: Record<string, string | object> | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-config-'));
  roots.push(dir);
  if (records) {
    await mkdir(join(dir, 'sessions'));
    for (const [name, record] of Object.entries(records))
      await writeFile(
        join(dir, 'sessions', name),
        typeof record === 'string' ? record : JSON.stringify(record)
      );
  }
  return dir;
}

function holding(sessionId: string, extra: object = {}) {
  return { sessionId, procStart: STARTED, entrypoint: 'cli', status: 'idle', ...extra };
}

/** A copy of `nativeSessionId` asked for by the Console session `session-1`. */
function fork(nativeSessionId: string, confirmedClosed: boolean) {
  return { dir: '/work', nativeSessionId, consoleSessionId: 'session-1', confirmedClosed };
}

function deps(
  described: Record<number, ProcessInfo> | null = {},
  overrides: Partial<CliConversationDeps> = {}
): CliConversationDeps {
  return {
    listSessions: vi.fn(async () => structuredClone(SESSIONS)),
    getSessionInfo: vi.fn(async (id: string) =>
      structuredClone(SESSIONS.find((session) => session.sessionId === id))
    ),
    forkSession: vi.fn(async () => ({ sessionId: 'copy' })),
    tagSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    processExists: () => true,
    processes: vi.fn(async () =>
      described === null ? null : new Map(Object.entries(described).map(([k, v]) => [Number(k), v]))
    ),
    ...overrides,
  };
}

it('lists the conversations started from Claude Code’s own clients, newest first, with what holds each', async () => {
  const dir = await configDir({ '41.json': holding('newer'), '41.abc.key': 'not a record' });
  const run = deps({ 41: CLAUDE });
  const list = await listClaudeCliConversations('/work', { CLAUDE_CONFIG_DIR: dir }, run);

  expect(run.listSessions).toHaveBeenCalledWith({
    dir: '/work',
    includeProgrammatic: false,
    includeWorktrees: false,
  });
  expect(list).toEqual({
    ownershipKnown: true,
    conversations: [
      {
        nativeSessionId: 'newer',
        title: 'Build fix',
        lastActivityAt: 2_000,
        gitBranch: null,
        openIn: { pid: 41, entrypoint: 'cli' },
      },
      {
        nativeSessionId: 'older',
        title: 'Tidy the README',
        lastActivityAt: 1_000,
        gitBranch: 'main',
        openIn: null,
      },
    ],
  });
});

it('reads conversations from the config directory the session’s environment names', async () => {
  const dir = await configDir({});
  const seen: (string | undefined)[] = [];
  const before = process.env.CLAUDE_CONFIG_DIR;
  await listClaudeCliConversations(
    '/work',
    { CLAUDE_CONFIG_DIR: dir },
    deps(
      {},
      {
        listSessions: vi.fn(async () => {
          seen.push(process.env.CLAUDE_CONFIG_DIR);
          return [];
        }),
      }
    )
  );
  expect(seen).toEqual([dir]);
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
});

it('keeps a live Claude Code process holding its conversation when the clock has moved its start', async () => {
  const dir = await configDir({ '41.json': holding('newer') });
  const list = await listClaudeCliConversations(
    '/work',
    { CLAUDE_CONFIG_DIR: dir },
    deps({ 41: { ...CLAUDE, startedAt: STARTED_AT + 3_600_000 } })
  );
  expect(list.conversations[0]!.openIn?.pid).toBe(41);
});

it('does not count a record whose process has gone, or whose process id now names something else', async () => {
  const dir = await configDir({ '41.json': holding('newer'), '42.json': holding('older') });
  const run = deps(
    { 42: { startedAt: STARTED_AT + 86_400_000, command: '/bin/zsh -c cat ~/.claude/notes' } },
    { processExists: (pid) => pid === 42 }
  );
  const list = await listClaudeCliConversations('/work', { CLAUDE_CONFIG_DIR: dir }, run);
  expect(list.conversations.map((c) => c.openIn)).toEqual([null, null]);
  expect(list.ownershipKnown).toBe(true);
});

it('asks `ps` about every live process at once, and takes one it cannot describe to hold its conversation', async () => {
  const dir = await configDir({ '41.json': holding('newer'), '42.json': holding('older') });
  const run = deps(null);
  const list = await listClaudeCliConversations('/work', { CLAUDE_CONFIG_DIR: dir }, run);
  expect(run.processes).toHaveBeenCalledOnce();
  expect([...vi.mocked(run.processes).mock.calls[0]![0]].sort((a, b) => a - b)).toEqual([41, 42]);
  expect(list.conversations.map((c) => c.openIn?.pid)).toEqual([41, 42]);
});

it('says ownership is unknown when a live Claude Code process’s record cannot be read', async () => {
  const dir = await configDir({ '41.json': '{"sessionId": "new', '42.json': holding('older') });
  const list = await listClaudeCliConversations(
    '/work',
    { CLAUDE_CONFIG_DIR: dir },
    deps({ 41: CLAUDE, 42: CLAUDE })
  );
  expect(list.ownershipKnown).toBe(false);
  expect(list.conversations.map((c) => c.openIn?.pid ?? null)).toEqual([null, 42]);
});

it('reads a record in a shape it does not fully know, as long as it names the conversation', async () => {
  const dir = await configDir({
    '41.json': { sessionId: 'newer', procStart: 7, entrypoint: null },
  });
  const list = await listClaudeCliConversations(
    '/work',
    { CLAUDE_CONFIG_DIR: dir },
    deps({ 41: CLAUDE })
  );
  expect(list.ownershipKnown).toBe(true);
  expect(list.conversations[0]!.openIn).toEqual({ pid: 41, entrypoint: null });
});

it('says when this Claude Code keeps no record of what its processes hold', async () => {
  const dir = await configDir(null);
  const list = await listClaudeCliConversations('/work', { CLAUDE_CONFIG_DIR: dir }, deps());
  expect(list.ownershipKnown).toBe(false);
  expect(list.conversations.every((c) => c.openIn === null)).toBe(true);
});

it('copies a closed conversation under a new id, titled so Claude Code’s own list shows it is taken and tagged with its session', async () => {
  const dir = await configDir({});
  const seen: (string | undefined)[] = [];
  const run = deps(
    {},
    {
      forkSession: vi.fn(async () => {
        seen.push(process.env.CLAUDE_CONFIG_DIR);
        return { sessionId: 'copy' };
      }),
    }
  );
  await expect(
    forkClaudeCliConversation(fork('newer', false), { CLAUDE_CONFIG_DIR: dir }, run)
  ).resolves.toEqual({ nativeSessionId: 'copy' });
  // The one conversation is read, not the folder's whole list.
  expect(run.getSessionInfo).toHaveBeenCalledWith('newer', { dir: '/work' });
  expect(run.listSessions).not.toHaveBeenCalled();
  expect(run.forkSession).toHaveBeenCalledWith('newer', {
    dir: '/work',
    title: 'Build fix (continued in Switch Console)',
  });
  expect(run.tagSession).toHaveBeenCalledWith('copy', 'switch-console:session-1', {
    dir: '/work',
  });
  expect(vi.mocked(run.forkSession).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(run.tagSession).mock.invocationCallOrder[0]!
  );
  expect(run.deleteSession).not.toHaveBeenCalled();
  expect(seen).toEqual([dir]);
});

it('removes a copy it could not tag, since nothing could find it to remove later', async () => {
  const dir = await configDir({});
  const run = deps({}, { tagSession: vi.fn(async () => Promise.reject(new Error('disk full'))) });
  await expect(
    forkClaudeCliConversation(fork('newer', true), { CLAUDE_CONFIG_DIR: dir }, run)
  ).rejects.toThrow(
    "Could not mark the copy of this conversation as Switch Console's, so it was removed"
  );
  expect(run.deleteSession).toHaveBeenCalledWith('copy', { dir: '/work' });
});

it('says so when a copy it could not tag could not be removed either', async () => {
  const dir = await configDir({});
  const run = deps(
    {},
    {
      tagSession: vi.fn(async () => Promise.reject(new Error('disk full'))),
      deleteSession: vi.fn(async () => Promise.reject(new Error('permission denied'))),
    }
  );
  await expect(
    forkClaudeCliConversation(fork('newer', true), { CLAUDE_CONFIG_DIR: dir }, run)
  ).rejects.toThrow(/copy copy .*disk full.*nor remove it.*permission denied/);
});

it.each([
  { label: 'tagged', info: { tag: 'switch-console:session-0', summary: 'Build fix' } },
  { label: 'titled', info: { summary: 'Build fix (continued in Switch Console)' } },
])('refuses to copy a copy Switch made ($label)', async ({ info }) => {
  const dir = await configDir({});
  const run = deps(
    {},
    {
      getSessionInfo: vi.fn(async () => ({ sessionId: 'newer', lastModified: 2_000, ...info })),
    }
  );
  await expect(
    forkClaudeCliConversation(fork('newer', true), { CLAUDE_CONFIG_DIR: dir }, run)
  ).rejects.toThrow('This conversation is a copy Switch Console made');
  expect(run.forkSession).not.toHaveBeenCalled();
});

it('refuses to copy a conversation that is open in Claude Code', async () => {
  const dir = await configDir({ '41.json': holding('newer') });
  const run = deps({ 41: CLAUDE });
  await expect(
    forkClaudeCliConversation(fork('newer', false), { CLAUDE_CONFIG_DIR: dir }, run)
  ).rejects.toThrow('This conversation is open in Claude Code (process 41)');
  expect(run.forkSession).not.toHaveBeenCalled();
});

it('refuses a conversation that is not one of the folder’s own', async () => {
  const dir = await configDir({});
  const run = deps();
  await expect(
    forkClaudeCliConversation(fork('elsewhere', false), { CLAUDE_CONFIG_DIR: dir }, run)
  ).rejects.toThrow('Claude Code has no conversation elsewhere in /work to continue.');
  expect(run.forkSession).not.toHaveBeenCalled();
});

it('leaves out the copies Switch made, a renamed one and one no session owns included', async () => {
  const dir = await configDir({});
  const list = await listClaudeCliConversations(
    '/work',
    { CLAUDE_CONFIG_DIR: dir },
    deps(
      {},
      {
        listSessions: vi.fn(async () => [
          ...structuredClone(SESSIONS),
          {
            sessionId: 'copy',
            summary: 'Build fix (continued in Switch Console)',
            lastModified: 3_000,
          },
          {
            sessionId: 'renamed-copy',
            summary: 'Renamed in the terminal',
            customTitle: 'Renamed in the terminal',
            tag: 'switch-console:session-1',
            lastModified: 4_000,
          },
          {
            sessionId: 'tagged-by-someone',
            summary: 'Tagged by the person',
            tag: 'mine',
            lastModified: 5_000,
          },
        ]),
      }
    )
  );
  expect(list.conversations.map((c) => c.nativeSessionId)).toEqual([
    'tagged-by-someone',
    'newer',
    'older',
  ]);
});

it('cuts a long title by character, never between the halves of one', async () => {
  const dir = await configDir({});
  const summary = `${'a'.repeat(199)}😀 and more`;
  const run = deps(
    {},
    {
      getSessionInfo: vi.fn(async () => ({ sessionId: 'newer', summary, lastModified: 2_000 })),
    }
  );
  await forkClaudeCliConversation(fork('newer', true), { CLAUDE_CONFIG_DIR: dir }, run);
  expect(run.forkSession).toHaveBeenCalledWith('newer', {
    dir: '/work',
    title: `${'a'.repeat(199)}😀 (continued in Switch Console)`,
  });
});

it('removes only the copies tagged as the given sessions’, wherever they came from', async () => {
  const dir = await configDir({});
  const seen: (string | undefined)[] = [];
  const run = deps(
    {},
    {
      listSessions: vi.fn(async () => {
        seen.push(process.env.CLAUDE_CONFIG_DIR);
        return [
          ...structuredClone(SESSIONS),
          {
            sessionId: 'mine',
            summary: 'Build fix',
            tag: 'switch-console:session-1',
            lastModified: 3,
          },
          {
            sessionId: 'another-session',
            summary: 'Build fix',
            tag: 'switch-console:session-10',
            lastModified: 4,
          },
          {
            sessionId: 'theirs',
            summary: 'Tidy the README',
            tag: 'switch-console:session-2',
            lastModified: 6,
          },
          {
            sessionId: 'untagged-copy',
            summary: 'Build fix (continued in Switch Console)',
            lastModified: 5,
          },
        ];
      }),
    }
  );
  await expect(
    deleteClaudeCliConversationCopies(
      '/work',
      ['session-1', 'session-2', 'session-3'],
      { CLAUDE_CONFIG_DIR: dir },
      run
    )
  ).resolves.toEqual({ deleted: { 'session-1': 1, 'session-2': 1, 'session-3': 0 } });
  // A copy is a programmatic conversation once its session has run in it.
  expect(run.listSessions).toHaveBeenCalledOnce();
  expect(run.listSessions).toHaveBeenCalledWith({
    dir: '/work',
    includeProgrammatic: true,
    includeWorktrees: false,
  });
  expect(vi.mocked(run.deleteSession).mock.calls).toEqual([
    ['mine', { dir: '/work' }],
    ['theirs', { dir: '/work' }],
  ]);
  expect(seen).toEqual([dir]);
});

it('copies only on the person’s word where Claude Code keeps no record of what is open', async () => {
  const dir = await configDir(null);
  const run = deps();
  await expect(
    forkClaudeCliConversation(fork('newer', false), { CLAUDE_CONFIG_DIR: dir }, run)
  ).rejects.toThrow('confirm it is closed');
  expect(run.forkSession).not.toHaveBeenCalled();
  await expect(
    forkClaudeCliConversation(fork('newer', true), { CLAUDE_CONFIG_DIR: dir }, run)
  ).resolves.toEqual({ nativeSessionId: 'copy' });
});

it('asks to try again, not to confirm, when a live Claude Code process’s record cannot be read just now', async () => {
  const dir = await configDir({ '41.json': '{"sessionId": "new' });
  const run = deps({ 41: CLAUDE });
  const refused = forkClaudeCliConversation(fork('newer', false), { CLAUDE_CONFIG_DIR: dir }, run);
  await expect(refused).rejects.toThrow(
    'Console could not read which conversations Claude Code has open right now. Try again in a moment.'
  );
  expect(run.forkSession).not.toHaveBeenCalled();
});

it('takes turns with the process-wide config directory, so overlapping reads each see their own', async () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: (string | undefined)[] = [];
  const first = withClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/a' }, async () => {
    await held;
    seen.push(process.env.CLAUDE_CONFIG_DIR);
  });
  const second = withClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/b' }, async () => {
    seen.push(process.env.CLAUDE_CONFIG_DIR);
  });
  release();
  await Promise.all([first, second]);
  expect(seen).toEqual(['/a', '/b']);
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
});
