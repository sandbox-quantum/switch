import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerSpec } from '../adapter';
import {
  APPROVAL_OPTIONS,
  decodeDialog,
  SWITCH_EXTENSION_COMMAND,
  SWITCH_EXTENSION_CONFIG_ENV,
  type SwitchDialog,
  type SwitchExtensionConfig,
} from './protocol';
import {
  piMcpServers,
  SWITCH_EXTENSION_FILE,
  writeSwitchExtension,
  writeSwitchExtensionConfig,
} from './switch-extension';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'switch-pi-test-'));
});
afterEach(async () => {
  delete process.env[SWITCH_EXTENSION_CONFIG_ENV];
  await rm(directory, { recursive: true, force: true });
});

interface ToolDefinition {
  name: string;
  parameters: { required: string[] };
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: Ctx
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
}
interface Ctx {
  signal: undefined;
  ui: { select: ReturnType<typeof vi.fn> };
}
type ToolCall = { toolName: string; toolCallId: string; input?: unknown };
type Gate = (event: ToolCall, ctx: Ctx) => Promise<{ block: true; reason: string } | undefined>;

/**
 * Loads the extension the way Pi does, with the settings it is given and a
 * stand-in for Pi's extension API, and returns what it registered.
 */
async function load(config: Partial<SwitchExtensionConfig> = {}) {
  const extension = await writeSwitchExtension(directory);
  const settings = await writeSwitchExtensionConfig(directory, {
    runtimeMode: 'approval-required',
    mcpServers: {},
    connectorMcpServers: [],
    ...config,
  });
  process.env[SWITCH_EXTENSION_CONFIG_ENV] = settings;
  // Each load reads the settings again, so each is a new module.
  const module = (await import(
    /* @vite-ignore */ `${pathToFileURL(extension).href}?${Math.random()}`
  )) as {
    default: (pi: unknown) => void;
  };
  const registered = {
    mcpServers: new Map<string, Record<string, unknown>>(),
    tools: new Map<string, ToolDefinition>(),
    commands: [] as string[],
    gate: undefined as Gate | undefined,
  };
  module.default({
    registerMcpServer: (name: string, server: Record<string, unknown>) =>
      registered.mcpServers.set(name, server),
    registerTool: (tool: ToolDefinition) => registered.tools.set(tool.name, tool),
    registerCommand: (name: string) => registered.commands.push(name),
    on: (event: string, handler: Gate) => {
      if (event === 'tool_call') registered.gate = handler;
    },
  });
  return registered;
}

/** A tool call run through the gate; `answer` is what the person picks, if asked. */
async function gate(
  registered: Awaited<ReturnType<typeof load>>,
  toolName: string,
  answer?: string
) {
  const ctx: Ctx = { signal: undefined, ui: { select: vi.fn().mockResolvedValue(answer) } };
  const result = await registered.gate!({ toolName, toolCallId: 'call-1', input: {} }, ctx);
  const [title, options] = ctx.ui.select.mock.calls[0] ?? [];
  return {
    result,
    asked: ctx.ui.select.mock.calls.length > 0,
    dialog: decodeDialog(title as string | undefined) as
      | Extract<SwitchDialog, { kind: 'approval' }>
      | undefined,
    options: options as string[] | undefined,
  };
}

describe('the extension', () => {
  it('registers the session MCP servers for this session, where the model sees their tools', async () => {
    const registered = await load({
      mcpServers: {
        switch: { url: 'http://127.0.0.1:1/mcp' },
        tools: { command: 'node', args: [] },
      },
    });
    expect([...registered.mcpServers]).toEqual([
      ['switch', { url: 'http://127.0.0.1:1/mcp', exposure: 'direct' }],
      ['tools', { command: 'node', args: [], exposure: 'direct' }],
    ]);
  });

  it('registers its marker command last, so that it is there only if all of it ran', async () => {
    const registered = await load();
    expect(registered.commands).toEqual([SWITCH_EXTENSION_COMMAND]);
    expect(registered.gate).toBeDefined();
    expect([...registered.tools.keys()]).toEqual(['ask_user']);
  });

  it('keeps the name of its settings file out of the commands Pi runs', async () => {
    await load();
    expect(process.env[SWITCH_EXTENSION_CONFIG_ENV]).toBeUndefined();
  });

  it('refuses to load without its settings, so the adapter sees it missing', async () => {
    const extension = await writeSwitchExtension(directory);
    process.env[SWITCH_EXTENSION_CONFIG_ENV] = join(directory, 'missing.json');
    await expect(
      import(/* @vite-ignore */ `${pathToFileURL(extension).href}?${Math.random()}`)
    ).rejects.toThrow('ENOENT');
  });
});

