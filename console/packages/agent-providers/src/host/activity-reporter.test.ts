import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Origin, ServerEvent } from '@switch-console/shared/session-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityReporter, type Report, type ToolDetailLookup } from './activity-reporter';
import { ToolDetailBuffer, type ToolDetailParts } from './tool-detail-buffer';
import { envKnownValues } from './tool-detail-known-values';
import { buildRegistry } from './tool-detail-redaction';
import { toolIoText } from './tool-detail-text';

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
const noUsage = () => [];
const noDetail = () => null;
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
  expect(rows(lines.reports(event(4, turn('running')), originOf, noUsage, noDetail))).toEqual([
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

it("carries an ended turn's usage on its row, and nothing on a turn still running", async () => {
  const lines = await reporter();
  const spent = [
    { model: 'big', inputTokens: 10, outputTokens: 2, cacheReadTokens: 300, cacheWriteTokens: 0 },
  ];
  const usageOf = (turnId: string) => (turnId === 'turn' ? spent : []);
  const report = (sequence: number, status: 'running' | 'completed' | 'error') =>
    rows(lines.reports(event(sequence, turn(status)), originOf, usageOf, noDetail))[0];
  expect(report(1, 'running')).not.toHaveProperty('usage');
  expect(report(2, 'completed')?.usage).toEqual([
    {
      model: 'big',
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 300,
      cache_write_tokens: 0,
    },
  ]);
  const errored = rows(lines.reports(event(3, turn('error')), originOf, noUsage, noDetail));
  expect(errored[0]).not.toHaveProperty('usage');
});

it('places a turn in its origin thread when it has one', async () => {
  const lines = await reporter();
  const [row] = rows(
    lines.reports(
      event(1, turn('queued')),
      () => ({ ...origin, threadId: 'sw_thread' }),
      noUsage,
      noDetail
    )
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
    ].flatMap((e) => lines.reports(e, originOf, noUsage, noDetail))
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
    lines.reports(
      event(1, item({ title: 't'.repeat(600), text: 'x'.repeat(9000) })),
      originOf,
      noUsage,
      noDetail
    )
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
  ].flatMap((e) => lines.reports(e, originOf, noUsage, noDetail));
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
  const still = rows(lines.reports(event(2, notice('Still going')), originOf, noUsage, noDetail));
  expect(still).toMatchObject([{ turn_id: 'turn', item_id: 'notice:2' }]);
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
    originOf,
    noUsage,
    noDetail
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
      originOf,
      noUsage,
      noDetail
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
    originOf,
    noUsage,
    noDetail
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

describe('tool rows: the detail of a finished call in a room', () => {
  // Synthetic, put together at run time.
  const secret = ['Qm7v', 'R2Xk', '9pT4', 'Lz8W'].join('');
  const registry = buildRegistry(envKnownValues({ DEPLOY_TOKEN: secret }));
  const detail: ToolDetailParts = {
    itemId: '["turn","tool-1"]',
    type: 'command_execution',
    toolName: null,
    input: { command: 'ls' },
    output: 'a.txt\n',
    truncated: false,
    exitCode: 0,
    inputClipped: false,
    head: 'a.txt\n',
    tail: '',
    outputClipped: false,
    hasOutput: true,
  };
  const shownLs = 'Input\n{\n  "command": "ls"\n}\n\nOutput\na.txt\n';
  const found = () => ({ detail, registry });
  const report = async (
    overrides: Partial<Item>,
    lookup: ToolDetailLookup,
    origins: (turnId: string) => Origin | null = originOf
  ) => rows((await reporter()).reports(event(1, item(overrides)), origins, noUsage, lookup))[0]!;

  it('sends the detail of a finished call placed in a room, as toolIoText gives it', async () => {
    const row = await report({ status: 'completed', title: 'ls' }, found);
    expect(row.title).toBe('ls');
    expect(row.tool_io).toBe(toolIoText(detail, registry));
    expect(row.tool_io).toBe(shownLs);
  });

  it('sends no detail for a call still running, outside a room, or not held', async () => {
    const lookup = vi.fn(found);
    expect(await report({ status: 'in-progress' }, lookup)).not.toHaveProperty('tool_io');
    expect(await report({ status: 'completed' }, lookup, () => null)).not.toHaveProperty('tool_io');
    expect(lookup).not.toHaveBeenCalled();
    const notHeld = () => ({ detail: null, registry });
    expect(await report({ status: 'failed' }, notHeld)).not.toHaveProperty('tool_io');
    expect(await report({ status: 'completed' }, noDetail)).not.toHaveProperty('tool_io');
  });

  it('sends the detail redacted, or the note toolIoText gives', async () => {
    const held = { ...detail, output: `token ${secret}`, head: `token ${secret}` };
    const masked = await report({ status: 'completed' }, () => ({ detail: held, registry }));
    expect(masked.tool_io).toContain('[REDACTED]');
    expect(masked.tool_io).not.toContain(secret.slice(0, 6));
    const bare = {
      ...detail,
      input: null,
      output: null,
      truncated: true,
      head: '',
      hasOutput: false,
    };
    const none = await report({ status: 'completed' }, () => ({ detail: bare, registry }));
    expect(none.tool_io).toBe('Detail not available');
  });

  it('a failed lookup or detail never stops reporting', async () => {
    const lines = await reporter();
    const throwing: ToolDetailLookup = () => {
      throw new Error('injected');
    };
    const [failed] = rows(
      lines.reports(event(1, item({ status: 'completed' })), originOf, noUsage, throwing)
    );
    expect(failed).toMatchObject({
      title: 'Ran `pytest`',
      status: 'completed',
      item_id: '["turn","tool-1"]',
    });
    expect(failed).not.toHaveProperty('tool_io');

    // Masking the detail throws: the detail is left out.
    const brokenForms = new Proxy(registry, {
      get(target, key, receiver) {
        if (key === 'forms') throw new Error('injected');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const [broken] = rows(
      lines.reports(
        event(2, item({ status: 'completed', title: 'ls' })),
        originOf,
        noUsage,
        () => ({ detail, registry: brokenForms })
      )
    );
    expect(broken).toMatchObject({ title: 'ls', status: 'completed' });
    expect(broken).not.toHaveProperty('tool_io');

    // And the next report is whole.
    const [next] = rows(
      lines.reports(event(3, item({ status: 'completed', title: 'ls' })), originOf, noUsage, found)
    );
    expect(next).toMatchObject({ title: 'ls', tool_io: shownLs });
  });

  it('finds the detail through a real buffer by turn and item id', async () => {
    const buffer = new ToolDetailBuffer();
    const base = { eventId: 'e', provider: 'codex', sessionId: 's', createdAt: '' } as const;
    buffer.ingest(
      {
        ...base,
        type: 'item.completed',
        turnId: 'turn',
        item: {
          id: 'tool-1',
          type: 'command_execution',
          status: 'completed',
          title: 'ls',
          text: 'a.txt\n',
          payload: { command: 'ls' },
        },
      },
      'epoch'
    );
    const lookup: ToolDetailLookup = (turnId, itemId) => ({
      detail: buffer.detail('epoch', turnId, itemId),
      registry,
    });
    const row = await report({ status: 'completed', title: 'ls' }, lookup);
    expect(row.tool_io).toBe(shownLs);
  });

  it('looks nothing up for a row that is not a tool call', async () => {
    const lookup = vi.fn(found);
    const lines = await reporter();
    const [message] = rows(
      lines.reports(
        event(1, item({ kind: 'assistant-message', title: '', text: 'Done' })),
        originOf,
        noUsage,
        lookup
      )
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(message).not.toHaveProperty('tool_io');
  });
});

describe('tool rows: secrets a clipped or spelled output hides, through a real buffer', () => {
  // Synthetic, put together at run time.
  const base = { eventId: 'e', provider: 'codex', sessionId: 's', createdAt: '' } as const;
  /** What the buffer keeps and the reporter sends for a finished command whose output is `output`. */
  const toolIoOf = async (output: string, known: readonly string[] = []) => {
    const buffer = new ToolDetailBuffer();
    buffer.ingest(
      {
        ...base,
        type: 'item.completed',
        turnId: 'turn',
        item: {
          id: 'tool-1',
          type: 'command_execution',
          status: 'completed',
          title: 'run',
          text: output,
          payload: { command: 'run' },
        },
      },
      'epoch'
    );
    const registry = buildRegistry(known);
    const lookup: ToolDetailLookup = (turnId, itemId) => ({
      detail: buffer.detail('epoch', turnId, itemId),
      registry,
    });
    const reports = (await reporter()).reports(
      event(1, item({ status: 'completed', title: 'run' })),
      originOf,
      noUsage,
      lookup
    );
    return {
      clipped: buffer.detail('epoch', 'turn', '["turn","tool-1"]')?.outputClipped,
      shown: String(rows(reports)[0]!.tool_io),
    };
  };
  const line = ['QUJD', 'REVG', 'R0hJ', 'SktM', 'TU5P', 'UFFS', 'U1RV', 'VldY', 'WVo='].join('');
  const kind = ['PRIV', 'ATE KEY'].join('');
  const keyNote = 'Output — lines that look like part of a private key are not shown';

  it('masks the key lines at both ends of a clipped PEM block, its armor plain, escaped or split', async () => {
    const armors: [string, string][] = [
      [`-----BEGIN ${kind}-----`, `-----END ${kind}-----`],
      [`-----\\u0042EGIN ${kind}-----`, `-----\\u0045ND ${kind}-----`],
      [`-----\\x42EGIN ${kind}-----`, `-----\\x45ND ${kind}-----`],
      [`-----BE­GIN ${kind}-----`, `-----E­ND ${kind}-----`],
    ];
    for (const [begin, end] of armors) {
      const output = `${begin}\n${line}\n${'A'.repeat(10_000)}\n${line}\n${end}\nsafe`;
      const { clipped, shown } = await toolIoOf(output);
      expect(clipped, begin).toBe(true);
      expect(shown, begin).not.toContain(line);
      expect(shown, begin).toContain('\n[REDACTED_PEM_BLOCK]\n…\n[REDACTED_PEM_BLOCK]\nsafe');
    }
  });

  it('masks every line of a key the output stops inside (`head -c 9000 key.pem`), in the head and in the tail', async () => {
    const keyLines = Array.from(
      { length: 150 },
      (_, index) => `${'Q'.repeat(60)}${String(index).padStart(4, '0')}`
    );
    const { clipped, shown } = await toolIoOf(
      `-----BEGIN RSA ${kind}-----\n${keyLines.join('\n')}`
    );
    expect(clipped).toBe(true);
    expect(shown).not.toContain('Q'.repeat(12));
    // The head from its BEGIN to its end; each key line of the tail as a line.
    expect(shown).toMatch(
      /the middle was not kept\n\[REDACTED_PEM_BLOCK\]\n…\n(?:\[REDACTED_PEM_BLOCK\]\n)+\[REDACTED_PEM_BLOCK\]\n\nOutput — lines that look like part of a private key are not shown$/
    );
  });

  it('documented limit: a tail of key lines under 40 characters with no armor line in it shows (`head -c 9000` of 24-character lines)', async () => {
    const keyLines = Array.from(
      { length: 400 },
      (_, index) => `${'Q'.repeat(20)}${String(index).padStart(4, '0')}`
    );
    const { clipped, shown } = await toolIoOf(
      `-----BEGIN RSA ${kind}-----\n${keyLines.join('\n')}`
    );
    expect(clipped).toBe(true);
    // The head is masked from its BEGIN to its end; the tail's lines, under 40
    // characters with no armor line there, are not read as a key.
    expect(shown).toContain('the middle was not kept\n[REDACTED_PEM_BLOCK]\n…\n');
    expect(shown).not.toContain(keyLines[0]);
    expect(shown).not.toContain(keyLines[1]);
    expect(shown).toContain(`\n${keyLines.at(-1)}\n\nOutput — lines that look like`);
  });

  it('masks a key in a diff or under PGP headers, its BEGIN cut at the head’s end, and keeps a `FAILED` line next to a masked digest', async () => {
    const L = ('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/' + 'AbCdEfGhIjKlMnOpQrStUvWxYz01').slice(
      0,
      64
    );
    const diff = await toolIoOf(
      `safe\n${'x'.repeat(6136)}\n------BEGIN ${kind}-----\n${Array(40).fill(`-${L}`).join('\n')}`
    );
    expect(diff.clipped).toBe(true);
    expect(diff.shown).not.toContain(L.slice(0, 12));
    expect(diff.shown.endsWith(`\n\n${keyNote}`)).toBe(true);
    const pgp = await toolIoOf(
      `safe\n${'x'.repeat(6137)}\n-----BEGIN PGP ${kind} BLOCK-----\nVersion: GnuPG v2\n\n${`${L}\n`.repeat(20)}${'done\n'.repeat(146)}end\n`
    );
    expect(pgp.clipped).toBe(true);
    expect(pgp.shown).not.toContain(L.slice(0, 12));
    const digest = ['pro56MFdgOWFjJbqydzI', 'QDpwweF92oRg50Vg1WXlqyE='].join('');
    const build = await toolIoOf(
      `${'ok\n'.repeat(3000)}START BUILD\n${digest}\nFAILED: actual diagnostic\n`
    );
    expect(build.clipped).toBe(true);
    expect(build.shown).toContain(
      '\nSTART BUILD\n[REDACTED_PEM_BLOCK]\nFAILED: actual diagnostic\n\n\n'
    );
    expect(build.shown.endsWith(keyNote)).toBe(true);
  });

  describe('a private key with only one of its armor lines in a part', () => {
    const keys = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `KEYLINE${String(index).padStart(4, '0')}${'Q'.repeat(53)}`
      ).join('\n');
    const begin = `-----BEGIN ${kind}-----`;
    const end = `-----END ${kind}-----`;
    const OUTPUT = 'Input\n{\n  "command": "run"\n}\n\nOutput\n';

    it('masks a key the tool cut: `head -n 21 key.pem` and `tail -n 21 key.pem`', async () => {
      const head = await toolIoOf(`${begin}\n${keys(20)}`);
      expect(head.clipped).toBe(false);
      expect(head.shown).toBe(`${OUTPUT}[REDACTED_PEM_BLOCK]`);
      const tail = await toolIoOf(`${keys(20)}\n${end}\ndone`);
      expect(tail.clipped).toBe(false);
      expect(tail.shown).toBe(`${OUTPUT}[REDACTED_PEM_BLOCK]\ndone`);
      const short = await toolIoOf(`$ head -n 5 key.pem\n${begin}\n${keys(4)}`);
      expect(short.shown).toBe(`${OUTPUT}$ head -n 5 key.pem\n[REDACTED_PEM_BLOCK]`);
    });

    it('masks a BEGIN with no END in the tail, and an END with no BEGIN in the head', async () => {
      const inTail = await toolIoOf(
        `${'ordinary log line of the command\n'.repeat(260)}${begin}\n${keys(15)}`
      );
      expect(inTail.clipped).toBe(true);
      expect(inTail.shown).not.toContain('KEYLINE');
      expect(inTail.shown.endsWith(`\n[REDACTED_PEM_BLOCK]\n\n${keyNote}`)).toBe(true);
      const inHead = await toolIoOf(
        `${keys(15)}\n${end}\n${'ordinary log line after\n'.repeat(400)}`
      );
      expect(inHead.clipped).toBe(true);
      expect(inHead.shown).not.toContain('KEYLINE');
      expect(inHead.shown).toContain(
        'the middle was not kept\n[REDACTED_PEM_BLOCK]\nordinary log line after\n'
      );
    });

    it('masks the key of a certificate-plus-key bundle the output stops inside', async () => {
      // The certificate opens in the kept head and closes in the kept tail.
      const cert = Array.from({ length: 120 }, (_, index) => `CERTLINE${index}`).join('\n');
      const output = `${'safe\n'.repeat(1200)}-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----\n${begin}\n${keys(20)}`;
      const { clipped, shown } = await toolIoOf(output);
      expect(clipped).toBe(true);
      expect(shown).not.toContain('KEYLINE');
      expect(
        shown.endsWith(`\n-----END CERTIFICATE-----\n[REDACTED_PEM_BLOCK]\n\n${keyNote}`)
      ).toBe(true);
    });

    it('masks a lone armor line written with escapes or split by a soft hyphen', async () => {
      for (const armor of [
        `-----\\u0042EGIN ${kind}-----`,
        `-----\\x42EGIN ${kind}-----`,
        `-----BE­GIN ${kind}-----`,
        '-----BEGIN PRIV­ATE KEY-----',
      ]) {
        const { shown } = await toolIoOf(`ok\n${armor}\n${keys(6)}`);
        expect(shown, armor).toBe(`${OUTPUT}ok\n[REDACTED_PEM_BLOCK]`);
      }
    });

    it('leaves the text after a lone armor line of another label as it is', async () => {
      const log = await toolIoOf(
        `-----BEGIN LOG-----\n${'normal log line\n'.repeat(700)}ALL TESTS PASSED\n`
      );
      expect(log.clipped).toBe(true);
      expect(log.shown).not.toContain('[REDACTED_PEM_BLOCK]');
      expect(log.shown).toContain(
        'the middle was not kept\n-----BEGIN LOG-----\nnormal log line\n'
      );
      expect(log.shown.endsWith('\nnormal log line\nALL TESTS PASSED\n')).toBe(true);
      for (const label of ['CERTIFICATE', 'PUBLIC KEY']) {
        const output = `-----BEGIN ${label}-----\nMIIBIjANBgkqhkiG9w0B\nshown`;
        expect((await toolIoOf(output)).shown, label).toBe(`${OUTPUT}${output}`);
      }
      const whole = await toolIoOf('-----BEGIN LOG-----\nbody\n-----END LOG-----\nafter');
      expect(whole.shown).toBe(`${OUTPUT}[REDACTED_PEM_BLOCK]\nafter`);
    });

    /** Key lines as PEM writes them: 64 base64 characters, the same on every run. */
    const bodyLines = (count: number) => {
      const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let state = 803;
      return Array.from({ length: count }, () =>
        Array.from({ length: 64 }, () => {
          state = (Math.imul(state, 1103515245) + 12345) >>> 0;
          return B64[(state >>> 16) & 63];
        }).join('')
      );
    };
    /** Whether 12 code units in a row of any of `lines` are in `shown`. */
    const showsPieceOf = (shown: string, lines: readonly string[]) =>
      lines.some((each) => {
        for (let at = 0; at + 12 <= each.length; at++)
          if (shown.includes(each.slice(at, at + 12))) return true;
        return false;
      });

    it('masks the key lines next to a cut through or before its BEGIN', async () => {
      const key = bodyLines(80);
      // The buffer's head ends 1 unit into `BEGIN` (`\n-`), at its start, or 2–6 units into it.
      const cases: [string, string][] = [
        ['cut 1 unit into BEGIN', `safe\n${'x'.repeat(6137)}\n-----BEGIN ${kind}-----\n`],
        ...[6143, 6144, 6142, 6139, 6138].map((length): [string, string] => [
          `prefix ${length}`,
          `${'ok\n'.repeat(2040)}${'p'.repeat(length - 6121)}\n-----BEGIN RSA ${kind}-----\n`,
        ]),
      ];
      for (const [name, start] of cases) {
        const { clipped, shown } = await toolIoOf(`${start}${key.slice(0, 40).join('\n')}`);
        expect(clipped, name).toBe(true);
        expect(showsPieceOf(shown, key), name).toBe(false);
        expect(shown.endsWith(`\n[REDACTED_PEM_BLOCK]\n\n${keyNote}`), name).toBe(true);
        // The head is not masked for a cut in the armor line after it.
        expect(shown, name).toMatch(/the middle was not kept\n(?:safe|ok)\n/);
      }
      // A key whose `BEGIN` is whole in the head, with no `END`: its lines in the tail are masked.
      const inHead = await toolIoOf(
        `${'ok\n'.repeat(1900)}-----BEGIN RSA ${kind}-----\n${key.slice(0, 40).join('\n')}`
      );
      expect(showsPieceOf(inHead.shown, key)).toBe(false);
      expect(inHead.shown).toMatch(/the middle was not kept\nok\n/);
    });

    it('shows ordinary lines next to a cut: dashes, YAML `---`, `BEGIN LOG` with more dashes', async () => {
      const L = '-----BEGIN LOG----------';
      /** `piece` and lines after it, so that the buffer's tail starts at `piece`. */
      const tailFrom = (piece: string) =>
        `${piece}${'tail line\n'.repeat(200)}${'y'.repeat(2048 - piece.length - 2001)}\n`;
      const cases: [string, string, string][] = [
        [
          '80 dashes at the cut',
          `${'ok\n'.repeat(2040)}${'-'.repeat(80)}\n${'tail line\n'.repeat(300)}`,
          'ok',
        ],
        ['YAML `---` at the cut', `${'ok\n'.repeat(2047)}---\n${'tail line\n'.repeat(300)}`, 'ok'],
        [
          'a pytest dash rule at the cut',
          `${'ok\n'.repeat(2030)}${'-'.repeat(20)} Captured stdout call ${'-'.repeat(40)}\n${'tail line\n'.repeat(300)}`,
          'ok',
        ],
        [
          'YAML `---` in the dropped middle, tail ends in `end`',
          `${'ok\n'.repeat(2200)}---\n${'tail line\n'.repeat(204)}end\n`,
          'ok',
        ],
        [
          'YAML `---` in the dropped middle, tail ends in `end!`',
          `${'ok\n'.repeat(2200)}---\n${'tail line\n'.repeat(204)}end!\n`,
          'ok',
        ],
        [
          'a dash rule after the cut',
          `safe\n${'x'.repeat(6133)}\n---------------------\n${'normal log line\n'.repeat(700)}ALL TESTS PASSED\n`,
          'safe',
        ],
        [
          '`BEGIN LOG` with more dashes after the cut',
          `safe\n${'x'.repeat(6138 - L.length)}\n${L}\n${'normal log line\n'.repeat(700)}ALL TESTS PASSED\n`,
          'safe',
        ],
        // `-----BEGIN CERT` ends the head; `CERTIFICATE-----`, `PUBLIC KEY-----` start the tail.
        [
          '`BEGIN CERT` ends the head',
          `${'ok\n'.repeat(2043)}-----BEGIN CERTIFICATE-----\n${'tail line\n'.repeat(300)}`,
          'ok',
        ],
        [
          '`CERTIFICATE-----` starts the tail',
          `${'ok\n'.repeat(2400)}-----END ${tailFrom('CERTIFICATE-----\n')}`,
          'ok',
        ],
        [
          '`PUBLIC KEY-----` starts the tail',
          `${'ok\n'.repeat(2400)}-----END ${tailFrom('PUBLIC KEY-----\n')}`,
          'ok',
        ],
      ];
      for (const [name, output, first] of cases) {
        const { clipped, shown } = await toolIoOf(output);
        expect(clipped, name).toBe(true);
        expect(shown, name).not.toContain('[REDACTED_PEM_BLOCK]');
        expect(shown, name).toContain(`the middle was not kept\n${first}\n`);
        const last = output.trimEnd().split('\n').at(-1)!;
        expect(shown.endsWith(`\n${last}\n`), name).toBe(true);
      }
    });

    it('writes a lone armor line’s mask as plain `[REDACTED]` when its marker would spell a known value', async () => {
      const known = ['PEM_', 'BLOCK'].join('');
      const lone = await toolIoOf(`-----BEGIN ${kind}-----\nfixture`, [known]);
      expect(lone.shown).toBe(`${OUTPUT}[REDACTED]`);
      const whole = await toolIoOf(`-----BEGIN ${kind}-----\nfixture\n-----END ${kind}-----`, [
        known,
      ]);
      expect(whole.shown).toBe(`${OUTPUT}[REDACTED]`);
      const tail = await toolIoOf(`${'ok\n'.repeat(2500)}${bodyLines(60).join('\n')}\n`, [known]);
      expect(tail.clipped).toBe(true);
      expect(tail.shown).not.toContain('[REDACTED_PEM_BLOCK]');
      // Each key line of the tail is masked as a line, with the plain marker.
      expect(tail.shown).toMatch(
        /\n…\n(?:\[REDACTED\]\n)+\n\nOutput — lines that look like part of a private key are not shown$/
      );
    });
  });

  describe('an OSC string the cut leaves open', () => {
    const hiddenNote =
      'Output — a terminal control sequence with no end hid the rest; it is not shown';
    const cutEscapeNote =
      'Output — the head ends on an escape the cut left unreadable; the tail is not shown';
    const startHiddenNote =
      'Output — a terminal control sequence terminator was found in the tail; the tail up to it is not shown';

    it('hides the tail it never ends, and says so', async () => {
      const lines = await toolIoOf(`hello\n\x1b]0;${'hidden\n'.repeat(1500)}`);
      expect(lines.clipped).toBe(true);
      expect(lines.shown).not.toContain('hidden');
      expect(lines.shown.endsWith(`\nhello\n…\n\n${hiddenNote}`)).toBe(true);
      const one = await toolIoOf(`hello\n\x1b]0;${'x'.repeat(10_000)}`);
      expect(one.clipped).toBe(true);
      expect(one.shown).not.toContain('xxxxxx');
      expect(one.shown.endsWith(`\nhello\n…\n\n${hiddenNote}`)).toBe(true);
    });

    it('hides the whole tail of a string the head leaves open, even one the tail ends, and says so', async () => {
      // What the dropped middle held is not known, so the tail is not read for its end.
      for (const output of [
        `hello\n\x1b]0;${'hidden\n'.repeat(1500)}\x07\nsafe\n`,
        `hello\n\\x1b]0;${'hidden\n'.repeat(1500)}\\x07\nsafe\n`,
      ]) {
        const { clipped, shown } = await toolIoOf(output);
        expect(clipped).toBe(true);
        expect(shown).not.toContain('hidden');
        expect(shown).not.toContain('safe');
        expect(shown.endsWith(`\nhello\n…\n\n${hiddenNote}`)).toBe(true);
      }
    });

    it('ends a string only at a terminator written as its opener is', async () => {
      // A real string with a terminator written as text in the head stays open.
      for (const output of [
        `hello\n\x1b]0;hidden\\x07\n${'hidden\n'.repeat(1500)}`,
        `hello\n\x1b]0;${'hidden\n'.repeat(400)}\\x07\n${'hidden2\n'.repeat(400)}${'visible\n'.repeat(400)}`,
        `hello\n\x1b]0;${'hidden\n'.repeat(800)}${'visible\n'.repeat(400)}`,
      ]) {
        const { clipped, shown } = await toolIoOf(output);
        expect(clipped).toBe(true);
        expect(shown).not.toContain('hidden');
        expect(shown).not.toContain('visible');
        expect(shown.endsWith(`\nhello\n…\n\n${hiddenNote}`)).toBe(true);
      }
      // A string written as text, terminated so in the head, leaves the rest shown.
      const escaped = await toolIoOf(`hello\n\\x1b]0;t\\x07ok\n${'line\n'.repeat(1700)}end\n`);
      expect(escaped.clipped).toBe(true);
      expect(escaped.shown).not.toContain(hiddenNote);
      expect(escaped.shown).toContain('\nhello\nok\nline\n');
      expect(escaped.shown.endsWith('\nline\nend\n')).toBe(true);
    });

    it('hides the tail when the head ends on the ESC of an opener the middle completes', async () => {
      for (const lead of ['ab', 'a']) {
        // `ab` puts ESC last in the head, `]` first in the middle; `a`, both in the head.
        const output = `${'ok\n'.repeat(2047)}${lead}\x1b]0;${'hidden\n'.repeat(400)}`;
        const { clipped, shown } = await toolIoOf(output);
        expect(clipped, lead).toBe(true);
        expect(shown, lead).not.toContain('hidden');
        // `ab`: the escape at the cut cannot be read; `a`: the head opens a string it does not end.
        expect(
          shown.endsWith(`\nok\n…\n\n${lead === 'ab' ? cutEscapeNote : hiddenNote}`),
          lead
        ).toBe(true);
      }
    });

    it('says so when a bell in the tail drops lines before it', async () => {
      for (const bell of ['bell\x07', 'printf("\\x07");']) {
        const output = `${'ok\n'.repeat(2100)}${'line A\n'.repeat(100)}${bell}\n${'after\n'.repeat(300)}`;
        const { clipped, shown } = await toolIoOf(output);
        expect(clipped, bell).toBe(true);
        expect(shown, bell).toContain('\nafter\n');
        // The note says a terminator was found; it does not claim the lines were in a sequence.
        expect(shown.endsWith(`\nafter\n\n\n${startHiddenNote}`), bell).toBe(true);
        expect(shown, bell).not.toContain(hiddenNote);
      }
    });

    it('shows a C1 opener written `\\x9d` as text, as the normalization does', async () => {
      const output = `${'ok\n'.repeat(100)}data = b'\\x9d\\x00'\n${'more\n'.repeat(1500)}${'tail line\n'.repeat(300)}`;
      const { clipped, shown } = await toolIoOf(output);
      expect(clipped).toBe(true);
      expect(shown).toContain("\ndata = b'\\x9d\\x00'\nmore\n");
      expect(shown.endsWith('\ntail line\n')).toBe(true);
      expect(shown).not.toContain(hiddenNote);
    });
  });

  it('masks a known value and a URL password however many unseen characters are inside a spelling', async () => {
    const value = ['abc', 'DEF', '123'].join('');
    const password = ['opaque', 'PASS', '803'].join('');
    for (const count of [8, 9, 50, 5000]) {
      const unseen = '­'.repeat(count);
      const known = await toolIoOf(`\\u${unseen}0061${value.slice(1)}`, [value]);
      expect(known.shown, String(count)).toBe(
        'Input\n{\n  "command": "run"\n}\n\nOutput\n[REDACTED]'
      );
      const url = await toolIoOf(`postgres:\\u${unseen}002f/user:${password}@db.example/test`);
      expect(url.shown, String(count)).not.toContain(password);
    }
  });
});
