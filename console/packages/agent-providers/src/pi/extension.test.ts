import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeMode } from '../adapter';
import {
  PI_APPROVAL_PREFIX,
  PI_EXTENSION_SOURCE,
  PI_SESSION_ENV,
  type PiExtensionSession,
  piMcpServer,
} from './extension';

type ToolCallHandler = (
  event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
  ctx: { ui: { select: (title: string, options: string[]) => Promise<string | undefined> } }
) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string };

let dir: string;
let switchSession: (pi: unknown) => void;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'switch-pi-extension-'));
  const file = join(dir, 'switch-session.mjs');
  await writeFile(file, PI_EXTENSION_SOURCE);
  switchSession = ((await import(pathToFileURL(file).href)) as { default: typeof switchSession })
    .default;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('switch.pi.session')];
});

/** Loads the extension as Pi would, with `settings` in the environment. */
function load(settings: PiExtensionSession | undefined) {
  if (settings) process.env[PI_SESSION_ENV] = JSON.stringify(settings);
  else delete process.env[PI_SESSION_ENV];
  const servers: Array<[string, unknown]> = [];
  let handler: ToolCallHandler | undefined;
  switchSession({
    registerMcpServer: (name: string, config: unknown) => servers.push([name, config]),
    on: (event: string, registered: ToolCallHandler) => {
      if (event === 'tool_call') handler = registered;
    },
  });
  const select = vi.fn<(title: string, options: string[]) => Promise<string | undefined>>();
  const call = (toolName: string, input: Record<string, unknown> = {}) => {
    if (!handler) throw new Error('no tool_call handler was registered');
    return Promise.resolve(
      handler({ toolName, toolCallId: `${toolName}-1`, input }, { ui: { select } })
    );
  };
  return { servers, call, select };
}

function session(
  runtimeMode: RuntimeMode,
  extra: Partial<PiExtensionSession> = {}
): PiExtensionSession {
  return { runtimeMode, mcpServers: {}, connectorMcpServers: [], ...extra };
}

const askOf = (title: string) =>
  JSON.parse(title.slice(PI_APPROVAL_PREFIX.length)) as Record<string, unknown>;

describe('the Switch extension for Pi', () => {
  it('takes its settings out of the environment, so commands the model runs never see them', () => {
    load(session('full-access'));
    expect(process.env[PI_SESSION_ENV]).toBeUndefined();
  });

  it("registers the session's MCP servers for the session, with their tools declared to the model", () => {
    const { servers } = load(
      session('approval-required', {
        mcpServers: { switch: { command: 'node', args: ['mcp.js'] } },
      })
    );
    expect(servers).toEqual([
      ['switch', { command: 'node', args: ['mcp.js'], exposure: 'direct' }],
    ]);
  });

  it('blocks every tool when it has no settings, rather than running unapproved', async () => {
    const { call } = load(undefined);
    expect(await call('read')).toMatchObject({ block: true });
  });

  it('keeps its settings for a reload in the same process', async () => {
    load(session('approval-required'));
    const reloaded = load(undefined);
    reloaded.select.mockResolvedValue('decline');
    expect(await reloaded.call('bash', { command: 'ls' })).toMatchObject({ block: true });
    expect(reloaded.select).toHaveBeenCalledTimes(1);
  });

  it('asks nothing in full access', async () => {
    const { call, select } = load(
      session('full-access', {
        connectorMcpServers: ['jira'],
        mcpServers: { jira: { url: 'https://x.test' } },
      })
    );
    for (const tool of ['bash', 'write', 'mcp__jira__create'])
      expect(await call(tool)).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("never asks about the session's own MCP tools, even in approval-required", async () => {
    const { call, select } = load(
      session('approval-required', { mcpServers: { 'switch-room': { command: 'node', args: [] } } })
    );
    expect(await call('mcp__switch_room__send_message')).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it('asks before a connector tool, naming its server', async () => {
    const { call, select } = load(
      session('approval-required', {
        mcpServers: { jira: { url: 'https://x.test' } },
        connectorMcpServers: ['jira'],
      })
    );
    select.mockResolvedValue('accept');
    expect(await call('mcp__jira__create_issue')).toBeUndefined();
    expect(askOf(select.mock.calls[0]?.[0] ?? '')).toMatchObject({ kind: 'mcp', server: 'jira' });
  });

  it('lets reads through and asks before commands and edits in approval-required', async () => {
    const { call, select } = load(session('approval-required'));
    select.mockResolvedValue('accept');
    for (const tool of ['read', 'grep', 'find', 'ls']) expect(await call(tool)).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    await call('bash', { command: 'make test' });
    await call('edit', { path: 'src/a.ts' });
    expect(select.mock.calls.map(([title]) => askOf(title))).toMatchObject([
      { kind: 'command', toolName: 'bash', detail: 'make test' },
      { kind: 'file', toolName: 'edit', detail: 'src/a.ts' },
    ]);
  });

  it('lets edits through but still asks before commands in auto-accept-edits', async () => {
    const { call, select } = load(session('auto-accept-edits'));
    select.mockResolvedValue('accept');
    expect(await call('write', { path: 'a.txt' })).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    await call('bash', { command: 'ls' });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('asks before a tool it does not know', async () => {
    const { call, select } = load(session('auto-accept-edits'));
    select.mockResolvedValue('accept');
    await call('some_extension_tool');
    expect(askOf(select.mock.calls[0]?.[0] ?? '')).toMatchObject({
      kind: 'tool',
      toolName: 'some_extension_tool',
    });
  });

  it('blocks a call that was declined, dismissed or answered with anything else', async () => {
    const { call, select } = load(session('approval-required'));
    for (const answer of ['decline', undefined, 'Allow']) {
      select.mockResolvedValueOnce(answer);
      expect(await call('bash', { command: 'ls' })).toMatchObject({ block: true });
    }
  });

  it('remembers a command allowed for the session, and asks again for another', async () => {
    const { call, select } = load(session('approval-required'));
    select.mockResolvedValueOnce('acceptForSession');
    expect(await call('bash', { command: 'npm test' })).toBeUndefined();
    expect(await call('bash', { command: 'npm test' })).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
    select.mockResolvedValueOnce('decline');
    expect(await call('bash', { command: 'rm -rf /' })).toMatchObject({ block: true });
    expect(select).toHaveBeenCalledTimes(2);
  });
});

describe('piMcpServer', () => {
  it('passes a stdio server the variables it names, from the session environment', () => {
    expect(
      piMcpServer(
        {
          transport: 'stdio',
          command: 'node',
          args: ['s.js'],
          envVars: ['TOKEN', 'MISSING'],
          env: { MODE: 'x' },
        },
        { TOKEN: 't', OTHER: 'o' }
      )
    ).toEqual({ command: 'node', args: ['s.js'], env: { TOKEN: 't', MODE: 'x' } });
  });

  it('keeps an HTTP server as Pi takes it', () => {
    expect(piMcpServer({ transport: 'http', url: 'https://x.test/mcp' }, {})).toEqual({
      url: 'https://x.test/mcp',
    });
  });
});
