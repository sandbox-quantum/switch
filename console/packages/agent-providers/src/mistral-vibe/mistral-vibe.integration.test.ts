import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acpInitialize, checkAcpSignIn } from '../acp/acp-adapter';
import type { AcpSessionResult } from '../acp/protocol';
import { ProviderConversationUnavailableError } from '../adapter';
import { findOnPath } from '../provider-process';
import { describeConformance, echoMcpServerSpec, EventRecorder } from '../testing/index';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import { createMistralVibeAdapter, mistralVibeAcp } from './mistral-vibe-acp';

const binary = 'vibe-acp';
const installed = () => {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return !result.error && result.status === 0;
};
const env = Object.fromEntries(
  [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TMPDIR',
    'LANG',
    'TERM',
    'MISTRAL_API_KEY',
    ...mistralVibeAcp.inheritEnv!,
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
);

// Vibe's plugin cache makes directories read-only. Only traverse our own scratch
// directories, without following symlinks into installed or user-owned plugins.
async function removeScratch(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory()) await removeScratch(join(dir, entry.name));
  await rm(dir, { recursive: true, force: true });
}

async function configureLocalModels(dir: string, apiBase: string): Promise<void> {
  await writeFile(
    join(dir, 'config.toml'),
    `
active_model = "local-one"
enable_telemetry = false
[session_logging]
generate_titles = false
[[providers]]
name = "switch-local"
api_base = "${apiBase}"
api_style = "openai"
[[models]]
name = "wire-one"
alias = "local-one"
provider = "switch-local"
[[models]]
name = "wire-two"
alias = "local-two"
provider = "switch-local"
`
  );
}

