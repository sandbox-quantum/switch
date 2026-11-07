import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSessionStartInput } from '../adapter';
import { EventRecorder } from '../testing/event-recorder';
import { writeNodeCli } from '../testing/node-cli';
import { AMP_MODES, approvalContent, createAmpAdapter, type AmpAdapter } from './amp-adapter';
import { FAKE_AMP_SCRIPT } from './fake-amp';
import { permissionRules, readUserSettings, sessionSettings } from './settings';
import { checkAmpSignIn } from './sign-in';

const THREAD = 'T-0e7c5b1a-1111-4222-8333-444455556666';

describe.skipIf(process.platform === 'win32')('Amp adapter', () => {
  let dir: string;
  let home: string;
  let binaryPath: string;
  let log: string;
  let adapter: AmpAdapter;
  let recorder: EventRecorder;

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '',
    HOME: home,
    FAKE_AMP_LOG: log,
    ...extra,
  });
  const start = (overrides: Partial<ProviderSessionStartInput> = {}) =>
    adapter.startSession({
      sessionId: 's1',
      cwd: dir,
      runtimeMode: 'approval-required',
      env: env(),
      mcpServers: {},
      connectorMcpServers: [],
      ...overrides,
    });
  const invocations = async (): Promise<string[][]> =>
    (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'amp-adapter-'));
    home = join(dir, 'home');
    await mkdir(home);
    log = join(dir, 'invocations.log');
    await writeFile(log, '');
    binaryPath = await writeNodeCli(dir, 'amp', FAKE_AMP_SCRIPT);
    adapter = createAmpAdapter({ binaryPath });
    recorder = new EventRecorder(adapter);
  });

  afterEach(async () => {
    await adapter.stopAll();
    recorder.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  describe('sign-in check', () => {
    const check = (extra: Record<string, string> = {}) =>
      checkAmpSignIn({ binaryPath, cwd: dir, env: env(extra) });

    it('takes AMP_API_KEY as signed in without running amp', async () => {
      expect(await check({ AMP_API_KEY: 'sgamp_test' })).toMatchObject({ status: 'authenticated' });
      expect(await invocations()).toEqual([]);
    });

    it('reads a saved account from amp account list', async () => {
      expect(await check({ FAKE_AMP_ACCOUNTS: '1' })).toMatchObject({ status: 'authenticated' });
    });

    it('says how to sign in when there is no account', async () => {
      const result = await check();
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('amp login');
    });

    it('stops amp the moment it starts its own sign-in', async () => {
      const started = Date.now();
      expect(await check({ FAKE_AMP_LOGIN_FLOW: '1' })).toMatchObject({
        status: 'unauthenticated',
      });
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  it('starts a thread in the chosen mode and reports it as the native session', async () => {
    const session = await start({ model: { id: 'high' } });
    expect(session.nativeSessionId).toBe(THREAD);
    expect(recorder.ofType('session.started')[0]?.nativeSessionId).toBe(THREAD);
    const [threadsNew] = await invocations();
    expect(threadsNew).toEqual(expect.arrayContaining(['threads', 'new', '--mode', 'high']));
    expect(await adapter.listModels('s1')).toEqual(AMP_MODES);
  });

  it('refuses to start, saying how to sign in, when amp starts a sign-in instead', async () => {
    await expect(start({ env: env({ FAKE_AMP_LOGIN_FLOW: '1' }) })).rejects.toThrow('amp login');
    expect(adapter.hasSession('s1')).toBe(false);
  });

  it('runs a turn on the thread and passes the mode with its first message only', async () => {
    await start({ model: { id: 'low' }, systemContext: 'You are in Switch.' });
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'hello' });
    const first = await recorder.waitFor('turn.completed', (event) => event.turnId === 't1');
    expect(first.outcome).toBe('completed');
    expect(recorder.assistantText('t1')).toBe('echo: You are in Switch.\n\nhello');
    expect(first.usage).toEqual([
      { model: '', inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
    ]);

    await adapter.sendTurn({ sessionId: 's1', turnId: 't2', text: 'again' });
    await recorder.waitFor('turn.completed', (event) => event.turnId === 't2');
    expect(recorder.assistantText('t2')).toBe('echo: again');

    const [, firstTurn, secondTurn] = await invocations();
    expect(firstTurn!.slice(0, 3)).toEqual(['threads', 'continue', THREAD]);
    expect(firstTurn).toEqual(
      expect.arrayContaining(['--execute', '--stream-json', '--stream-json-input'])
    );
    expect(firstTurn).toEqual(expect.arrayContaining(['--mode', 'low']));
    expect(secondTurn).not.toContain('--mode');
  });

  it('leaves out what Amp resumes from earlier work before the new message', async () => {
    await start({ env: env({ FAKE_AMP_EARLIER_WORK: '1' }) });
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'hello' });
    await recorder.waitFor('turn.completed', (event) => event.turnId === 't1');
    expect(recorder.assistantText('t1')).toBe('echo: hello');
  });

  it('asks before a command and runs it once accepted', async () => {
    await start();
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'run: echo hi' });
    const request = await recorder.waitFor('request.opened');
    expect(request).toMatchObject({
      turnId: 't1',
      requestType: 'command_execution_approval',
      detail: 'echo hi',
    });
    await adapter.respondToRequest('s1', request.requestId, 'accept');
    const done = await recorder.waitFor('turn.completed');
    expect(done.outcome).toBe('completed');
    const tool = recorder.ofType('item.completed').find((event) => event.item.id === 'toolu_1');
    expect(tool?.item).toMatchObject({
      type: 'command_execution',
      status: 'completed',
      text: 'ran echo hi',
    });
  });

  it('returns a declined command to Amp as refused', async () => {
    await start();
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'run: rm -rf build' });
    const request = await recorder.waitFor('request.opened');
    await adapter.respondToRequest('s1', request.requestId, 'decline');
    await recorder.waitFor('turn.completed');
    const tool = recorder.ofType('item.completed').find((event) => event.item.id === 'toolu_1');
    expect(tool?.item.status).toBe('failed');
    expect(tool?.item.text).toContain('declined');
    expect(recorder.ofType('request.resolved')[0]?.decision).toBe('decline');
  });

  it('remembers a tool allowed for the session', async () => {
    await start();
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'run: ls' });
    const request = await recorder.waitFor('request.opened');
    await adapter.respondToRequest('s1', request.requestId, 'acceptForSession');
    await recorder.waitFor('turn.completed', (event) => event.turnId === 't1');
    await adapter.sendTurn({ sessionId: 's1', turnId: 't2', text: 'run: pwd' });
    const second = await recorder.waitFor('turn.completed', (event) => event.turnId === 't2');
    expect(second.outcome).toBe('completed');
    expect(recorder.ofType('request.opened')).toHaveLength(1);
  });

  it('never asks in full access', async () => {
    await start({ runtimeMode: 'full-access' });
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'run: echo hi' });
    await recorder.waitFor('turn.completed');
    expect(recorder.ofType('request.opened')).toEqual([]);
    const tool = recorder.ofType('item.completed').find((event) => event.item.id === 'toolu_1');
    expect(tool?.item.status).toBe('completed');
  });

  it('steers a message sent mid-turn into the running turn', async () => {
    await start();
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'slow' });
    await recorder.waitFor('content.delta', (event) => event.turnId === 't1');
    const result = await adapter.sendTurn({ sessionId: 's1', turnId: 't2', text: 'stop now' });
    expect(result).toEqual({ turnId: 't2', steeredInto: 't1' });
    const done = await recorder.waitFor('turn.completed', (event) => event.turnId === 't1');
    expect(done.outcome).toBe('completed');
    expect(recorder.assistantText('t1')).toContain('steered: stop now');
    expect(recorder.ofType('turn.completed')).toHaveLength(1);
  });

  it('interrupts a turn and continues the same thread on the next one', async () => {
    await start();
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'slow' });
    await recorder.waitFor('content.delta', (event) => event.turnId === 't1');
    await adapter.interruptTurn('s1');
    const stopped = await recorder.waitFor('turn.completed', (event) => event.turnId === 't1');
    expect(stopped.outcome).toBe('interrupted');
    await adapter.sendTurn({ sessionId: 's1', turnId: 't2', text: 'after' });
    const next = await recorder.waitFor('turn.completed', (event) => event.turnId === 't2');
    expect(next.outcome).toBe('completed');
    expect((await invocations()).at(-1)!.slice(0, 3)).toEqual(['threads', 'continue', THREAD]);
  });

  it('resumes a thread without creating one, in the mode it already has', async () => {
    await start({ resume: { nativeSessionId: 'T-resumed' }, model: { id: 'high' } });
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'remember?' });
    await recorder.waitFor('turn.completed');
    const calls = await invocations();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual(['threads', 'continue', 'T-resumed']);
    expect(calls[0]).not.toContain('--mode');
  });

  it('cancels an open approval when the session stops', async () => {
    await start();
    await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'run: echo hi' });
    const request = await recorder.waitFor('request.opened');
    await adapter.stopSession('s1');
    expect(recorder.ofType('request.resolved')).toEqual([
      expect.objectContaining({ requestId: request.requestId, decision: 'cancel' }),
    ]);
    expect(recorder.ofType('turn.completed')[0]?.outcome).toBe('interrupted');
    expect(recorder.ofType('session.exited')).toHaveLength(1);
    expect(adapter.hasSession('s1')).toBe(false);
  });
});