describe('the approval gate', () => {
  it.each(['read', 'ls', 'grep', 'find', 'ask_user', 'codemode', 'read_mcp_resource'])(
    'lets %s run without asking',
    async (tool) => {
      expect((await gate(await load(), tool)).asked).toBe(false);
    }
  );

  it.each(['bash', 'edit', 'write', 'a_tool_nobody_heard_of'])(
    'asks before %s in approval-required mode',
    async (tool) => {
      const { asked, dialog, options } = await gate(await load(), tool, 'Allow once');
      expect(asked).toBe(true);
      expect(dialog).toEqual({ kind: 'approval', toolCallId: 'call-1', toolName: tool });
      expect(options).toEqual([...APPROVAL_OPTIONS]);
    }
  );

  it('asks wherever approval-required asks when the mode is auto, for Pi has no reviewer of its own', async () => {
    expect((await gate(await load({ runtimeMode: 'auto' }), 'bash', 'Allow once')).asked).toBe(
      true
    );
    expect((await gate(await load({ runtimeMode: 'auto' }), 'write', 'Allow once')).asked).toBe(
      true
    );
  });

  it('asks about nothing in full-access mode', async () => {
    const registered = await load({
      runtimeMode: 'full-access',
      connectorMcpServers: ['github'],
      mcpServers: { github: {} },
    });
    for (const tool of ['bash', 'write', 'mcp__github__create_issue', 'mcp__elsewhere__tool'])
      expect((await gate(registered, tool)).asked).toBe(false);
  });

  it('lets edits through in auto-accept-edits mode and asks about the rest', async () => {
    const registered = await load({ runtimeMode: 'auto-accept-edits' });
    expect((await gate(registered, 'edit')).asked).toBe(false);
    expect((await gate(registered, 'write')).asked).toBe(false);
    expect((await gate(registered, 'bash', 'Allow once')).asked).toBe(true);
  });

  it('never asks about the tools of the servers the session registered, the Switch tools first', async () => {
    const registered = await load({
      mcpServers: { switch: {}, 'my-tools': {} },
      connectorMcpServers: [],
    });
    expect((await gate(registered, 'mcp__switch__send_message')).asked).toBe(false);
    // A server name is written into a tool name with "-" turned into "_".
    expect((await gate(registered, 'mcp__my_tools__run')).asked).toBe(false);
  });

  it('asks about a connector tool, naming the server', async () => {
    const registered = await load({
      mcpServers: { switch: {}, github: {} },
      connectorMcpServers: ['github'],
    });
    const { dialog } = await gate(registered, 'mcp__github__create_issue', 'Allow once');
    expect(dialog).toEqual({
      kind: 'approval',
      toolCallId: 'call-1',
      toolName: 'mcp__github__create_issue',
      server: 'github',
      connector: true,
    });
  });

  it("asks about a server from the person's own Pi configuration, which Switch cannot vouch for", async () => {
    const { asked, dialog } = await gate(await load(), 'mcp__their_server__tool', 'Allow once');
    expect(asked).toBe(true);
    expect(dialog).toMatchObject({ server: 'their_server', connector: false });
  });

  it('runs the tool when it is allowed once, and asks again the next time', async () => {
    const registered = await load();
    expect((await gate(registered, 'bash', 'Allow once')).result).toBeUndefined();
    expect((await gate(registered, 'bash', 'Allow once')).asked).toBe(true);
  });

  it('remembers a tool allowed for the session, and no other', async () => {
    const registered = await load();
    expect((await gate(registered, 'bash', 'Allow for this session')).result).toBeUndefined();
    expect((await gate(registered, 'bash')).asked).toBe(false);
    expect((await gate(registered, 'write', 'Allow once')).asked).toBe(true);
  });

  it('blocks the tool when the person rejects it', async () => {
    const { result } = await gate(await load(), 'bash', 'Reject');
    expect(result).toEqual({ block: true, reason: 'Denied by the user in Switch.' });
  });

  it('blocks the tool when the request is cancelled, and remembers nothing', async () => {
    const registered = await load();
    expect((await gate(registered, 'bash', undefined)).result).toEqual({
      block: true,
      reason: 'The approval request was cancelled.',
    });
    expect((await gate(registered, 'bash', 'Allow once')).asked).toBe(true);
  });
});

