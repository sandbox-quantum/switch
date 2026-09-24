import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Origin, ServerEvent } from '@switch-console/shared/session-v1';
import { afterEach, expect, it } from 'vitest';
import { ActivityReporter, type Report } from './activity-reporter';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function reporter(): Promise<ActivityReporter> {
  const root = await mkdtemp(join(tmpdir(), 'activity-reporter-'));
  roots.push(root);
  return ActivityReporter.load(root);
}

const origin: Origin = {
  surface: 'slack',
  actorId: '@person:test',
  roomId: 'room-1',
  threadId: null,
  messageId: 'sw_asked',
};
const originOf = (turnId: string) => (turnId === 'turn' ? origin : null);
const OCCURRED = '2026-09-24T12:00:00.000Z';

function event(sequence: number, body: ServerEvent['body']): ServerEvent {
  return {
    contractVersion: 1,
    eventId: `event-${sequence}`,
    sessionId: 'session',
    sequence,
    occurredAt: OCCURRED,
    body,
  };
}

function item(overrides: Partial<Item>): ServerEvent['body'] {
  return {
    type: 'item.upsert',
    item: {
      itemId: '["turn","tool-1"]',
      turnId: 'turn',
      revision: 1,
      kind: 'tool-activity',
      status: 'in-progress',
      title: 'Ran `pytest`',
      text: '',
      attachments: [],
      origin: null,
      ...overrides,
    },
  };
}

const turn = (status: 'queued' | 'running' | 'completed' | 'error'): ServerEvent['body'] => ({
  type: 'turn.upsert',
  turnId: 'turn',
  status,
  commandId: 'turn',
});

const notice = (message: string): ServerEvent['body'] => ({
  type: 'notice',
  level: 'warning',
  code: 'X',
  message,
});

const rows = (reports: Report[]) =>
  reports.map((report) => {
    if (report.kind !== 'activity')
      throw new Error(`Expected an activity row, not ${report.kind}.`);
    return report.row;
  });

const placed = { room_id: 'room-1', thread_id: 'sw_asked', message_id: 'sw_asked' };

it('reports the turn itself as a row revised by event sequence, placed where it was asked', async () => {
  const lines = await reporter();
  expect(rows(lines.reports(event(4, turn('running')), originOf))).toEqual([
    {
      turn_id: 'turn',
      item_id: 'turn',
      kind: 'turn',
      revision: 4,
      status: 'running',
      title: '',
      text: '',
      command_id: 'turn',
      ...placed,
      occurred_at: OCCURRED,
    },
  ]);
});

it('places a turn in its origin thread when it has one', async () => {
  const lines = await reporter();
  const [row] = rows(
    lines.reports(event(1, turn('queued')), () => ({ ...origin, threadId: 'sw_thread' }))
  );
  expect(row).toMatchObject({ room_id: 'room-1', thread_id: 'sw_thread', message_id: 'sw_asked' });
});

it('reports every message and tool item, streamed parts included, as its own row', async () => {
  const lines = await reporter();
  const reported = rows(
    [
      event(
        1,
        item({
          itemId: 'user-turn',
          kind: 'user-message',
          status: 'completed',
          title: '',
          text: 'Run tests',
        })
      ),
      event(2, item({ revision: 1 })),
      event(3, item({ revision: 2, status: 'failed' })),
      event(
        4,
        item({ itemId: 'answer', kind: 'assistant-message', revision: 3, title: '', text: 'Done' })
      ),
      event(
        5,
        item({
          itemId: 'answer:part:1',
          kind: 'assistant-message',
          revision: 3,
          title: '',
          text: 'more',
        })
      ),
    ].flatMap((e) => lines.reports(e, originOf))
  );
  expect(
    reported.map((row) => [row.item_id, row.kind, row.revision, row.status, row.title, row.text])
  ).toEqual([
    ['user-turn', 'user-message', 1, 'completed', '', 'Run tests'],
    ['["turn","tool-1"]', 'tool-activity', 1, 'in-progress', 'Ran `pytest`', ''],
    ['["turn","tool-1"]', 'tool-activity', 2, 'failed', 'Ran `pytest`', ''],
    ['answer', 'assistant-message', 3, 'in-progress', '', 'Done'],
    ['answer:part:1', 'assistant-message', 3, 'in-progress', '', 'more'],
  ]);
  expect(reported[0]).toMatchObject({ turn_id: 'turn', command_id: null, ...placed });
});