describe('Amp permissions', () => {
  it('auto-approves Switch servers and reads, and delegates everything else', () => {
    const rules = permissionRules({
      runtimeMode: 'approval-required',
      autoApprovedMcpServers: ['switch'],
      helperPath: '/tmp/approve.sh',
    });
    expect(rules[0]).toEqual({ tool: 'mcp__switch__*', action: 'allow' });
    expect(rules).toContainEqual({ tool: 'Read', action: 'allow' });
    expect(rules).not.toContainEqual({ tool: 'edit_file', action: 'allow' });
    expect(rules.at(-1)).toEqual({ tool: '*', action: 'delegate', to: '/tmp/approve.sh' });
  });

  it('allows edits in auto-accept-edits and auto mode', () => {
    for (const runtimeMode of ['auto-accept-edits', 'auto'] as const)
      expect(
        permissionRules({ runtimeMode, autoApprovedMcpServers: [], helperPath: '/h' })
      ).toContainEqual({ tool: 'edit_file', action: 'allow' });
  });

  it('delegates nothing in full access', () => {
    expect(
      permissionRules({ runtimeMode: 'full-access', autoApprovedMcpServers: [], helperPath: '/h' })
    ).toEqual([]);
  });

  it("keeps the person's settings and puts their rules after the session's", async () => {
    const home = await mkdtemp(join(tmpdir(), 'amp-settings-'));
    try {
      await mkdir(join(home, '.config', 'amp'), { recursive: true });
      await writeFile(
        join(home, '.config', 'amp', 'settings.json'),
        '{\n  // theirs\n  "amp.showCosts": false,\n  "amp.permissions": [{"tool": "Bash", "action": "reject"}],\n}\n'
      );
      const { settings, warning } = await readUserSettings({ HOME: home });
      expect(warning).toBeUndefined();
      const merged = sessionSettings(settings, {
        runtimeMode: 'approval-required',
        rules: [{ tool: '*', action: 'delegate', to: '/h' }],
      });
      expect(merged).toEqual({
        'amp.showCosts': false,
        'amp.dangerouslyAllowAll': false,
        'amp.permissions': [
          { tool: '*', action: 'delegate', to: '/h' },
          { tool: 'Bash', action: 'reject' },
        ],
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('words approval cards by what is being approved', () => {
    expect(approvalContent('edit_file', { path: 'src/a.ts' })).toEqual({
      requestType: 'file_change_approval',
      title: 'Amp wants to change a file',
      detail: 'src/a.ts',
    });
    expect(approvalContent('mcp__github__create_issue', { title: 'x' })).toMatchObject({
      requestType: 'mcp_tool_approval',
      title: 'github wants to run create_issue',
    });
  });
});
