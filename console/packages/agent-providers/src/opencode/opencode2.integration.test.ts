import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderRuntimeEvent } from '../events';
import { checkOpencodeSignInAnyLine, createOpencodeRuntimeAdapter } from './runtime';

/**
 * OpenCode 2 itself, driven through the runtime adapter, against a scripted
 * stand-in for a model: an OpenAI-compatible endpoint that answers each turn
 * with the next scripted step. Needs a 2.x binary in SWITCH_OPENCODE2_BIN;
 * nothing here reaches a real model provider.
 */
const BINARY = process.env['SWITCH_OPENCODE2_BIN'];

type Step =
  | { tool: string; args: Record<string, unknown> }
  | { text: string; delayMs?: number; reasoning?: string };

let server: Server;
let script: Step[] = [];
const seen: Array<Array<{ role: string; content: unknown }>> = [];
const bodies: string[] = [];

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'scripted',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish
      ? {
          usage: {
            prompt_tokens: 120,
            completion_tokens: 7,
            total_tokens: 127,
            prompt_tokens_details: { cached_tokens: 100 },
          },
        }
      : {}),
  })}\n\n`;
}

async function startModel(): Promise<string> {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (data: Buffer) => (body += data.toString()));
    request.on('end', () => {
      const json = JSON.parse(body || '{}') as {
        tools?: unknown[];
        messages?: Array<{ role: string; content: unknown }>;
      };
      // Title generation and the like carry no tools; only the agent's own
      // calls take a scripted step.
      const step: Step = json.tools?.length ? (script.shift() ?? { text: 'done' }) : { text: 'T' };
      if (json.tools?.length) {
        seen.push(json.messages ?? []);
        bodies.push(body);
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(
        () => {
          if ('tool' in step)
            response.write(
              chunk(
                {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${seen.length}`,
                      type: 'function',
                      function: { name: step.tool, arguments: JSON.stringify(step.args) },
                    },
                  ],
                },
                'tool_calls'
              )
            );
          else {
            if (step.reasoning)
              response.write(chunk({ role: 'assistant', reasoning_content: step.reasoning }, null));
            response.write(chunk({ role: 'assistant', content: step.text }, 'stop'));
          }
          response.end('data: [DONE]\n\n');
        },
        'delayMs' in step ? (step.delayMs ?? 0) : 0
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

/** A summary in the shape OpenCode 2's compaction requires. */
const COMPACTION_SUMMARY = [
  '## Objective',
  '- the word kiwi, compacted',
  '',
  '## Requirements',
  '- (none)',
  '',
  '## Decisions',
  '- (none)',
  '',
  '## Work State',
  '### Completed',
  '- (none)',
  '',
  '### Active',
  '- (none)',
  '',
  '### Blocked',
  '- (none)',
  '',
  '## Next Move',
  '1. (none)',
  '',
  '## Relevant Files',
  '- (none)',
  '',
  '## Important Context',
  '- (none)',
].join('\n');

const ECHO_MCP = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params.arguments.text }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

