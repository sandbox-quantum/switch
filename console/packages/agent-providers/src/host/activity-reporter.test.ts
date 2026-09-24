import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Origin, ServerEvent } from '@switch-console/shared/session-v1';
import { afterEach, expect, it } from 'vitest';
import { ActivityReporter, LINES_PER_EVENT } from './activity-reporter';

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

function event(sequence: number, body: ServerEvent['body']): ServerEvent {
  return {
    contractVersion: 1,
    eventId: `event-${sequence}`,
    sessionId: 'session',
    sequence,
    occurredAt: '2026-09-24T12:00:00.000Z',
    body,
  };
}

function tool(revision: number, status: 'in-progress' | 'completed' | 'failed') {
  return {
    type: 'item.upsert' as const,
    item: {
      itemId: '["turn","tool-1"]',
      turnId: 'turn',
      revision,
      kind: 'tool-activity' as const,
      status,
      title: 'Ran `pytest`',
      text: '',
      attachments: [],
      origin: null,
    },
  };
}

it('turns a turn into activity lines placed where its command came from', async () => {
  const lines = await reporter();
  const reports = [
    event(1, { type: 'turn.upsert', turnId: 'turn', status: 'running', commandId: 'turn' }),
    event(2, tool(1, 'in-progress')),
    event(3, tool(2, 'in-progress')),
    event(4, tool(3, 'completed')),
    event(5, { type: 'notice', level: 'warning', code: 'X', message: 'Slow provider' }),
    event(6, { type: 'turn.upsert', turnId: 'turn', status: 'completed', commandId: 'turn' }),
    event(7, { type: 'notice', level: 'info', code: 'Y', message: 'Idle' }),
  ].flatMap((e) => lines.reports(e, originOf));

  expect(
    reports.map((r) => (r.kind === 'activity' ? [r.line.seq, r.line.type, r.line.summary] : r))
  ).toEqual([
    [1 * LINES_PER_EVENT, 'turn.started', 'Started working'],
    [2 * LINES_PER_EVENT, 'tool.called', 'Ran `pytest`'],
    [4 * LINES_PER_EVENT + 1, 'tool.finished', 'Ran `pytest`'],
    [5 * LINES_PER_EVENT, 'notice', 'Slow provider'],
    [6 * LINES_PER_EVENT, 'turn.finished', 'Finished'],
    [7 * LINES_PER_EVENT, 'notice', 'Idle'],
  ]);
  const [started] = reports;
  expect(started).toMatchObject({
    kind: 'activity',
    line: { turn_id: 'turn', room_id: 'room-1', thread_id: 'sw_asked' },
  });
  expect(reports.at(-1)).toMatchObject({ line: { turn_id: null, room_id: null } });
});

it('reports a tool that finished before it was first shown as called and finished', async () => {
  const lines = await reporter();
  const reports = lines.reports(event(3, tool(1, 'failed')), originOf);
  expect(reports.map((r) => (r.kind === 'activity' ? r.line.summary : null))).toEqual([
    'Ran `pytest`',
    'Ran `pytest` (failed)',
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
        expiresAt: null,
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
        question: 'Write file\n\napp.py',
        options: [{ id: '0', label: 'Allow', decision: 'accept' }],
        room_id: 'room-1',
        thread_id: 'sw_asked',
        expires_at: null,
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
