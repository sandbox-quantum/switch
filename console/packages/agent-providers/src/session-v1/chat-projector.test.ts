import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@switch-console/shared/session-v1';
import { describe, expect, it } from 'vitest';
import type { ProviderRuntimeEvent } from '../events';
import { Redactions } from '../host/redaction';
import { ChatProjector } from './chat-projector';
import { EventOutbox } from './event-outbox';

const session = (provider: Session['provider']): Session => ({
  sessionId: 'session',
  epoch: 'epoch',
  agentId: 'agent',
  hostId: 'host',
  provider,
  status: 'ready',
  connectivity: 'online',
  capabilities: {
    input: 'queue',
    approvals: false,
    questions: false,
    interrupt: true,
    reset: false,
    compact: false,
    modelChange: false,
    attachmentMimeTypes: [],
  },
  pendingRequestIds: [],
});
const context = {
  commandId: 'command',
  origin: {
    surface: 'mattermost' as const,
    actorId: 'actor',
    roomId: 'room',
    threadId: 'thread',
    messageId: 'message',
  },
};

describe('chat projection', () => {
  it.each(['claude', 'codex', 'opencode', 'antigravity', 'cursor'] as const)(
    'projects %s text with bounded full replacements and immediate final state',
    (provider) => {
      const projector = new ChatProjector(session(provider), null);
      projector.bindTurn('turn', context);
      const base = {
        provider,
        sessionId: 'session',
        eventId: 'native-event',
        createdAt: '2026-09-07T12:00:00Z',
        turnId: 'turn',
      };
      const first = projector.ingest(
        {
          ...base,
          type: 'item.started',
          item: {
            id: 'answer',
            type: 'assistant_message',
            status: 'in_progress',
            title: '',
            text: '',
          },
        },
        0
      );
      expect(first).toHaveLength(1);
      expect(
        projector.ingest({ ...base, type: 'content.delta', itemId: 'answer', delta: 'Hello' }, 10)
      ).toEqual([]);
      const update = projector.ingest(
        { ...base, type: 'content.delta', itemId: 'answer', delta: ' world' },
        250
      )[0];
      expect(update).toMatchObject({
        type: 'item.upsert',
        item: {
          text: 'Hello world',
          revision: 2,
          origin: null,
        },
      });
      expect(
        projector.ingest(
          {
            ...base,
            type: 'item.completed',
            item: {
              id: 'answer',
              type: 'assistant_message',
              status: 'completed',
              title: '',
              text: 'Hello world!',
            },
          },
          260
        )[0]
      ).toMatchObject({ item: { revision: 3, status: 'completed', text: 'Hello world!' } });
    }
  );
  it('excludes reasoning and tool payload/output while preserving verified user origin', () => {
    const projector = new ChatProjector(session('claude'), null);
    projector.bindTurn('turn', context);
    const base = {
      provider: 'claude',
      sessionId: 'session',
      eventId: 'native-event',
      createdAt: '2026-09-07T12:00:00Z',
      turnId: 'turn',
    };
    expect(
      projector.ingest(
        {
          ...base,
          type: 'item.started',
          item: {
            id: 'thought',
            type: 'reasoning',
            status: 'in_progress',
            title: 'Private',
            text: 'Private',
          },
        },
        0
      )
    ).toEqual([]);
    const output = projector.ingest(
      {
        ...base,
        type: 'item.completed',
        raw: { source: 'sdk', payload: { secret: 'private' } },
        item: {
          id: 'tool',
          type: 'command_execution',
          status: 'completed',
          title: 'Run tests',
          text: 'raw output',
          payload: { secret: 'private' },
        },
      },
      0
    );
    expect(JSON.stringify(output)).not.toMatch(/raw output|private|payload/);
    expect(
      projector.ingest(
        {
          ...base,
          type: 'item.completed',
          item: { id: 'user', type: 'user_message', status: 'completed', title: '', text: 'Hello' },
        },
        0
      )[0]
    ).toMatchObject({ item: { origin: context.origin } });
    expect(() =>
      projector.ingest(
        { ...base, sessionId: 'wrong', type: 'turn.started' } as ProviderRuntimeEvent,
        0
      )
    ).toThrow('identity');
  });
});

