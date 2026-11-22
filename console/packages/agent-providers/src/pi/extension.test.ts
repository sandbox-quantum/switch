import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoShadowingServers,
  PI_EXTENSION_SOURCE,
  PI_SESSION_ENV,
  PI_SESSION_KEY,
  PI_TOOL_CALL_DIALOG,
  piLiteral,
  piMcpServers,
} from './extension';

type ToolCallHandler = (
  event: { toolCallId: string; toolName: string; input: Record<string, unknown> },
  ctx: { ui: { confirm: typeof confirm }; signal?: AbortSignal }
) => Promise<{ block: true; reason: string } | undefined>;

const confirm =
  vi.fn<(title: string, message: string, opts: { signal?: AbortSignal }) => Promise<boolean>>();
let dir: string;

const kept = globalThis as Record<symbol, unknown>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-extension-'));
  confirm.mockReset();
  // Each Pi process loads one session; these tests share a process.
  delete kept[Symbol.for(PI_SESSION_KEY)];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** Loads the extension as Pi does, with a stand-in for its API. */
async function load(api: Record<string, unknown> = {}) {
  const file = join(dir, `switch-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, PI_EXTENSION_SOURCE);
  const module = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    default: (pi: unknown) => void;
  };
  const registered: Array<[string, unknown]> = [];
  const handlers = new Map<string, ToolCallHandler>();
  module.default({
    registerMcpServer: (name: string, config: unknown) => registered.push([name, config]),
    on: (event: string, handler: ToolCallHandler) => handlers.set(event, handler),
    ...api,
  });
  return { registered, toolCall: handlers.get('tool_call')! };
}

async function withSession(mcpServers: Record<string, unknown>): Promise<string> {
  const session = join(dir, 'session.json');
  await writeFile(session, JSON.stringify({ mcpServers }));
  vi.stubEnv(PI_SESSION_ENV, session);
  return session;
}

describe('the Switch extension', () => {
  it("registers the session's MCP servers as given", async () => {
    const echo = { command: '/node', args: ['/echo.mjs'], exposure: 'direct' };
    await withSession({ echo });
    expect((await load()).registered).toEqual([['echo', echo]]);
  });

  it("keeps the session's credentials from Pi's commands and MCP servers, and still reloads", async () => {
    const remote = { url: 'http://127.0.0.1:4000/mcp', headers: { Authorization: 'Bearer t' } };
    const session = await withSession({ switch: remote });
    expect((await load()).registered).toEqual([['switch', remote]]);
    await expect(stat(session)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(process.env[PI_SESSION_ENV]).toBeUndefined();
    expect((await load()).registered).toEqual([['switch', remote]]);
  });

  it('lets a tool call run only when the adapter says yes, tied to the turn', async () => {
    await withSession({});
    const { toolCall } = await load();
    const signal = new AbortController().signal;
    const event = { toolCallId: 'call_1', toolName: 'bash', input: { command: 'ls' } };
    confirm.mockResolvedValueOnce(true);
    expect(await toolCall(event, { ui: { confirm }, signal })).toBeUndefined();
    expect(confirm).toHaveBeenCalledWith(PI_TOOL_CALL_DIALOG, JSON.stringify(event), { signal });
    for (const answer of [false, undefined]) {
      confirm.mockResolvedValueOnce(answer as boolean);
      expect(await toolCall(event, { ui: { confirm }, signal })).toEqual({
        block: true,
        reason: 'The user did not allow this tool call.',
      });
    }
  });

  it('fails to load, which stops Pi, without its session or the MCP API', async () => {
    vi.stubEnv(PI_SESSION_ENV, '');
    await expect(load()).rejects.toThrow(`${PI_SESSION_ENV} is not set.`);
    vi.stubEnv(PI_SESSION_ENV, join(dir, 'missing.json'));
    await expect(load()).rejects.toThrow('ENOENT');
    await withSession({});
    await expect(load({ registerMcpServer: undefined })).rejects.toThrow(
      'Switch needs a Pi that can register MCP servers'
    );
  });
});

describe('MCP servers for Pi', () => {
  it('declares each to the model, with its values read literally', () => {
    expect(
      piMcpServers({
        switch: {
          transport: 'http',
          url: 'http://127.0.0.1:4000/mcp',
          headers: { Authorization: 'Bearer $abc' },
        },
        'echo-1': { transport: 'stdio', command: '/node', args: ['/e.mjs'], env: { RUN: '!id' } },
        plain: { transport: 'stdio', command: '/node', args: [] },
      })
    ).toEqual({
      switch: {
        url: 'http://127.0.0.1:4000/mcp',
        headers: { Authorization: 'Bearer $$abc' },
        exposure: 'direct',
      },
      'echo-1': { command: '/node', args: ['/e.mjs'], env: { RUN: '$!id' }, exposure: 'direct' },
      plain: { command: '/node', args: [], exposure: 'direct' },
    });
    expect(() =>
      piMcpServers({ 'my.server': { transport: 'stdio', command: 'x', args: [] } })
    ).toThrow('Pi cannot take an MCP server named my.server');
  });

  it("escapes Pi's variable and command syntax", () => {
    expect(piLiteral('plain')).toBe('plain');
    expect(piLiteral('$HOME and ${PATH}')).toBe('$$HOME and $${PATH}');
    expect(piLiteral('!curl evil')).toBe('$!curl evil');
    expect(piLiteral('!$x')).toBe('$!$$x');
    expect(piLiteral('a!b')).toBe('a!b');
  });
});

describe("the user's own Pi MCP configuration", () => {
  async function config(path: string, mcpServers: Record<string, unknown>): Promise<string> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers }));
    return path;
  }

  it('may define servers of other names', async () => {
    await config(join(dir, 'home', '.pi', 'agent', 'mcp.json'), { docs: { url: 'https://d' } });
    await expect(
      assertNoShadowingServers(['switch'], join(dir, 'work'), { HOME: join(dir, 'home') })
    ).resolves.toBeUndefined();
  });

  it("may not define a server Pi would take for one of the session's", async () => {
    const user = await config(join(dir, 'home', '.pi', 'agent', 'mcp.json'), {
      switch: { command: 'x' },
    });
    await expect(
      assertNoShadowingServers(['switch'], join(dir, 'work'), { HOME: join(dir, 'home') })
    ).rejects.toThrow(`${user} defines an MCP server named switch`);
    const project = await config(join(dir, 'work', '.pi', 'mcp.json'), {
      room_tools__x: { command: 'x' },
    });
    await expect(
      assertNoShadowingServers(['room-tools'], join(dir, 'work'), { HOME: join(dir, 'nobody') })
    ).rejects.toThrow(`${project} defines an MCP server named room_tools__x`);
  });

  it('is read from PI_CODING_AGENT_DIR when that is set', async () => {
    const custom = await config(join(dir, 'custom', 'mcp.json'), { switch: { command: 'x' } });
    await expect(
      assertNoShadowingServers(['switch'], join(dir, 'work'), {
        HOME: join(dir, 'home'),
        PI_CODING_AGENT_DIR: join(dir, 'custom'),
      })
    ).rejects.toThrow(custom);
  });
});
