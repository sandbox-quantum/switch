import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { acpInitialize } from '../acp/acp-adapter';
import type { AcpSessionResult } from '../acp/protocol';
import type { ProviderSessionStartInput } from '../adapter';
import { findOnPath, execProvider } from '../provider-process';
import { providerRuntime } from '../providers/registry';
import { EventRecorder } from '../testing/event-recorder';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import { createDeepseekHarnessAdapter, deepseekHarnessAcp } from './deepseek-harness-acp';

const env = Object.fromEntries(
  [
    'PATH',
    'HOME',
    'USERPROFILE',
    'DSH_HOME',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'DSH_TELEMETRY_DISABLED',
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
);

it.for([
  'accept',
  'decline',
  'auto-approve',
  'interrupt',
  'room-tool',
  'room-tool-http',
  'connector-tool',
] as const)(
  'real CLI selects the model and handles %s for a tool through a local Messages endpoint',
  { timeout: 120_000 },
  async (decision, ctx) => {
    if (!(await findOnPath('dsh', process.env.PATH))) return ctx.skip('dsh is not installed');
    const requests: Array<{ model: string; messages: unknown[]; tools: Array<{ name: string }> }> =
      [];
    const mcp =
      decision === 'room-tool' || decision === 'room-tool-http' || decision === 'connector-tool';
    const endpoint = createServer(async (request, response) => {
      if (request.url === '/mcp' && request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/mcp') {
        const server = new McpServer({ name: 'room-tools', version: '1.0.0' });
        server.registerTool(
          'switch_echo',
          { inputSchema: { text: z.string() } },
          async ({ text }) => ({
            content: [{ type: 'text', text }],
          })
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on('close', () => {
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
        return;
      }
      requests.push(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const toolCall = requests.length === 1;
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'local-message',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-v4-pro',
            content: [],
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: toolCall
            ? {
                type: 'tool_use',
                id: 'local-tool',
                name: mcp
                  ? requests[0]!.tools.find((tool) => tool.name.startsWith('mcp__'))!.name
                  : 'write',
                input: {},
              }
            : { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: toolCall
            ? {
                type: 'input_json_delta',
                partial_json: JSON.stringify(
                  mcp
                    ? { text: 'LOCAL_MCP_OK' }
                    : {
                        file_path: 'marker.txt',
                        content: 'LOCAL_TOOL_OK',
                        sandbox_permissions: 'danger-full-access',
                        justification:
                          'Exercise one-shot permission handling in a temporary test directory.',
                      }
                ),
              }
            : { type: 'text_delta', text: 'LOCAL_MODEL_OK' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: 'message_stop' },
      ];
      for (const event of events)
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    endpoint.listen(0, '127.0.0.1');
    await once(endpoint, 'listening');
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('Missing local endpoint address');
    const cwd = await mkdtemp(join(tmpdir(), 'switch-dsh-model-'));
    const home = await mkdtemp(join(tmpdir(), 'switch-dsh-model-home-'));
    const adapter = createDeepseekHarnessAdapter();
    const recorder = new EventRecorder(adapter);
    let answer: Promise<void> | undefined;
    const unsubscribe = adapter.subscribe((event) => {
      if (
        event.type !== 'request.opened' ||
        decision === 'auto-approve' ||
        decision === 'room-tool' ||
        decision === 'room-tool-http'
      )
        return;
      if (decision === 'interrupt') {
        answer = adapter
          .sendTurn({
            sessionId: 'selected-model',
            turnId: 'queued',
            text: 'Reply after interruption.',
          })
          .then(() => adapter.interruptTurn('selected-model'));
      } else {
        answer = adapter.respondToRequest(
          'selected-model',
          event.requestId,
          decision === 'connector-tool' ? 'accept' : decision
        );
      }
    });
    const input: ProviderSessionStartInput = {
      sessionId: 'selected-model',
      cwd,
      runtimeMode: decision === 'auto-approve' ? 'full-access' : 'approval-required',
      env: {
        ...env,
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DEEPSEEK_API_KEY: 'local-endpoint-placeholder',
      },
      mcpServers: mcp
        ? {
            'Room tools!':
              decision === 'room-tool-http'
                ? { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` }
                : echoMcpServerSpec(),
          }
        : {},
      connectorMcpServers: decision === 'connector-tool' ? ['Room tools!'] : [],
      model: { id: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']) },
    };
    try {
      if (decision === 'accept') {
        const runtime = providerRuntime('deepseek-harness');
        const probe = { binaryPath: 'dsh', cwd, env: input.env };
        expect(
          (await runtime.checkSignIn({ ...probe, env: { ...input.env, DEEPSEEK_API_KEY: '' } }))
            .status
        ).toBe('unauthenticated');
        expect((await runtime.checkSignIn(probe)).status).toBe('authenticated');
        expect(requests).toHaveLength(0);
      }
      const session = await adapter.startSession(input);
      await adapter.sendTurn({
        sessionId: 'selected-model',
        turnId: 'model-turn',
        text: 'Reply briefly.',
      });
      const completed = await recorder.waitFor('turn.completed', () => true, 60_000);
      await answer;
      expect(completed.outcome).toBe(decision === 'interrupt' ? 'interrupted' : 'completed');
      if (decision === 'interrupt') {
        const queued = await recorder.waitFor(
          'turn.completed',
          (event) => event.turnId === 'queued'
        );
        expect(queued.outcome).toBe('completed');
      }
      expect(recorder.assistantText(decision === 'interrupt' ? 'queued' : 'model-turn')).toBe(
        'LOCAL_MODEL_OK'
      );
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.model === 'deepseek-v4-pro')).toBe(true);
      expect(recorder.ofType('request.opened')).toHaveLength(
        decision === 'auto-approve' || mcp ? 0 : 1
      );
      expect(
        recorder
          .ofType('item.started')
          .some((event) => event.item.type === (mcp ? 'mcp_tool_call' : 'file_change'))
      ).toBe(true);
      if (mcp) {
        expect(JSON.stringify(requests.at(-1)!.messages)).toContain('LOCAL_MCP_OK');
        // DSH's native policy permits ordinary MCP calls without asking ACP,
        // even for connectors. Fake-server tests cover requests when exposed.
      } else if (decision === 'decline' || decision === 'interrupt')
        await expect(readFile(join(cwd, 'marker.txt'), 'utf8')).rejects.toThrow();
      else expect(await readFile(join(cwd, 'marker.txt'), 'utf8')).toBe('LOCAL_TOOL_OK');
      if (decision === 'accept') {
        await adapter.stopAll();
        const restored = await adapter.startSession({
          ...input,
          model: undefined,
          resume: { nativeSessionId: session.nativeSessionId },
        });
        expect(restored.nativeSessionId).toBe(session.nativeSessionId);
        await adapter.sendTurn({
          sessionId: input.sessionId,
          turnId: 'after-restart',
          text: 'Continue the saved conversation.',
        });
        const continued = await recorder.waitFor(
          'turn.completed',
          (event) => event.turnId === 'after-restart'
        );
        expect(continued.outcome).toBe('completed');
        const history = JSON.stringify(requests.at(-1)!.messages);
        expect(history).toContain('Reply briefly.');
        expect(history).toContain('LOCAL_MODEL_OK');
        expect(history).toContain('LOCAL_TOOL_OK');
        expect(requests.at(-1)!.model).toBe('deepseek-v4-pro');
      }
    } finally {
      await adapter.stopAll();
      unsubscribe();
      recorder.dispose();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      await Promise.all([cwd, home].map((dir) => rm(dir, { recursive: true, force: true })));
    }
  }
);

describeConformance('deepseek-harness', {
  createAdapter: async () => createDeepseekHarnessAdapter(),
  approvalPromptSuffix:
    'Request explicit per-call sandbox escalation: set sandbox_permissions to "danger-full-access" and supply a nonempty justification on the shell tool call, so the ACP client can approve or deny it.',
  unavailableReason: async () => {
    const binaryPath = await findOnPath('dsh', process.env.PATH);
    if (!binaryPath) return 'the dsh binary is not on PATH';
    try {
      await execProvider(binaryPath, ['--version'], { env, timeout: 10_000 });
      const result = await providerRuntime('deepseek-harness').checkSignIn({
        binaryPath,
        cwd: process.cwd(),
        env,
      });
      return result.status === 'authenticated' ? null : result.message;
    } catch {
      return 'dsh could not start; check the ACP profile installation';
    }
  },
  skip: {
    'user-input':
      'Official dsh-acp 0.2.1-rc.5 omits elicitation and interactive question extensions (2026-11-04).',
    subagent:
      'Official dsh-acp 0.2.1-rc.5 exposes generic tool lifecycle only, without structured subagent activity (2026-11-04).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});

it('real CLI discovers models, applies selection, and resumes a session without a model call', async (ctx) => {
  if (!(await findOnPath('dsh', process.env.PATH))) return ctx.skip('dsh is not installed');
  const cwd = await mkdtemp(join(tmpdir(), 'switch-dsh-protocol-'));
  const home = await mkdtemp(join(tmpdir(), 'switch-dsh-protocol-home-'));
  const adapter = createDeepseekHarnessAdapter();
  let resumed: StdioJsonRpcClient | undefined;
  const input = {
    sessionId: 'protocol',
    cwd,
    runtimeMode: 'approval-required' as const,
    env: { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    mcpServers: {},
    connectorMcpServers: [],
  };
  try {
    const session = await adapter.startSession(input);
    const models = await adapter.listModels(input.sessionId);
    expect(models.length).toBeGreaterThan(0);
    const selected = models.find((model) => model.id.includes('deepseek-v4-pro')) ?? models[0]!;
    await adapter.setModel(input.sessionId, { id: selected.id });
    await adapter.stopAll();
    resumed = new StdioJsonRpcClient({
      command: 'dsh',
      args: ['--profile', 'acp'],
      env: input.env,
      cwd,
      logger: noopLogger,
      onExit: () => {},
    });
    const initialized = await acpInitialize(resumed, deepseekHarnessAcp);
    expect(initialized.authMethods).toEqual([]);
    expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toBeDefined();
    expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    const restored = await resumed.request<AcpSessionResult>('session/resume', {
      sessionId: session.nativeSessionId,
      cwd,
      mcpServers: [],
    });
    expect(restored.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe(
      selected.id
    );
  } finally {
    await Promise.allSettled([adapter.stopAll(), resumed?.dispose()]);
    await Promise.all([cwd, home].map((dir) => rm(dir, { recursive: true, force: true })));
  }
}, 120_000);