describe('Mistral Vibe real CLI', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map(removeScratch));
  });
  async function isolated() {
    const dir = await mkdtemp(join(tmpdir(), 'switch-vibe-smoke-'));
    dirs.push(dir);
    await writeFile(join(dir, 'config.toml'), 'enable_telemetry = false\n');
    // Exclude the user's environment credentials and keyring for signed-out checks.
    const isolatedEnv = Object.fromEntries(
      ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM'].flatMap((key) =>
        env[key] === undefined ? [] : [[key, env[key]!]]
      )
    );
    return {
      dir,
      isolatedEnv: {
        ...isolatedEnv,
        VIBE_HOME: dir,
        PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      },
    };
  }

  it('distinguishes missing and installed executables through PATH', async (ctx) => {
    expect(await findOnPath(binary, '')).toBeNull();
    if (!installed()) return ctx.skip('vibe-acp is not installed');
    expect(await findOnPath(binary, env.PATH)).not.toBeNull();
  });

  it('reports signed out without opening a login flow', async (ctx) => {
    if (!installed()) return ctx.skip('vibe-acp is not installed');
    const { dir, isolatedEnv } = await isolated();
    const status = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: binary,
      cwd: dir,
      env: isolatedEnv,
    });
    expect(status.status).toBe('unauthenticated');
    expect(status.message).toContain('vibe-acp --setup');
  }, 30_000);

  it('initializes, discovers models, selects a model and changes modes without a model call', async (ctx) => {
    if (!installed()) return ctx.skip('vibe-acp is not installed');
    const { dir, isolatedEnv } = await isolated();
    // Deliberately invalid: proves local credential presence/configuration only.
    // No inference request is sent and this is not evidence of a usable account.
    const configEnv = { ...isolatedEnv, MISTRAL_API_KEY: 'not-a-credential' };
    const status = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: binary,
      cwd: dir,
      env: configEnv,
    });
    expect(status.status).toBe('authenticated');
    const adapter = createMistralVibeAdapter();
    try {
      await adapter.startSession({
        sessionId: 'smoke',
        cwd: dir,
        env: configEnv,
        runtimeMode: 'approval-required',
        mcpServers: {},
        connectorMcpServers: [],
      });
      const models = await adapter.listModels('smoke');
      expect(models.length).toBeGreaterThan(0);
      await adapter.setModel('smoke', { id: models[0]!.id });
    } finally {
      await adapter.stopAll();
    }
    for (const runtimeMode of ['auto-accept-edits', 'auto', 'full-access'] as const) {
      const other = createMistralVibeAdapter();
      try {
        await other.startSession({
          sessionId: runtimeMode,
          cwd: dir,
          env: configEnv,
          runtimeMode,
          mcpServers: {},
          connectorMcpServers: [],
        });
      } finally {
        await other.stopAll();
      }
    }
  }, 60_000);

  it('reads back native model and permission-mode changes', async (ctx) => {
    if (!installed()) return ctx.skip('vibe-acp is not installed');
    const { dir, isolatedEnv } = await isolated();
    await configureLocalModels(dir, 'http://127.0.0.1:1/v1');
    const start = () =>
      new StdioJsonRpcClient({
        command: binary,
        args: [],
        cwd: dir,
        env: isolatedEnv,
        logger: noopLogger,
        onExit: () => {},
      });
    const client = start();
    try {
      await acpInitialize(client);
      const session = await client.request<AcpSessionResult>('session/new', {
        cwd: dir,
        mcpServers: [],
      });
      const model = session.configOptions?.find((option) => option.id === 'model');
      const choices =
        model?.options?.flatMap((option) => ('options' in option ? option.options : [option])) ??
        [];
      expect(model?.currentValue).toBe('local-one');
      const other = choices.find((option) => option.value === 'local-two');
      expect(other, 'Vibe must offer the second configured model').toBeDefined();
      const changed = await client.request<AcpSessionResult>('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'model',
        value: other!.value,
      });
      expect(changed.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe(
        other!.value
      );
      await expect(
        client.request('session/set_config_option', {
          sessionId: session.sessionId,
          configId: 'model',
          value: 'switch-nonexistent-model',
        })
      ).rejects.toThrow();
      for (const modeId of ['ask', 'accept-edits', 'auto-approve']) {
        await client.request('session/set_mode', { sessionId: session.sessionId, modeId });
        // Switch sets the mode before the model at startup. A model reload
        // must preserve that mode, particularly bypass permissions.
        const configured = await client.request<AcpSessionResult>('session/set_config_option', {
          sessionId: session.sessionId,
          configId: 'model',
          value: modeId === 'accept-edits' ? 'local-one' : other!.value,
        });
        expect(configured.configOptions?.find((option) => option.id === 'mode')?.currentValue).toBe(
          modeId
        );
      }
    } finally {
      await client.dispose();
    }
  }, 60_000);

  it('reports an unsaved empty native session as unavailable after restart', async (ctx) => {
    if (!installed()) return ctx.skip('vibe-acp is not installed');
    const { dir, isolatedEnv } = await isolated();
    await configureLocalModels(dir, 'http://127.0.0.1:1/v1');
    const input = {
      sessionId: 'empty',
      cwd: dir,
      env: isolatedEnv,
      runtimeMode: 'approval-required' as const,
      mcpServers: {},
      connectorMcpServers: [],
    };
    const first = createMistralVibeAdapter();
    const second = createMistralVibeAdapter();
    try {
      const session = await first.startSession(input);
      await first.stopAll();
      await expect(
        second.startSession({ ...input, resume: { nativeSessionId: session.nativeSessionId } })
      ).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
    } finally {
      await first.stopAll();
      await second.stopAll();
    }
  }, 60_000);

  it('uses the selected model for real CLI requests, queues, cancels and resumes with a scripted local model', async (ctx) => {
    if (!installed()) return ctx.skip('vibe-acp is not installed');
    const { dir, isolatedEnv } = await isolated();
    const requests: Array<{ model: string; messages: unknown[] }> = [];
    const mcpMethods: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url === '/mcp') {
        const rpc = JSON.parse(Buffer.concat(chunks).toString()) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string };
        };
        mcpMethods.push(rpc.method);
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result:
              rpc.method === 'initialize'
                ? {
                    protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'switch-local', version: '1' },
                  }
                : rpc.method === 'tools/list'
                  ? {
                      tools: [
                        {
                          name: 'room_context',
                          description: 'Read the room context.',
                          inputSchema: { type: 'object', properties: {} },
                        },
                      ],
                    }
                  : rpc.method === 'tools/call'
                    ? { content: [{ type: 'text', text: 'NATIVE_MCP_ROOM_CONTEXT' }] }
                    : {},
          })
        );
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string;
        messages: unknown[];
        stream?: boolean;
      };
      requests.push(body);
      const held = JSON.stringify(body.messages.at(-1)).includes('HOLD_TURN');
      const toolMarker = /WRITE_(APPROVED|DENIED|CANCELLED|AUTO)/.exec(
        JSON.stringify(body.messages.at(-1))
      )?.[1];
      const readRoom = JSON.stringify(body.messages.at(-1)).includes('READ_MCP_ROOM');
      const toolCalls = readRoom
        ? [
            {
              index: 0,
              id: 'read-room',
              type: 'function',
              function: {
                name: 'run_typescript',
                arguments: JSON.stringify({
                  code: 'async function main() { return await tools.mcp_switch.room_context({}); }',
                }),
              },
            },
          ]
        : toolMarker
          ? [
              {
                index: 0,
                id: `write-${toolMarker}`,
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: join(dir, `${toolMarker}.txt`),
                    content: `native-${toolMarker}`,
                  }),
                },
              },
            ]
          : undefined;
      const content = held ? 'waiting' : 'LOCAL_MODEL_REPLY';
      if (!body.stream) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'local',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: toolCalls
                  ? { role: 'assistant', content: null, tool_calls: toolCalls }
                  : { role: 'assistant', content },
                finish_reason: toolCalls ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          })
        );
        return;
      }
      response.setHeader('content-type', 'text/event-stream');
      const send = (delta: Record<string, unknown>, finish_reason: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            id: 'local',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`
        );
      send(
        toolCalls ? { role: 'assistant', tool_calls: toolCalls } : { role: 'assistant', content },
        null
      );
      if (!held) {
        send({}, toolCalls ? 'tool_calls' : 'stop');
        response.write(
          `data: ${JSON.stringify({
            id: 'local',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          })}\n\n`
        );
        response.end('data: [DONE]\n\n');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing model server port');
    await configureLocalModels(dir, `http://127.0.0.1:${address.port}/v1`);
    const adapter = createMistralVibeAdapter();
    const resumed = createMistralVibeAdapter();
    const recorder = new EventRecorder(adapter);
    const input = {
      sessionId: 'local',
      cwd: dir,
      env: isolatedEnv,
      runtimeMode: 'approval-required' as const,
      mcpServers: {
        switch: { transport: 'http' as const, url: `http://127.0.0.1:${address.port}/mcp` },
      },
      connectorMcpServers: [],
      model: { id: 'local-two' },
      systemContext: 'ROOM_CONTEXT_MARKER',
    };
    try {
      const session = await adapter.startSession(input);
      await adapter.sendTurn({
        sessionId: 'local',
        turnId: 'first',
        text: 'REMEMBER_ROOM_MENTION',
      });
      const first = await recorder.waitFor('turn.completed', (event) => event.turnId === 'first');
      expect(first.outcome, first.message).toBe('completed');
      expect(recorder.assistantText('first')).toContain('LOCAL_MODEL_REPLY');
      expect(requests.at(-1)?.model).toBe('wire-two');
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('ROOM_CONTEXT_MARKER');
      expect(mcpMethods).toContain('initialize');
      expect(mcpMethods).toContain('tools/list');
      await adapter.sendTurn({
        sessionId: 'local',
        turnId: 'mcp-room',
        text: 'READ_MCP_ROOM',
      });
      expect(
        (await recorder.waitFor('turn.completed', (event) => event.turnId === 'mcp-room')).outcome
      ).toBe('completed');
      expect(mcpMethods).toContain('tools/call');
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('NATIVE_MCP_ROOM_CONTEXT');
      expect(
        recorder.events.some(
          (event) => event.type === 'request.opened' && event.turnId === 'mcp-room'
        )
      ).toBe(false);
      for (const [marker, decision] of [
        ['APPROVED', 'accept'],
        ['DENIED', 'decline'],
        ['CANCELLED', null],
      ] as const) {
        await adapter.sendTurn({
          sessionId: 'local',
          turnId: marker,
          text: `WRITE_${marker}`,
        });
        const approval = await recorder.waitFor(
          'request.opened',
          (event) => event.turnId === marker
        );
        expect(approval.requestType).toBe('tool_approval');
        if (decision) await adapter.respondToRequest('local', approval.requestId, decision);
        else await adapter.interruptTurn('local');
        const completed = await recorder.waitFor(
          'turn.completed',
          (event) => event.turnId === marker
        );
        expect(completed.outcome, completed.message).toBe(decision ? 'completed' : 'interrupted');
        if (marker === 'APPROVED')
          expect(await readFile(join(dir, `${marker}.txt`), 'utf8')).toBe(`native-${marker}`);
        else
          await expect(readFile(join(dir, `${marker}.txt`))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        if (marker === 'APPROVED')
          expect(recorder.events).toContainEqual(
            expect.objectContaining({
              type: 'item.completed',
              turnId: marker,
              item: expect.objectContaining({ type: 'file_change', status: 'completed' }),
            })
          );
        if (!decision)
          expect(recorder.events).toContainEqual(
            expect.objectContaining({
              type: 'request.resolved',
              requestId: approval.requestId,
              decision: 'cancel',
            })
          );
      }
      const automatic = createMistralVibeAdapter();
      const autoEvents = new EventRecorder(automatic);
      try {
        await automatic.startSession({
          ...input,
          sessionId: 'auto',
          runtimeMode: 'full-access',
        });
        await automatic.sendTurn({ sessionId: 'auto', turnId: 'AUTO', text: 'WRITE_AUTO' });
        expect((await autoEvents.waitFor('turn.completed')).outcome).toBe('completed');
        expect(await readFile(join(dir, 'AUTO.txt'), 'utf8')).toBe('native-AUTO');
        expect(autoEvents.events.some((event) => event.type === 'request.opened')).toBe(false);
      } finally {
        await automatic.stopAll();
        autoEvents.dispose();
      }
      await adapter.sendTurn({ sessionId: 'local', turnId: 'held', text: 'HOLD_TURN' });
      await recorder.waitFor('content.delta', (event) => event.turnId === 'held');
      const count = requests.length;
      await adapter.sendTurn({ sessionId: 'local', turnId: 'queued', text: 'QUEUED_ROOM_MENTION' });
      expect(requests).toHaveLength(count);
      await adapter.interruptTurn('local');
      expect(
        (await recorder.waitFor('turn.completed', (event) => event.turnId === 'held')).outcome
      ).toBe('interrupted');
      expect(
        (await recorder.waitFor('turn.completed', (event) => event.turnId === 'queued')).outcome
      ).toBe('completed');
      await adapter.stopAll();
      const afterRestart = new EventRecorder(resumed);
      await resumed.startSession({
        ...input,
        sessionId: 'resumed',
        resume: { nativeSessionId: session.nativeSessionId },
      });
      await resumed.sendTurn({
        sessionId: 'resumed',
        turnId: 'recall',
        text: 'Recall the earlier room mention',
      });
      expect((await afterRestart.waitFor('turn.completed')).outcome).toBe('completed');
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('REMEMBER_ROOM_MENTION');
      expect(requests.at(-1)?.model).toBe('wire-two');
      afterRestart.dispose();
    } finally {
      await adapter.stopAll();
      await resumed.stopAll();
      recorder.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 120_000);
});

describeConformance('mistral-vibe', {
  createAdapter: async () => createMistralVibeAdapter(),
  unavailableReason: async () => {
    if (!installed()) return 'vibe-acp is not installed (uv tool install mistral-vibe)';
    const status = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: binary,
      cwd: process.cwd(),
      env,
    });
    return status.status === 'authenticated' ? null : status.message;
  },
  env,
  mcpServers: { echo: echoMcpServerSpec() },
  skip: {
    'user-input': 'Vibe uses ACP elicitation, which the generic Switch client does not advertise.',
  },
});
