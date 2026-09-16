import type * as ChildProcess from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEvent } from '../events';
import { FakeAgy } from './fake-agy';

const processes: FakeAgy[] = [];
const spawns: Array<{ args: string[]; env: Record<string, string>; cwd: string }> = [];
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: (
    _command: string,
    args: string[],
    options: { env: Record<string, string>; cwd: string }
  ) => {
    spawns.push({ args, env: options.env, cwd: options.cwd });
    const child = new FakeAgy(args);
    processes.push(child);
    return child;
  },
}));
const { createAntigravityAdapter } = await import('./antigravity-adapter');

const roots: string[] = [];
let cwd = '';
let home = '';
beforeEach(async () => {
  processes.length = 0;
  spawns.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'antigravity-unit-'));
  roots.push(root);
  cwd = join(root, 'work');
  home = join(root, 'home');
  await mkdir(cwd);
  await mkdir(home);
  cwd = await realpath(cwd);
});
afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(
  overrides: Partial<
    Parameters<ReturnType<typeof createAntigravityAdapter>['startSession']>[0]
  > = {}
) {
  const adapter = createAntigravityAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const starting = adapter.startSession({
    sessionId: 's',
    cwd,
    runtimeMode: 'full-access',
    env: { HOME: home, PATH: '/usr/bin' },
    mcpServers: {},
    ...overrides,
  });
  // Registering MCP servers touches disk before the process starts.
  while (processes.length === 0) await flush();
  processes.at(-1)!.init('native-1');
  const session = await starting;
  return { adapter, events, session, agy: () => processes.at(-1)! };
}

it('spawns with exactly the session environment and the caller working directory', async () => {
  const { session } = await setup();
  expect(session.nativeSessionId).toBe('native-1');
  expect(spawns[0]!.env).toEqual({ HOME: home, PATH: '/usr/bin' });
  expect(spawns[0]!.cwd).toBe(cwd);
  // Without --add-dir the CLI runs file tools in its own scratch workspace.
  expect(spawns[0]!.args).toContain('--add-dir');
  expect(spawns[0]!.args[spawns[0]!.args.indexOf('--add-dir') + 1]).toBe(cwd);
  expect(spawns[0]!.args).toContain('--dangerously-skip-permissions');
});

it('maps the runtime modes onto the flags the CLI offers and warns when it cannot ask', async () => {
  const edits = await setup({ runtimeMode: 'auto-accept-edits' });
  expect(spawns[0]!.args.join(' ')).toContain('--mode accept-edits');
  expect(edits.events.some((event) => event.type === 'runtime.warning')).toBe(false);

  processes.length = 0;
  spawns.length = 0;
  const gated = await setup({ runtimeMode: 'approval-required' });
  expect(spawns[0]!.args).not.toContain('--dangerously-skip-permissions');
  expect(spawns[0]!.args).not.toContain('--mode');
  const warning = gated.events.find((event) => event.type === 'runtime.warning');
  expect(warning?.type === 'runtime.warning' && warning.message).toContain('approval');
});

it('resumes the named conversation and passes the model and effort through', async () => {
  await setup({
    resume: { nativeSessionId: 'native-resumed' },
    model: { id: 'gemini-3.1-pro-high', options: { effort: 'high' } },
  });
  expect(spawns[0]!.args.join(' ')).toContain('--conversation native-resumed');
  expect(spawns[0]!.args.join(' ')).toContain('--model gemini-3.1-pro-high');
  expect(spawns[0]!.args.join(' ')).toContain('--effort high');
});

it('merges session MCP servers into the workspace config and puts it back on stop', async () => {
  const path = join(cwd, '.agents/mcp_config.json');
  await mkdir(join(cwd, '.agents'));
  await writeFile(path, '{"mcpServers":{"mine":{"command":"keep"}}}');
  const { adapter } = await setup({
    runtimeMode: 'approval-required',
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], envVars: ['PATH'] },
      remote: { transport: 'http', url: 'https://example.invalid/mcp' },
    },
  });
  const written = JSON.parse(await readFile(path, 'utf8'));
  expect(written.mcpServers.mine).toEqual({ command: 'keep' });
  expect(written.mcpServers.switch).toEqual({
    command: 'node',
    args: ['server.js'],
    env: { PATH: '/usr/bin' },
  });
  expect(written.mcpServers.remote).toEqual({ serverUrl: 'https://example.invalid/mcp' });
  const settings = JSON.parse(
    await readFile(join(home, '.gemini/antigravity-cli/settings.json'), 'utf8')
  );
  expect(settings.permissions.allow).toEqual(['mcp(switch/*)', 'mcp(remote/*)']);

  await adapter.stopSession('s');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    mcpServers: { mine: { command: 'keep' } },
  });
  expect(
    JSON.parse(await readFile(join(home, '.gemini/antigravity-cli/settings.json'), 'utf8'))
  ).toEqual({});
});

