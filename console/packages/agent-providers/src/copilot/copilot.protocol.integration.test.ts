import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acpInitialize } from '../acp/acp-adapter';
import type { AcpPermissionRequest, AcpSessionResult } from '../acp/protocol';
import type { ProviderSessionStartInput } from '../adapter';
import { EventRecorder } from '../testing/event-recorder';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import { checkCopilotSignIn, copilotAcp, createCopilotAdapter } from './copilot-adapter';
import { copilotEchoFixture } from './http-echo-fixture';

// Real Copilot process and tools, deterministic local inference. This suite
// proves protocol behavior, not real model quality or GitHub account access.
const probe = spawnSync('copilot', ['--version'], { encoding: 'utf8', timeout: 15_000 });
const available = !probe.error && probe.status === 0;
if (!available) console.info('Copilot protocol tests skipped: copilot is not installed on PATH.');

describe.skipIf(!available)('Copilot CLI with mocked BYOK inference', () => {
  let cwd: string;
  let env: Record<string, string>;
  let server: Server;
  let callTool: boolean;
  let mcpToolName: string | undefined;
  let requests: Array<{ model: string; messages: unknown[] }>;
  const adapters: ReturnType<typeof createCopilotAdapter>[] = [];
  const clients: StdioJsonRpcClient[] = [];
  const fixtures: Awaited<ReturnType<typeof copilotEchoFixture>>[] = [];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'switch-copilot-protocol-'));
    requests = [];
    callTool = true;
    mcpToolName = undefined;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number];
      requests.push(body);
      const tool = callTool;
      callTool = false;
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `probe-call-${requests.length}`,
                type: 'function',
                function: {
                  name: mcpToolName ?? (process.platform === 'win32' ? 'powershell' : 'bash'),
                  arguments: JSON.stringify(
                    mcpToolName
                      ? { text: 'MCP_OK' }
                      : {
                          command:
                            process.platform === 'win32'
                              ? 'Set-Content -Path probe.txt -Value verified -NoNewline'
                              : 'printf verified > probe.txt',
                          description: 'Write probe file',
                        }
                  ),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'PROTOCOL_OK' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [part, finish] of [
        [delta, null],
        [{}, tool ? 'tool_calls' : 'stop'],
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: 'probe',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: part, finish_reason: finish }],
          })}\n\n`
        );
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    env = {};
    for (const name of ['PATH', 'HOME', 'USER', 'SHELL', 'SYSTEMROOT', 'TEMP', 'TMP']) {
      if (process.env[name] !== undefined) env[name] = process.env[name]!;
    }
    Object.assign(env, {
      HOME: cwd,
      USERPROFILE: cwd,
      COPILOT_HOME: join(cwd, 'profile'),
      COPILOT_OFFLINE: 'true',
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      COPILOT_PROVIDER_MODEL_ID: 'gpt-4.1',
      COPILOT_PROVIDER_WIRE_MODEL: 'switch-protocol-model',
    });
  });

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
    await Promise.all(clients.splice(0).map((client) => client.dispose()));
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function start(overrides: Partial<ProviderSessionStartInput> = {}) {
    const adapter = createCopilotAdapter();
    adapters.push(adapter);
    const recorder = new EventRecorder(adapter);
    const session = await adapter.startSession({
      sessionId: 's',
      cwd,
      env,
      runtimeMode: 'approval-required',
      mcpServers: {},
      connectorMcpServers: [],
      ...overrides,
    });
    return { adapter, recorder, session };
  }

  it('detects signed out without login, then BYOK session access without inference', async () => {
    const { COPILOT_OFFLINE: _offline, COPILOT_PROVIDER_BASE_URL: _url, ...signedOut } = env;
    expect(await checkCopilotSignIn({ binaryPath: 'copilot', cwd, env: signedOut })).toMatchObject({
      status: 'unauthenticated',
      message: expect.stringContaining('copilot login'),
    });
    expect(await checkCopilotSignIn({ binaryPath: 'copilot', cwd, env })).toMatchObject({
      status: 'authenticated',
    });
    expect(requests).toHaveLength(0);
  }, 30_000);

  it.each(['accept', 'decline'] as const)(
    'enforces %s and reports tool activity',
    async (decision) => {
      const { adapter, recorder } = await start();
      await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'Run the probe.' });
      const opened = await recorder.waitFor('request.opened');
      await expect(readFile(join(cwd, 'probe.txt'), 'utf8')).rejects.toThrow();
      await adapter.respondToRequest('s', opened.requestId, decision);
      await recorder.waitFor('turn.completed');
      if (decision === 'accept')
        expect(await readFile(join(cwd, 'probe.txt'), 'utf8')).toBe('verified');
      else await expect(readFile(join(cwd, 'probe.txt'), 'utf8')).rejects.toThrow();
      expect(recorder.ofType('item.started')).toContainEqual(
        expect.objectContaining({ item: expect.objectContaining({ type: 'command_execution' }) })
      );
      expect(recorder.ofType('item.completed')).not.toHaveLength(0);
      expect(recorder.assistantText('t')).toBe(
        decision === 'accept' ? 'PROTOCOL_OK' : 'Info: Operation cancelled by user'
      );
      expect(requests.every((request) => request.model === 'switch-protocol-model')).toBe(true);
    },
    30_000
  );

  it('auto-approves through Switch in full access without --yolo', async () => {
    const { adapter, recorder } = await start({ runtimeMode: 'full-access' });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'Run the probe.' });
    await recorder.waitFor('turn.completed');
    expect(recorder.ofType('request.opened')).toHaveLength(0);
    expect(await readFile(join(cwd, 'probe.txt'), 'utf8')).toBe('verified');
  }, 30_000);

  it.each([false, true])(
    'calls registered HTTP MCP tools while respecting connector approval (connector: %s)',
    async (connector) => {
      const echo = await copilotEchoFixture();
      fixtures.push(echo);
      const name = connector ? 'service-echo' : 'echo';
      mcpToolName = `${name}-switch_echo`;
      const { adapter, recorder } = await start({
        mcpServers: { [name]: echo.spec },
        connectorMcpServers: connector ? [name] : [],
      });
      await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'Call the echo tool.' });
      if (connector) {
        const permission = await recorder.waitFor('request.opened');
        expect(permission.requestType).toBe('mcp_tool_approval');
        expect(echo.calls).toHaveLength(0);
        await adapter.respondToRequest('s', permission.requestId, 'decline');
      }
      await recorder.waitFor('turn.completed');
      if (connector) expect(echo.calls).toHaveLength(0);
      else {
        expect(recorder.ofType('request.opened')).toHaveLength(0);
        expect(echo.calls).toEqual([{ name: 'switch_echo', args: { text: 'MCP_OK' } }]);
      }
    },
    30_000
  );

  it('requires shell approval in edit-only auto approval', async () => {
    const { adapter, recorder } = await start({ runtimeMode: 'auto-accept-edits' });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'Run the probe.' });
    const opened = await recorder.waitFor('request.opened');
    await adapter.respondToRequest('s', opened.requestId, 'decline');
    await recorder.waitFor('turn.completed');
    await expect(readFile(join(cwd, 'probe.txt'), 'utf8')).rejects.toThrow();
  }, 30_000);

  it('keeps allow-for-session approval out of a new native session', async () => {
    const first = await start();
    await first.adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'Run the probe.' });
    const permission = await first.recorder.waitFor('request.opened');
    await first.adapter.respondToRequest('s', permission.requestId, 'acceptForSession');
    await first.recorder.waitFor('turn.completed');
    expect(await readFile(join(cwd, 'probe.txt'), 'utf8')).toBe('verified');
    await first.adapter.stopAll();
    await rm(join(cwd, 'probe.txt'));
    callTool = true;
    const second = await start({ sessionId: 'fresh' });
    await second.adapter.sendTurn({ sessionId: 'fresh', turnId: 'two', text: 'Run the probe.' });
    const nextPermission = await second.recorder.waitFor('request.opened');
    await second.adapter.respondToRequest('fresh', nextPermission.requestId, 'decline');
    await second.recorder.waitFor('turn.completed');
    await expect(readFile(join(cwd, 'probe.txt'), 'utf8')).rejects.toThrow();
  }, 30_000);

  it('cancels a permission, interrupts the turn and delivers the queued message', async () => {
    const { adapter, recorder } = await start();
    await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'Run the probe.' });
    await recorder.waitFor('request.opened');
    await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'Queued room mention.' });
    expect(requests).toHaveLength(1);
    await adapter.interruptTurn('s');
    expect(
      await recorder.waitFor('turn.completed', (event) => event.turnId === 'one')
    ).toMatchObject({
      outcome: 'interrupted',
    });
    await recorder.waitFor('turn.completed', (event) => event.turnId === 'two');
    expect(recorder.assistantText('two')).toBe('PROTOCOL_OK');
    await expect(readFile(join(cwd, 'probe.txt'), 'utf8')).rejects.toThrow();
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Queued room mention.');
  }, 30_000);

  it('loads the native session after process restart with its room context', async () => {
    const first = await start({
      runtimeMode: 'full-access',
      systemContext: 'Room context marker: shared project goals.',
    });
    await first.adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'Remember ROOM_MARKER.' });
    await first.recorder.waitFor('turn.completed');
    expect(await readFile(join(cwd, 'probe.txt'), 'utf8')).toBe('verified');
    await rm(join(cwd, 'probe.txt'));
    await first.adapter.stopAll();
    callTool = true;
    const second = await start({ resume: { nativeSessionId: first.session.nativeSessionId } });
    await second.adapter.sendTurn({
      sessionId: 's',
      turnId: 'two',
      text: 'Resume the conversation.',
    });
    const permission = await second.recorder.waitFor('request.opened');
    await second.adapter.respondToRequest('s', permission.requestId, 'decline');
    await second.recorder.waitFor('turn.completed');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('ROOM_MARKER');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('shared project goals');
    expect(second.session.nativeSessionId).toBe(first.session.nativeSessionId);
    await expect(readFile(join(cwd, 'probe.txt'), 'utf8')).rejects.toThrow();
  }, 30_000);

  it('records whether native --yolo bypasses ACP permission requests in this CLI version', async () => {
    const client = new StdioJsonRpcClient({
      command: 'copilot',
      args: ['--acp', '--stdio', '--yolo'],
      cwd,
      env,
      logger: noopLogger,
      onExit: () => {},
    });
    clients.push(client);
    const permissions: AcpPermissionRequest[] = [];
    client.onServerRequest('session/request_permission', async (request) => {
      permissions.push(request as AcpPermissionRequest);
      return { outcome: { outcome: 'cancelled' } };
    });
    const handshake = await acpInitialize(client, copilotAcp);
    const session = await client.request<AcpSessionResult>('session/new', { cwd, mcpServers: [] });
    await client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Run the probe.' }],
    });
    console.info(
      `Copilot ${handshake.agentInfo?.version}: --yolo permission requests=${permissions.length}`
    );
    // Both historical behaviors are safe to probe: the handler refuses every
    // request, and the only proposed command writes inside this temporary cwd.
    if (permissions.length === 0)
      expect(await readFile(join(cwd, 'probe.txt'), 'utf8')).toBe('verified');
    else await expect(readFile(join(cwd, 'probe.txt'), 'utf8')).rejects.toThrow();
  }, 30_000);
});