describe.skipIf(!BINARY)('OpenCode 2 through opencode acp', () => {
  let root: string;
  let cwd: string;
  let env: Record<string, string>;
  let echo: string;

  beforeAll(async () => {
    const baseURL = await startModel();
    root = mkdtempSync(join(tmpdir(), 'opencode2-'));
    cwd = join(root, 'work');
    mkdirSync(cwd);
    mkdirSync(join(root, 'home', '.config', 'opencode'), { recursive: true });
    writeFileSync(
      join(root, 'home', '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        provider: {
          scripted: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Scripted',
            options: { baseURL, apiKey: 'unused' },
            models: { model: { name: 'Scripted', tool_call: true } },
          },
        },
        model: 'scripted/model',
      })
    );
    echo = join(root, 'echo-mcp.cjs');
    writeFileSync(echo, ECHO_MCP);
    env = { PATH: process.env['PATH'] ?? '', HOME: join(root, 'home') };
  });
  afterAll(() => {
    server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  function adapter() {
    const runtime = createOpencodeRuntimeAdapter({
      binaryPath: BINARY,
      logger: undefined,
      skills: [
        {
          name: 'switch',
          content: '---\nname: switch\ndescription: Working in Switch rooms.\n---\nBody',
        },
      ],
    });
    const events: ProviderRuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const next = async <T extends ProviderRuntimeEvent['type']>(type: T, after = 0) => {
      for (let waited = 0; waited < 60_000; waited += 50) {
        const found = events.slice(after).find((event) => event.type === type);
        if (found) return found as Extract<ProviderRuntimeEvent, { type: T }>;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no ${type}: ${JSON.stringify(events.map((event) => event.type))}`);
    };
    return { runtime, events, next };
  }

  it('reports the connected provider when signed in', async () => {
    const result = await checkOpencodeSignInAnyLine({ binaryPath: BINARY!, cwd, env });
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('Scripted');
  });

  it('asks before a command, runs it once allowed, and resumes the conversation', async () => {
    const { runtime, events, next } = adapter();
    script = [{ tool: 'bash', args: { command: 'echo hi > made.txt' } }, { text: 'made it' }];
    const session = await runtime.startSession({
      sessionId: 's1',
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: {},
      connectorMcpServers: [],
    });
    expect(session.nativeSessionId).toMatch(/^ses/);
    await runtime.sendTurn({ sessionId: 's1', turnId: 't1', text: 'make a file' });
    const request = await next('request.opened');
    expect(request.requestType).toBe('command_execution_approval');
    // "Always allow" outlives the session in OpenCode 2, so it is not offered.
    expect(request.options.map((option) => option.decision)).not.toContain('acceptForSession');
    await runtime.respondToRequest('s1', request.requestId, 'accept');
    const done = await next('turn.completed');
    expect(done.outcome).toBe('completed');
    expect(bodies.at(-1)).toContain('Working in Switch rooms.');
    await runtime.stopSession('s1');

    script = [{ text: 'still here' }];
    const resumed = await runtime.startSession({
      sessionId: 's2',
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: {},
      connectorMcpServers: [],
      resume: { nativeSessionId: session.nativeSessionId },
    });
    expect(resumed.nativeSessionId).toBe(session.nativeSessionId);
    const before = events.length;
    await runtime.sendTurn({ sessionId: 's2', turnId: 't2', text: 'again' });
    expect((await next('turn.completed', before)).outcome).toBe('completed');
    expect(JSON.stringify(seen.at(-1))).toContain('make a file');
    await runtime.stopAll();
  });

  it("calls a registered server's tools without asking, and asks for a connector's", async () => {
    const { runtime, next, events } = adapter();
    const spec = { transport: 'stdio' as const, command: 'node', args: [echo] };
    script = [{ tool: 'switch_echo', args: { text: 'a' } }, { text: 'ok' }];
    await runtime.startSession({
      sessionId: 'm1',
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: { switch: spec, github: spec },
      connectorMcpServers: ['github'],
    });
    await runtime.sendTurn({ sessionId: 'm1', turnId: 't1', text: 'echo' });
    expect((await next('turn.completed')).outcome).toBe('completed');
    expect(events.some((event) => event.type === 'request.opened')).toBe(false);

    script = [{ tool: 'github_echo', args: { text: 'b' } }, { text: 'ok' }];
    const before = events.length;
    await runtime.sendTurn({ sessionId: 'm1', turnId: 't2', text: 'connector' });
    const request = await next('request.opened', before);
    expect(request.connector).toBe('github');
    await runtime.respondToRequest('m1', request.requestId, 'accept');
    expect((await next('turn.completed', before)).outcome).toBe('completed');
    await runtime.stopAll();
  });

  it('asks its questions through Switch', async () => {
    const { runtime, next } = adapter();
    script = [
      {
        tool: 'question',
        args: {
          questions: [
            {
              question: 'Which color?',
              header: 'Color',
              options: [
                { label: 'Red', description: 'warm' },
                { label: 'Blue', description: 'cool' },
              ],
            },
          ],
        },
      },
      { text: 'thanks' },
    ];
    await runtime.startSession({
      sessionId: 'q1',
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: {},
      connectorMcpServers: [],
    });
    await runtime.sendTurn({ sessionId: 'q1', turnId: 't1', text: 'ask me' });
    const asked = await next('user-input.requested');
    expect(asked.questions[0]?.options.map((option) => option.label)).toEqual(['Red', 'Blue']);
    const question = asked.questions[0]!;
    await runtime.respondToUserInput('q1', asked.requestId, { [question.id]: ['Red'] });
    expect((await next('turn.completed')).outcome).toBe('completed');
    expect(JSON.stringify(seen.at(-1))).toContain('Red');
    await runtime.stopAll();
  });

  it('shows its reasoning, reports what a turn spent, and applies the effort chosen', async () => {
    const { runtime, next, events } = adapter();
    script = [{ text: 'answer', reasoning: 'thinking it over' }];
    await runtime.startSession({
      sessionId: 'r1',
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: {},
      connectorMcpServers: [],
    });
    const models = await runtime.listModels('r1');
    expect(models.find((model) => model.id === 'scripted/model')?.options['effort']).toContain(
      'high'
    );
    await runtime.setModel('r1', { id: 'scripted/model', options: { effort: 'high' } });
    await runtime.sendTurn({ sessionId: 'r1', turnId: 't1', text: 'think' });
    const done = await next('turn.completed');
    expect(done.usage).toEqual([
      {
        model: 'scripted/model',
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
      },
    ]);
    const reasoning = events.find(
      (event) => event.type === 'item.completed' && event.item.type === 'reasoning'
    );
    expect(reasoning && 'item' in reasoning && reasoning.item.text).toBe('thinking it over');
    expect(bodies.at(-1)).toContain('"reasoning_effort":"high"');
    await runtime.stopAll();
  });

  it('compacts the conversation between turns', async () => {
    const { runtime, next, events } = adapter();
    script = [{ text: 'first' }, { text: COMPACTION_SUMMARY }, { text: 'after' }];
    await runtime.startSession({
      sessionId: 'c1',
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: {},
      connectorMcpServers: [],
    });
    expect(await runtime.canCompact('c1')).toBe(true);
    await runtime.sendTurn({ sessionId: 'c1', turnId: 't1', text: 'remember the word kiwi' });
    expect((await next('turn.completed')).outcome).toBe('completed');
    await runtime.compactSession('c1');
    expect(JSON.stringify(seen.at(-1))).toContain('summarize the conversation');
    const before = events.length;
    await runtime.sendTurn({ sessionId: 'c1', turnId: 't2', text: 'and now' });
    expect((await next('turn.completed', before)).outcome).toBe('completed');
    expect(JSON.stringify(seen.at(-1))).toContain('the word kiwi, compacted');
    await runtime.stopAll();
  });

  it('reports a compaction OpenCode could not make', async () => {
    const { runtime, next } = adapter();
    script = [{ text: 'first' }, { text: 'not a summary' }];
    await runtime.startSession({
      sessionId: 'c2',
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: {},
      connectorMcpServers: [],
    });
    await runtime.sendTurn({ sessionId: 'c2', turnId: 't1', text: 'hi' });
    expect((await next('turn.completed')).outcome).toBe('completed');
    await expect(runtime.compactSession('c2')).rejects.toThrow('could not compact the session');
    await runtime.stopAll();
  });

  it('steers a message into the running turn', async () => {
    const { runtime, next } = adapter();
    script = [{ text: 'first', delayMs: 3000 }, { text: 'second' }];
    await runtime.startSession({
      sessionId: 'st1',
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: {},
      connectorMcpServers: [],
    });
    await runtime.sendTurn({ sessionId: 'st1', turnId: 't1', text: 'start' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const steered = await runtime.sendTurn({
      sessionId: 'st1',
      turnId: 't2',
      text: 'also this',
      expectedTurnId: 't1',
    });
    expect(steered).toEqual({ turnId: 't2', steeredInto: 't1' });
    expect((await next('turn.completed')).turnId).toBe('t1');
    expect(JSON.stringify(seen.at(-1))).toContain('also this');
    await runtime.stopAll();
  });
});
