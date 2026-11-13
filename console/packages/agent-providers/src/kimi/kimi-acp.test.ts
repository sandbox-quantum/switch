import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import type { AcpSelectedAnswer, AcpSessionContext } from '../acp/hooks';
import type { AcpPermissionRequest } from '../acp/protocol';
import type { UserInputQuestion } from '../events';
import { writeNodeCli } from '../testing/index';
import { kimiAcp, kimiMcpServer, kimiQuestions } from './kimi-acp';

// A stand-in for `kimi acp`: answers `initialize`, answers `session/new` as
// Kimi does when signed in or out, and writes every method it is sent to a log.
const FAKE_KIMI = `
const { appendFileSync } = require('node:fs');
const log = process.env.FAKE_KIMI_LOG;
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    appendFileSync(log, message.method + ' ' + JSON.stringify(message.params) + '\\n');
    const reply = (body) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }) + '\\n');
    if (message.method === 'initialize')
      reply({ result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'login', name: 'Login' }] } });
    else if (message.method === 'session/new')
      reply(
        process.env.FAKE_KIMI_SIGNED_OUT
          ? { error: { code: -32000, message: 'Authentication required' } }
          : { result: { sessionId: 'probe-session' } }
      );
    else if (message.method === 'session/delete') reply({ result: {} });
    else reply({ error: { code: -32601, message: 'Method not found' } });
  }
});
`;

let root: string;
let kimi: string;
let log: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'switch-kimi-test-'));
  kimi = await writeNodeCli(root, 'kimi', FAKE_KIMI);
  log = join(root, 'calls.log');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function check(extra: Record<string, string> = {}) {
  const result = await checkAcpSignIn(kimiAcp, {
    binaryPath: kimi,
    cwd: root,
    env: { ...process.env, FAKE_KIMI_LOG: log, ...extra } as Record<string, string>,
  });
  return { result, calls: (await readFile(log, 'utf8')).trim().split('\n') };
}