it('persists host sequences and acknowledgements across reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-outbox-'));
  try {
    const path = join(dir, 'events.jsonl');
    const outbox = await EventOutbox.load(path, 'session', 'epoch');
    const body = { type: 'session.upsert' as const, session: session('claude') };
    await Promise.all([
      outbox.append(body, '2026-09-07T12:00:00Z'),
      outbox.append(body, '2026-09-07T12:00:01Z'),
    ]);
    await expect(outbox.acknowledge(3)).rejects.toThrow('Invalid');
    await outbox.acknowledge(1);
    const recovered = await EventOutbox.load(path, 'session', 'epoch');
    expect(recovered.pending().map((x) => x.hostSequence)).toEqual([2]);
    expect((await recovered.append(body, '2026-09-07T12:00:02Z')).hostSequence).toBe(3);
    expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(4);
    await expect(EventOutbox.load(path, 'other', 'epoch')).rejects.toThrow('identity');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('preserves a long Unicode response in bounded wire items', () => {
  const projector = new ChatProjector(session('claude'), null);
  projector.bindTurn('turn', context);
  const text = '😀\n"'.repeat(20000);
  const events = projector.ingest(
    {
      provider: 'claude',
      sessionId: 'session',
      eventId: 'large',
      createdAt: '2026-09-07T12:00:00Z',
      turnId: 'turn',
      type: 'item.completed',
      item: { id: 'answer', type: 'assistant_message', status: 'completed', title: '', text },
    },
    0
  );
  expect(
    events.map((event) => (event.type === 'item.upsert' ? event.item.text : '')).join('')
  ).toBe(text);
  for (const event of events)
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(60 * 1024);
});

describe('service tokens in streamed text', () => {
  const TOKEN = 'synthetic-installation-token-0123456789';
  const base = {
    provider: 'claude' as const,
    sessionId: 'session',
    eventId: 'native-event',
    createdAt: '2026-09-07T12:00:00Z',
    turnId: 'turn',
  };
  const texts = (bodies: ReturnType<ChatProjector['ingest']>) =>
    bodies.flatMap((body) => (body.type === 'item.upsert' ? [body.item.text] : []));

  function projector() {
    const redactions = new Redactions();
    redactions.add(TOKEN);
    const projected = new ChatProjector(session('claude'), redactions);
    projected.bindTurn('turn', context);
    return projected;
  }

  it('never publishes part of a token that arrives over several chunks', () => {
    const p = projector();
    const published = texts(
      p.ingest(
        {
          ...base,
          type: 'item.started',
          item: {
            id: 'answer',
            type: 'assistant_message',
            status: 'in_progress',
            title: '',
            text: '',
          },
        },
        0
      )
    );
    const chunks = [
      'The token is ',
      TOKEN.slice(0, 12),
      TOKEN.slice(12, 25),
      TOKEN.slice(25),
      ' ok',
    ];
    chunks.forEach((delta, index) =>
      published.push(
        ...texts(
          p.ingest({ ...base, type: 'content.delta', itemId: 'answer', delta }, (index + 1) * 300)
        )
      )
    );
    published.push(...texts(p.flush(10_000, true)));
    expect(published.at(-1)).toBe('The token is [REDACTED] ok');
    for (const text of published) expect(text).not.toContain(TOKEN.slice(0, 8));
  });

  it('scrubs a token before a long message is split into parts', () => {
    const p = projector();
    const text = `${'a'.repeat(4096 - 10)}${TOKEN} done`;
    const parts = texts(
      p.ingest(
        {
          ...base,
          type: 'item.completed',
          item: { id: 'answer', type: 'assistant_message', status: 'completed', title: '', text },
        },
        0
      )
    );
    expect(parts.join('')).toBe(`${'a'.repeat(4096 - 10)}[REDACTED] done`);
    for (const part of parts) expect(part).not.toContain(TOKEN.slice(-8));
  });
});