it('truncates long titles and texts', async () => {
  const lines = await reporter();
  const [row] = rows(
    lines.reports(event(1, item({ title: 't'.repeat(600), text: 'x'.repeat(9000) })), originOf)
  );
  expect(Array.from(row!.title)).toHaveLength(500);
  expect(row!.title.endsWith('…')).toBe(true);
  expect(Array.from(row!.text)).toHaveLength(8000);
  expect(row!.text.endsWith('…')).toBe(true);
});

it('reports a notice in the running turn, and in a turn that just ended', async () => {
  const lines = await reporter();
  const reported = [
    event(1, notice('Before any turn')),
    event(2, turn('running')),
    event(3, notice('Slow provider')),
    event(4, turn('error')),
    event(5, notice('The turn failed')),
    event(6, notice('Model changed')),
  ].flatMap((e) => lines.reports(e, originOf));
  const notices = rows(reported).filter((row) => row.kind === 'notice');
  expect(notices).toEqual([
    {
      turn_id: 'turn',
      item_id: 'notice:3',
      kind: 'notice',
      revision: 0,
      status: 'warning',
      title: 'Slow provider',
      text: 'Slow provider',
      command_id: null,
      ...placed,
      occurred_at: OCCURRED,
    },
    expect.objectContaining({ item_id: 'notice:5', turn_id: 'turn', title: 'The turn failed' }),
  ]);
});

it('knows the running turn after a restart from the events it already reported', async () => {
  const lines = await reporter();
  lines.catchUp([event(1, turn('running'))]);
  expect(rows(lines.reports(event(2, notice('Still going')), originOf))).toMatchObject([
    { turn_id: 'turn', item_id: 'notice:2' },
  ]);
});

it('opens an approval with its options and closes it when it settles', async () => {
  const lines = await reporter();
  const opened = lines.reports(
    event(1, {
      type: 'request.opened',
      request: {
        requestId: 'permission',
        turnId: 'turn',
        revision: 1,
        state: 'open',
        expiresAt: '2026-09-24T13:00:00.000Z',
        content: {
          kind: 'approval',
          title: 'Write file',
          detail: 'app.py',
          options: [{ optionId: '0', label: 'Allow', decision: 'accept' }],
        },
      },
    }),
    originOf
  );
  expect(opened).toEqual([
    {
      kind: 'approval.open',
      body: {
        request_id: 'permission',
        turn_id: 'turn',
        kind: 'approval',
        title: 'Write file',
        detail: 'app.py',
        options: [{ id: '0', label: 'Allow', decision: 'accept' }],
        questions: [],
        room_id: 'room-1',
        thread_id: 'sw_asked',
        expires_at: '2026-09-24T13:00:00.000Z',
      },
    },
  ]);
  expect(
    lines.reports(
      event(2, {
        type: 'request.settled',
        requestId: 'permission',
        revision: 2,
        outcome: 'interrupted',
        commandId: null,
        result: null,
      }),
      originOf
    )
  ).toEqual([{ kind: 'approval.close', requestId: 'permission' }]);
});

it('opens questions with every question and its options', async () => {
  const lines = await reporter();
  const opened = lines.reports(
    event(1, {
      type: 'request.opened',
      request: {
        requestId: 'question',
        turnId: 'turn',
        revision: 1,
        state: 'open',
        expiresAt: null,
        content: {
          kind: 'questions',
          title: 'Question from the agent',
          questions: [
            {
              questionId: 'colour',
              title: 'Colour',
              prompt: 'Which colours?',
              options: [
                { optionId: 'colour:0', label: 'Red', description: 'Warm' },
                { optionId: 'colour:1', label: 'Blue', description: null },
              ],
              multiSelect: true,
              allowCustomAnswer: false,
            },
          ],
        },
      },
    }),
    originOf
  );
  expect(opened).toEqual([
    {
      kind: 'approval.open',
      body: {
        request_id: 'question',
        turn_id: 'turn',
        kind: 'questions',
        title: 'Question from the agent',
        detail: null,
        options: [],
        questions: [
          {
            id: 'colour',
            title: 'Colour',
            prompt: 'Which colours?',
            options: [
              { id: 'colour:0', label: 'Red', description: 'Warm' },
              { id: 'colour:1', label: 'Blue', description: null },
            ],
            multi_select: true,
            allow_custom_answer: false,
          },
        ],
        room_id: 'room-1',
        thread_id: 'sw_asked',
        expires_at: null,
      },
    },
  ]);
});

it('remembers how far it reported across a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'activity-reporter-'));
  roots.push(root);
  const first = await ActivityReporter.load(root);
  expect(first.fresh).toBe(true);
  await first.advance(7);
  await first.advance(3);
  const again = await ActivityReporter.load(root);
  expect(again.fresh).toBe(false);
  expect(again.cursor).toBe(7);
});