describe('Kimi Code ACP hooks', () => {
  it('starts ACP mode with the supplied environment, updates off, and never authenticates', async () => {
    const env = { KIMI_CODE_HOME: '/profiles/kimi' };
    expect(await kimiAcp.launch({ binaryPath: '/tools/kimi', cwd: '.', env })).toEqual({
      command: '/tools/kimi',
      args: ['acp'],
      env: { ...env, KIMI_CODE_NO_AUTO_UPDATE: '1' },
      exitsOnClosedInput: true,
    });
    expect(kimiAcp.authMethodId).toBeUndefined();
  });

  it('passes the KIMI_MODEL_* variables through, so a machine can run Kimi on its own key', () => {
    expect(kimiAcp.inheritEnv).toEqual(
      expect.arrayContaining([
        'KIMI_MODEL_NAME',
        'KIMI_MODEL_API_KEY',
        'KIMI_MODEL_BASE_URL',
        'KIMI_MODEL_PROVIDER_TYPE',
      ])
    );
  });

  it.each([
    ['approval-required', 'default'],
    ['auto-accept-edits', 'default'],
    ['auto', 'yolo'],
    ['full-access', 'yolo'],
  ] as const)('puts %s sessions in Kimi mode %s', (mode, expected) => {
    expect(kimiAcp.sessionMode!(mode, undefined)).toBe(expected);
  });

  describe('sign-in', () => {
    it('is signed in when Kimi opens a session, which it then deletes', async () => {
      const { result, calls } = await check();
      expect(calls[0]).toContain('"elicitation":{"form":{}}');
      expect(result.status).toBe('authenticated');
      expect(calls.map((call) => call.split(' ')[0])).toEqual([
        'initialize',
        'session/new',
        'session/delete',
      ]);
      expect(calls[2]).toContain('"sessionId":"probe-session"');
      expect(calls.join('\n')).not.toContain('authenticate');
    });

    it('is signed out when Kimi requires authentication, with the login command', async () => {
      const { result, calls } = await check({ FAKE_KIMI_SIGNED_OUT: '1' });
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('kimi login');
      expect(calls.map((call) => call.split(' ')[0])).toEqual(['initialize', 'session/new']);
    });

    it('opens the probe session in an empty directory of its own, with no MCP servers', async () => {
      const { calls } = await check();
      const params = JSON.parse(calls[1]!.slice('session/new '.length)) as {
        cwd: string;
        mcpServers: unknown[];
      };
      expect(params.cwd).not.toBe(root);
      expect(params.mcpServers).toEqual([]);
    });
  });

  it('reads the MCP server from the tool name a permission request carries', () => {
    const servers = new Set(['echo']);
    expect(kimiAcp.mcpServerOf!({ toolCallId: 'call', title: 'mcp__echo__echo' }, servers)).toBe(
      'echo'
    );
    expect(kimiAcp.mcpServerOf!({ toolCallId: 'call', title: 'Bash' }, servers)).toBeUndefined();
    expect(kimiAcp.mcpServerOf!({ toolCallId: 'call' }, servers)).toBeUndefined();
  });

  it('names a session server as registered, though Kimi rewrote its name in the tool name', () => {
    // Kimi writes `my.tools` as `my_tools` and `a__b` as `a_b`.
    const servers = new Set(['switch', 'my.tools', 'a__b']);
    expect(kimiMcpServer('mcp__switch__post_message', servers)).toBe('switch');
    expect(kimiMcpServer('mcp__my_tools__search', servers)).toBe('my.tools');
    expect(kimiMcpServer('mcp__a_b__run', servers)).toBe('a__b');
    // A server of Kimi's own is read from the name.
    expect(kimiMcpServer('mcp__github__search', servers)).toBe('github');
    expect(kimiMcpServer('mcp__switch', servers)).toBeUndefined();
  });

  it('types the Agent tool as a subagent, from its title before its input arrives', () => {
    // How Kimi Code 2.5.2 opens an Agent call over ACP.
    expect(kimiAcp.itemType!({ toolCallId: 'call', title: 'Agent', kind: 'other' })).toBe(
      'subagent'
    );
    const call = (rawInput: Record<string, unknown>) => ({ toolCallId: 'call', rawInput });
    expect(kimiAcp.itemType!(call({ prompt: 'Read README.md', subagent_type: 'coder' }))).toBe(
      'subagent'
    );
    expect(kimiAcp.itemType!(call({ prompt: 'Continue', resume: 'agent-1' }))).toBe('subagent');
    // The titles Kimi gives its Agent and AgentSwarm calls once their input is in.
    for (const title of [
      'AgentSwarm',
      'Launching coder agent: Read README.md',
      'Launching background explore agent: Map the tests',
      'Launching agent swarm: Review each package',
    ])
      expect(kimiAcp.itemType!({ toolCallId: 'call', title })).toBe('subagent');
    expect(kimiAcp.itemType!({ toolCallId: 'call', title: 'Launching the tests' })).toBeUndefined();
    expect(kimiAcp.itemType!(call({ prompt: 'Read README.md' }))).toBeUndefined();
    expect(kimiAcp.itemType!(call({ command: 'ls' }))).toBeUndefined();
  });

  describe('permission requests', () => {
    const approval = [
      { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
      { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ];
    const request = (title: string, options = approval): AcpPermissionRequest => ({
      sessionId: 'session',
      toolCall: { toolCallId: 'call', title },
      options,
    });
    const context = (selected: AcpSelectedAnswer[]) => {
      let asked: UserInputQuestion[] = [];
      const ctx = {
        askQuestions: vi.fn(
          async (questions: UserInputQuestion[], answer: (s: AcpSelectedAnswer[]) => unknown) => {
            asked = questions;
            return answer(selected);
          }
        ),
      } as unknown as AcpSessionContext;
      return { ctx, asked: () => asked };
    };

    it.each([
      ['Write', 'edit'],
      ['Edit', 'edit'],
      ['Bash', 'execute'],
      ['Terminal', 'execute'],
      ['Read', undefined],
      ['mcp__echo__Write', undefined],
    ])('gives a %s request the kind %s and leaves it to the adapter', (title, kind) => {
      const { ctx } = context([]);
      const req = request(title);
      expect(kimiAcp.permission!(ctx, req)).toBeUndefined();
      expect(req.toolCall.kind).toBe(kind);
    });

    // How Kimi asks a question as a permission request when it cannot use a form.
    const question = (options: AcpPermissionRequest['options']): AcpPermissionRequest => ({
      sessionId: 'session',
      toolCall: {
        toolCallId: 'ask',
        title: 'AskUserQuestion',
        content: [{ type: 'content', content: { type: 'text', text: 'Which test runner?' } }],
      },
      options,
    });
    const runnerOptions = [
      { optionId: 'q0_opt_0', name: 'Jest', kind: 'allow_once' },
      { optionId: 'q0_opt_1', name: 'Vitest', kind: 'allow_once' },
      { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
    ];

    it('asks a question sent as a permission request as a question, without its Skip', async () => {
      const { ctx, asked } = context([{ questionId: 'ask', values: ['q0_opt_1'] }]);
      expect(await kimiAcp.permission!(ctx, question(runnerOptions))).toEqual({
        outcome: { outcome: 'selected', optionId: 'q0_opt_1' },
      });
      expect(asked()).toEqual([
        {
          id: 'ask',
          question: 'Which test runner?',
          options: [
            { value: 'q0_opt_0', label: 'Jest' },
            { value: 'q0_opt_1', label: 'Vitest' },
          ],
          multiSelect: false,
          allowCustomAnswer: false,
        },
      ]);
    });

    it('dismisses a question that offers nothing but Skip', async () => {
      const { ctx } = context([]);
      expect(await kimiAcp.permission!(ctx, question([runnerOptions[2]!]))).toEqual({
        outcome: { outcome: 'cancelled' },
      });
      expect(ctx.askQuestions).not.toHaveBeenCalled();
    });
  });

  it('asks every question of a form in Switch and answers in the form', async () => {
    let handler: ((params: unknown) => Promise<unknown>) | undefined;
    const askQuestions = vi.fn(
      async (_questions: UserInputQuestion[], answer: (s: AcpSelectedAnswer[]) => unknown) =>
        answer([
          { questionId: 'q0', values: ['Vitest'] },
          { questionId: 'q1', values: ['Unit', 'E2E'] },
        ])
    );
    kimiAcp.extensions!({ askQuestions } as unknown as AcpSessionContext, {
      request: (method, h) => {
        if (method === 'elicitation/create') handler = h as typeof handler;
      },
      notification: () => {},
    });
    // What Kimi sends for an AskUserQuestion with two questions.
    const answer = await handler!({
      sessionId: 'session',
      toolCallId: 'call',
      mode: 'form',
      message: 'Which test runner?\nWhich suites?',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: {
            type: 'string',
            title: 'Runner',
            oneOf: [
              { const: 'Jest', title: 'Jest' },
              { const: 'Vitest', title: 'Vitest' },
            ],
          },
          q1: {
            type: 'array',
            title: 'Suites',
            minItems: 1,
            items: {
              anyOf: [
                { const: 'Unit', title: 'Unit' },
                { const: 'E2E', title: 'E2E' },
              ],
            },
          },
        },
        required: ['q0', 'q1'],
      },
    });
    // Kimi titles each field with the question's header and puts the
    // questions themselves in the message, one a line.
    expect(
      askQuestions.mock.calls[0]![0].map((q) => [q.question, q.header, q.multiSelect])
    ).toEqual([
      ['Which test runner?', 'Runner', false],
      ['Which suites?', 'Suites', true],
    ]);
    expect(answer).toEqual({ action: 'accept', content: { q0: 'Vitest', q1: ['Unit', 'E2E'] } });
  });

  describe('form questions', () => {
    const field = (title: string) => ({
      type: 'string',
      title,
      oneOf: [
        { const: 'Yes', title: 'Yes' },
        { const: 'No', title: 'No' },
      ],
    });
    const form = (message: string, titles: string[]) => ({
      mode: 'form' as const,
      message,
      requestedSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(titles.map((title, i) => [`q${i}`, field(title)])),
        required: titles.map((_title, i) => `q${i}`),
      },
    });

    it('asks a lone question by the whole message, even one that breaks its own lines', () => {
      const [asked] = kimiQuestions(form('Ship it?\nIt has not been reviewed.', ['Ship']));
      expect([asked!.question, asked!.header]).toEqual([
        'Ship it?\nIt has not been reviewed.',
        'Ship',
      ]);
    });

    it('asks by the header when the lines cannot be told apart, and gives no header twice', () => {
      // Two questions in three lines: one of them broke its own line.
      const asked = kimiQuestions(form('First?\nstill first\nSecond?', ['One', 'Two']));
      expect(asked.map((q) => [q.question, q.header])).toEqual([
        ['One', undefined],
        ['Two', undefined],
      ]);
    });

    it('asks a question with no header by its own text, as Kimi titles it then', () => {
      const [asked] = kimiQuestions(form('Ship it?', ['Ship it?']));
      expect([asked!.question, asked!.header]).toEqual(['Ship it?', undefined]);
    });
  });
});
