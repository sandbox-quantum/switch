import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PI_EXTENSION_SOURCE,
  PI_READY,
  PI_SESSION_ENV,
  PI_TOOL_CALL,
  piLiteral,
  piMcpServers,
  writePiSessionFiles,
} from './extension';

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

let dir: string;
let load: (pi: unknown) => void;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-extension-'));
  const file = join(dir, 'switch-session.mjs');
  await writeFile(file, PI_EXTENSION_SOURCE);
  load = ((await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void }).default;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env[PI_SESSION_ENV];
});

/** Pi's extension API, as much of it as the extension uses. */
function fakePi(tools: Array<{ name: string; annotations?: Record<string, boolean> }> = []) {
  const handlers = new Map<string, Handler>();
  const servers: Record<string, unknown> = {};
  return {
    handlers,
    servers,
    api: {
      registerMcpServer: (name: string, config: unknown) => (servers[name] = config),
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      getAllTools: () => tools,
    },
  };
}

function loaded(tools?: Parameters<typeof fakePi>[0]) {
  process.env[PI_SESSION_ENV] = JSON.stringify({
    mcpServers: { switch: { url: 'http://127.0.0.1:1/mcp', exposure: 'direct' } },
  });
  const pi = fakePi(tools);
  load(pi.api);
  return pi;
}

/** Calls the `tool_call` handler as Pi does, answering its question with `answer`. */
async function toolCall(
  pi: ReturnType<typeof fakePi>,
  answer: string | undefined | Error
): Promise<{ result: unknown; question: unknown; options: unknown }> {
  let question: unknown;
  let options: unknown;
  const ctx = {
    ui: {
      select: async (title: string, choices: string[]) => {
        question = JSON.parse(title);
        options = choices;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
  const result = await pi.handlers.get('tool_call')!(
    { toolCallId: 'call-1', toolName: 'mcp__docs__search', input: { q: 'x' } },
    ctx
  );
  return { result, question, options };
}

describe('the Switch extension Pi loads', () => {
  it("registers the session's servers and removes the variable they came in", () => {
    const pi = loaded();
    expect(pi.servers).toEqual({ switch: { url: 'http://127.0.0.1:1/mcp', exposure: 'direct' } });
    expect(process.env[PI_SESSION_ENV]).toBeUndefined();
  });

  it('refuses to load without a session, which makes Pi exit', () => {
    expect(() => load(fakePi().api)).toThrow(`${PI_SESSION_ENV} is not set`);
  });

  it('says it is ready once its session starts', () => {
    const pi = loaded();
    const notes: unknown[] = [];
    pi.handlers.get('session_start')!(
      {},
      { ui: { notify: (...args: unknown[]) => notes.push(args) } }
    );
    expect(notes).toEqual([[PI_READY, 'info']]);
  });

  it('asks the host about each tool call, with what it will run and what its server says of it', async () => {
    const pi = loaded([{ name: 'mcp__docs__search', annotations: { readOnlyHint: true } }]);
    const { result, question, options } = await toolCall(pi, 'allow');
    expect(question).toEqual({
      switch: PI_TOOL_CALL,
      toolCallId: 'call-1',
      toolName: 'mcp__docs__search',
      input: { q: 'x' },
      annotations: { readOnlyHint: true },
    });
    expect(options).toEqual(['allow', 'block']);
    expect(result).toBeUndefined();
  });

  it('blocks the call on a refusal, and tells the model to stop and wait rather than work around it', async () => {
    const { result } = await toolCall(loaded(), 'block');
    expect(result).toEqual({
      block: true,
      reason:
        'Declined in Switch. Stop here and wait for the person to say how to go on; do not do this another way.',
    });
  });

  it('blocks the call when the question is cancelled', async () => {
    const { result } = await toolCall(loaded(), undefined);
    expect(result).toMatchObject({ block: true, reason: 'Cancelled before anyone answered.' });
  });

  it('lets a failure reach Pi, which blocks a tool whose handler throws', async () => {
    await expect(toolCall(loaded(), new Error('stdin closed'))).rejects.toThrow('stdin closed');
  });
});

describe('MCP servers as Pi reads them', () => {
  it('passes every value literally, never as a variable or a command', () => {
    expect(piLiteral('Bearer abc')).toBe('Bearer abc');
    expect(piLiteral('a$b${HOME}$$')).toBe('a$$b$${HOME}$$$$');
    expect(piLiteral('!rm -rf ~')).toBe('$!rm -rf ~');
    expect(piLiteral('$!x')).toBe('$$!x');
  });

  it("declares every tool to the model, and fills a stdio server's variables from the session", () => {
    expect(
      piMcpServers(
        {
          echo: {
            transport: 'stdio',
            command: 'node',
            args: ['echo.js'],
            env: { MODE: 'test' },
            envVars: ['ECHO_TOKEN', 'MISSING'],
          },
          switch: {
            transport: 'http',
            url: 'http://127.0.0.1:1/mcp',
            headers: { Authorization: 'Bearer $x' },
          },
        },
        { ECHO_TOKEN: '!secret', MODE: 'from the session' }
      )
    ).toEqual({
      echo: {
        command: 'node',
        args: ['echo.js'],
        env: { ECHO_TOKEN: '$!secret', MODE: 'test' },
        exposure: 'direct',
      },
      switch: {
        url: 'http://127.0.0.1:1/mcp',
        headers: { Authorization: 'Bearer $$x' },
        exposure: 'direct',
      },
    });
  });
});

describe("the session's own folder", () => {
  it('holds the extension and the system context, readable only by their owner', async () => {
    const files = await writePiSessionFiles('Skill text');
    try {
      expect((await stat(files.dir)).mode & 0o777).toBe(0o700);
      expect((await stat(files.extension)).mode & 0o777).toBe(0o600);
      expect(files.systemPrompt).not.toBeNull();
      expect((await stat(files.systemPrompt!)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(files.dir, { recursive: true, force: true });
    }
  });

  it('has no system context file when there is no context', async () => {
    const files = await writePiSessionFiles('');
    try {
      expect(files.systemPrompt).toBeNull();
    } finally {
      await rm(files.dir, { recursive: true, force: true });
    }
  });
});