describe('ask_user', () => {
  async function ask(params: Record<string, unknown>, answer: string | undefined) {
    const { tools } = await load();
    const tool = tools.get('ask_user')!;
    const ctx: Ctx = { signal: undefined, ui: { select: vi.fn().mockResolvedValue(answer) } };
    const result = await tool.execute('call-1', params, undefined, undefined, ctx);
    const [title, options] = ctx.ui.select.mock.calls[0]!;
    return { text: result.content[0]!.text, dialog: decodeDialog(title as string), options };
  }

  it('asks the question with its choices and returns the one chosen', async () => {
    const { text, dialog, options } = await ask(
      { question: 'Which color?', options: ['red', 'green'], header: 'Color' },
      'green'
    );
    expect(text).toBe('green');
    expect(options).toEqual(['red', 'green']);
    expect(dialog).toEqual({
      kind: 'question',
      question: 'Which color?',
      header: 'Color',
      multiSelect: false,
    });
  });

  it('reads a multiple choice back from the JSON array the adapter answers with', async () => {
    const { text, dialog } = await ask(
      { question: 'Which?', options: ['a', 'b', 'c'], multiSelect: true },
      '["a","c"]'
    );
    expect(text).toBe('a, c');
    expect(dialog).toMatchObject({ multiSelect: true });
  });

  it('says so when the question went unanswered', async () => {
    expect((await ask({ question: 'Which?', options: ['a'] }, undefined)).text).toBe(
      'The user did not answer.'
    );
  });

  it('needs a question and its choices', async () => {
    expect((await load()).tools.get('ask_user')!.parameters.required).toEqual([
      'question',
      'options',
    ]);
  });
});

describe('the dialogs', () => {
  it('are recognised by their prefix alone, so another extension is never taken for Switch', () => {
    expect(decodeDialog('Pick one:')).toBeUndefined();
    expect(decodeDialog('switch-pi:not json')).toBeUndefined();
    expect(decodeDialog('switch-pi:{"kind":"other"}')).toBeUndefined();
  });
});

describe('piMcpServers', () => {
  const stdio: McpServerSpec = {
    transport: 'stdio',
    command: '/usr/bin/node',
    args: ['server.js'],
    env: { TOKEN: 'a$b' },
    envVars: ['HOME', 'ABSENT'],
  };

  it('writes a stdio server with its environment from the session, under its own', () => {
    expect(piMcpServers({ echo: stdio }, { HOME: '/home/u', OTHER: 'x' })).toEqual({
      echo: {
        command: '/usr/bin/node',
        args: ['server.js'],
        env: { HOME: '/home/u', TOKEN: 'a$$b' },
      },
    });
  });

  it('writes an HTTP server with its headers', () => {
    expect(
      piMcpServers(
        {
          switch: {
            transport: 'http',
            url: 'http://127.0.0.1:9/mcp',
            headers: { Authorization: 'Bearer t' },
          },
        },
        {}
      )
    ).toEqual({
      switch: { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer t' } },
    });
  });

  it('keeps Pi from expanding or running what is only text', () => {
    const servers = piMcpServers(
      {
        web: {
          transport: 'http',
          url: 'http://127.0.0.1:9/mcp',
          headers: { A: '$HOME', B: '${HOME}', C: '!rm -rf', D: 'cost: 5$' },
        },
      },
      {}
    );
    // Pi reads "$$" as "$" and a leading "$!" as "!".
    expect(servers.web).toMatchObject({
      headers: { A: '$$HOME', B: '$${HOME}', C: '$!rm -rf', D: 'cost: 5$$' },
    });
  });
});

describe('installing the extension', () => {
  it('writes the extension and its settings to the directory it is given, and nowhere else', async () => {
    const path = await writeSwitchExtension(directory);
    await writeSwitchExtensionConfig(directory, {
      runtimeMode: 'full-access',
      mcpServers: {},
      connectorMcpServers: [],
    });
    expect(path).toBe(join(directory, SWITCH_EXTENSION_FILE));
    expect((await readdir(directory)).sort()).toEqual(['config.json', SWITCH_EXTENSION_FILE]);
  });

  it('can be written twice', async () => {
    await writeSwitchExtension(directory);
    await writeFile(join(directory, SWITCH_EXTENSION_FILE), 'stale');
    await writeSwitchExtension(directory);
    expect(await readdir(directory)).toEqual([SWITCH_EXTENSION_FILE]);
  });
});
