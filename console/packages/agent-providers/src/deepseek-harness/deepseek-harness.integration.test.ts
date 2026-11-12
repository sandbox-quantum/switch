import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { acpInitialize } from '../acp/acp-adapter';
import type { AcpLaunch } from '../acp/hooks';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import { describeConformance, echoMcpServerSpec, EventRecorder } from '../testing/index';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import {
  checkDshSignIn,
  createDeepseekHarnessAdapter,
  deepseekHarnessAcp,
  dshLaunch,
} from './deepseek-harness-acp';

// The harness gets a minimal environment, so the key (and an endpoint or
// harness home, when the shell names one) is passed through by name.
const env = Object.fromEntries(
  ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME'].flatMap((name) => {
    const value = process.env[name];
    return value ? [[name, value]] : [];
  })
);
const model = process.env.DSH_CONFORMANCE_MODEL;

async function unavailableReason(): Promise<string | null> {
  const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return 'the dsh binary is not on PATH';
  const signIn = await checkDshSignIn({
    cwd: process.cwd(),
    env: { ...env, HOME: process.env.HOME ?? '' },
  });
  return signIn.status === 'authenticated' ? null : signIn.message;
}

describeConformance('deepseek-harness', {
  createAdapter: async () => createDeepseekHarnessAdapter(),
  unavailableReason,
  ...(model ? { model: { id: model } } : {}),
  mcpServers: { echo: echoMcpServerSpec() },
  env,
  skip: {
    interrupt:
      'dsh sends a message only once it is committed, so the first text of the counting turn arrives as the turn ends and the scenario interrupts a finished turn. Interrupting a running turn is the test below (dsh 0.2.1-rc.5, 2026-11-05).',
    'user-input':
      'dsh --profile acp has no ask-the-user tool or elicitation over ACP: its user-questions plugin answers the Web UI only (dsh 0.2.1-rc.5, 2026-11-05).',
  },
});

/** Declines every request the session opens after `first`. */
function declineLater(adapter: ProviderAdapter, sessionId: string, first: string): void {
  adapter.subscribe((event) => {
    if (
      event.type === 'request.opened' &&
      event.sessionId === sessionId &&
      event.requestId !== first
    )
      void adapter.respondToRequest(sessionId, event.requestId, 'decline').catch(() => {});
  });
}

// Needs only the binary: no prompt is sent, so no key and no tokens.
describe('deepseek-harness approval gate', () => {
  const installed = () => {
    const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
    return !probe.error && probe.status === 0;
  };
  const input = async () => ({
    binaryPath: 'dsh',
    cwd: await mkdtemp(join(tmpdir(), 'switch-dsh-gate-')),
    env: { PATH: process.env.PATH ?? '', HOME: await mkdtemp(join(tmpdir(), 'switch-dsh-home-')) },
    runtimeMode: 'approval-required' as const,
  });
  const handshake = async (launch: AcpLaunch, cwd: string) => {
    const client = new StdioJsonRpcClient({ ...launch, cwd, logger: noopLogger, onExit: () => {} });
    try {
      return await acpInitialize(client, deepseekHarnessAcp);
    } finally {
      await client.dispose();
    }
  };

  it('loads, and only then lets the ACP server answer', { timeout: 60_000 }, async (ctx) => {
    if (!installed()) return ctx.skip('the dsh binary is not on PATH');
    const launch = await input();
    const answer = await handshake(await dshLaunch(launch), launch.cwd);
    expect(answer.agentInfo?.name).toBe('deepseek-harness-acp');
  });

  it('stops dsh with a clear error when it does not load', { timeout: 60_000 }, async (ctx) => {
    if (!installed()) return ctx.skip('the dsh binary is not on PATH');
    const launch = await input();
    const gated = await dshLaunch(launch);
    const patch = gated.args.at(-1)!;
    await writeFile(
      patch,
      (await readFile(patch, 'utf8')).replace(
        /name: ".*"/,
        `name: "${pathToFileURL(join(launch.cwd, 'gone.mjs')).href}"`
      )
    );
    await expect(handshake(gated, launch.cwd)).rejects.toThrow(
      "DeepSeek Harness did not load Switch's approval gate, so the session was not started"
    );
  });
});