it('never allow-lists MCP servers in full access, where nothing asks in the first place', async () => {
  await setup({ mcpServers: { switch: { transport: 'stdio', command: 'node', args: [] } } });
  await expect(
    readFile(join(home, '.gemini/antigravity-cli/settings.json'), 'utf8')
  ).rejects.toThrow();
});

it('streams assistant text as deltas and closes the item when the step is done', async () => {
  const { adapter, events, agy } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  await flush();
  expect(agy().received.at(-1)).toEqual({
    event: 'user',
    message: { content: [{ type: 'text', text: 'hello' }] },
  });
  agy().step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'He' });
  agy().step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'llo' });
  agy().result({ status: 'SUCCESS', response: 'Hello' });
  await flush();
  const deltas = events.filter((event) => event.type === 'content.delta');
  expect(deltas.map((event) => event.type === 'content.delta' && event.delta)).toEqual([
    'He',
    'llo',
  ]);
  const started = events.findIndex(
    (event) => event.type === 'item.started' && event.item.type === 'assistant_message'
  );
  expect(started).toBeGreaterThanOrEqual(0);
  expect(started).toBeLessThan(events.indexOf(deltas[0]!));
  expect(events.find((event) => event.type === 'item.completed')).toMatchObject({
    item: { type: 'assistant_message', status: 'completed', text: 'Hello' },
  });
  expect(events.find((event) => event.type === 'turn.completed')).toMatchObject({
    turnId: 't',
    outcome: 'completed',
  });
});

it('classifies tool steps and carries a denied tool through as a failed item', async () => {
  const { adapter, events, agy } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'work' });
  await flush();
  agy().step({
    step_index: 2,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'touch marker.txt' } },
  });
  agy().step({
    step_index: 2,
    state: 'ERROR',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'touch marker.txt' },
      error: { type: 'TOOL_ERROR', message: 'user denied permission to run commands' },
    },
  });
  agy().step({
    step_index: 3,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'write_to_file',
    tool_info: { name: 'write_to_file', parameters: { TargetFile: '/work/marker.txt' } },
  });
  agy().result({
    status: 'SUCCESS',
    response: '',
    denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
  });
  await flush();
  const completed = events.filter((event) => event.type === 'item.completed');
  expect(completed.map((event) => event.type === 'item.completed' && event.item.type)).toEqual([
    'command_execution',
    'file_change',
  ]);
  expect(completed[0]).toMatchObject({
    item: { status: 'failed', title: 'run_command: touch marker.txt' },
  });
  // The caller must be told the agent was silently blocked, not just that the turn ended.
  expect(
    events.some((event) => event.type === 'runtime.warning' && event.message.includes('RunCommand'))
  ).toBe(true);
  expect(events.some((event) => event.type === 'request.opened')).toBe(false);
});

it('reports delegation from its own step type, not from a tool call', async () => {
  const { adapter, events, agy } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'delegate' });
  await flush();
  const subagents = [
    { type_name: 'research', role: 'Readme Reader', initial_prompt: 'Read README.md' },
    { type_name: 'research', role: 'Second Reader', initial_prompt: 'Read LICENSE' },
  ];
  agy().step({
    step_index: 2,
    state: 'ACTIVE',
    step_type: 'subagent',
    tool_name: 'invoke_subagent',
    subagent_info: { subagents },
  });
  agy().step({
    step_index: 2,
    state: 'DONE',
    step_type: 'subagent',
    tool_name: 'invoke_subagent',
    subagent_info: {
      subagents: subagents.map((child, index) => ({
        ...child,
        conversation_id: `child-${index}`,
      })),
    },
  });
  agy().step({ step_index: 3, state: 'DONE', step_type: 'system_message' });
  agy().result({ status: 'SUCCESS', response: 'done' });
  await flush();
  const started = events.filter(
    (event) => event.type === 'item.started' && event.item.type === 'subagent'
  );
  expect(started.map((event) => event.type === 'item.started' && event.item.title)).toEqual([
    'Readme Reader',
    'Second Reader',
  ]);
  const completed = events.filter(
    (event) => event.type === 'item.completed' && event.item.type === 'subagent'
  );
  expect(completed).toHaveLength(2);
  expect(completed[0]).toMatchObject({
    item: { status: 'completed', nativeChildId: 'child-0', toolName: 'research' },
  });
  expect(started[1]!.type === 'item.started' && started[1]!.item.id).not.toBe(
    started[0]!.type === 'item.started' && started[0]!.item.id
  );
  expect(events.find((event) => event.type === 'turn.completed')).toMatchObject({
    outcome: 'completed',
  });
});

