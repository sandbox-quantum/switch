import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import type { AcpSelectedAnswer, AcpSessionContext } from '../acp/hooks';
import { ACP_CANCELLED } from '../acp/protocol';
import type { UserInputQuestion } from '../events';
import { writeNodeCli } from '../testing/index';
import { answerGrokQuestion, authMethod, grokAcp } from './grok-acp';

// A stand-in for `grok agent stdio`: answers `initialize` as Grok does with an
// account sign-in saved or without one, and logs every call it is sent.
const FAKE_GROK = `
const { appendFileSync } = require('node:fs');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    appendFileSync(process.env.FAKE_GROK_LOG, message.method + ' ' + JSON.stringify(message.params) + '\\n');
    const reply = (body) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }) + '\\n');
    if (message.method === 'initialize')
      reply({
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: process.env.FAKE_GROK_SIGNED_IN
            ? [{ id: 'cached_token' }, { id: 'grok.com' }]
            : [{ id: 'grok.com' }],
        },
      });
    else reply({ error: { code: -32601, message: 'Method not found' } });
  }
});
`;

let root: string;
let grok: string;
let log: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'switch-grok-test-'));
  grok = await writeNodeCli(root, 'grok', FAKE_GROK);
  log = join(root, 'calls.log');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function check(extra: Record<string, string>) {
  const result = await checkAcpSignIn(grokAcp, {
    binaryPath: grok,
    cwd: root,
    env: { PATH: process.env.PATH ?? '', FAKE_GROK_LOG: log, ...extra },
  });
  const calls = existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : [];
  return { result, calls: calls.map((call) => call.split(' ')[0]) };
}

