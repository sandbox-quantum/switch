import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@switch-console/shared/session-v1';
import { describe, expect, it } from 'vitest';
import type { ProviderRuntimeEvent } from '../events';
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
  it.each(['claude', 'codex', 'opencode', 'gemini', 'cursor'] as const)(
    'projects %s text with bounded full replacements and immediate final state',
    (provider) => {
      const projector = new ChatProjector(session(provider));
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
    const projector = new ChatProjector(session('claude'));
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