describe('deepseek-harness real CLI', () => {
  const adapters: ReturnType<typeof createDeepseekHarnessAdapter>[] = [];
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.allSettled(adapters.map((adapter) => adapter.stopAll()));
    await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function start(sessionId: string, input: Partial<ProviderSessionStartInput>) {
    const cwd = await mkdtemp(join(tmpdir(), 'switch-dsh-'));
    dirs.push(cwd);
    const adapter = createDeepseekHarnessAdapter();
    adapters.push(adapter);
    const recorder = new EventRecorder(adapter);
    await adapter.startSession({
      sessionId,
      cwd,
      runtimeMode: 'full-access',
      mcpServers: {},
      connectorMcpServers: [],
      ...input,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env, ...input.env },
    });
    return { adapter, recorder, cwd };
  }

  it(
    'asks before a command that writes nothing, and a declined one does not run',
    { timeout: 240_000 },
    async (ctx) => {
      const reason = await unavailableReason();
      if (reason) return ctx.skip(reason);
      const { adapter, recorder } = await start('ask', {
        runtimeMode: 'approval-required',
        ...(model ? { model: { id: model } } : {}),
      });
      await adapter.sendTurn({
        sessionId: 'ask',
        turnId: 't',
        text: 'Run the shell command: date. Then reply "done".',
      });
      const request = await recorder.waitFor('request.opened', () => true, 180_000);
      expect(request).toMatchObject({ requestType: 'command_execution_approval', title: 'date' });
      const command = recorder
        .ofType('item.started')
        .find((e) => e.item.type === 'command_execution' && e.item.title === 'date');
      expect(command).toBeDefined();
      expect(
        recorder.ofType('item.completed').filter((e) => e.item.id === command!.item.id)
      ).toEqual([]);
      // The model may try another way, and every way asks: decline those too.
      declineLater(adapter, 'ask', request.requestId);
      await adapter.respondToRequest('ask', request.requestId, 'decline');
      const ran = await recorder.waitFor(
        'item.completed',
        (e) => e.item.id === command!.item.id,
        60_000
      );
      expect(ran.item.status).toBe('failed');
      const done = await recorder.waitFor('turn.completed', (e) => e.turnId === 't', 180_000);
      expect(done.outcome).toBe('completed');
    }
  );

  it('asks before a workflow, which runs model-written code', { timeout: 240_000 }, async (ctx) => {
    const reason = await unavailableReason();
    if (reason) return ctx.skip(reason);
    const { adapter, recorder } = await start('workflow', {
      runtimeMode: 'approval-required',
      ...(model ? { model: { id: model } } : {}),
    });
    await adapter.sendTurn({
      sessionId: 'workflow',
      turnId: 't',
      text: 'Use your workflow tool (not the shell, not any other tool) to run a one-line workflow that returns 1 + 1. Then reply with the result, or "declined" if it is not allowed.',
    });
    const request = await recorder.waitFor('request.opened', () => true, 180_000);
    const call = recorder.ofType('item.started').find((e) => e.item.title === 'workflow');
    expect(call).toBeDefined();
    expect(request.requestType).toBe('tool_approval');
    expect(recorder.ofType('item.completed').filter((e) => e.item.id === call!.item.id)).toEqual(
      []
    );
    declineLater(adapter, 'workflow', request.requestId);
    await adapter.respondToRequest('workflow', request.requestId, 'decline');
    const ran = await recorder.waitFor(
      'item.completed',
      (e) => e.item.id === call!.item.id,
      60_000
    );
    expect(ran.item.status).toBe('failed');
    const done = await recorder.waitFor('turn.completed', (e) => e.turnId === 't', 180_000);
    expect(done.outcome).toBe('completed');
  });

  it('lets a subagent write in the workspace in full access', { timeout: 240_000 }, async (ctx) => {
    const reason = await unavailableReason();
    if (reason) return ctx.skip(reason);
    const { adapter, recorder, cwd } = await start('child', model ? { model: { id: model } } : {});
    await adapter.sendTurn({
      sessionId: 'child',
      turnId: 't',
      text: 'Delegate this to a subagent (do not do it yourself): create the file child.txt in the current directory containing exactly SWITCH_CONFORMANCE_OK. When it returns, reply "done".',
    });
    const done = await recorder.waitFor('turn.completed', (e) => e.turnId === 't', 200_000);
    expect(done.outcome).toBe('completed');
    expect(recorder.ofType('item.started').some((e) => e.item.type === 'subagent')).toBe(true);
    expect(recorder.ofType('request.opened')).toEqual([]);
    expect((await readFile(join(cwd, 'child.txt'), 'utf8')).trim()).toBe('SWITCH_CONFORMANCE_OK');
  });

  it('interrupts a running turn, then answers the next', { timeout: 240_000 }, async (ctx) => {
    const reason = await unavailableReason();
    if (reason) return ctx.skip(reason);
    const { adapter, recorder } = await start('interrupt', model ? { model: { id: model } } : {});
    await adapter.sendTurn({
      sessionId: 'interrupt',
      turnId: 't',
      text: 'Run the shell command `sleep 90` in the foreground (not in the background), then reply "done".',
    });
    await recorder.waitFor(
      'item.started',
      (e) => e.turnId === 't' && e.item.type === 'command_execution' && /sleep/.test(e.item.title),
      180_000
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(recorder.ofType('turn.completed')).toEqual([]);
    await adapter.interruptTurn('interrupt');
    const done = await recorder.waitFor('turn.completed', (e) => e.turnId === 't', 60_000);
    expect(done.outcome).toBe('interrupted');
    await adapter.sendTurn({
      sessionId: 'interrupt',
      turnId: 'next',
      text: 'Reply with exactly SWITCH_CONFORMANCE_OK.',
    });
    const next = await recorder.waitFor('turn.completed', (e) => e.turnId === 'next', 180_000);
    expect([next.outcome, next.message]).toEqual(['completed', undefined]);
    expect(recorder.assistantText('next')).toContain('SWITCH_CONFORMANCE_OK');
  });

  it(
    'sends the chosen model on the wire, not the profile default',
    { timeout: 240_000 },
    async (ctx) => {
      const reason = await unavailableReason();
      if (reason) return ctx.skip(reason);
      // A pass-through in front of the harness's endpoint, noting each request's
      // model. The official route reads DEEPSEEK_BASE_URL; so may a custom one.
      const upstream = (env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic').replace(
        /\/+$/,
        ''
      );
      const seen: string[] = [];
      const proxy = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        if (body.length) {
          try {
            const sent = (JSON.parse(body.toString()) as { model?: unknown }).model;
            if (typeof sent === 'string') seen.push(sent);
          } catch {
            // Not a model request.
          }
        }
        const headers = Object.fromEntries(
          Object.entries(request.headers).flatMap(([name, value]) =>
            ['host', 'content-length', 'connection'].includes(name) || value === undefined
              ? []
              : [[name, Array.isArray(value) ? value.join(', ') : value]]
          )
        );
        const answer = await fetch(`${upstream}${request.url}`, {
          method: request.method,
          headers,
          ...(body.length ? { body } : {}),
        });
        response.writeHead(
          answer.status,
          Object.fromEntries(
            [...answer.headers].filter(
              ([name]) =>
                !['content-encoding', 'content-length', 'transfer-encoding'].includes(name)
            )
          )
        );
        if (answer.body)
          Readable.fromWeb(answer.body as unknown as WebReadableStream).pipe(response);
        else response.end();
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      try {
        const { adapter, recorder } = await start('model-choice', {
          env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` },
        });
        // Any listed model but the profile's default, unless the shell names one.
        const models = await adapter.listModels('model-choice');
        const chosen =
          models.find((choice) => choice.id === process.env.DSH_CONFORMANCE_SECOND_MODEL) ??
          models.find((choice) => choice.id !== (model ?? models[0]?.id));
        if (!chosen) throw new Error('DeepSeek Harness listed no second model to choose.');
        await adapter.setModel('model-choice', { id: chosen.id });
        await adapter.sendTurn({ sessionId: 'model-choice', turnId: 't', text: 'Reply with: ok' });
        const done = await recorder.waitFor('turn.completed', (e) => e.turnId === 't', 180_000);
        expect([done.outcome, done.message]).toEqual(['completed', undefined]);
        // Each value is a [provider, model] pair; the wire carries the model.
        const [, wanted] = JSON.parse(chosen.id) as [string, string];
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen)).toEqual(new Set([wanted]));
      } finally {
        proxy.close();
      }
    }
  );
});