it('respawns with the attachment directory readable when it cannot ask to read it', async () => {
  const staging = join(await realpath(tmpdir()), 'switch-staging');
  const { adapter, events } = await setup({ runtimeMode: 'auto-accept-edits' });
  await adapter.sendTurn({
    sessionId: 's',
    turnId: 'one',
    text: 'summarise',
    attachments: [{ path: join(staging, 'report.txt'), mimeType: 'text/plain' }],
  });
  // The grant is read at launch, so the running process cannot be told about it.
  while (processes.length < 2) await flush();
  processes[1]!.init('native-1');
  await flush();
  const args = spawns[1]!.args;
  expect(args.join(' ')).toContain('--conversation native-1');
  expect(args.filter((argument) => argument === '--add-dir')).toHaveLength(2);
  expect(args).toContain(staging);
  expect(JSON.stringify(processes[1]!.received[0])).toContain('report.txt');

  // A second turn from the same directory reuses the process.
  processes[1]!.result({ status: 'SUCCESS', response: 'ok' });
  await flush();
  await adapter.sendTurn({
    sessionId: 's',
    turnId: 'two',
    text: 'again',
    attachments: [{ path: join(staging, 'other.txt'), mimeType: 'text/plain' }],
  });
  await flush();
  expect(processes).toHaveLength(2);

  processes[1]!.result({
    status: 'SUCCESS',
    response: '',
    denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }],
  });
  await flush();
  expect(
    events.some((event) => event.type === 'runtime.warning' && event.message.includes('other.txt'))
  ).toBe(true);
});

it('does not widen access for attachments when the session already has full access', async () => {
  const { adapter, agy } = await setup();
  await adapter.sendTurn({
    sessionId: 's',
    turnId: 'one',
    text: 'summarise',
    attachments: [{ path: join(tmpdir(), 'switch-staging/report.txt'), mimeType: 'text/plain' }],
  });
  await flush();
  expect(processes).toHaveLength(1);
  expect(spawns[0]!.args.filter((argument) => argument === '--add-dir')).toHaveLength(1);
  expect(JSON.stringify(agy().received[0])).toContain('report.txt');
});

it('interrupts by killing the process and resumes the conversation for the next turn', async () => {
  const { adapter, events, agy } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'count' });
  await flush();
  const first = agy();
  await adapter.interruptTurn('s');
  expect(first.signals).toEqual(['SIGINT']);
  // The dying process still emits its own error result; it must not win the turn.
  first.result({ status: 'ERROR', error: 'interrupted' });
  await flush();
  expect(events.find((event) => event.type === 'turn.completed')).toMatchObject({
    turnId: 'one',
    outcome: 'interrupted',
  });
  expect(adapter.hasSession('s')).toBe(true);
  expect(events.some((event) => event.type === 'session.exited')).toBe(false);

  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'again' });
  await flush();
  expect(processes).toHaveLength(2);
  expect(spawns[1]!.args.join(' ')).toContain('--conversation native-1');
  processes[1]!.init('native-1');
  await flush();
  processes[1]!.result({ status: 'SUCCESS', response: 'ok' });
  await flush();
  expect(
    events.filter((event) => event.type === 'turn.completed').map((event) => event.turnId)
  ).toEqual(['one', 'two']);
});

it('settles the running and queued turns when the CLI dies on its own', async () => {
  const { adapter, events, agy } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  await flush();
  agy().crash(1);
  await flush();
  expect(adapter.hasSession('s')).toBe(false);
  expect(
    events.filter((event) => event.type === 'turn.completed').map((event) => event.outcome)
  ).toEqual(['error', 'error']);
  expect(events.at(-1)).toMatchObject({ type: 'session.exited' });
});

it('runs queued turns one at a time, each with the caller turn id', async () => {
  const { adapter, events, agy } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  await flush();
  expect(agy().received).toHaveLength(1);
  agy().result({ status: 'SUCCESS', response: 'a' });
  await flush();
  expect(agy().received).toHaveLength(2);
  agy().result({ status: 'SUCCESS', response: 'b' });
  await flush();
  expect(
    events.filter((event) => event.type === 'turn.completed').map((event) => event.turnId)
  ).toEqual(['one', 'two']);
  expect(
    events.filter((event) => event.type === 'turn.started').map((event) => event.turnId)
  ).toEqual(['one', 'two']);
});

it('prepends the system context to the first turn only', async () => {
  const { adapter, agy } = await setup({ systemContext: 'ROOM CONTEXT' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await flush();
  expect(JSON.stringify(agy().received[0])).toContain('ROOM CONTEXT\\n\\nfirst');
  agy().result({ status: 'SUCCESS', response: 'a' });
  await flush();
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  await flush();
  expect(JSON.stringify(agy().received[1])).not.toContain('ROOM CONTEXT');
});

it('refuses approvals and questions it can never carry instead of pretending to answer', async () => {
  const { adapter } = await setup();
  await expect(adapter.respondToRequest('s', 'r', 'accept')).rejects.toThrow(/headless/);
  await expect(adapter.respondToUserInput('s', 'r', { q: 'a' })).rejects.toThrow(/ask_question/);
  await expect(adapter.sendTurn({ sessionId: 'missing', turnId: 't', text: 'x' })).rejects.toThrow(
    /not running/
  );
});