describe('Grok Build ACP hooks', () => {
  it('runs grok as an ACP agent over stdio, without updating itself', async () => {
    const launch = await grokAcp.launch({ binaryPath: 'grok', cwd: '.', env: {} });
    expect(launch.args).toEqual(['--no-auto-update', 'agent', 'stdio']);
  });

  it('starts sessions with the API key when there is one, and never with the Grok account', () => {
    expect(authMethod({ XAI_API_KEY: 'xai-test' })).toBe('xai.api_key');
    expect(authMethod({ XAI_API_KEY: ' ' })).toBeUndefined();
    expect(authMethod({})).toBeUndefined();
    expect(grokAcp.authMethodId).toBe(authMethod);
    expect(grokAcp.inheritEnv).toContain('XAI_API_KEY');
    expect(grokAcp.loginCommand).toBe('grok login');
  });

  it('leaves full access to the adapter, as Grok has no session modes', () => {
    expect(grokAcp.sessionMode).toBeUndefined();
  });

  it('takes an API key as a sign-in without starting Grok', async () => {
    const { result, calls } = await check({ XAI_API_KEY: 'xai-test' });
    expect(result.status).toBe('authenticated');
    expect(calls).toEqual([]);
  });

  it('is signed in when Grok offers the account sign-in it saved, and never authenticates', async () => {
    const { result, calls } = await check({ FAKE_GROK_SIGNED_IN: '1' });
    expect(result.status).toBe('authenticated');
    expect(calls).toEqual(['initialize']);
  });

  it('is signed out, with both ways to sign in, when Grok has nothing saved', async () => {
    const { result, calls } = await check({});
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('grok login');
    expect(result.message).toContain('grok login --device-auth');
    expect(result.message).toContain('XAI_API_KEY');
    expect(calls).toEqual(['initialize']);
  });

  it('reads the MCP server from the tool use_tool calls, as Grok 1.0.77 sends it', () => {
    const servers = new Set(['echo', 'gws']);
    expect(
      grokAcp.mcpServerOf!(
        {
          toolCallId: 'c',
          title: 'use_tool',
          rawInput: { tool_name: 'echo__switch_echo', tool_input: { text: 'hi' } },
        },
        servers
      )
    ).toBe('echo');
    expect(grokAcp.mcpServerOf!({ toolCallId: 'c', title: 'echo__switch_echo' }, servers)).toBe(
      'echo'
    );
    expect(grokAcp.mcpServerOf!({ toolCallId: 'c', title: 'mcp__gws__send' }, servers)).toBe('gws');
    expect(
      grokAcp.mcpServerOf!(
        { toolCallId: 'c', title: 'Execute `echo hi > a.txt`', kind: 'execute' },
        servers
      )
    ).toBeUndefined();
    expect(
      grokAcp.mcpServerOf!({ toolCallId: 'c', title: 'run_terminal_command' }, servers)
    ).toBeUndefined();
  });

  it('places a call only on a server the session registered, the longest that fits', () => {
    expect(
      grokAcp.mcpServerOf!({ toolCallId: 'c', title: 'other__tool' }, new Set(['echo']))
    ).toBeUndefined();
    expect(
      grokAcp.mcpServerOf!({ toolCallId: 'c', title: 'my__srv__tool' }, new Set(['my', 'my__srv']))
    ).toBe('my__srv');
  });

  it('shows spawn_subagent calls as subagents', () => {
    expect(grokAcp.itemType!({ toolCallId: 'c', title: 'spawn_subagent' })).toBe('subagent');
    expect(
      grokAcp.itemType!({
        toolCallId: 'c',
        title: 'Read README first line',
        rawInput: { variant: 'Task', prompt: 'Read README.md' },
      })
    ).toBe('subagent');
    // Grok 1.0.77 renames the call after its task once the input is in, and
    // names the tool in `_meta` throughout.
    expect(
      grokAcp.itemType!({
        toolCallId: 'c',
        title: 'Reply with OK',
        _meta: { 'x.ai/tool': { name: 'spawn_subagent', kind: 'task', label: 'Subagent' } },
      })
    ).toBe('subagent');
    expect(
      grokAcp.itemType!({
        toolCallId: 'c',
        title: 'run_terminal_command',
        _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
      })
    ).toBeUndefined();
    expect(grokAcp.itemType!({ toolCallId: 'c', title: 'run_terminal_command' })).toBeUndefined();
  });

  describe('questions', () => {
    // What Grok 1.0.77 sends for its ask_user_question tool.
    const request = {
      sessionId: 's',
      toolCallId: 'call-1',
      mode: 'default',
      questions: [
        {
          question: 'Which color?',
          options: [
            { label: 'Red', description: 'Choose red.' },
            { label: 'Green', description: 'Choose green.' },
          ],
          multiSelect: null,
        },
        {
          question: 'Which suites?',
          options: [{ label: 'Unit' }, { label: 'E2E' }],
          multiSelect: true,
        },
      ],
    };
    /** A session whose user picks `selected`. */
    const context = (selected: AcpSelectedAnswer[]) => {
      const askQuestions = vi.fn(
        async (_questions: UserInputQuestion[], reply: (s: AcpSelectedAnswer[]) => unknown) =>
          reply(selected)
      );
      return { askQuestions, ctx: { askQuestions } as unknown as AcpSessionContext };
    };

    it('asks each question in Switch and answers with the labels chosen, keyed by question', async () => {
      const { askQuestions, ctx } = context([
        { questionId: '0', values: ['Green'] },
        { questionId: '1', values: ['Unit', 'E2E'] },
      ]);
      expect(await answerGrokQuestion(ctx, request)).toEqual({
        outcome: 'accepted',
        answers: { 'Which color?': 'Green', 'Which suites?': 'Unit, E2E' },
      });
      expect(
        askQuestions.mock.calls[0]![0].map((q) => [q.question, q.multiSelect, q.options.length])
      ).toEqual([
        ['Which color?', false, 2],
        ['Which suites?', true, 2],
      ]);
    });

    it('answers cancelled when the question is cancelled in Switch', async () => {
      const askQuestions = vi.fn(async () => ACP_CANCELLED);
      const ctx = { askQuestions } as unknown as AcpSessionContext;
      expect(await answerGrokQuestion(ctx, request)).toEqual({ outcome: 'cancelled' });
    });

    it('answers Grok on its own request', () => {
      const methods: string[] = [];
      grokAcp.extensions!({} as AcpSessionContext, {
        request: (method) => methods.push(method),
        notification: () => {},
      });
      expect(methods).toEqual(['_x.ai/ask_user_question']);
      expect(grokAcp.capabilities.userInput).toBe(true);
    });
  });
});
