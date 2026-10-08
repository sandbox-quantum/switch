import { expect, it } from 'vitest';
import type { ProviderItem, ProviderRuntimeEvent } from '../events';
import { REASONING_TEXT_LIMIT, REASONING_TURN_LIMIT, ReasoningBuffer } from './reasoning-buffer';

const base = { eventId: 'e', provider: 'codex', sessionId: 'session', createdAt: '' } as const;

function itemEvent(
  type: 'item.started' | 'item.updated' | 'item.completed',
  turnId: string,
  item: Partial<ProviderItem> & { id: string }
): ProviderRuntimeEvent {
  return {
    ...base,
    type,
    turnId,
    item: { type: 'reasoning', status: 'in_progress', title: '', ...item },
  };
}

function delta(turnId: string, itemId: string, text: string): ProviderRuntimeEvent {
  return { ...base, type: 'item.delta', turnId, itemId, delta: text };
}

const at = (seconds: number) => Date.parse('2026-10-08T12:00:00.000Z') + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

it('times a reasoning item from its start to its completion (Codex, OpenCode)', () => {
  const buffer = new ReasoningBuffer();
  buffer.ingest(itemEvent('item.started', 'turn', { id: 'r1' }), 'epoch', at(0));
  buffer.ingest(delta('turn', 'r1', 'Look at '), 'epoch', at(1));
  buffer.ingest(delta('turn', 'r1', 'the file.'), 'epoch', at(2));
  expect(buffer.list('epoch', null)).toEqual({
    epoch: 'epoch',
    turns: [{ turnId: 'turn', text: 'Look at the file.', startedAt: iso(0), completedAt: null }],
  });
  buffer.ingest(
    itemEvent('item.completed', 'turn', {
      id: 'r1',
      status: 'completed',
      text: 'Look at the file.',
    }),
    'epoch',
    at(4)
  );
  expect(buffer.list('epoch', ['turn']).turns).toEqual([
    { turnId: 'turn', text: 'Look at the file.', startedAt: iso(0), completedAt: iso(4) },
  ]);
});

it('takes the first delta as the start when the item itself carried none', () => {
  const buffer = new ReasoningBuffer();
  buffer.ingest(
    itemEvent('item.started', 'turn', { id: 'r1', status: 'completed', text: '' }),
    'epoch',
    at(0)
  );
  expect(buffer.list('epoch', null).turns[0]!.startedAt).toBeNull();
  const fresh = new ReasoningBuffer();
  fresh.ingest(itemEvent('item.updated', 'turn', { id: 'r1', text: 'a' }), 'epoch', at(1));
  expect(fresh.list('epoch', null).turns[0]!.startedAt).toBe(iso(1));
});

it('leaves the start unknown for reasoning reported only on completion (Claude)', () => {
  const buffer = new ReasoningBuffer();
  buffer.ingest(
    itemEvent('item.completed', 'turn', { id: 'm#t0', status: 'completed', text: 'Hmm.' }),
    'epoch',
    at(5)
  );
  expect(buffer.list('epoch', null).turns).toEqual([
    { turnId: 'turn', text: 'Hmm.', startedAt: null, completedAt: iso(5) },
  ]);
});

it('joins a turn’s reasoning items and stays open until each completes', () => {
  const joined = new ReasoningBuffer();
  joined.ingest(itemEvent('item.started', 'turn', { id: 'a', text: 'one' }), 'epoch', at(0));
  joined.ingest(itemEvent('item.started', 'turn', { id: 'b', text: 'two' }), 'epoch', at(2));
  joined.ingest(
    itemEvent('item.completed', 'turn', { id: 'a', status: 'completed' }),
    'epoch',
    at(3)
  );
  expect(joined.list('epoch', null).turns[0]).toEqual({
    turnId: 'turn',
    text: 'one\n\ntwo',
    startedAt: iso(0),
    completedAt: null,
  });
  joined.ingest(
    itemEvent('item.completed', 'turn', { id: 'b', status: 'completed' }),
    'epoch',
    at(6)
  );
  expect(joined.list('epoch', null).turns[0]!.completedAt).toBe(iso(6));
});

it('ignores everything but reasoning', () => {
  const buffer = new ReasoningBuffer();
  buffer.ingest(
    itemEvent('item.started', 'turn', { id: 'x', type: 'assistant_message', text: 'hello' }),
    'epoch',
    at(0)
  );
  buffer.ingest(delta('turn', 'cmd', 'stdout'), 'epoch', at(0));
  buffer.ingest(
    { ...base, type: 'content.delta', turnId: 'turn', itemId: 'x', delta: 'more' },
    'epoch',
    at(0)
  );
  expect(buffer.list('epoch', null).turns).toEqual([]);
});

it('keeps the most recent turns and the latest text of each, and drops another epoch', () => {
  const buffer = new ReasoningBuffer();
  for (let index = 0; index < REASONING_TURN_LIMIT + 5; index++)
    buffer.ingest(itemEvent('item.started', `turn-${index}`, { id: 'r' }), 'epoch', at(index));
  const turns = buffer.list('epoch', null).turns;
  expect(turns).toHaveLength(REASONING_TURN_LIMIT);
  expect(turns[0]!.turnId).toBe('turn-5');

  buffer.ingest(delta('turn-60', 'r', 'x'), 'epoch', at(0));
  buffer.ingest(
    delta(`turn-${REASONING_TURN_LIMIT + 4}`, 'r', 'a'.repeat(REASONING_TEXT_LIMIT)),
    'epoch',
    at(0)
  );
  buffer.ingest(delta(`turn-${REASONING_TURN_LIMIT + 4}`, 'r', 'tail'), 'epoch', at(0));
  const last = buffer.list('epoch', [`turn-${REASONING_TURN_LIMIT + 4}`]).turns[0]!;
  expect(last.text).toHaveLength(REASONING_TEXT_LIMIT);
  expect(last.text.endsWith('tail')).toBe(true);

  for (let index = 0; index < 3; index++)
    buffer.ingest(
      itemEvent('item.started', 'many', { id: `r${index}`, text: 'b'.repeat(20000) }),
      'epoch',
      at(0)
    );
  const many = buffer.list('epoch', ['many']).turns[0]!;
  expect(many.text.length).toBeLessThanOrEqual(REASONING_TEXT_LIMIT);

  expect(buffer.list('other', null)).toEqual({ epoch: 'other', turns: [] });
  buffer.ingest(itemEvent('item.started', 'fresh', { id: 'r' }), 'next', at(0));
  expect(buffer.list('next', null).turns.map((turn) => turn.turnId)).toEqual(['fresh']);
});
