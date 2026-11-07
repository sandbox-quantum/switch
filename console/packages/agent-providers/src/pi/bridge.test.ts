import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bridgeSource,
  PI_BRIDGE_CONFIG_ENV,
  PI_BRIDGE_ERROR_NOTICE,
  piBridge,
  piBridgeHandshakeCommand,
  piBridgeRunTag,
  type PiBridgeApi,
  type PiBridgeBashOperations,
  type PiBridgeBlock,
  type PiBridgeConfirmMessage,
  type PiBridgeContext,
  type PiBridgeSdk,
  type PiBridgeToolCallEvent,
  type PiBridgeToolDefinition,
  type PiMcpServerConfig,
} from './bridge';
import { killPiBashGroups } from './pi-adapter';
import {
  PI_BASH_MARKER_ENV,
  piBashArgsFingerprint,
  piBashProcessView,
  piBashPsArgsDigest,
  piProcSource,
  piProcessGroupMembers,
  readPiBashRegistry,
  readPiProcStat,
  readPiPsCommand,
  signalPiBashGroup,
  verifyPiBashGroup,
} from './pi-bash';
import { piConversationStore } from './pi-conversation';

const NONCE = 'nonce_0123456789abcdef';
const SECRET = 'sk-test-SECRET-value-7f3a';

type Handler = (event: unknown, ctx: PiBridgeContext) => unknown;

// As Pi 1.4.0 reports it (`bashSchema` in `core/tools/bash.js`); the bridge's `bash` keeps it.
const BASH_SCHEMA = {
  type: 'object',
  required: ['command'],
  properties: { command: { type: 'string' }, timeout: { type: 'number' } },
};
/** `sourceInfo.path` Pi gives what the bridge registers: the path passed to `-e`. */
const BRIDGE_PATH = '/run/switch/pi/bridge-0123abcd.mjs';
const FOREIGN_PATH = '/home/user/.pi/agent/extensions/other.mjs';

type ToolInfo = ReturnType<PiBridgeApi['getAllTools']>[number];

/** Pi's extension API as far as the bridge uses it, recording what the bridge registers. */
class FakePiApi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands: Array<{
    name: string;
    handler: (args: string, ctx: unknown) => Promise<void>;
  }> = [];
  readonly tools: PiBridgeToolDefinition[] = [];
  readonly mcp: Array<[string, PiMcpServerConfig]> = [];
  /** Built-in tools and the MCP tools of `builtin:mcp`. */
  toolInfos: ToolInfo[] = [
    { name: 'bash', sourceInfo: { path: 'builtin:bash' }, parameters: BASH_SCHEMA } as ToolInfo,
    {
      name: 'mcp__team_docs__search',
      namespace: { name: 'mcp__team_docs', aliases: ['team-docs'] },
      sourceInfo: { path: 'builtin:mcp' },
    },
  ];
  /** Tools and commands of other extensions, loaded before or after the bridge. */
  readonly foreign: Array<{
    order: 'before' | 'after';
    path: string;
    tools: ToolInfo[];
    commands: string[];
  }> = [];
  readonly api = {
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    },
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> }
    ) => {
      this.commands.push({ name, handler: options.handler });
    },
    registerTool: (tool: PiBridgeToolDefinition) => {
      this.tools.push(tool);
    },
    registerMcpServer: (name: string, config: PiMcpServerConfig) => {
      this.mcp.push([name, config]);
    },
    getAllTools: () => this.allTools(),
    getCommands: () => this.allCommands(),
  } as unknown as PiBridgeApi;

  /** Another extension, loaded before or after the bridge, registers tools and commands. */
  addForeign(
    order: 'before' | 'after',
    { tools = [] as string[], commands = [] as string[], path: file = FOREIGN_PATH } = {}
  ) {
    this.foreign.push({
      order,
      path: file,
      tools: tools.map((name) => ({ name, sourceInfo: { path: file } }) as ToolInfo),
      commands,
    });
  }

  /** Extensions in load order: those before the bridge, the bridge, those after it. */
  private extensions() {
    const own = {
      path: BRIDGE_PATH,
      tools: this.tools.map(
        (tool) =>
          ({
            name: tool.name,
            parameters: tool.parameters,
            sourceInfo: { path: BRIDGE_PATH },
          }) as ToolInfo
      ),
      commands: this.commands.map((command) => command.name),
    };
    return [
      ...this.foreign.filter((ext) => ext.order === 'before'),
      own,
      ...this.foreign.filter((ext) => ext.order === 'after'),
    ];
  }

  /**
   * Like Pi 1.4.0: the first extension that registers a name wins among extensions
   * (`ExtensionRunner.getAllRegisteredTools`), and an extension tool replaces a built-in one
   * (`AgentSession._refreshToolRegistry`).
   */
  private allTools(): ToolInfo[] {
    const byName = new Map(this.toolInfos.map((tool) => [tool.name, tool]));
    const registered = new Map<string, ToolInfo>();
    for (const ext of this.extensions()) {
      for (const tool of ext.tools) if (!registered.has(tool.name)) registered.set(tool.name, tool);
    }
    for (const [name, tool] of registered) byName.set(name, tool);
    return [...byName.values()];
  }

  /** Like Pi 1.4.0 `resolveRegisteredCommands`: a shared name becomes `<name>:<n>`. */
  private allCommands() {
    const all = this.extensions().flatMap((ext) =>
      ext.commands.map((name) => ({ name, sourceInfo: { path: ext.path } }))
    );
    const counts = new Map<string, number>();
    for (const command of all) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
    const seen = new Map<string, number>();
    return all.map((command) => {
      const n = (seen.get(command.name) ?? 0) + 1;
      seen.set(command.name, n);
      const name = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${n}` : command.name;
      return { name, source: 'extension', sourceInfo: command.sourceInfo };
    });
  }

  /** Runs the handlers of `event` like Pi: in order, the first block wins for `tool_call`. */
  async emit(event: string, payload: unknown, ctx: PiBridgeContext): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      result = await handler(payload, ctx);
      if ((result as PiBridgeBlock | undefined)?.block) return result;
    }
    return result;
  }

  toolCall(event: PiBridgeToolCallEvent, ctx: PiBridgeContext) {
    return this.emit('tool_call', event, ctx) as Promise<PiBridgeBlock | undefined>;
  }

  get bash(): PiBridgeToolDefinition | undefined {
    return this.tools.find((tool) => tool.name === 'bash');
  }
}

function context(
  confirm: (title: string, message: string, options?: { signal?: AbortSignal }) => unknown,
  signal: AbortSignal = new AbortController().signal
) {
  const ctx = {
    ui: {
      confirm: vi.fn(async (...args: Parameters<typeof confirm>) => confirm(...args)),
      notify: vi.fn(),
    },
    signal,
    cwd: os.tmpdir(),
  };
  return ctx;
}

/** Stand-in for `@earendil-works/pi-coding-agent`: a `bash` definition that runs the operations. */
const stubSdk: PiBridgeSdk = {
  createBashToolDefinition(cwd, options) {
    return {
      name: 'bash',
      label: 'bash',
      description: 'stub bash',
      parameters: BASH_SCHEMA,
      async execute(_toolCallId, params, signal) {
        const { command, timeout } = params as { command: string; timeout?: number };
        const chunks: Buffer[] = [];
        if (!options?.operations) throw new Error('stub needs operations');
        const { exitCode } = await options.operations.exec(command, cwd, {
          onData: (data) => chunks.push(data),
          signal,
          timeout,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', STUB_ENV: SECRET },
        });
        return { output: Buffer.concat(chunks).toString('utf8'), exitCode };
      },
    };
  },
  getShellConfig: () => ({ shell: '/bin/bash', args: ['-c'] }),
};

let dir: string;
let registry: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bridge-test-'));
  registry = path.join(dir, 'procs.jsonl');
  delete process.env[PI_BRIDGE_CONFIG_ENV];
});

afterEach(() => {
  delete process.env[PI_BRIDGE_CONFIG_ENV];
  for (const group of readPiBashRegistry(registry).groups) {
    signalPiBashGroup(group, 'SIGKILL');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown, name = 'config.json'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), {
    mode: 0o600,
  });
  return file;
}

function baseConfig(extra: Record<string, unknown> = {}) {
  return { protocolVersion: 1, nonce: NONCE, mcpServers: {}, processRegistry: registry, ...extra };
}

async function startBridge(
  config: unknown = baseConfig(),
  {
    sdk = stubSdk as PiBridgeSdk | undefined,
    env = true,
    host = {} as { procRoot?: string; ps?: string },
  } = {}
) {
  const pi = new FakePiApi();
  if (env) process.env[PI_BRIDGE_CONFIG_ENV] = writeConfig(config);
  // R7-C: the rule of where processes are read, as the generated module passes it.
  await piBridge(pi.api, {
    importPi: sdk ? async () => sdk : undefined,
    procSource: piProcSource,
    ...host,
  });
  return pi;
}

const bashCall = (toolCallId: string, command: string, extra: Record<string, unknown> = {}) => ({
  toolName: 'bash',
  toolCallId,
  input: { command, ...extra },
});

function parsedMessage(ctx: ReturnType<typeof context>, call = 0): PiBridgeConfirmMessage {
  return JSON.parse(ctx.ui.confirm.mock.calls[call]?.[1] as string) as PiBridgeConfirmMessage;
}

describe('without SWITCH_PI_BRIDGE', () => {
  it('registers nothing', async () => {
    const pi = await startBridge(undefined, { env: false });
    expect(pi.handlers.size).toBe(0);
    expect(pi.commands).toEqual([]);
    expect(pi.tools).toEqual([]);
    expect(pi.mcp).toEqual([]);
  });
});

describe('config (SC2)', () => {
  it('reads the config, removes the file and the variable, and answers the handshake', async () => {
    const file = path.join(dir, 'config.json');
    const pi = await startBridge();
    expect(fs.existsSync(file)).toBe(false);
    expect(process.env[PI_BRIDGE_CONFIG_ENV]).toBeUndefined();
    expect(pi.commands.map((command) => command.name)).toEqual([piBridgeHandshakeCommand(NONCE)]);
    await expect(pi.commands[0]?.handler('', {})).resolves.toBeUndefined();
    expect(pi.bash).toBeDefined();
  });

  // Configs are built when each case runs: `registry` exists only after `beforeEach`, and a config
  // without it would be refused for that reason alone, whatever the case is about.
  it.each([
    ['missing file', () => null],
    ['not JSON', () => `{"nonce": "${SECRET}"`],
    ['wrong protocol', () => baseConfig({ protocolVersion: 2 })],
    ['short nonce', () => baseConfig({ nonce: 'short' })],
    ['nonce with a colon', () => baseConfig({ nonce: 'abcdefgh:ijklmnopq' })],
    ['relative registry', () => baseConfig({ processRegistry: 'procs.jsonl' })],
    ['relative shell', () => baseConfig({ shellPath: 'bash' })],
    ['no servers', () => ({ protocolVersion: 1, nonce: NONCE, processRegistry: registry })],
    ['unknown transport', () => baseConfig({ mcpServers: { a: { transport: 'sse', url: 'x' } } })],
    [
      'bad server name',
      () => baseConfig({ mcpServers: { 'a b': { transport: 'http', url: 'x' } } }),
    ],
    ...['a.b', '', 'a/b', 'a__b', 'a-_b', '__'].map((name): [string, () => unknown] => [
      `server name ${JSON.stringify(name)}`,
      () => baseConfig({ mcpServers: { [name]: { transport: 'http', url: 'x' } } }),
    ]),
    [
      'servers with the same namespace',
      () =>
        baseConfig({
          mcpServers: {
            'team-docs': { transport: 'http', url: 'x' },
            team_docs: { transport: 'http', url: 'y' },
          },
        }),
    ],
    [
      'a server namespace that starts with another and _',
      () =>
        baseConfig({
          mcpServers: {
            docs: { transport: 'http', url: 'x' },
            'docs-': { transport: 'http', url: 'y' },
          },
        }),
    ],
    [
      'non-string header',
      () => baseConfig({ mcpServers: { a: { transport: 'http', url: 'x', headers: { h: 1 } } } }),
    ],
    [
      'non-string arg',
      () => baseConfig({ mcpServers: { a: { transport: 'stdio', command: 'c', args: [1] } } }),
    ],
  ])('blocks every tool call when the config is unusable: %s', async (_name, makeConfig) => {
    const pi = new FakePiApi();
    const config = makeConfig();
    process.env[PI_BRIDGE_CONFIG_ENV] =
      config === null ? path.join(dir, 'absent.json') : writeConfig(config);
    await piBridge(pi.api, { importPi: async () => stubSdk });
    expect(process.env[PI_BRIDGE_CONFIG_ENV]).toBeUndefined();
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(pi.commands).toEqual([]);
    expect(pi.tools).toEqual([]);
    expect(pi.mcp).toEqual([]);
    expect(pi.handlers.has('before_agent_start')).toBe(false);
    const ctx = context(() => true);
    for (const call of [
      bashCall('t1', 'true'),
      { toolName: 'read', toolCallId: 't2', input: { path: 'x' } },
      { toolName: 'mcp__team_docs__search', toolCallId: 't3', input: {} },
    ]) {
      const result = await pi.toolCall(call, ctx);
      expect(result?.block).toBe(true);
      expect(result?.reason).toMatch(
        /^switch: bridge unavailable \(config_(unreadable|invalid)\)$/
      );
    }
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    await pi.emit('session_start', {}, ctx);
    const notice = ctx.ui.notify.mock.calls[0]?.[0] as string;
    expect(notice.startsWith(PI_BRIDGE_ERROR_NOTICE)).toBe(true);
    expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain(SECRET);
  });

  it('accepts every server name Pi accepts that keeps owners unambiguous (X2-04)', async () => {
    // `0` first: JavaScript lists integer keys before the others.
    const names = ['0', '_docs', 'docs_', 'Docs-2', '-x', 'a_b-c'];
    const pi = await startBridge(
      baseConfig({
        mcpServers: Object.fromEntries(
          names.map((name) => [name, { transport: 'http', url: 'http://127.0.0.1:9/mcp' }])
        ),
      })
    );
    expect(pi.mcp.map(([name]) => name)).toEqual(names);
    expect(pi.commands.map((command) => command.name)).toEqual([piBridgeHandshakeCommand(NONCE)]);
  });

  it('blocks everything when the config path is a directory, not a file', async () => {
    const pi = new FakePiApi();
    fs.mkdirSync(path.join(dir, 'cfgdir'));
    process.env[PI_BRIDGE_CONFIG_ENV] = path.join(dir, 'cfgdir');
    await piBridge(pi.api, { importPi: async () => stubSdk });
    const result = await pi.toolCall(
      bashCall('t1', 'true'),
      context(() => true)
    );
    expect(result?.block).toBe(true);
    expect(pi.commands).toEqual([]);
  });

  it('blocks everything and removes the link when the config path is a symlink', async () => {
    const target = writeConfig(baseConfig(), 'target.json');
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(target, link);
    const pi = new FakePiApi();
    process.env[PI_BRIDGE_CONFIG_ENV] = link;
    await piBridge(pi.api, { importPi: async () => stubSdk });
    expect(fs.existsSync(link)).toBe(false);
    expect(
      (
        await pi.toolCall(
          bashCall('t1', 'true'),
          context(() => true)
        )
      )?.block
    ).toBe(true);
    expect(pi.commands).toEqual([]);
  });

  it('blocks everything when the variable is set but empty', async () => {
    const pi = new FakePiApi();
    process.env[PI_BRIDGE_CONFIG_ENV] = '';
    await piBridge(pi.api, { importPi: async () => stubSdk });
    expect(
      (
        await pi.toolCall(
          bashCall('t1', 'true'),
          context(() => true)
        )
      )?.block
    ).toBe(true);
    expect(pi.commands).toEqual([]);
  });

  it.each([
    ['no importer', undefined],
    ['importer throws', 'throw'],
    ['module without createBashToolDefinition', 'empty'],
  ])('blocks everything without the Pi SDK: %s', async (_name, mode) => {
    const pi = new FakePiApi();
    process.env[PI_BRIDGE_CONFIG_ENV] = writeConfig(baseConfig());
    await piBridge(pi.api, {
      importPi:
        mode === undefined
          ? undefined
          : async () => {
              if (mode === 'throw') throw new Error('Cannot find package');
              return {} as PiBridgeSdk;
            },
    });
    const result = await pi.toolCall(
      bashCall('t1', 'true'),
      context(() => true)
    );
    expect(result).toEqual({
      block: true,
      reason: 'switch: bridge unavailable (pi_sdk_unavailable)',
    });
    expect(pi.commands).toEqual([]);
  });

  it('blocks everything when registering a server fails', async () => {
    const pi = new FakePiApi();
    (pi.api as { registerMcpServer: unknown }).registerMcpServer = () => {
      throw new Error('duplicate');
    };
    process.env[PI_BRIDGE_CONFIG_ENV] = writeConfig(
      baseConfig({ mcpServers: { a: { transport: 'http', url: 'http://127.0.0.1:1/mcp' } } })
    );
    await piBridge(pi.api, { importPi: async () => stubSdk });
    const result = await pi.toolCall(
      bashCall('t1', 'true'),
      context(() => true)
    );
    expect(result).toEqual({ block: true, reason: 'switch: bridge unavailable (setup_failed)' });
    expect(pi.commands).toEqual([]);
  });
});

describe('approval (SC2)', () => {
  it('lets a call through only on an explicit true, with the full call in the message', async () => {
    const pi = await startBridge();
    await pi.emit(
      'before_agent_start',
      {},
      context(() => true)
    );
    const ctx = context(() => true);
    const long = 'x'.repeat(5000);
    const result = await pi.toolCall(
      {
        toolName: 'mcp__team_docs__search',
        toolCallId: 'call-1',
        parentToolCallId: 'parent-1',
        input: { text: long },
      },
      ctx
    );
    expect(result).toBeUndefined();
    const [title, , options] = ctx.ui.confirm.mock.calls[0] ?? [];
    expect(title).toBe(piBridgeRunTag(NONCE, 1));
    expect(options).toEqual({ signal: ctx.signal });
    expect(parsedMessage(ctx)).toEqual({
      protocolVersion: 1,
      nonce: NONCE,
      run: 1,
      toolCallId: 'call-1',
      parentToolCallId: 'parent-1',
      toolName: 'mcp__team_docs__search',
      server: { namespace: 'mcp__team_docs', aliases: ['team-docs'], sourcePath: 'builtin:mcp' },
      input: { text: long },
    });
  });

  it('reports no server for a tool without a namespace', async () => {
    const pi = await startBridge();
    const ctx = context(() => true);
    await pi.toolCall({ toolName: 'read', toolCallId: 'r1', input: { path: 'a' } }, ctx);
    expect(parsedMessage(ctx).server).toBeNull();
    expect(parsedMessage(ctx).parentToolCallId).toBeNull();
  });

  it.each([
    ['false', () => false, 'switch: not approved'],
    ['undefined', () => undefined, 'switch: not approved'],
    ['null', () => null, 'switch: not approved'],
    ['1', () => 1, 'switch: not approved'],
    ['"true"', () => 'true', 'switch: not approved'],
    ['an object', () => ({ confirmed: true }), 'switch: not approved'],
    [
      'a throw',
      () => {
        throw new Error('ui gone');
      },
      'switch: approval failed',
    ],
    ['a rejection', () => Promise.reject(new Error('rpc closed')), 'switch: approval failed'],
  ])('blocks on %s', async (_name, answer, reason) => {
    const pi = await startBridge();
    const result = await pi.toolCall(bashCall('t1', 'true'), context(answer));
    expect(result).toEqual({ block: true, reason });
    await expect(
      pi.bash?.execute('t1', { command: 'true' }, undefined, undefined, undefined)
    ).rejects.toThrow('switch: bash call was not approved');
  });

  it('blocks a cancelled dialog: the signal aborts and Pi answers false', async () => {
    const pi = await startBridge();
    const controller = new AbortController();
    const ctx = context(
      (_title, _message, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(false));
        }),
      controller.signal
    );
    const pending = pi.toolCall(bashCall('t1', 'true'), ctx);
    controller.abort();
    await expect(pending).resolves.toEqual({ block: true, reason: 'switch: not approved' });
  });

  it('blocks input that cannot be serialized, without asking', async () => {
    const pi = await startBridge();
    const ctx = context(() => true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const input of [cyclic, undefined, { n: 10n }]) {
      const result = await pi.toolCall({ toolName: 'x', toolCallId: 'c', input }, ctx);
      expect(result).toEqual({ block: true, reason: 'switch: tool input cannot be checked' });
    }
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it('runs an approved bash call once; execute refuses calls it did not approve', async () => {
    const pi = await startBridge();
    expect(
      await pi.toolCall(
        bashCall('ok-1', 'echo hi'),
        context(() => true)
      )
    ).toBeUndefined();
    const bash = pi.bash as PiBridgeToolDefinition;
    await expect(
      bash.execute('ok-1', { command: 'echo hi' }, undefined, undefined, undefined)
    ).resolves.toEqual({ output: 'hi\n', exitCode: 0 });
    await expect(
      bash.execute('ok-1', { command: 'echo again' }, undefined, undefined, undefined)
    ).rejects.toThrow('not approved');
    await expect(
      bash.execute('never', { command: 'echo x' }, undefined, undefined, undefined)
    ).rejects.toThrow('not approved');
  });
});

describe('input mutation (SC3)', () => {
  it('freezes the input before the dialog: a write during it fails, the shown call runs', async () => {
    const pi = await startBridge();
    const proof = path.join(dir, 'safe.txt');
    const evil = path.join(dir, 'evil.txt');
    const call = bashCall('m1', `touch '${proof}'`);
    const errors: unknown[] = [];
    const ctx = context(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        (call.input as { command: string }).command = `touch '${evil}'`;
      } catch (error) {
        errors.push(error);
      }
      return true;
    });
    expect(await pi.toolCall(call, ctx)).toBeUndefined();
    expect(errors).toEqual([expect.any(TypeError)]);
    expect(parsedMessage(ctx).input).toEqual({ command: `touch '${proof}'` });
    await pi.bash?.execute('m1', call.input, undefined, undefined, undefined);
    expect(fs.existsSync(proof)).toBe(true);
    expect(fs.existsSync(evil)).toBe(false);
  });

  it.each([
    [
      'a nested value',
      (input: Record<string, unknown>) => ((input.opts as { deep: string }).deep = 'evil'),
    ],
    ['an added key', (input: Record<string, unknown>) => (input.extra = 1)],
    ['a deleted key', (input: Record<string, unknown>) => delete input.text],
    [
      'a reordered object',
      (input: Record<string, unknown>) => {
        const text = input.text;
        delete input.text;
        input.text = text;
      },
    ],
    [
      'an accessor',
      (input: Record<string, unknown>) =>
        Object.defineProperty(input, 'text', flipping('a', 'evil', 4)),
    ],
  ])('makes %s during the dialog fail', async (_name, mutate) => {
    const pi = await startBridge();
    const input: Record<string, unknown> = { text: 'a', opts: { deep: 'x' } };
    const ctx = context(() => {
      expect(() => mutate(input)).toThrow(TypeError);
      return true;
    });
    const result = await pi.toolCall(
      { toolName: 'mcp__team_docs__search', toolCallId: 'n', input },
      ctx
    );
    expect(result).toBeUndefined();
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(input).toEqual({ text: 'a', opts: { deep: 'x' } });
  });

  it('freezes the approved input deeply, so later writes fail', async () => {
    const pi = await startBridge();
    const input = { command: 'echo safe', nested: { list: [{ v: 1 }] } };
    const held = input;
    expect(
      await pi.toolCall(
        { toolName: 'bash', toolCallId: 'f1', input },
        context(() => true)
      )
    ).toBeUndefined();
    expect(() => {
      held.command = 'echo evil';
    }).toThrow(TypeError);
    expect(() => {
      held.nested.list[0]!.v = 2;
    }).toThrow(TypeError);
    expect(() => {
      held.nested.list.push({ v: 3 });
    }).toThrow(TypeError);
    // A write scheduled before the answer and run after it does not land either.
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(Object.isFrozen(input)).toBe(true);
    expect(input).toEqual({ command: 'echo safe', nested: { list: [{ v: 1 }] } });
  });

  it('freezes with the built-ins it took at load, even if another extension replaces them', async () => {
    const pi = await startBridge();
    const freeze = Object.freeze;
    const isFrozen = Object.isFrozen;
    const input = { command: 'echo safe' };
    try {
      Object.freeze = <T>(value: T) => value;
      Object.isFrozen = () => true;
      expect(
        await pi.toolCall(
          { toolName: 'bash', toolCallId: 'f2', input },
          context(() => true)
        )
      ).toBeUndefined();
    } finally {
      Object.freeze = freeze;
      Object.isFrozen = isFrozen;
    }
    expect(Object.isFrozen(input)).toBe(true);
  });
});

/** Puts a foreign extension's `tool_call` handler after the bridge's, as Pi's load order does (D-4 A). */
function foreignAfter(pi: FakePiApi, handler: (event: PiBridgeToolCallEvent) => void) {
  pi.handlers.set('tool_call', [
    ...(pi.handlers.get('tool_call') ?? []),
    (event: unknown) => {
      handler(event as PiBridgeToolCallEvent);
      return undefined;
    },
  ]);
}

describe('a handler after the bridge (R2-A, D-4 A)', () => {
  it('replacing event.input changes nothing: the approved original runs', async () => {
    const pi = await startBridge();
    const proof = path.join(dir, 'safe.txt');
    const evil = path.join(dir, 'evil.txt');
    foreignAfter(pi, (event) => {
      event.input = { command: `touch '${evil}'` };
    });
    // Pi keeps its own reference to the arguments and executes that (`args` in Pi 1.4.0
    // `core/agent-session.js` `_beforeToolCall`); `event.input` is a copy of the reference.
    const args = { command: `touch '${proof}'` };
    const event = { toolName: 'bash', toolCallId: 'after-1', input: args as unknown };
    const ctx = context(() => true);
    expect(await pi.toolCall(event, ctx)).toBeUndefined();
    expect(event.input).not.toBe(args);
    expect(parsedMessage(ctx).input).toEqual({ command: `touch '${proof}'` });
    await pi.bash?.execute('after-1', args, undefined, undefined, undefined);
    expect(fs.existsSync(proof)).toBe(true);
    expect(fs.existsSync(evil)).toBe(false);
  });

  it('changing the original in place throws, so Pi blocks the call', async () => {
    const pi = await startBridge();
    const evil = path.join(dir, 'evil.txt');
    foreignAfter(pi, (event) => {
      (event.input as { command: string }).command = `touch '${evil}'`;
    });
    const args = { command: 'echo safe' };
    // Pi turns the handler's exception into a blocked call (`_beforeToolCall`, `prepareToolCall`).
    await expect(
      pi.toolCall(
        { toolName: 'bash', toolCallId: 'after-2', input: args },
        context(() => true)
      )
    ).rejects.toThrow(TypeError);
    expect(args).toEqual({ command: 'echo safe' });
    expect(fs.existsSync(evil)).toBe(false);
  });

  it('own bash refuses parameters other than the approved ones, before anything starts', async () => {
    const pi = await startBridge();
    const evil = path.join(dir, 'evil.txt');
    const ctx = context(() => true);
    expect(await pi.toolCall(bashCall('after-3', 'echo safe'), ctx)).toBeUndefined();
    await expect(
      pi.bash?.execute('after-3', { command: `touch '${evil}'` }, undefined, undefined, undefined)
    ).rejects.toThrow('switch: bash input differs from the approved one, command not run');
    expect(fs.existsSync(registry)).toBe(false);
    expect(fs.existsSync(evil)).toBe(false);
    // The approval is spent: the same id does not run later, not even with the approved input.
    await expect(
      pi.bash?.execute('after-3', { command: 'echo safe' }, undefined, undefined, undefined)
    ).rejects.toThrow('not approved');
  });

  it.each([
    ['an extra field', { command: 'echo safe', timeout: 1 }],
    ['a missing field', {}],
    ['a proxy of the approved input', new Proxy({ command: 'echo safe' }, {})],
    ['no object', undefined],
  ])('own bash refuses %s', async (_name, params) => {
    const pi = await startBridge();
    expect(
      await pi.toolCall(
        bashCall('after-4', 'echo safe'),
        context(() => true)
      )
    ).toBeUndefined();
    await expect(
      pi.bash?.execute('after-4', params, undefined, undefined, undefined)
    ).rejects.toThrow('differs from the approved one');
    expect(fs.existsSync(registry)).toBe(false);
  });
});

describe('reused bash toolCallId (R2-D)', () => {
  it('refuses a toolCallId it already ran, while its group is in the registry', async () => {
    const pi = await startBridge();
    const marker = path.join(dir, 'bg.txt');
    const command = `(while true; do echo x >> '${marker}'; sleep 0.05; done) & echo started`;
    const execute = await approvedBash(pi, 'dup-1', command);
    await execute('dup-1', { command }, undefined, undefined, undefined);
    const ctx = context(() => true);
    expect(await pi.toolCall(bashCall('dup-1', 'echo second'), ctx)).toEqual({
      block: true,
      reason: 'switch: tool call id reused',
    });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    await expect(
      execute('dup-1', { command: 'echo second' }, undefined, undefined, undefined)
    ).rejects.toThrow('not approved');
    const { groups } = readPiBashRegistry(registry);
    expect(groups.map((group) => group.toolCallId)).toEqual(['dup-1']);
    expect(groups[0]?.marker).toBe(
      registryEvents().find((entry) => entry.event === 'spawn')?.marker
    );
  });

  it('refuses a second call with the same id while the first is still waiting', async () => {
    const pi = await startBridge();
    let release: (value: boolean) => void = () => {};
    const first = pi.toolCall(
      bashCall('dup-2', 'echo one'),
      context(() => new Promise<boolean>((resolve) => (release = resolve)))
    );
    const ctx = context(() => true);
    expect(await pi.toolCall(bashCall('dup-2', 'echo two'), ctx)).toEqual({
      block: true,
      reason: 'switch: tool call id reused',
    });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    release(true);
    expect(await first).toBeUndefined();
    await expect(
      pi.bash?.execute('dup-2', { command: 'echo one' }, undefined, undefined, undefined)
    ).resolves.toEqual({ output: 'one\n', exitCode: 0 });
  });

  it('refuses a denied id when it comes again', async () => {
    const pi = await startBridge();
    expect(
      await pi.toolCall(
        bashCall('dup-3', 'echo one'),
        context(() => false)
      )
    ).toEqual({ block: true, reason: 'switch: not approved' });
    expect(
      await pi.toolCall(
        bashCall('dup-3', 'echo one'),
        context(() => true)
      )
    ).toEqual({ block: true, reason: 'switch: tool call id reused' });
  });
});

const NOT_OWN_BASH = "switch: the active bash tool is not the bridge's own";
const SERIALIZATION_CHANGED =
  'switch: JSON serialization was changed in this process (toJSON or JSON.stringify)';
const mcpCall = (toolCallId: string) => ({
  toolName: 'mcp__team_docs__search',
  toolCallId,
  input: { q: 'docs', tags: ['a'] },
});

describe('defensive check: the active bash is the bridge’s own (D-7 A.1, R3-B)', () => {
  it('lets bash through when the bash Pi runs is the bridge’s (control)', async () => {
    const pi = await startBridge();
    // An extension after the bridge does not take `bash` over: Pi keeps the first registration.
    pi.addForeign('after', { tools: ['bash', 'other_tool'], commands: ['other'] });
    const execute = await approvedBash(pi, 'own-1', 'echo own');
    await expect(
      execute('own-1', { command: 'echo own' }, undefined, undefined, undefined)
    ).resolves.toEqual({ output: 'own\n', exitCode: 0 });
  });

  it('blocks bash without asking when another extension’s bash is the active one', async () => {
    const pi = await startBridge();
    pi.addForeign('before', { tools: ['bash'] });
    const ctx = context(() => true);
    expect(await pi.toolCall(bashCall('own-2', 'echo x'), ctx)).toEqual({
      block: true,
      reason: NOT_OWN_BASH,
    });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    await expect(
      pi.bash?.execute('own-2', { command: 'echo x' }, undefined, undefined, undefined)
    ).rejects.toThrow('not approved');
    expect(registryEvents()).toEqual([]);
    // Other tools are still asked about: only `bash` has an owner to check.
    const mcpCtx = context(() => true);
    expect(await pi.toolCall(mcpCall('own-2m'), mcpCtx)).toBeUndefined();
    expect(mcpCtx.ui.confirm).toHaveBeenCalledTimes(1);
  });

  it('blocks bash after the approval when another bash became active during the dialog', async () => {
    const pi = await startBridge();
    const ctx = context(() => {
      pi.addForeign('before', { tools: ['bash'] });
      return true;
    });
    expect(await pi.toolCall(bashCall('own-3', 'echo x'), ctx)).toEqual({
      block: true,
      reason: NOT_OWN_BASH,
    });
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    await expect(
      pi.bash?.execute('own-3', { command: 'echo x' }, undefined, undefined, undefined)
    ).rejects.toThrow('not approved');
  });

  it('blocks bash when another extension registers the handshake command too', async () => {
    const pi = await startBridge();
    pi.addForeign('after', { commands: [piBridgeHandshakeCommand(NONCE)] });
    const ctx = context(() => true);
    expect(await pi.toolCall(bashCall('own-4', 'echo x'), ctx)).toEqual({
      block: true,
      reason: NOT_OWN_BASH,
    });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ['getAllTools throws', 'getAllTools'],
    ['getCommands throws', 'getCommands'],
    ['getCommands is missing', 'no-getCommands'],
  ])('blocks bash when Pi cannot say who owns it: %s', async (_name, mode) => {
    const pi = await startBridge();
    const api = pi.api as unknown as Record<string, unknown>;
    if (mode === 'no-getCommands') delete api.getCommands;
    else {
      api[mode] = () => {
        throw new Error('Extension runtime not initialized');
      };
    }
    const ctx = context(() => true);
    expect(await pi.toolCall(bashCall('own-5', 'echo x'), ctx)).toEqual({
      block: true,
      reason: NOT_OWN_BASH,
    });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it('blocks bash when its owner has no path', async () => {
    const pi = await startBridge();
    const api = pi.api as unknown as { getCommands: () => unknown[] };
    api.getCommands = () => [{ name: piBridgeHandshakeCommand(NONCE), source: 'extension' }];
    const ctx = context(() => true);
    expect((await pi.toolCall(bashCall('own-6', 'echo x'), ctx))?.reason).toBe(NOT_OWN_BASH);
  });
});

/**
 * Runs `body` with `property` defined on `target`, and removes or restores it in `finally`, so a
 * failed expectation cannot leave the process's prototypes or JSON changed.
 */
async function withProperty<T>(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor,
  body: () => Promise<T>
): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, { configurable: true, ...descriptor });
  try {
    return await body();
  } finally {
    if (before) Object.defineProperty(target, property, before);
    else delete (target as Record<PropertyKey, unknown>)[property];
  }
}

describe('defensive check: JSON serialization is unchanged (D-7 A.2, R3-C)', () => {
  it('asks about MCP and bash calls while nothing is changed (control)', async () => {
    const pi = await startBridge();
    const ctx = context(() => true);
    expect(await pi.toolCall(mcpCall('ser-0'), ctx)).toBeUndefined();
    expect(await pi.toolCall(bashCall('ser-0b', 'echo x'), ctx)).toBeUndefined();
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Object.prototype', 'value', Object.prototype],
    ['Object.prototype', 'getter', Object.prototype],
    ['Array.prototype', 'value', Array.prototype],
    ['Array.prototype', 'getter', Array.prototype],
  ])('blocks every call without asking while %s has a toJSON (%s)', async (_n, kind, proto) => {
    const pi = await startBridge();
    let reads = 0;
    // Returns its receiver: serialization in this process stays as it was while the test runs.
    const toJSON = function (this: unknown) {
      return this;
    };
    const descriptor: PropertyDescriptor =
      kind === 'value'
        ? { value: toJSON, writable: true }
        : {
            get: () => {
              reads += 1;
              return undefined;
            },
          };
    const ctx = context(() => true);
    const results = await withProperty(proto, 'toJSON', descriptor, async () => [
      await pi.toolCall(mcpCall('ser-1'), ctx),
      await pi.toolCall(bashCall('ser-1b', 'echo x'), ctx),
      await pi.toolCall({ toolName: 'read', toolCallId: 'ser-1r', input: { path: 'x' } }, ctx),
    ]);
    expect(results).toEqual(Array(3).fill({ block: true, reason: SERIALIZATION_CHANGED }));
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    // The check reads descriptors: it never runs the getter.
    expect(reads).toBe(0);
    expect(Object.getOwnPropertyDescriptor(proto, 'toJSON')).toBeUndefined();
  });

  it('blocks after the approval when a toJSON appears during the dialog', async () => {
    const pi = await startBridge();
    let restore = () => {};
    const ctx = context(() => {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        writable: true,
        value: function (this: unknown) {
          return this;
        },
      });
      restore = () => delete (Object.prototype as { toJSON?: unknown }).toJSON;
      return true;
    });
    try {
      expect(await pi.toolCall(mcpCall('ser-2'), ctx)).toEqual({
        block: true,
        reason: SERIALIZATION_CHANGED,
      });
    } finally {
      restore();
    }
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')).toBeUndefined();
  });

  it('blocks when JSON.stringify is replaced', async () => {
    const pi = await startBridge();
    const original = JSON.stringify;
    const ctx = context(() => true);
    const result = await withProperty(
      JSON,
      'stringify',
      { writable: true, value: (...args: Parameters<typeof JSON.stringify>) => original(...args) },
      () => pi.toolCall(mcpCall('ser-3'), ctx)
    );
    expect(result).toEqual({ block: true, reason: SERIALIZATION_CHANGED });
    expect(JSON.stringify).toBe(original);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it('blocks when globalThis.JSON is replaced', async () => {
    const pi = await startBridge();
    const original = JSON;
    const ctx = context(() => true);
    const result = await withProperty(
      globalThis,
      'JSON',
      { writable: true, value: Object.create(original) as JSON },
      () => pi.toolCall(mcpCall('ser-4'), ctx)
    );
    expect(result).toEqual({ block: true, reason: SERIALIZATION_CHANGED });
    expect(globalThis.JSON).toBe(original);
  });

  it('blocks when Array.prototype inherits from something else than Object.prototype', async () => {
    const pi = await startBridge();
    const between = Object.create(Object.prototype) as object;
    const ctx = context(() => true);
    Object.setPrototypeOf(Array.prototype, between);
    let result: unknown;
    try {
      result = await pi.toolCall(mcpCall('ser-5'), ctx);
    } finally {
      Object.setPrototypeOf(Array.prototype, Object.prototype);
    }
    expect(result).toEqual({ block: true, reason: SERIALIZATION_CHANGED });
    expect(Object.getPrototypeOf(Array.prototype)).toBe(Object.prototype);
  });
});

/**
 * Puts a foreign extension's `tool_call` handler before the bridge's, as Pi's load order would if
 * the adapter did not load the bridge first (defence in depth, C2-01).
 */
function foreignFirst(pi: FakePiApi, handler: (event: PiBridgeToolCallEvent) => void) {
  pi.handlers.set('tool_call', [
    (event: unknown) => {
      handler(event as PiBridgeToolCallEvent);
      return undefined;
    },
    ...(pi.handlers.get('tool_call') ?? []),
  ]);
}

/** A getter that shows `safe` for the first `reads` reads and `evil` after (st2r_claude S2-01). */
function flipping(safe: string, evil: string, reads: number) {
  let count = 0;
  return {
    configurable: true,
    enumerable: true,
    get: () => (++count <= reads ? safe : evil),
  };
}

describe('input that is not plain data (SC3, C2-01)', () => {
  it('runs a plain input it approved (control)', async () => {
    const pi = await startBridge();
    const proof = path.join(dir, 'safe.txt');
    const ctx = context(() => true);
    expect(await pi.toolCall(bashCall('p0', `touch '${proof}'`), ctx)).toBeUndefined();
    await pi.bash?.execute('p0', { command: `touch '${proof}'` }, undefined, undefined, undefined);
    expect(fs.existsSync(proof)).toBe(true);
  });

  it.each([1, 4, 100])(
    'blocks, without asking, an own accessor set before the bridge (flip after %i reads)',
    async (reads) => {
      const pi = await startBridge();
      const evil = path.join(dir, 'evil.txt');
      foreignFirst(pi, (event) => {
        Object.defineProperty(
          event.input,
          'command',
          flipping('echo safe', `touch '${evil}'`, reads)
        );
      });
      const call = bashCall('a1', 'echo safe');
      const ctx = context(() => true);
      expect(await pi.toolCall(call, ctx)).toEqual({
        block: true,
        reason: 'switch: tool input cannot be checked',
      });
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      await expect(
        pi.bash?.execute('a1', call.input, undefined, undefined, undefined)
      ).rejects.toThrow('not approved');
      expect(fs.existsSync(evil)).toBe(false);
    }
  );

  it('blocks an accessor in a nested object', async () => {
    const pi = await startBridge();
    const input = { text: 'a', opts: { deep: 'x' } as Record<string, unknown> };
    Object.defineProperty(input.opts, 'deep', flipping('x', 'evil', 4));
    const ctx = context(() => true);
    expect(
      await pi.toolCall({ toolName: 'mcp__team_docs__search', toolCallId: 'n1', input }, ctx)
    ).toEqual({ block: true, reason: 'switch: tool input cannot be checked' });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it('blocks an accessor on the prototype (the field is not the input’s own)', async () => {
    const pi = await startBridge();
    foreignFirst(pi, (event) => {
      const input = event.input as Record<string, unknown>;
      delete input.command;
      Object.setPrototypeOf(input, {
        get command() {
          return 'echo evil';
        },
      });
    });
    const ctx = context(() => true);
    expect(await pi.toolCall(bashCall('a3', 'echo safe'), ctx)).toEqual({
      block: true,
      reason: 'switch: tool input cannot be checked',
    });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it('blocks a required field that is missing, and a declared field that is inherited', async () => {
    const pi = await startBridge();
    const bare = Object.create(null) as Record<string, unknown>;
    bare.timeout = 1;
    expect(
      await pi.toolCall(
        { toolName: 'bash', toolCallId: 'r1', input: bare },
        context(() => true)
      )
    ).toEqual({ block: true, reason: 'switch: tool input lacks a required field' });
    // Another extension pollutes Object.prototype with a field `bash` declares.
    Object.defineProperty(Object.prototype, 'timeout', { configurable: true, get: () => 0.001 });
    try {
      expect(
        await pi.toolCall(
          bashCall('r2', 'echo safe'),
          context(() => true)
        )
      ).toEqual({
        block: true,
        reason: 'switch: tool input inherits a field',
      });
    } finally {
      delete (Object.prototype as Record<string, unknown>).timeout;
    }
  });

  it.each([
    [
      'a hidden field',
      (input: Record<string, unknown>) =>
        Object.defineProperty(input, 'timeout', { value: 1, enumerable: false }),
    ],
    [
      'a symbol key',
      (input: Record<string, unknown>) => Object.defineProperty(input, Symbol('x'), { value: 1 }),
    ],
    ['a function', (input: Record<string, unknown>) => (input.extra = () => 'x')],
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the case under test
    ['a holey array', (input: Record<string, unknown>) => (input.list = [1, , 3])],
    ['NaN', (input: Record<string, unknown>) => (input.n = Number.NaN)],
    ['a Date', (input: Record<string, unknown>) => (input.d = new Date(0))],
  ])('blocks an input with %s, without asking', async (_name, change) => {
    const pi = await startBridge();
    const call = bashCall('h1', 'echo safe');
    change(call.input);
    const ctx = context(() => true);
    expect(await pi.toolCall(call, ctx)).toEqual({
      block: true,
      reason: 'switch: tool input cannot be checked',
    });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  /** A proxy that counts every trap Pi or the bridge could run, and lies through `get`. */
  function countingProxy<T extends object>(target: T, lie: (key: string | symbol) => unknown) {
    const traps = { count: 0 };
    const handler: ProxyHandler<T> = {};
    for (const trap of [
      'getOwnPropertyDescriptor',
      'ownKeys',
      'getPrototypeOf',
      'has',
      'isExtensible',
      'preventExtensions',
      'defineProperty',
    ] as const) {
      (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
        traps.count += 1;
        return (Reflect[trap] as (...a: unknown[]) => unknown)(...args);
      };
    }
    handler.get = (inner, key, receiver) => {
      traps.count += 1;
      const lied = lie(key);
      return lied === undefined ? Reflect.get(inner, key, receiver) : lied;
    };
    return { proxy: new Proxy(target, handler), traps };
  }

  it('blocks a Proxy without asking and without running any of its traps (R2-B)', async () => {
    const pi = await startBridge();
    const evil = path.join(dir, 'evil.txt');
    const { proxy, traps } = countingProxy({ command: 'echo safe' }, (key) =>
      key === 'command' ? `touch '${evil}'` : undefined
    );
    const ctx = context(() => true);
    expect(await pi.toolCall({ toolName: 'bash', toolCallId: 'x1', input: proxy }, ctx)).toEqual({
      block: true,
      reason: 'switch: tool input cannot be checked',
    });
    expect(traps.count).toBe(0);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    await expect(pi.bash?.execute('x1', proxy, undefined, undefined, undefined)).rejects.toThrow(
      'not approved'
    );
    expect(fs.existsSync(evil)).toBe(false);
    expect(fs.existsSync(registry)).toBe(false);
  });

  it.each([
    ['an object', (proxy: object) => ({ text: 'a', opts: proxy })],
    ['an array', (proxy: object) => ({ text: 'a', list: [1, [proxy]] })],
  ])('blocks a nested Proxy in %s whose get trap makes up a toJSON (R2-B)', async (_name, wrap) => {
    const pi = await startBridge();
    // `toJSON` is not on the target: only the trap invents it, so a snapshot read through the
    // descriptors and the JSON an MCP client sends would differ.
    const { proxy, traps } = countingProxy({ deep: 'x' }, (key) =>
      key === 'toJSON' ? () => ({ deep: 'evil' }) : undefined
    );
    expect(JSON.stringify(proxy)).toBe('{"deep":"evil"}');
    traps.count = 0;
    const input = wrap(proxy);
    const ctx = context(() => true);
    expect(
      await pi.toolCall({ toolName: 'mcp__team_docs__search', toolCallId: 'x2', input }, ctx)
    ).toEqual({ block: true, reason: 'switch: tool input cannot be checked' });
    expect(traps.count).toBe(0);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it('blocks a Proxy with no traps at all (R2-B)', async () => {
    const pi = await startBridge();
    const ctx = context(() => true);
    expect(
      await pi.toolCall(
        { toolName: 'bash', toolCallId: 'x3', input: new Proxy({ command: 'echo safe' }, {}) },
        ctx
      )
    ).toEqual({ block: true, reason: 'switch: tool input cannot be checked' });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
});

describe('runs (SC4)', () => {
  it('announces each run and tags the run’s tool calls with its number', async () => {
    const pi = await startBridge();
    const ui = context(() => true);
    await pi.emit('before_agent_start', {}, ui);
    await pi.emit('before_agent_start', {}, ui);
    expect(ui.ui.notify.mock.calls).toEqual([
      [piBridgeRunTag(NONCE, 1), 'info'],
      [piBridgeRunTag(NONCE, 2), 'info'],
    ]);
    const ctx = context(() => true);
    await pi.toolCall(bashCall('t', 'true'), ctx);
    expect(ctx.ui.confirm.mock.calls[0]?.[0]).toBe('switch:' + NONCE + ':run:2');
    expect(parsedMessage(ctx).run).toBe(2);
  });

  it('keeps the run a call started in, even if the next run starts during its dialog', async () => {
    const pi = await startBridge();
    const ui = context(() => true);
    await pi.emit('before_agent_start', {}, ui);
    const ctx = context(async () => {
      await pi.emit('before_agent_start', {}, ui);
      return true;
    });
    await pi.toolCall(bashCall('t', 'true'), ctx);
    expect(ctx.ui.confirm.mock.calls[0]?.[0]).toBe(piBridgeRunTag(NONCE, 1));
  });

  it('registers the handshake after everything else', async () => {
    const order: string[] = [];
    const pi = new FakePiApi();
    const api = pi.api as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ['on', 'registerCommand', 'registerTool', 'registerMcpServer']) {
      const original = api[name] as (...args: unknown[]) => unknown;
      api[name] = (...args: unknown[]) => {
        order.push(name === 'on' ? `on:${String(args[0])}` : name);
        return original(...args);
      };
    }
    process.env[PI_BRIDGE_CONFIG_ENV] = writeConfig(
      baseConfig({ mcpServers: { a: { transport: 'http', url: 'http://127.0.0.1:1/mcp' } } })
    );
    await piBridge(pi.api, { importPi: async () => stubSdk });
    expect(order).toEqual([
      'on:tool_call',
      'on:session_start',
      'registerTool',
      'registerMcpServer',
      'on:before_agent_start',
      'registerCommand',
    ]);
  });
});

/** Pi 1.4.0 `parseConfigValueTemplate` for values without variables (literal parts only). */
function piLiteral(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const next = value[index + 1];
    if (char === '$' && (next === '$' || next === '!')) {
      out += next;
      index++;
    } else {
      out += char;
    }
  }
  return out;
}

describe('MCP servers (SC4)', () => {
  const VALUES = [
    'pa$$word',
    '!echo pwned',
    '$HOME-literal',
    'x$!y',
    '$!z',
    '!',
    '${NAME}',
    SECRET,
  ];

  it('registers stdio and HTTP servers directly exposed, with escaped env and headers', async () => {
    const env = Object.fromEntries(VALUES.map((value, index) => [`E${index}`, value]));
    const headers = Object.fromEntries(VALUES.map((value, index) => [`x-h${index}`, value]));
    const pi = await startBridge(
      baseConfig({
        mcpServers: {
          echo: {
            transport: 'stdio',
            command: 'node',
            args: ['server.mjs', '$HOME'],
            env,
            envVars: ['ANTHROPIC_API_KEY'],
          },
          switch: {
            transport: 'http',
            url: 'http://127.0.0.1:9/mcp',
            headers,
            auth: { provider: 'anthropic' },
            oauth: { clientId: 'x' },
          },
          plain: { transport: 'stdio', command: 'srv', args: [] },
        },
      })
    );
    expect(pi.mcp.map(([name]) => name)).toEqual(['echo', 'switch', 'plain']);
    const [, stdio] = pi.mcp[0] as [string, Extract<PiMcpServerConfig, { type: 'stdio' }>];
    const [, http] = pi.mcp[1] as [string, Extract<PiMcpServerConfig, { type: 'http' }>];
    expect(stdio).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.mjs', '$HOME'],
      env: {
        E0: 'pa$$$$word',
        E1: '$!echo pwned',
        E2: '$$HOME-literal',
        E3: 'x$$!y',
        E4: '$$!z',
        E5: '$!',
        E6: '$${NAME}',
        E7: SECRET,
      },
      exposure: 'direct',
    });
    expect(http).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:9/mcp',
      headers: Object.fromEntries(
        Object.entries(stdio.env ?? {}).map(([k, v]) => [`x-h${k.slice(1)}`, v])
      ),
      exposure: 'direct',
    });
    expect(pi.mcp[2]).toEqual([
      'plain',
      { type: 'stdio', command: 'srv', args: [], exposure: 'direct' },
    ]);
    for (const value of [...Object.values(stdio.env ?? {}), ...Object.values(http.headers ?? {})]) {
      expect(value.startsWith('!')).toBe(false);
    }
    expect(Object.values(stdio.env ?? {}).map(piLiteral)).toEqual(VALUES);
    expect(Object.values(http.headers ?? {}).map(piLiteral)).toEqual(VALUES);
  });

  it('keeps secret values out of everything the bridge reports', async () => {
    const errors = vi.spyOn(console, 'error');
    const logs = vi.spyOn(console, 'log');
    const warns = vi.spyOn(console, 'warn');
    const stderr = vi.spyOn(process.stderr, 'write');
    const pi = await startBridge(
      baseConfig({
        mcpServers: {
          s: {
            transport: 'http',
            url: 'http://127.0.0.1:9/mcp',
            headers: { authorization: SECRET },
          },
        },
      })
    );
    const ui = context(() => false);
    await pi.emit('session_start', {}, ui);
    await pi.emit('before_agent_start', {}, ui);
    expect(await pi.toolCall(bashCall('d', 'true'), ui)).toEqual({
      block: true,
      reason: 'switch: not approved',
    });
    expect(
      await pi.toolCall(
        bashCall('ok', 'echo out'),
        context(() => true)
      )
    ).toBeUndefined();
    await pi.bash?.execute('ok', { command: 'echo out' }, undefined, undefined, undefined);
    const reported = JSON.stringify([
      ui.ui.notify.mock.calls,
      ui.ui.confirm.mock.calls,
      errors.mock.calls,
      logs.mock.calls,
      warns.mock.calls,
      stderr.mock.calls,
      fs.readFileSync(registry, 'utf8'),
    ]);
    expect(reported).not.toContain(SECRET);
    errors.mockRestore();
    logs.mockRestore();
    warns.mockRestore();
    stderr.mockRestore();
  });
});

async function approvedBash(pi: FakePiApi, toolCallId: string, command: string, extra = {}) {
  expect(
    await pi.toolCall(
      bashCall(toolCallId, command, extra),
      context(() => true)
    )
  ).toBeUndefined();
  return (pi.bash as PiBridgeToolDefinition).execute.bind(pi.bash);
}

const waitUntil = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('own bash and the process registry (ER-06)', () => {
  it('records every shell when it is created, with its marker and run', async () => {
    const pi = await startBridge();
    await pi.emit(
      'before_agent_start',
      {},
      context(() => true)
    );
    const command = `echo "$${PI_BASH_MARKER_ENV}|$${PI_BRIDGE_CONFIG_ENV}|$STUB_ENV"`;
    const execute = await approvedBash(pi, 'reg-1', command);
    const result = (await execute('reg-1', { command }, undefined, undefined, undefined)) as {
      output: string;
    };
    const lines = fs
      .readFileSync(registry, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.event)).toEqual(['intent', 'spawn', 'exit']);
    const spawn = lines[1] as Record<string, unknown>;
    expect(spawn).toMatchObject({ v: 1, toolCallId: 'reg-1', run: 1, pgid: spawn.pid });
    expect(typeof spawn.starttime).toBe('string');
    expect(spawn.marker).toBe(`${String(spawn.instance)}:reg-1`);
    expect(lines[2]).toMatchObject({ code: 0, pid: spawn.pid });
    // The marker reaches the shell, the config variable does not.
    expect(result.output).toBe(`${String(spawn.marker)}||${SECRET}\n`);
    expect(fs.statSync(registry).mode & 0o777).toBe(0o600);
    const { groups } = readPiBashRegistry(registry);
    expect(groups).toEqual([
      expect.objectContaining({ toolCallId: 'reg-1', run: 1, shellExited: true }),
    ]);
  });

  it('leaves a background job in a registered group that pi-bash can verify and stop', async () => {
    const pi = await startBridge();
    const marker = path.join(dir, 'bg.txt');
    const command = `(while true; do echo x >> '${marker}'; sleep 0.05; done) & echo started`;
    const execute = await approvedBash(pi, 'bg-1', command);
    const result = (await execute('bg-1', { command }, undefined, undefined, undefined)) as {
      output: string;
      exitCode: number;
    };
    expect(result).toEqual({ output: 'started\n', exitCode: 0 });
    const [group] = readPiBashRegistry(registry).groups;
    if (!group) throw new Error('no group');
    expect(group.shellExited).toBe(true);
    await waitUntil(() => fs.existsSync(marker));
    expect(piProcessGroupMembers(group.pgid).length).toBeGreaterThan(0);
    const signalled = signalPiBashGroup(group, 'SIGKILL');
    expect(signalled).toMatchObject({
      sent: true,
      verification: { ok: true, reason: 'members_verified' },
    });
    await waitUntil(() => piProcessGroupMembers(group.pgid).length === 0);
    const size = fs.statSync(marker).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.statSync(marker).size).toBe(size);
  });

  it('signals the group on abort and records it; the group is gone only after the shell exited', async () => {
    const pi = await startBridge();
    const execute = await approvedBash(pi, 'ab-1', 'sleep 30');
    const controller = new AbortController();
    const running = execute(
      'ab-1',
      { command: 'sleep 30' },
      controller.signal,
      undefined,
      undefined
    );
    await waitUntil(() => readPiBashRegistry(registry).groups.length === 1);
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
    const [group] = readPiBashRegistry(registry).groups;
    expect(group).toMatchObject({ killedByBridge: true, shellExited: true });
    expect(piProcessGroupMembers(group?.pgid ?? -1)).toEqual([]);
  });

  it('signals the group on timeout; the group is gone only after the shell exited', async () => {
    const pi = await startBridge();
    const execute = await approvedBash(pi, 'to-1', 'sleep 30', { timeout: 0.2 });
    await expect(
      execute('to-1', { command: 'sleep 30', timeout: 0.2 }, undefined, undefined, undefined)
    ).rejects.toThrow('timeout:0.2');
    // `killedByBridge` records the sent signal; the end is the shell's `exit` and an empty group.
    const [group] = readPiBashRegistry(registry).groups;
    expect(group).toMatchObject({ killedByBridge: true, shellExited: true });
    expect(piProcessGroupMembers(group?.pgid ?? -1)).toEqual([]);
  });

  // D-15: where procfs gives no start time (macOS; here a hidden procfs), the bridge records the
  // shell's `lstart`, and `pi-bash.ts` verifies and stops the group through `ps`.
  const hiddenProc = () => ({ procRoot: path.join(dir, 'no-proc'), ps: 'ps' });

  // R11-D: the starts come from `ps` after the spawn, in their own record.
  const lstartRecord = () => registryEvents().find((line) => line.event === 'lstart');

  // `sleep 30; true`: bash runs `sleep` as a child and stays the leader (with `sleep 30` alone
  // it would `exec` it, see the next test).
  it('records lstart without procfs; pi-bash verifies and stops the group through ps', async () => {
    const command = 'sleep 30; true';
    const pi = await startBridge(baseConfig(), { host: hiddenProc() });
    const execute = await approvedBash(pi, 'ps-1', command);
    const running = execute('ps-1', { command }, undefined, undefined, undefined);
    await waitUntil(() => lstartRecord() !== undefined);
    const spawn = registryEvents().find((line) => line.event === 'spawn');
    // D-18: the shell's label is a word of its command line after the command (`$1`; `$0` is the
    // shell's path, as before), in the intent and the spawn.
    const label = String(spawn?.label);
    expect(label).toMatch(/^[0-9a-f]{32}$/);
    expect(registryEvents().find((line) => line.event === 'intent')).toMatchObject({ label });
    expect(spawn).toMatchObject({
      starttime: null,
      ppid: process.pid,
      args: piBashArgsFingerprint(['/bin/bash', '-c', command, '/bin/bash', label]),
    });
    expect(spawn).not.toHaveProperty('lstart');
    expect(lstartRecord()).toMatchObject({
      lstart: expect.stringMatching(/\d{4}$/),
      plstart: expect.stringMatching(/\d{4}$/),
      cmd: piBashPsArgsDigest(readPiPsCommand(Number(spawn?.pid)).args),
    });
    const [group] = readPiBashRegistry(registry).groups;
    if (!group) throw new Error('no group');
    expect(signalPiBashGroup(group, 'SIGKILL', hiddenProc())).toMatchObject({
      sent: true,
      verification: { ok: true, reason: 'leader_verified', members: 2 },
    });
    await expect(running).resolves.toEqual({ output: '', exitCode: 137 });
    await waitUntil(() => piProcessGroupMembers(group.pgid).length === 0);
    expect(verifyPiBashGroup(group, hiddenProc())).toMatchObject({ reason: 'group_empty' });
  });

  // R11-A: the cost of parity. `bash -c 'sleep 30'` runs `exec sleep 30`; procfs still finds the
  // marker, `ps` sees another command line and cannot tell this `exec` from one that dropped the
  // marker, so it refuses. The bridge's own abort still stops the group.
  it('refuses through ps a shell that ran exec; the bridge itself still stops it', async () => {
    const pi = await startBridge(baseConfig(), { host: hiddenProc() });
    const execute = await approvedBash(pi, 'ps-5', 'sleep 30');
    const controller = new AbortController();
    const running = execute(
      'ps-5',
      { command: 'sleep 30' },
      controller.signal,
      undefined,
      undefined
    );
    await waitUntil(() => lstartRecord() !== undefined);
    const [group] = readPiBashRegistry(registry).groups;
    if (!group) throw new Error('no group');
    await waitUntil(() => {
      const verification = verifyPiBashGroup(group, hiddenProc());
      return !verification.ok && verification.reason === 'leader_command_mismatch';
    });
    // The same shell as procfs sees it (this host has procfs): verified, the marker is there.
    const starttime = readPiProcStat(group.pid)?.starttime ?? null;
    expect(verifyPiBashGroup({ ...group, starttime })).toMatchObject({
      ok: true,
      reason: 'leader_verified',
    });
    const kill = vi.fn();
    expect(signalPiBashGroup(group, 'SIGKILL', { ...hiddenProc(), kill })).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_command_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
    expect(readPiBashRegistry(registry).groups[0]).toMatchObject({ killedByBridge: true });
  });

  it('records no lstart when ps fails; the group is then not verified', async () => {
    const pi = await startBridge(baseConfig(), {
      host: { procRoot: path.join(dir, 'no-proc'), ps: path.join(dir, 'no-ps') },
    });
    const execute = await approvedBash(pi, 'ps-2', 'sleep 30');
    const controller = new AbortController();
    const running = execute(
      'ps-2',
      { command: 'sleep 30' },
      controller.signal,
      undefined,
      undefined
    );
    await waitUntil(() => readPiBashRegistry(registry).groups.length === 1);
    expect(registryEvents().find((line) => line.event === 'spawn')).toMatchObject({
      starttime: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(lstartRecord()).toBeUndefined();
    const [group] = readPiBashRegistry(registry).groups;
    if (!group) throw new Error('no group');
    expect(group).not.toHaveProperty('lstart');
    const kill = vi.fn();
    expect(signalPiBashGroup(group, 'SIGKILL', { ...hiddenProc(), kill })).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'starttime_unknown' },
    });
    expect(kill).not.toHaveBeenCalled();
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
  });

  /**
   * A fake `ps` for the bridge's read of the starts (`-p <shell>,<own>`): `rows` is shell code
   * that prints what it wants, with `$shell` and `$own` set; it touches `done` when it has printed.
   * D-18: the bridge's second read, of the shell's command line (`-o pid=,ppid=,lstart=,args=`,
   * `$3`), gets `args` (shell code; by default the shell's real command line after the fake start
   * `D` the rows print, so a read that is the shell's carries its label).
   */
  function startsPs(
    rows: string,
    before = '',
    args = `echo "$shell $own ${D} $(ps -ww -o args= -p "$shell")"`
  ) {
    const ps = path.join(dir, `starts-ps-${Math.random().toString(36).slice(2)}`);
    const done = `${ps}.done`;
    fs.writeFileSync(
      ps,
      `#!/bin/sh\n${before}\nshell=\${5%%,*}\nown=$PPID\ncase "$3" in *args*) ${args}; exit 0;; esac\nown=\${5#*,}\n${rows}\ntouch '${done}'\n`,
      { mode: 0o700 }
    );
    return { ps, done };
  }
  const D = 'Wed Nov  4 09:10:58 2026';
  const P = 'Wed Nov  4 09:00:00 2026';

  it.each([
    [
      'two padded rows, collapsed',
      `echo "  $shell  $own  $shell  ${D}  "; echo "  $own 1 $own ${P}"`,
      { lstart: 'Wed Nov 4 09:10:58 2026', plstart: 'Wed Nov 4 09:00:00 2026' },
    ],
    ['only the shell, not trusted', `echo "$shell $own $shell ${D}"`, null],
    [
      'a third row, not trusted',
      `echo "$shell $own $shell ${D}"; echo "$own 1 $own ${P}"; echo "7 1 7 ${P}"`,
      null,
    ],
    [
      'a shell that is not this process child, not trusted',
      `echo "$shell 1 $shell ${D}"; echo "$own 1 $own ${P}"`,
      null,
    ],
    [
      'a shell outside its group, not trusted',
      `echo "$shell $own 7 ${D}"; echo "$own 1 $own ${P}"`,
      null,
    ],
    // A09 (R11-B): a non-date is no start.
    [
      'unavailable, not trusted',
      `echo "$shell $own $shell unavailable"; echo "$own 1 $own ${P}"`,
      null,
    ],
    [
      'a cut-off date, not trusted',
      `echo "$shell $own $shell Wed Nov  4"; echo "$own 1 $own ${P}"`,
      null,
    ],
    ['nothing, not trusted', ':', null],
    [
      'a failed ps, not trusted',
      `echo "$shell $own $shell ${D}"; echo "$own 1 $own ${P}"; touch "$0.done"; exit 1`,
      null,
    ],
  ])('records the starts from what ps prints: %s', async (_name, rows, expected) => {
    const { ps, done } = startsPs(rows);
    const pi = await startBridge(baseConfig(), {
      host: { procRoot: path.join(dir, 'no-proc'), ps },
    });
    const execute = await approvedBash(pi, 'ps-4', 'sleep 30; true');
    const controller = new AbortController();
    const running = execute(
      'ps-4',
      { command: 'sleep 30; true' },
      controller.signal,
      undefined,
      undefined
    );
    await waitUntil(() => fs.existsSync(done));
    if (expected) await waitUntil(() => lstartRecord() !== undefined);
    else await new Promise((resolve) => setTimeout(resolve, 100));
    if (expected) expect(lstartRecord()).toMatchObject(expected);
    else expect(lstartRecord()).toBeUndefined();
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
  });

  // R11-A: a start read after the shell was reaped could be another process's.
  it('records no starts once the shell is reaped', async () => {
    // This `ps` prints whole rows only once the shell is gone (reaped: `kill -0` fails). The
    // background `sleep` keeps the pipes open, so the call lasts until they fall idle after
    // `exit` (100 ms), while `ps` prints.
    const { ps, done } = startsPs(
      `echo "$shell $own $shell ${D}"; echo "$own 1 $own ${P}"`,
      'shell=${5%%,*}; while kill -0 "$shell" 2>/dev/null; do sleep 0.01; done'
    );
    const pi = await startBridge(baseConfig(), {
      host: { procRoot: path.join(dir, 'no-proc'), ps },
    });
    const command = 'sleep 1 & exit 0';
    const execute = await approvedBash(pi, 'ps-6', command);
    await execute('ps-6', { command }, undefined, undefined, undefined);
    expect(fs.existsSync(done)).toBe(true);
    expect(lstartRecord()).toBeUndefined();
  });

  // R11-D: `ps` ends with the call; it does not outlive it.
  it('ends its ps when the call ends', async () => {
    const pidFile = path.join(dir, 'ps.pid');
    const ps = path.join(dir, 'slow-ps');
    fs.writeFileSync(ps, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o700 });
    const pi = await startBridge(baseConfig(), {
      host: { procRoot: path.join(dir, 'no-proc'), ps },
    });
    const execute = await approvedBash(pi, 'ps-7', 'sleep 0.2');
    await execute('ps-7', { command: 'sleep 0.2' }, undefined, undefined, undefined);
    await waitUntil(() => fs.existsSync(pidFile));
    const psPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitUntil(() => {
      try {
        process.kill(psPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  // R11-D (A08): a slow `ps` does not hold the call's deadline.
  it('keeps the deadline while ps is slow', async () => {
    const ps = path.join(dir, 'slow-ps');
    fs.writeFileSync(ps, `#!/bin/sh\nsleep 0.6\nexec ps "$@"\n`, { mode: 0o700 });
    const pi = await startBridge(baseConfig(), {
      host: { procRoot: path.join(dir, 'no-proc'), ps },
    });
    const effect = path.join(dir, 'after-deadline');
    const command = `sleep 0.2; touch '${effect}'`;
    const execute = await approvedBash(pi, 'ps-8', command, { timeout: 0.05 });
    await expect(
      execute('ps-8', { command, timeout: 0.05 }, undefined, undefined, undefined)
    ).rejects.toThrow('timeout:0.05');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(effect)).toBe(false);
  });

  // C17: the same deadline, with procfs.
  it('keeps the deadline with procfs', async () => {
    const pi = await startBridge();
    const effect = path.join(dir, 'after-deadline');
    const command = `sleep 0.2; touch '${effect}'`;
    const execute = await approvedBash(pi, 'ps-9', command, { timeout: 0.05 });
    await expect(
      execute('ps-9', { command, timeout: 0.05 }, undefined, undefined, undefined)
    ).rejects.toThrow('timeout:0.05');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(effect)).toBe(false);
  });

  it('runs no ps where procfs gives the start time', async () => {
    const pi = await startBridge(baseConfig(), { host: { ps: path.join(dir, 'no-ps') } });
    const execute = await approvedBash(pi, 'ps-3', 'true');
    await execute('ps-3', { command: 'true' }, undefined, undefined, undefined);
    const spawn = registryEvents().find((line) => line.event === 'spawn');
    expect(typeof spawn?.starttime).toBe('string');
    expect(spawn).not.toHaveProperty('lstart');
  });

  // C14: `procRoot` and `ps` come only from the host the generated module passes, which names
  // neither (its source, `piBridge(pi, { importPi: async () => piSdk, isProxy })`, is checked
  // literally in 'the generated module is valid…'); the config does not reach them.
  it('takes no procRoot or ps from the config', async () => {
    const touched = path.join(dir, 'override-reached');
    const ps = path.join(dir, 'override-ps');
    fs.writeFileSync(ps, `#!/bin/sh\ntouch '${touched}'\n`, { mode: 0o700 });
    const pi = await startBridge(baseConfig({ procRoot: path.join(dir, 'no-proc'), ps }));
    const execute = await approvedBash(pi, 'ps-12', 'sleep 0.2');
    await execute('ps-12', { command: 'sleep 0.2' }, undefined, undefined, undefined);
    expect(fs.existsSync(touched)).toBe(false);
    expect(readPiBashRegistry(registry).groups[0]?.starttime).not.toBeNull();
  });

  // R11-C (A07): a procfs with processes but no `self` is procfs for the bridge as for pi-bash;
  // both read the same source, so the bridge runs no `ps`.
  it('chooses the source by the rule pi-bash checks with', async () => {
    const touched = path.join(dir, 'ps-ran');
    const ps = path.join(dir, 'touch-ps');
    fs.writeFileSync(ps, `#!/bin/sh\ntouch '${touched}'\nexit 1\n`, { mode: 0o700 });
    const partial = path.join(dir, 'partial-proc');
    fs.mkdirSync(path.join(partial, '4242'), { recursive: true });
    const host = { procRoot: partial, ps };
    expect(piBashProcessView(host)).toBe('procfs');
    const pi = await startBridge(baseConfig(), { host });
    const execute = await approvedBash(pi, 'ps-10', 'sleep 0.2');
    await execute('ps-10', { command: 'sleep 0.2' }, undefined, undefined, undefined);
    expect(fs.existsSync(touched)).toBe(false);
    // An empty mount point is no procfs, for both.
    const empty = path.join(dir, 'empty-proc');
    fs.mkdirSync(empty);
    expect(piBashProcessView({ procRoot: empty, ps })).toBe('ps');
    fs.rmSync(registry, { force: true });
    const second = await startBridge(baseConfig(), { host: { procRoot: empty, ps } });
    const run = await approvedBash(second, 'ps-11', 'sleep 0.2');
    await run('ps-11', { command: 'sleep 0.2' }, undefined, undefined, undefined);
    expect(fs.existsSync(touched)).toBe(true);
  });

  it('keeps the shell exit code and reports a signal as 128 + number', async () => {
    const pi = await startBridge();
    let execute = await approvedBash(pi, 'c1', 'exit 3');
    await expect(
      execute('c1', { command: 'exit 3' }, undefined, undefined, undefined)
    ).resolves.toEqual({
      output: '',
      exitCode: 3,
    });
    execute = await approvedBash(pi, 'c2', 'kill -TERM $$');
    await expect(
      execute('c2', { command: 'kill -TERM $$' }, undefined, undefined, undefined)
    ).resolves.toEqual({ output: '', exitCode: 143 });
  });

  it('runs nothing when the registry cannot be written', async () => {
    const pi = await startBridge(
      baseConfig({ processRegistry: path.join(dir, 'missing', 'procs.jsonl') })
    );
    const proof = path.join(dir, 'ran.txt');
    const execute = await approvedBash(pi, 'nr-1', `touch '${proof}'`);
    await expect(
      execute('nr-1', { command: `touch '${proof}'` }, undefined, undefined, undefined)
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(proof)).toBe(false);
  });

  it('refuses invalid timeouts and missing directories like Pi', async () => {
    const operations: PiBridgeBashOperations[] = [];
    const sdk: PiBridgeSdk = {
      ...stubSdk,
      createBashToolDefinition: (cwd, options) => {
        if (options?.operations) operations.push(options.operations);
        return stubSdk.createBashToolDefinition(cwd, options);
      },
    };
    const pi = await startBridge(baseConfig(), { sdk });
    const execute = await approvedBash(pi, 'v1', 'true');
    await execute('v1', { command: 'true' }, undefined, undefined, undefined);
    const ops = operations[0] as PiBridgeBashOperations;
    const onData = () => {};
    await expect(ops.exec('true', dir, { onData, timeout: 0 })).rejects.toThrow('Invalid timeout');
    await expect(ops.exec('true', dir, { onData, timeout: Number.NaN })).rejects.toThrow(
      'Invalid timeout'
    );
    await expect(ops.exec('true', path.join(dir, 'nope'), { onData })).rejects.toThrow(
      'Working directory does not exist'
    );
    const aborted = AbortSignal.abort();
    await expect(ops.exec('true', dir, { onData, signal: aborted })).rejects.toThrow('aborted');
  });
});

/** The bridge's `BashOperations`, taken from the first approved `bash` call. */
async function bridgeOperations(
  shell?: ReturnType<NonNullable<PiBridgeSdk['getShellConfig']>>,
  toolCallId = 'ops'
): Promise<PiBridgeBashOperations> {
  const operations: PiBridgeBashOperations[] = [];
  const sdk: PiBridgeSdk = {
    ...stubSdk,
    ...(shell === undefined ? {} : { getShellConfig: () => shell }),
    createBashToolDefinition: (cwd, options) => {
      if (options?.operations) operations.push(options.operations);
      return stubSdk.createBashToolDefinition(cwd, options);
    },
  };
  const pi = await startBridge(baseConfig(), { sdk });
  const execute = await approvedBash(pi, toolCallId, 'true');
  await execute(toolCallId, { command: 'true' }, undefined, undefined, undefined);
  fs.rmSync(registry, { force: true });
  return operations[0] as PiBridgeBashOperations;
}

/** A child process that does only what the test makes it do. */
function fakeChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
}

const registryEvents = () =>
  fs.existsSync(registry)
    ? fs
        .readFileSync(registry, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

describe('own bash: cancellation and signals (X2-02, X2-03)', () => {
  const childProcess = process.getBuiltinModule('node:child_process');
  // A PID no process holds: the spawn record reads its start time from procfs and finds none.
  const FAKE_PID = 4_194_301;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts nothing when the call is cancelled while the directory is checked', async () => {
    const ops = await bridgeOperations();
    const spawn = vi.spyOn(childProcess, 'spawn');
    const controller = new AbortController();
    const proof = path.join(dir, 'ran.txt');
    const running = ops.exec(`touch '${proof}'`, dir, {
      onData: () => {},
      signal: controller.signal,
    });
    // `exec` is now waiting for `access(cwd)`.
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
    expect(spawn).not.toHaveBeenCalled();
    expect(registryEvents()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(proof)).toBe(false);
  });

  it('sends nothing to the PID once the shell has exited, also while the pipes drain', async () => {
    const ops = await bridgeOperations();
    const child = fakeChild(FAKE_PID);
    vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const controller = new AbortController();
    const running = ops.exec('sleep 30', dir, {
      onData: () => {},
      signal: controller.signal,
      timeout: 0.05,
    });
    const outcome = running.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
    child.emit('exit', 0, null);
    // The pipes are still open (the bridge waits 100 ms for them to fall idle): abort and the
    // timeout come after the exit.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(kill).not.toHaveBeenCalled();
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
    expect(await outcome).toBe('aborted');
    expect(kill).not.toHaveBeenCalled();
    expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
  });

  // The shell lives on (no `exit`, no `close`, pipes open): the call must still end, at once, with
  // an error, and the registry must leave the group's state unknown (R3-D). `ESRCH` is not such a
  // failure: it says the group is gone (R7-C, the tests below).
  it.each([
    ['aborted', 'abort', 'EPERM', undefined],
    ['aborted', 'abort', 'EINVAL', undefined],
    ['timed out', 'timeout', 'EPERM', 0.05],
  ])(
    'ends with an error when %s and the group signal fails (%s, %s), never signalling the bare PID (R3-D)',
    async (_name, why, code, timeout) => {
      const ops = await bridgeOperations();
      const child = fakeChild(FAKE_PID);
      vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error(`kill ${code}`), { code });
      });
      const controller = new AbortController();
      const started = Date.now();
      const running = ops.exec('sleep 30', dir, {
        onData: () => {},
        signal: controller.signal,
        ...(timeout === undefined ? {} : { timeout }),
      });
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      if (why === 'abort') controller.abort();
      const outcome = await Promise.race([
        running.then(
          () => 'resolved',
          (error: Error) => error.message
        ),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000)),
      ]);
      expect(outcome).toBe(
        `switch: ${why}, but the command could not be stopped (${code}); the state of its process group is unknown`
      );
      expect(Date.now() - started).toBeLessThan(1500);
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      // The pipes were closed on the bridge's side; nothing else reaches the shell.
      expect(child.stdout.destroyed).toBe(true);
      expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'kill']);
      expect(registryEvents()[2]).toMatchObject({ why, sent: false, error: code });
      expect(readPiBashRegistry(registry).groups[0]).toMatchObject({
        killedByBridge: false,
        bridgeKillFailed: true,
        shellExited: false,
      });
      // A late `exit` is recorded as it came (D-18, R12-D: the shell's `exit` is written when it
      // is reaped, whenever that is, since its PID is free from then on), and nothing else: no
      // other `kill`, no signal, the failed kill stays (the group's members are still unknown).
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registryEvents().map((entry) => entry.event)).toEqual([
        'intent',
        'spawn',
        'kill',
        'exit',
      ]);
      expect(registryEvents()[3]).toMatchObject({ code: null, signal: 'SIGKILL', pid: FAKE_PID });
      expect(readPiBashRegistry(registry).groups[0]).toMatchObject({
        bridgeKillFailed: true,
        shellExited: true,
      });
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
    }
  );

  // The `spawn` record fails after the shell started (R4-A): the adapter cannot see the group, so
  // the bridge sends SIGKILL to it and says what it knows. With the command passed as an argument
  // the shell may have run it; with stdin transport the command is never written. A sent signal
  // is not a confirmed end: the message says so, before any `exit` (R5-B).
  it.each([
    [
      'argument',
      undefined,
      'the command may have run',
      'its process group: SIGKILL sent; termination not confirmed',
    ],
    [
      'argument',
      'EPERM',
      'the command may have run',
      'its process group could not be stopped (EPERM); the state of its process group is unknown',
    ],
    [
      'stdin',
      undefined,
      'command not run',
      'its process group: SIGKILL sent; termination not confirmed',
    ],
    // ESRCH: no process is left in the group, so it is gone, not in an unknown state (R7-C).
    ['stdin', 'ESRCH', 'command not run', 'its process group no longer exists (ESRCH)'],
  ])(
    'reports the truth when the spawn record fails after the shell started (%s transport, signal error %s) (R4-A)',
    async (transport, code, ran, group) => {
      const viaStdin = transport === 'stdin';
      const ops = await bridgeOperations(
        viaStdin
          ? { shell: '/bin/bash', args: [], commandTransport: 'stdin' }
          : { shell: '/bin/bash', args: ['-c'] }
      );
      const nodeFs = process.getBuiltinModule('node:fs');
      const openSync = nodeFs.openSync.bind(nodeFs);
      let registryOpens = 0;
      vi.spyOn(nodeFs, 'openSync').mockImplementation(((
        file: fs.PathLike,
        flags: fs.OpenMode,
        mode?: fs.Mode | null
      ) => {
        if (file === registry && ++registryOpens === 2) {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        return openSync(file, flags, mode);
      }) as typeof nodeFs.openSync);
      const written: Buffer[] = [];
      const stdin = new PassThrough();
      stdin.on('data', (data: Buffer) => written.push(data));
      const child: Omit<ReturnType<typeof fakeChild>, 'stdin'> & { stdin: PassThrough | null } =
        fakeChild(FAKE_PID);
      if (viaStdin) child.stdin = stdin;
      const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        if (code !== undefined) throw Object.assign(new Error(`kill ${code}`), { code });
        return true;
      });
      const outcome = await ops.exec('echo side-effect', dir, { onData: () => {} }).then(
        () => 'resolved',
        (error: Error) => error.message
      );
      expect(outcome).toBe(
        `switch: process registry unavailable${viaStdin ? ', ' : ' after the shell started, '}${ran}; ${group}`
      );
      if (!viaStdin) expect(outcome).not.toContain('not run');
      // The call ended before the shell did: nothing may claim the group is gone.
      expect(outcome).not.toMatch(/\bkilled\b|\bterminated\b|\bstopped\b(?! \()/);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      if (viaStdin) {
        expect(stdin.destroyed).toBe(true);
        expect(Buffer.concat(written).toString('utf8')).toBe('');
      }
      // Only the intent reached the registry, and no fictitious `exit` follows.
      expect(registryEvents().map((entry) => entry.event)).toEqual(['intent']);
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registryEvents().map((entry) => entry.event)).toEqual(['intent']);
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
    }
  );

  // `writeSync` may write fewer bytes than asked (R5-A). The bridge writes the rest; a write that
  // makes no progress fails the record, and the call goes on as for any failed record: no shell
  // after a failed `intent`, the R4-A path after a failed `spawn`. The id has multi-byte characters,
  // so bytes and characters differ.
  it.each([
    ['intent', 'completes'],
    ['intent', 'stalls'],
    ['spawn', 'completes'],
    ['spawn', 'stalls'],
  ])(
    'writes the whole %s record after a short write, or fails it when the write %s (R5-A)',
    async (target, then) => {
      const toolCallId = 'zażółć-🐚';
      const ops = await bridgeOperations(undefined, toolCallId);
      const nodeFs = process.getBuiltinModule('node:fs');
      const writeSync = nodeFs.writeSync.bind(nodeFs) as (
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number
      ) => number;
      const attempts: number[] = [];
      vi.spyOn(nodeFs, 'writeSync').mockImplementation(((
        fd: number,
        buffer: Uint8Array,
        offset: number,
        length: number
      ) => {
        const line = Buffer.from(buffer).toString('utf8');
        if (!line.includes(`"event":"${target}"`)) return writeSync(fd, buffer, offset, length);
        attempts.push(offset);
        // First write: up to the middle of a multi-byte character, then as asked or nothing.
        if (attempts.length === 1) {
          const cut = Buffer.from(buffer).indexOf(Buffer.from('ż', 'utf8')) + 1;
          return writeSync(fd, buffer, offset, cut - offset);
        }
        return then === 'completes' ? writeSync(fd, buffer, offset, length) : 0;
      }) as typeof nodeFs.writeSync);
      const child = fakeChild(FAKE_PID);
      const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const running = ops.exec('echo side-effect', dir, { onData: () => {} }).then(
        (result) => result,
        (error: Error) => error.message
      );
      const parsed = () => readPiBashRegistry(registry);
      const cutAt = () => {
        expect(attempts[0]).toBe(0);
        expect(attempts[1]).toBeGreaterThan(0);
      };
      if (then === 'completes') {
        await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
        cutAt();
        expect(spawn).toHaveBeenCalledTimes(1);
        // Every line is a whole record: the group is visible with its own id.
        expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn']);
        expect(parsed()).toMatchObject({ invalidLines: 0, unspawned: [] });
        expect(parsed().groups).toEqual([
          expect.objectContaining({ toolCallId, pid: FAKE_PID, shellExited: false }),
        ]);
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        expect(await running).toEqual({ exitCode: 0 });
        expect(kill).not.toHaveBeenCalled();
        expect(parsed()).toMatchObject({ invalidLines: 0 });
        expect(parsed().groups[0]).toMatchObject({ toolCallId, shellExited: true });
        return;
      }
      const outcome = await running;
      expect(attempts).toHaveLength(2);
      cutAt();
      if (target === 'intent') {
        expect(outcome).toMatch(
          /^switch: process registry write made no progress \(\d+ of \d+ bytes\)$/
        );
        expect(spawn).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
        expect(parsed()).toEqual({ groups: [], unspawned: [], invalidLines: 1 });
      } else {
        expect(outcome).toBe(
          'switch: process registry unavailable after the shell started, the command may have run; its process group: SIGKILL sent; termination not confirmed'
        );
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
        expect(child.stdout.destroyed).toBe(true);
        // The intent and the cut-off spawn line, which the parser does not trust.
        expect(parsed()).toMatchObject({ groups: [], invalidLines: 1 });
        expect(parsed().unspawned).toEqual([expect.objectContaining({ toolCallId })]);
        child.emit('exit', null, 'SIGKILL');
        child.emit('close', null, 'SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(parsed()).toMatchObject({ groups: [], invalidLines: 1 });
      }
    }
  );

  it.each([
    ['times out', 'timeout:0.1', undefined],
    ['is aborted', 'aborted', 120],
  ])(
    'ends on time when it %s after the shell exited while a leftover keeps writing (R2-C)',
    async (_name, message, abortAfterMs) => {
      const ops = await bridgeOperations();
      const child = fakeChild(FAKE_PID);
      vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const controller = new AbortController();
      const started = Date.now();
      const running = ops.exec('sleep 30', dir, {
        onData: () => {},
        signal: controller.signal,
        ...(abortAfterMs === undefined ? { timeout: 0.1 } : {}),
      });
      const outcome = running.then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      child.emit('exit', 0, null);
      // A process left in the group holds the pipes and writes more often than the idle wait.
      const writer = setInterval(() => child.stdout.write('x\n'), 20);
      if (abortAfterMs !== undefined) setTimeout(() => controller.abort(), abortAfterMs);
      try {
        expect(await outcome).toBe(message);
      } finally {
        clearInterval(writer);
      }
      expect(Date.now() - started).toBeLessThan(1500);
      expect(kill).not.toHaveBeenCalled();
      expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
    }
  );

  it('ends at exit when the timeout came first and a leftover keeps writing (R2-C)', async () => {
    const ops = await bridgeOperations();
    const child = fakeChild(FAKE_PID);
    vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const running = ops.exec('sleep 30', dir, { onData: () => {}, timeout: 0.05 });
    const outcome = running.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await waitUntil(() => kill.mock.calls.length > 0);
    expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
    const writer = setInterval(() => child.stdout.write('x\n'), 20);
    const exitedAt = Date.now();
    child.emit('exit', null, 'SIGKILL');
    try {
      expect(await outcome).toBe('timeout:0.05');
    } finally {
      clearInterval(writer);
    }
    expect(Date.now() - exitedAt).toBeLessThan(500);
    expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
  });

  // SIGKILL was sent, but the shell never reports `exit` or `close` (e.g. stuck in the kernel): the
  // call must still end, within the bridge's 1 s limit, with an error that says only what is known
  // (R6-A). When `exit` comes within the limit, the call ends as before.
  // The bridge's own timers (call timeout 50 ms, pipes idle 100 ms, kill confirmation 1 s) that
  // have neither fired nor been cleared.
  function trackBridgeTimers() {
    const setTimer = globalThis.setTimeout;
    const clearTimer = globalThis.clearTimeout;
    const pending = new Set<unknown>();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const handle = setTimer(() => {
        pending.delete(handle);
        callback(...args);
      }, ms);
      if (ms === 50 || ms === 100 || ms === 1000) pending.add(handle);
      return handle;
    }) as never);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: unknown) => {
      pending.delete(handle);
      clearTimer(handle as Parameters<typeof clearTimeout>[0]);
    }) as never);
    return pending;
  }
  it.each([
    ['timed out', 'timeout', 0.05, undefined],
    ['aborted', 'abort', undefined, undefined],
    ['timed out', 'timeout', 0.05, 300],
    ['aborted', 'abort', undefined, 300],
  ])(
    'ends when %s after a sent SIGKILL (%s, timeout %s s, exit after %s ms) (R6-A)',
    async (_name, why, timeout, exitAfter) => {
      const ops = await bridgeOperations();
      const child = fakeChild(FAKE_PID);
      vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const controller = new AbortController();
      const pending = trackBridgeTimers();
      const running = ops.exec('sleep 30', dir, {
        onData: () => {},
        signal: controller.signal,
        ...(timeout === undefined ? {} : { timeout }),
      });
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      const started = Date.now();
      if (why === 'abort') controller.abort();
      await waitUntil(() => kill.mock.calls.length > 0);
      if (exitAfter !== undefined) {
        setTimeout(() => child.emit('exit', null, 'SIGKILL'), exitAfter);
      }
      let guard: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        running.then(
          () => 'resolved',
          (error: Error) => error.message
        ),
        new Promise((resolve) => {
          guard = setTimeout(() => resolve('still waiting'), 3000);
        }),
      ]);
      const took = Date.now() - started;
      clearTimeout(guard);
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      expect(child.stdout.destroyed).toBe(true);
      if (exitAfter === undefined) {
        expect(outcome).toBe(
          `switch: ${why}; its process group: SIGKILL sent; termination not confirmed`
        );
        expect(took).toBeGreaterThanOrEqual(900);
        expect(took).toBeLessThan(2000);
        // The sent kill, and no `exit` the shell never reported.
        expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'kill']);
        expect(registryEvents()[2]).toMatchObject({ why, sent: true });
        expect(readPiBashRegistry(registry).groups[0]).toMatchObject({
          shellExited: false,
          killedByBridge: true,
          bridgeKillFailed: false,
        });
      } else {
        expect(outcome).toBe(why === 'abort' ? 'aborted' : 'timeout:0.05');
        expect(took).toBeLessThan(900);
        expect(registryEvents().map((entry) => entry.event)).toEqual([
          'intent',
          'spawn',
          'kill',
          'exit',
        ]);
      }
      // No timer of the call outlives it, and nothing happens after the call ended.
      expect(pending.size).toBe(0);
      const events = registryEvents().length;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(registryEvents()).toHaveLength(events);
      expect(kill.mock.calls).toHaveLength(1);
    },
    10_000
  );

  // Timeout and abort both come before the shell's `exit` (R7-C): the first decides. The group gets
  // one SIGKILL and the registry one `kill`; the second trigger sends and writes nothing. A second
  // signal would find the group gone (ESRCH) and must not turn a sent SIGKILL into "unknown".
  it.each([
    ['timeout', 'abort', 'never'],
    ['abort', 'timeout', 'never'],
    ['timeout', 'abort', 'exits'],
    ['abort', 'timeout', 'exits'],
  ])(
    'signals the group once when %s comes before %s, both before exit (shell %s) (R7-C)',
    async (first, second, shell) => {
      const ops = await bridgeOperations();
      const child = fakeChild(FAKE_PID);
      vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        if (kill.mock.calls.length > 1) {
          throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        }
        return true;
      });
      const controller = new AbortController();
      const pending = trackBridgeTimers();
      const running = ops.exec('sleep 30', dir, {
        onData: () => {},
        signal: controller.signal,
        timeout: first === 'timeout' ? 0.05 : 0.3,
      });
      const outcome = running.then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      if (first === 'abort') controller.abort();
      await waitUntil(() => kill.mock.calls.length > 0);
      // The second trigger, still before `exit` and within the 1 s confirmation limit.
      if (second === 'abort') controller.abort();
      else await new Promise((resolve) => setTimeout(resolve, 350));
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'kill']);
      if (shell === 'exits') child.emit('exit', null, 'SIGKILL');
      if (shell === 'exits') {
        expect(await outcome).toBe(first === 'abort' ? 'aborted' : 'timeout:0.05');
        expect(registryEvents().map((entry) => entry.event)).toEqual([
          'intent',
          'spawn',
          'kill',
          'exit',
        ]);
      } else {
        expect(await outcome).toBe(
          `switch: ${first}; its process group: SIGKILL sent; termination not confirmed`
        );
        expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'kill']);
      }
      expect(registryEvents()[2]).toMatchObject({ why: first, sent: true });
      expect(registryEvents()[2]).not.toHaveProperty('error');
      expect(readPiBashRegistry(registry)).toMatchObject({ invalidLines: 0 });
      expect(readPiBashRegistry(registry).groups[0]).toMatchObject({
        killedByBridge: true,
        bridgeKillFailed: false,
        shellExited: shell === 'exits',
      });
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      expect(pending.size).toBe(0);
    },
    10_000
  );

  // `ESRCH` on the first signal: no process, not even a zombie, is left in the group, so the
  // group is gone; its state is not unknown (R7-C, like `isGone` in `./pi-bash.ts`). The shell was
  // reaped already, so its `exit` normally follows at once; without it the call still ends.
  it.each([['exits'], ['never']])(
    'treats ESRCH on the first signal as a group that is gone (shell %s) (R7-C)',
    async (shell) => {
      const ops = await bridgeOperations();
      const child = fakeChild(FAKE_PID);
      vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });
      const controller = new AbortController();
      const running = ops.exec('sleep 30', dir, {
        onData: () => {},
        signal: controller.signal,
        timeout: 0.05,
      });
      const outcome = running.then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      controller.abort();
      await waitUntil(() => kill.mock.calls.length > 0);
      const started = Date.now();
      if (shell === 'exits') child.emit('exit', null, 'SIGKILL');
      const message = await outcome;
      expect(message).not.toContain('unknown');
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      expect(registryEvents()[2]).toMatchObject({
        event: 'kill',
        why: 'abort',
        sent: false,
        error: 'ESRCH',
      });
      expect(readPiBashRegistry(registry).groups[0]).toMatchObject({
        killedByBridge: false,
        bridgeKillFailed: false,
        shellExited: shell === 'exits',
      });
      if (shell === 'exits') {
        expect(message).toBe('aborted');
        expect(Date.now() - started).toBeLessThan(500);
        expect(registryEvents().map((entry) => entry.event)).toEqual([
          'intent',
          'spawn',
          'kill',
          'exit',
        ]);
      } else {
        expect(message).toBe('switch: abort; its process group no longer exists (ESRCH)');
        expect(Date.now() - started).toBeLessThan(2000);
        expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'kill']);
      }
    },
    10_000
  );

  // A throwing output callback or a failed pipe ends the call under control (R7-A): no uncaught
  // exception and no unhandled `error` event (vitest fails the run on either), SIGKILL to the
  // group through the same path as an abort, one `kill`, no fictitious `exit`.
  it.each([
    [
      'the output callback throws',
      'output_callback_error',
      'output callback failed (boom)',
      'exits',
    ],
    [
      'the output callback throws',
      'output_callback_error',
      'output callback failed (boom)',
      'never',
    ],
    ['stdout fails', 'stdout_error', 'stdout failed (EIO)', 'exits'],
    ['stdout fails', 'stdout_error', 'stdout failed (EIO)', 'never'],
    ['stderr fails', 'stderr_error', 'stderr failed (EIO)', 'exits'],
  ])(
    'ends the call with an error when %s, and signals the group (%s: %s, shell %s) (R7-A)',
    async (_name, why, text, shell) => {
      const ops = await bridgeOperations();
      const child = fakeChild(FAKE_PID);
      vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const pending = trackBridgeTimers();
      const seen: string[] = [];
      const running = ops.exec('sleep 30', dir, {
        onData: (data: Buffer) => {
          seen.push(data.toString('utf8'));
          if (why === 'output_callback_error') throw new Error('boom');
        },
      });
      const outcome = running.then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      const started = Date.now();
      const failure = (code: string) => Object.assign(new Error(`${code}: failed`), { code });
      if (why === 'output_callback_error') child.stdout.write('first');
      else if (why === 'stdout_error') child.stdout.destroy(failure('EIO'));
      else child.stderr.destroy(failure('EIO'));
      await waitUntil(() => kill.mock.calls.length > 0);
      // Nothing more reaches the callback once the call failed.
      if (why !== 'stdout_error') child.stdout.write('more');
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (shell === 'exits') child.emit('exit', null, 'SIGKILL');
      let guard: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        outcome,
        new Promise((resolve) => {
          guard = setTimeout(() => resolve('still waiting'), 3000);
        }),
      ]);
      clearTimeout(guard);
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      expect(registryEvents()[2]).toMatchObject({ event: 'kill', why, sent: true });
      if (why === 'output_callback_error') expect(seen).toEqual(['first']);
      else expect(seen).toEqual([]);
      if (shell === 'exits') {
        expect(result).toBe(`switch: ${text}`);
        expect(Date.now() - started).toBeLessThan(900);
        expect(registryEvents().map((entry) => entry.event)).toEqual([
          'intent',
          'spawn',
          'kill',
          'exit',
        ]);
      } else {
        expect(result).toBe(
          `switch: ${text}; its process group: SIGKILL sent; termination not confirmed`
        );
        expect(Date.now() - started).toBeLessThan(2000);
        expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'kill']);
      }
      expect(pending.size).toBe(0);
    },
    10_000
  );

  it('ends at exit after a failed output callback while a leftover keeps writing (R7-A, R2-C)', async () => {
    const ops = await bridgeOperations();
    const child = fakeChild(FAKE_PID);
    vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const running = ops.exec('sleep 30', dir, {
      onData: () => {
        throw new Error('boom');
      },
    });
    const outcome = running.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
    child.stdout.write('x');
    await waitUntil(() => kill.mock.calls.length > 0);
    // A process left in the group holds the pipes and writes more often than the idle wait.
    const writer = setInterval(() => child.stderr.write('x\n'), 20);
    const exitedAt = Date.now();
    child.emit('exit', null, 'SIGKILL');
    try {
      expect(await outcome).toBe('switch: output callback failed (boom)');
    } finally {
      clearInterval(writer);
    }
    expect(Date.now() - exitedAt).toBeLessThan(500);
    expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
  });

  it('ends with an error and sends nothing when the output callback throws after exit (R7-A)', async () => {
    const ops = await bridgeOperations();
    const child = fakeChild(FAKE_PID);
    vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const running = ops.exec('true', dir, {
      onData: () => {
        throw new Error('late');
      },
    });
    const outcome = running.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
    child.emit('exit', 0, null);
    // The pipes are still draining: the PID may be reused, so no signal.
    child.stdout.write('x');
    expect(await outcome).toBe('switch: output callback failed (late)');
    expect(kill).not.toHaveBeenCalled();
    expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
  });

  // A failed stdin (R9-A, D-11 A). EPIPE means the reading end is closed, by the command itself
  // (`exec 0<&-`) or because the shell has ended: like Pi (`PKG/dist/core/tools/bash.js:70-72`)
  // the bridge ignores it and returns the shell's own result; a shell that hangs is ended only by
  // the timeout or an abort. Any other error ends the call under control, like a failed pipe (R7-A).
  function stdinChild() {
    const stdin = new PassThrough();
    const child: Omit<ReturnType<typeof fakeChild>, 'stdin'> & { stdin: PassThrough } =
      Object.assign(fakeChild(FAKE_PID), { stdin });
    vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    return child;
  }
  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  const stdinFailure = (code: string | undefined) =>
    code === undefined ? new Error('weird') : Object.assign(new Error(`write ${code}`), { code });

  it.each([['before'], ['after']])(
    'returns the shell’s own result when stdin fails with EPIPE %s its exit (R9-A)',
    async (order) => {
      const ops = await bridgeOperations({
        shell: '/bin/bash',
        args: ['-s'],
        commandTransport: 'stdin',
      });
      const child = stdinChild();
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const pending = trackBridgeTimers();
      const seen: string[] = [];
      const running = ops.exec('echo did-run; exit 7', dir, {
        onData: (data: Buffer) => seen.push(data.toString('utf8')),
      });
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      child.stdout.write('did-run\n');
      await waitUntil(() => seen.length > 0);
      if (order === 'before') {
        child.stdin.destroy(epipe());
        await new Promise((resolve) => setTimeout(resolve, 300));
        child.emit('exit', 7, null);
      } else {
        child.emit('exit', 7, null);
        child.stdin.destroy(epipe());
      }
      child.stdout.end();
      child.stderr.end();
      expect(await running).toEqual({ exitCode: 7 });
      expect(seen).toEqual(['did-run\n']);
      expect(kill).not.toHaveBeenCalled();
      expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
      expect(registryEvents()[2]).toMatchObject({ code: 7 });
      expect(pending.size).toBe(0);
    },
    10_000
  );

  it('ignores EPIPE while the shell lives on, past any limit, and returns its result (R9-A)', async () => {
    const ops = await bridgeOperations({
      shell: '/bin/bash',
      args: ['-s'],
      commandTransport: 'stdin',
    });
    const child = stdinChild();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const pending = trackBridgeTimers();
    const seen: string[] = [];
    const running = ops.exec('exec 0<&-; sleep 1.5; echo after', dir, {
      onData: (data: Buffer) => seen.push(data.toString('utf8')),
    });
    await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
    child.stdin.destroy(epipe());
    // Longer than KILL_CONFIRM_MS (1 s, R8-A's old limit): no signal, output still flows.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(kill).not.toHaveBeenCalled();
    child.stdout.write('after\n');
    await waitUntil(() => seen.length > 0);
    child.emit('exit', 0, null);
    child.stdout.end();
    child.stderr.end();
    expect(await running).toEqual({ exitCode: 0 });
    expect(seen).toEqual(['after\n']);
    expect(kill).not.toHaveBeenCalled();
    expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
    expect(pending.size).toBe(0);
  }, 10_000);

  it.each([
    ['EIO', 'exits'],
    ['EIO', 'never'],
    ['EBADF', 'exits'],
    [undefined, 'exits'],
  ])(
    'ends the call under control at once when stdin fails with %s while the shell lives on (shell %s after the signal) (R9-A, R7-A)',
    async (code, shell) => {
      const ops = await bridgeOperations({
        shell: '/bin/bash',
        args: ['-s'],
        commandTransport: 'stdin',
      });
      const child = stdinChild();
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const pending = trackBridgeTimers();
      const seen: string[] = [];
      const running = ops.exec('sleep 30', dir, {
        onData: (data: Buffer) => seen.push(data.toString('utf8')),
      });
      const outcome = running.then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      const started = Date.now();
      child.stdin.destroy(stdinFailure(code));
      await waitUntil(() => kill.mock.calls.length > 0);
      expect(Date.now() - started).toBeLessThan(500);
      // Nothing more reaches the callback once the call failed.
      child.stdout.write('more');
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (shell === 'exits') child.emit('exit', null, 'SIGKILL');
      let guard: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        outcome,
        new Promise((resolve) => {
          guard = setTimeout(() => resolve('still waiting'), 3000);
        }),
      ]);
      clearTimeout(guard);
      const text = `stdin failed (${code ?? 'weird'})`;
      expect(seen).toEqual([]);
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      expect(registryEvents()[2]).toMatchObject({ event: 'kill', why: 'stdin_error', sent: true });
      if (shell === 'exits') {
        expect(result).toBe(`switch: ${text}`);
        expect(registryEvents().map((entry) => entry.event)).toEqual([
          'intent',
          'spawn',
          'kill',
          'exit',
        ]);
      } else {
        expect(result).toBe(
          `switch: ${text}; its process group: SIGKILL sent; termination not confirmed`
        );
        expect(Date.now() - started).toBeLessThan(3000);
        expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'kill']);
      }
      expect(pending.size).toBe(0);
    },
    10_000
  );

  it('ends with an error and sends nothing when stdin fails with EIO after exit (R9-A, R7-A)', async () => {
    const ops = await bridgeOperations({
      shell: '/bin/bash',
      args: ['-s'],
      commandTransport: 'stdin',
    });
    const child = stdinChild();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const running = ops.exec('echo x', dir, { onData: () => {} });
    const outcome = running.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
    child.emit('exit', 0, null);
    child.stdin.destroy(stdinFailure('EIO'));
    child.stdout.end();
    child.stderr.end();
    expect(await outcome).toBe('switch: stdin failed (EIO)');
    expect(kill).not.toHaveBeenCalled();
    expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
  });

  it.each([['abort'], ['timeout']])(
    'lets only %s end a shell that hangs after EPIPE (R9-A, R7-C)',
    async (how) => {
      const ops = await bridgeOperations({
        shell: '/bin/bash',
        args: ['-s'],
        commandTransport: 'stdin',
      });
      const child = stdinChild();
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const pending = trackBridgeTimers();
      const controller = new AbortController();
      const running = ops.exec('exec 0<&-; sleep 30', dir, {
        onData: () => {},
        signal: controller.signal,
        ...(how === 'timeout' ? { timeout: 1.5 } : {}),
      });
      const outcome = running.then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      const started = Date.now();
      child.stdin.destroy(epipe());
      // Past R8-A's old 1 s limit: EPIPE alone changed nothing.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(kill).not.toHaveBeenCalled();
      if (how === 'abort') controller.abort();
      await waitUntil(() => kill.mock.calls.length > 0);
      if (how === 'timeout') expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
      child.emit('exit', null, 'SIGKILL');
      expect(await outcome).toBe(how === 'abort' ? 'aborted' : 'timeout:1.5');
      expect(kill.mock.calls).toEqual([[-FAKE_PID, 'SIGKILL']]);
      expect(registryEvents().map((entry) => entry.event)).toEqual([
        'intent',
        'spawn',
        'kill',
        'exit',
      ]);
      expect(registryEvents()[2]).toMatchObject({ why: how });
      expect(pending.size).toBe(0);
    },
    10_000
  );

  function spawnRecordingStdinErrors() {
    const spawn = childProcess.spawn;
    const stdinErrors: string[] = [];
    vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      child.stdin?.on('error', (error: NodeJS.ErrnoException) =>
        stdinErrors.push(String(error.code))
      );
      return child;
    }) as never);
    return stdinErrors;
  }
  // A tail far larger than a pipe's buffer: the write is still going when the reading end closes.
  const bigTail = `#${'x'.repeat(5 * 1024 * 1024)}\n`;

  it('returns the real code when a real `bash -s` exits before the command is fully written (R8-A, R9-A, real shell)', async () => {
    const stdinErrors = spawnRecordingStdinErrors();
    const ops = await bridgeOperations({
      shell: '/bin/bash',
      args: ['-s'],
      commandTransport: 'stdin',
    });
    const seen: string[] = [];
    // bash exits at `exit 7`, before the tail is written, and the rest of the write fails with EPIPE.
    const result = await ops.exec(`echo did-run; exit 7\n${bigTail}`, dir, {
      onData: (data: Buffer) => seen.push(data.toString('utf8')),
    });
    expect(result).toEqual({ exitCode: 7 });
    expect(seen.join('')).toBe('did-run\n');
    expect(stdinErrors).toContain('EPIPE');
    expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
    expect(readPiBashRegistry(registry).groups[0]).toMatchObject({
      shellExited: true,
      killedByBridge: false,
    });
  });

  it('lets a real `bash -s` that closes its stdin run on past 1 s and returns its result (R9-A, real shell)', async () => {
    const stdinErrors = spawnRecordingStdinErrors();
    const ops = await bridgeOperations({
      shell: '/bin/bash',
      args: ['-s'],
      commandTransport: 'stdin',
    });
    const seen: string[] = [];
    const started = Date.now();
    // bash reads the first line whole, closes its stdin (EPIPE for the tail) and runs the rest of
    // the line; the next read finds no input, so bash ends with the last command's code.
    const result = await ops.exec(
      `exec 0<&-; echo before; sleep 1.5; echo after\n${bigTail}`,
      dir,
      { onData: (data: Buffer) => seen.push(data.toString('utf8')) }
    );
    expect(result).toEqual({ exitCode: 0 });
    expect(seen.join('')).toBe('before\nafter\n');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(stdinErrors).toContain('EPIPE');
    expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
    expect(readPiBashRegistry(registry).groups[0]).toMatchObject({
      shellExited: true,
      killedByBridge: false,
    });
  });

  it('ends a real `bash -s` that closed its stdin and hangs at the timeout (R9-A, real shell)', async () => {
    const stdinErrors = spawnRecordingStdinErrors();
    const ops = await bridgeOperations({
      shell: '/bin/bash',
      args: ['-s'],
      commandTransport: 'stdin',
    });
    const started = Date.now();
    await expect(
      ops.exec(`exec 0<&-; sleep 30\n${bigTail}`, dir, { onData: () => {}, timeout: 1.5 })
    ).rejects.toThrow('timeout:1.5');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(stdinErrors).toContain('EPIPE');
    const [group] = readPiBashRegistry(registry).groups;
    expect(group).toMatchObject({ killedByBridge: true, shellExited: true });
    expect(piProcessGroupMembers(group?.pgid ?? -1)).toEqual([]);
  });

  it('ends the call and stops the group when the output callback throws (R7-A, real shell)', async () => {
    const ops = await bridgeOperations();
    const started = Date.now();
    await expect(
      ops.exec('echo x; sleep 30', dir, {
        onData: () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('switch: output callback failed (boom)');
    expect(Date.now() - started).toBeLessThan(2000);
    const [group] = readPiBashRegistry(registry).groups;
    expect(group).toMatchObject({
      killedByBridge: true,
      bridgeKillFailed: false,
      shellExited: true,
    });
    expect(piProcessGroupMembers(group?.pgid ?? -1)).toEqual([]);
  });

  it('ends at the timeout when a background job keeps the pipes busy (R2-C, real shell)', async () => {
    const pi = await startBridge();
    const command = '(while true; do echo x; sleep 0.02; done) & exit 0';
    const execute = await approvedBash(pi, 'bg-to', command, { timeout: 0.3 });
    const started = Date.now();
    await expect(
      execute('bg-to', { command, timeout: 0.3 }, undefined, undefined, undefined)
    ).rejects.toThrow('timeout:0.3');
    expect(Date.now() - started).toBeLessThan(2000);
    // The shell had exited: its PID gets no signal; the group is left to the adapter.
    expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
    expect(readPiBashRegistry(registry).groups[0]).toMatchObject({
      shellExited: true,
      killedByBridge: false,
    });
  });
});

// --- The bridge as Pi gets it: the generated module, in a fresh node (E10-17, E11-06). ---

type EstreeNode = { type: string; [key: string]: unknown };
// Loaded without its types: `vitest/node` types pull in DOM globals that clash with the package's.
const { parseAst } = (await import('vitest/node' as string)) as {
  parseAst: (code: string) => unknown;
};
const isNode = (value: unknown): value is EstreeNode =>
  typeof value === 'object' && value !== null && typeof (value as EstreeNode).type === 'string';

function bindingNames(pattern: EstreeNode, out: string[] = []): string[] {
  if (pattern.type === 'Identifier') out.push(pattern.name as string);
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties as EstreeNode[]) {
      bindingNames(
        (property.type === 'RestElement' ? property.argument : property.value) as EstreeNode,
        out
      );
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements as Array<EstreeNode | null>)
      if (element) bindingNames(element, out);
  } else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left as EstreeNode, out);
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument as EstreeNode, out);
  return out;
}

/** Identifiers a function reads from outside its own body (ESTree scope walk). */
function freeIdentifiers(source: string): string[] {
  const program = parseAst(`(${source});`) as unknown as EstreeNode;
  const free = new Set<string>();
  const declared = (name: string, scopes: Set<string>[]) => scopes.some((scope) => scope.has(name));
  const lexical = (statements: EstreeNode[]) => {
    const names = new Set<string>();
    for (const statement of statements) {
      if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
        for (const declarator of statement.declarations as EstreeNode[]) {
          for (const name of bindingNames(declarator.id as EstreeNode)) names.add(name);
        }
      } else if (
        (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') &&
        isNode(statement.id)
      ) {
        names.add(statement.id.name as string);
      }
    }
    return names;
  };
  const vars = (node: unknown, names = new Set<string>()): Set<string> => {
    if (Array.isArray(node)) for (const item of node) vars(item, names);
    else if (isNode(node)) {
      if (node.type.includes('Function')) return names;
      if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        for (const declarator of node.declarations as EstreeNode[]) {
          for (const name of bindingNames(declarator.id as EstreeNode)) names.add(name);
        }
      }
      for (const [key, value] of Object.entries(node)) if (key !== 'type') vars(value, names);
    }
    return names;
  };
  const patternExpressions = (pattern: EstreeNode, scopes: Set<string>[]) => {
    if (pattern.type === 'AssignmentPattern') {
      visit(pattern.right, scopes);
      patternExpressions(pattern.left as EstreeNode, scopes);
    } else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties as EstreeNode[]) {
        if (property.type === 'RestElement')
          patternExpressions(property.argument as EstreeNode, scopes);
        else {
          if (property.computed) visit(property.key, scopes);
          patternExpressions(property.value as EstreeNode, scopes);
        }
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements as Array<EstreeNode | null>) {
        if (element) patternExpressions(element, scopes);
      }
    } else if (pattern.type === 'RestElement')
      patternExpressions(pattern.argument as EstreeNode, scopes);
  };
  const visitFunction = (fn: EstreeNode, scopes: Set<string>[]) => {
    const scope = new Set<string>();
    if (fn.type === 'FunctionExpression' && isNode(fn.id)) scope.add(fn.id.name as string);
    for (const param of fn.params as EstreeNode[])
      for (const name of bindingNames(param)) scope.add(name);
    for (const name of vars(fn.body)) scope.add(name);
    const inner = [...scopes, scope];
    for (const param of fn.params as EstreeNode[]) patternExpressions(param, inner);
    visit(fn.body, inner);
  };
  const visit = (node: unknown, scopes: Set<string>[]): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, scopes);
      return;
    }
    if (!isNode(node)) return;
    switch (node.type) {
      case 'Identifier':
        if (!declared(node.name as string, scopes)) free.add(node.name as string);
        return;
      case 'MemberExpression':
        visit(node.object, scopes);
        if (node.computed) visit(node.property, scopes);
        return;
      case 'Property':
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, scopes);
        visit(node.value, scopes);
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(node, scopes);
        return;
      case 'VariableDeclaration':
        for (const declarator of node.declarations as EstreeNode[]) {
          patternExpressions(declarator.id as EstreeNode, scopes);
          visit(declarator.init, scopes);
        }
        return;
      case 'BlockStatement':
      case 'StaticBlock':
      case 'Program': {
        const body = node.body as EstreeNode[];
        visit(body, [...scopes, lexical(body)]);
        return;
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scopes);
        const cases = node.cases as EstreeNode[];
        const inner = [
          ...scopes,
          lexical(cases.flatMap((item) => item.consequent as EstreeNode[])),
        ];
        for (const item of cases) {
          visit(item.test, inner);
          visit(item.consequent, inner);
        }
        return;
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const head = (node.init ?? node.left) as EstreeNode | null;
        const inner = [
          ...scopes,
          head?.type === 'VariableDeclaration' ? lexical([head]) : new Set<string>(),
        ];
        for (const [key, value] of Object.entries(node)) if (key !== 'type') visit(value, inner);
        return;
      }
      case 'CatchClause': {
        const scope = new Set(isNode(node.param) ? bindingNames(node.param) : []);
        visit(node.body, [...scopes, scope]);
        return;
      }
      case 'LabeledStatement':
        visit(node.body, scopes);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      default:
        for (const [key, value] of Object.entries(node)) if (key !== 'type') visit(value, scopes);
    }
  };
  visit(program, []);
  return [...free].sort();
}

// Joint round 3 of stages 2 and 5 (`p1_joint_fix3_brief.md`, D-18 A): the shell's label in its
// command line, the `exit` written as the shell is reaped, the range of every id the bridge reads
// from `ps` (R12-C), and the attacks of round 12 (Codex `r12.attack.test.ts` A01, A02, A05, C12,
// P01–P06; Sonnet S2-NN on real shells). Every process here is a decoy the test started.
describe('joint round 3: the label of each shell (D-18; R12-A, R12-C, R12-D)', () => {
  const hidden = () => ({ procRoot: path.join(dir, 'no-proc'), ps: 'ps' });
  const lstartOf = () => registryEvents().find((line) => line.event === 'lstart');
  const groupOf = (toolCallId: string) => {
    const found = readPiBashRegistry(registry).groups.find((g) => g.toolCallId === toolCallId);
    if (!found) throw new Error(`no group ${toolCallId}`);
    return found;
  };
  const alive = (pid: number) => {
    const stat = readPiProcStat(pid);
    return stat !== undefined && stat.state !== 'Z' && stat.state !== 'X';
  };
  async function running(command: string, toolCallId = 'lbl', host = hidden(), extra = {}) {
    const pi = await startBridge(baseConfig(), { host });
    const execute = await approvedBash(pi, toolCallId, command, extra);
    const controller = new AbortController();
    const outcome = execute(
      toolCallId,
      { command, ...extra },
      controller.signal,
      undefined,
      undefined
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: String(error) })
    );
    return { pi, controller, outcome };
  }

  it('puts a label of its own after the command ($1, $0 as before) and in the registry first', async () => {
    const command = 'echo "$0|$#|$1"';
    const pi = await startBridge(baseConfig(), { host: hidden() });
    const execute = await approvedBash(pi, 'lbl-0', command);
    const result = (await execute('lbl-0', { command }, undefined, undefined, undefined)) as {
      output: string;
    };
    const [intent, spawn] = registryEvents();
    expect(intent).toMatchObject({
      event: 'intent',
      label: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(spawn).toMatchObject({ event: 'spawn', label: intent?.label });
    // The command runs as it did; `$0` is the shell, the label is a positional parameter.
    expect(result.output).toBe(`/bin/bash|1|${String(intent?.label)}\n`);
    // A new label for every shell.
    const again = await approvedBash(pi, 'lbl-1', command);
    await again('lbl-1', { command }, undefined, undefined, undefined);
    const labels = registryEvents()
      .filter((line) => line.event === 'intent')
      .map((line) => line.label);
    expect(new Set(labels).size).toBe(2);
  });

  // Codex A01, A02 (R12-A): the approved shell replaces itself (`exec`) without the marker. Any
  // change of its command line, the label dropped or only ` #` appended, is refused on the `ps`
  // path as procfs refuses it. The known limit: an `exec` that keeps the exact command line,
  // label included, is taken for the shell on the `ps` path (it is the approved command's own
  // process), while procfs refuses it (no marker).
  it.each([
    ['A01: the same -c string, the label dropped', '', '', 'leader_command_mismatch'],
    ['A02: ` #` appended, the label dropped', ' #', '', 'leader_command_mismatch'],
    ['` #` appended, the label kept', ' #', ' "$0" "$1"', 'leader_command_mismatch'],
    ['known limit: the exact command line kept', '', ' "$0" "$1"', 'leader_verified'],
  ])('%s', async (_name, suffix, keep, reason) => {
    const gate = path.join(dir, 'go');
    const ready = path.join(dir, 'ready');
    const command = `if [ -n "\${${PI_BASH_MARKER_ENV}-}" ]; then while [ ! -f '${gate}' ]; do sleep 0.01; done; exec env -u ${PI_BASH_MARKER_ENV} /bin/bash -c "$BASH_EXECUTION_STRING${suffix}"${keep}; fi; touch '${ready}'; sleep 30; true`;
    const { controller, outcome } = await running(command);
    await waitUntil(() => lstartOf()?.cmd !== undefined);
    const group = groupOf('lbl');
    const procfs = { ...group, starttime: readPiProcStat(group.pid)?.starttime ?? null };
    expect(verifyPiBashGroup(procfs)).toMatchObject({ ok: true });
    expect(verifyPiBashGroup(group, hidden())).toMatchObject({
      ok: true,
      reason: 'leader_verified',
    });
    fs.writeFileSync(gate, 'go');
    await waitUntil(() => fs.existsSync(ready));
    expect(verifyPiBashGroup(procfs)).toMatchObject({ ok: false, reason: 'leader_without_marker' });
    const kill = vi.fn();
    const result = signalPiBashGroup(group, 'SIGKILL', { ...hidden(), kill });
    expect(result.verification.reason).toBe(reason);
    expect(result.sent).toBe(reason === 'leader_verified');
    controller.abort();
    expect(await outcome).toMatchObject({ error: expect.stringContaining('aborted') });
  });

  // R12-D (Sonnet S2-NN on real shells): two shells of one bridge, the same command, the same
  // parent. Had B the PID of A in the same second, A's record would name B; B's label is its own.
  it('tells two shells of one bridge with the same command apart by their labels', async () => {
    const command = 'sleep 30; true';
    const pi = await startBridge(baseConfig(), { host: hidden() });
    const controller = new AbortController();
    const calls = ['a', 'b'].map(async (id) => {
      const execute = await approvedBash(pi, id, command);
      return execute(id, { command }, controller.signal, undefined, undefined).catch(String);
    });
    await waitUntil(
      () => registryEvents().filter((line) => line.event === 'lstart' && line.cmd).length === 2
    );
    const a = groupOf('a');
    const b = groupOf('b');
    expect(a.label).not.toBe(b.label);
    expect(a.args).not.toBe(b.args);
    // A's record, as if B had got A's PID in the same second (the rest of A's record unchanged).
    const reused = { ...a, pid: b.pid, pgid: b.pgid, lstart: b.lstart };
    const kill = vi.fn();
    expect(signalPiBashGroup(reused, 'SIGKILL', { ...hidden(), kill })).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_command_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
    expect(verifyPiBashGroup(b, hidden())).toMatchObject({ ok: true, reason: 'leader_verified' });
    controller.abort();
    await Promise.all(calls);
  });

  it('labels a shell that reads its command from stdin (-s), and verifies it through ps', async () => {
    const sdk: PiBridgeSdk = {
      ...stubSdk,
      getShellConfig: () => ({ shell: '/bin/bash', args: ['-s'], commandTransport: 'stdin' }),
    };
    const pi = await startBridge(baseConfig(), { sdk, host: hidden() });
    const execute = await approvedBash(pi, 'stdin-1', 'sleep 30; true');
    const controller = new AbortController();
    const call = execute(
      'stdin-1',
      { command: 'sleep 30; true' },
      controller.signal,
      undefined,
      undefined
    ).catch(String);
    await waitUntil(() => lstartOf()?.cmd !== undefined);
    const group = groupOf('stdin-1');
    expect(group.args).toBe(piBashArgsFingerprint(['/bin/bash', '-s', String(group.label)]));
    expect(readPiPsCommand(group.pid).args).toBe(`/bin/bash -s ${String(group.label)}`);
    expect(verifyPiBashGroup(group, hidden())).toMatchObject({
      ok: true,
      reason: 'leader_verified',
    });
    controller.abort();
    expect(await call).toContain('aborted');
  });

  it('gives no label to a shell whose arguments are not -c or -s last: ps never verifies it', async () => {
    const sdk: PiBridgeSdk = {
      ...stubSdk,
      getShellConfig: () => ({ shell: '/bin/bash', args: ['--norc'], commandTransport: 'stdin' }),
    };
    const pi = await startBridge(baseConfig(), { sdk, host: hidden() });
    const execute = await approvedBash(pi, 'nolabel', 'sleep 30; true');
    const controller = new AbortController();
    const call = execute(
      'nolabel',
      { command: 'sleep 30; true' },
      controller.signal,
      undefined,
      undefined
    ).catch(String);
    await waitUntil(() => lstartOf() !== undefined);
    expect(registryEvents()[0]).not.toHaveProperty('label');
    expect(lstartOf()).not.toHaveProperty('cmd');
    const kill = vi.fn();
    expect(signalPiBashGroup(groupOf('nolabel'), 'SIGKILL', { ...hidden(), kill })).toMatchObject({
      sent: false,
      verification: { reason: 'leader_command_mismatch' },
    });
    controller.abort();
    expect(await call).toContain('aborted');
  });

  // R12-C (Codex A05) and the read of the command line: only rows in range, of the shell with its
  // label, are recorded; the starts alone are recorded when only the command line read fails.
  const D = 'Wed Nov  4 09:10:58 2026';
  const P = 'Wed Nov  4 09:00:00 2026';
  /**
   * A fake `ps` as `startsPs` above: `rows` for the read of the starts (`$shell`, `$own` set),
   * `args` for the read of the command line; by default the shell's real command line after `D`.
   */
  const fake = (
    rows: string,
    args = `echo "$shell $own ${D} $(ps -ww -o args= -p "$shell")"`
  ): { ps: string; done: string } => {
    const ps = path.join(dir, `r3-ps-${Math.random().toString(36).slice(2)}`);
    const done = `${ps}.done`;
    fs.writeFileSync(
      ps,
      `#!/bin/sh\nshell=\${5%%,*}\nown=$PPID\ncase "$3" in *args*) ${args}; exit 0;; esac\nown=\${5#*,}\n${rows}\ntouch '${done}'\n`,
      { mode: 0o700 }
    );
    return { ps, done };
  };
  it.each([
    [
      'A05: a parent beyond pid_t',
      `echo "$shell $own $shell ${D}"; echo "$own 9999999999 $own ${P}"`,
    ],
    ['a group beyond pid_t', `echo "$shell $own $shell ${D}"; echo "$own 1 9999999999 ${P}"`],
    ['a shell group beyond pid_t', `echo "$shell $own 9999999999 ${D}"; echo "$own 1 $own ${P}"`],
    ['a pid beyond pid_t', `echo "$shell $own $shell ${D}"; echo "9999999999 1 1 ${P}"`],
    ['a signed id', `echo "$shell $own $shell ${D}"; echo "+$own 1 $own ${P}"`],
  ])('R12-C: records nothing from a row out of range: %s', async (_name, rows) => {
    const { ps, done } = fake(rows);
    const { controller, outcome } = await running('sleep 30; true', 'r12c', {
      procRoot: path.join(dir, 'no-proc'),
      ps,
    });
    await waitUntil(() => fs.existsSync(done));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lstartOf()).toBeUndefined();
    controller.abort();
    await outcome;
  });

  it.each([
    ['without the label', `echo "$shell $own ${D} /bin/bash -c sleep 30; true"`],
    ['of another parent', `echo "$shell 1 ${D} $(ps -ww -o args= -p "$shell")"`],
    ['with another start', `echo "$shell $own ${P} $(ps -ww -o args= -p "$shell")"`],
    ['that fails', 'exit 1'],
    ['out of range', `echo "$shell 9999999999 ${D} $(ps -ww -o args= -p "$shell")"`],
  ])('records the starts without the command line when its read is %s', async (_name, args) => {
    const rows = `echo "$shell $own $shell ${D}"; echo "$own 1 $own ${P}"`;
    const { ps } = fake(rows, args);
    const { controller, outcome } = await running('sleep 30; true', 'cmd', {
      procRoot: path.join(dir, 'no-proc'),
      ps,
    });
    await waitUntil(() => lstartOf() !== undefined);
    expect(lstartOf()).toMatchObject({ lstart: 'Wed Nov 4 09:10:58 2026' });
    expect(lstartOf()).not.toHaveProperty('cmd');
    controller.abort();
    await outcome;
  });

  // D-18 point 2 (R12-D): `exit` is in the registry when the shell is reaped, before anything of
  // the call's end runs (here: synchronously within the `exit` event).
  it('writes exit in the handler of the shell’s exit, before the call ends', async () => {
    const childProcess = process.getBuiltinModule('node:child_process');
    const ops = await bridgeOperations();
    const child = fakeChild(4_194_302);
    vi.spyOn(childProcess, 'spawn').mockReturnValue(child as never);
    try {
      const call = ops.exec('true', dir, { onData: () => {} });
      await waitUntil(() => registryEvents().some((entry) => entry.event === 'spawn'));
      child.exitCode = 0;
      child.emit('exit', 0, null);
      // No `await` in between: written by the handler itself.
      expect(registryEvents().map((entry) => entry.event)).toEqual(['intent', 'spawn', 'exit']);
      expect(registryEvents()[2]).toMatchObject({ code: 0, signal: null, pid: 4_194_302 });
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);
      await expect(call).resolves.toEqual({ exitCode: 0 });
      expect(registryEvents().filter((entry) => entry.event === 'exit')).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Codex P01–P06: ordinary commands on the `ps` path, then the bridge's own abort.
  it.each([
    ['P01', 'sleep 30', 'leader_command_mismatch'],
    ['P02', 'true; sleep 30', 'leader_command_mismatch'],
    ['P03', 'sleep 30; true', 'leader_verified'],
    ['P04', 'sleep 30 | cat', 'leader_verified'],
    ['P05', 'sleep 30 & wait', 'leader_verified'],
  ])('%s: %s through ps, then the abort stops it', async (_id, command, reason) => {
    const { controller, outcome } = await running(command, 'p');
    await waitUntil(() => lstartOf() !== undefined);
    const group = groupOf('p');
    const procfs = { ...group, starttime: readPiProcStat(group.pid)?.starttime ?? null };
    expect(verifyPiBashGroup(procfs).ok).toBe(true);
    await waitUntil(() => verifyPiBashGroup(group, hidden()).reason === reason);
    controller.abort();
    expect(await outcome).toMatchObject({ error: expect.stringContaining('aborted') });
    await waitUntil(() => !alive(group.pid));
    expect(verifyPiBashGroup(groupOf('p'), hidden()).reason).toBe('group_empty');
  });

  it('P06: a job the shell left in its group stays unverifiable through ps', async () => {
    const command = 'sleep 30 & exit 0';
    const pi = await startBridge(baseConfig(), { host: hidden() });
    const execute = await approvedBash(pi, 'p6', command);
    await execute('p6', { command }, undefined, undefined, undefined);
    const group = groupOf('p6');
    try {
      expect(group.shellExited).toBe(true);
      expect(verifyPiBashGroup(group).ok).toBe(true);
      expect(verifyPiBashGroup(group, hidden())).toMatchObject({ reason: 'members_unverifiable' });
    } finally {
      // The test's own decoy (the `ps` path leaves it, and the cleanup after each test reads procfs
      // with the start time this record does not have).
      process.kill(-group.pgid, 'SIGKILL');
    }
  });

  // Codex C12: a `ps` that does not end never outlives the call, whatever ends it.
  it.each(['abort', 'timeout', 'normal'] as const)(
    'C12 (%s): a slow ps ends with the call and records nothing',
    async (mode) => {
      const pidFile = path.join(dir, 'ps.pid');
      const ps = path.join(dir, 'slow-ps');
      fs.writeFileSync(ps, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o700 });
      const begin = Date.now();
      const { controller, outcome } = await running(
        mode === 'normal' ? 'sleep 0.15' : 'sleep 30',
        'c12',
        { procRoot: path.join(dir, 'no-proc'), ps },
        mode === 'timeout' ? { timeout: 0.15 } : {}
      );
      await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '');
      const psPid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (mode === 'abort') controller.abort();
      await outcome;
      await waitUntil(() => !alive(psPid));
      expect(Date.now() - begin).toBeLessThan(2000);
      expect(lstartOf()).toBeUndefined();
    }
  );
});

// R7-C (brief 2.2): the decisions of every place that reads processes, for one table of roots:
// the bridge (where it records a shell's start), the checks of `./pi-bash.ts`, the adapter and the
// conversation store. Each is seen from outside where it can be: a `ps` first on PATH (or the one
// given) notes when it runs; the bridge's decision is the one its rule answered it (a spy on the
// rule it is given), and its `ps` running or not. Every place must decide as `piProcSource` does.
describe('joint round 3: one decision of where processes are read, in every place (R7-C)', () => {
  const realPs = spawnSyncText('/bin/sh', ['-c', 'command -v ps']).trim();
  let bin: string;
  let ran: string;
  beforeEach(() => {
    bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    ran = path.join(dir, 'ps-ran');
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\ntouch '${ran}'\nexec '${realPs}' "$@"\n`, {
      mode: 0o700,
    });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  /** What a place did: ran `ps`, refused (no source), or read procfs. */
  const observed = (ranPs: boolean, none: boolean) => (ranPs ? 'ps' : none ? 'none' : 'procfs');
  const fresh = () => fs.rmSync(ran, { force: true });

  const roots: Array<[string, () => string]> = [
    ['absent', () => path.join(dir, 'no-proc')],
    [
      'empty',
      () => {
        const root = path.join(dir, 'empty-root');
        fs.mkdirSync(root);
        return root;
      },
    ],
    [
      'only self',
      () => {
        const root = path.join(dir, 'self-root');
        fs.mkdirSync(root);
        fs.symlinkSync('/proc/self', path.join(root, 'self'));
        return root;
      },
    ],
    [
      'no self, with a pid',
      () => {
        const root = path.join(dir, 'pid-root');
        fs.mkdirSync(root);
        fs.symlinkSync(`/proc/${process.pid}`, path.join(root, String(process.pid)));
        return root;
      },
    ],
    ['the system root', () => '/proc'],
  ];
  const cases = roots.flatMap(([name, make]) =>
    [false, true].map(
      (psGiven) => [`${name}, ${psGiven ? 'ps given' : 'no ps'}`, make, psGiven] as const
    )
  );

  it.each(cases)('%s', async (_name, make, psGiven) => {
    const root = make();
    const options = { procRoot: root, ...(psGiven ? { ps: path.join(bin, 'ps') } : {}) };
    const expected = piProcSource(root, psGiven, (r) => fs.readdirSync(r)).source;
    // A shell that is gone, recorded with its label (the adapter and the checks look for it).
    const gone = spawnSyncPid('/bin/true');
    const record = {
      v: 1,
      instance: 'cmp',
      toolCallId: 'gone',
      run: 1,
      marker: 'cmp:gone',
      label: 'a'.repeat(32),
    };
    const reg = path.join(dir, 'cmp.jsonl');
    fs.writeFileSync(
      reg,
      `${JSON.stringify({ ...record, event: 'intent' })}\n${JSON.stringify({ ...record, event: 'spawn', pid: gone, pgid: gone, starttime: null, label: record.label })}\n`
    );
    const decisions: Record<string, string> = {};

    // The checks of `./pi-bash.ts`.
    fresh();
    const [group] = readPiBashRegistry(reg).groups;
    if (!group) throw new Error('no group');
    const verification = verifyPiBashGroup(group, options);
    decisions.checks = observed(
      fs.existsSync(ran),
      !verification.ok &&
        verification.reason === 'inspection_failed' &&
        verification.error === 'no_source'
    );

    // The adapter.
    fresh();
    const cleanup = await killPiBashGroups(reg, () => true, { ...options, timeoutMs: 0 });
    decisions.adapter = observed(
      fs.existsSync(ran),
      cleanup.unconfirmed.some((line) => /process table could not be read/.test(line))
    );

    // The store.
    fresh();
    let none = false;
    try {
      piConversationStore({ ...options, procSource: piProcSource }).processStart(process.pid);
    } catch (error) {
      none = /no source/.test(String(error));
    }
    decisions.store = observed(fs.existsSync(ran), none);

    // The bridge: the decision its rule gave it, and whether it ran `ps` for the shell's start.
    fresh();
    const answers: string[] = [];
    const spy = (...args: Parameters<typeof piProcSource>) => {
      const answer = piProcSource(...args);
      answers.push(answer.source);
      return answer;
    };
    const pi = await startBridge(baseConfig(), {
      host: { ...options, procSource: spy } as { procRoot?: string; ps?: string },
    });
    const execute = await approvedBash(pi, 'cmp-shell', 'sleep 0.3; true');
    await execute('cmp-shell', { command: 'sleep 0.3; true' }, undefined, undefined, undefined);
    expect(answers).toHaveLength(1);
    decisions.bridge = answers[0] as string;
    expect(fs.existsSync(ran)).toBe(answers[0] === 'ps');

    expect(decisions).toEqual({
      checks: expected,
      adapter: expected,
      store: expected,
      bridge: expected,
    });
  });
});

function spawnSyncText(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' });
}
function spawnSyncPid(command: string): number {
  const child = process.getBuiltinModule('node:child_process').spawnSync(command);
  return child.pid as number;
}

/** Globals the bridge may read: JavaScript built-ins and `process`. */
const BRIDGE_GLOBALS = [
  'Array',
  'Date',
  'Error',
  'JSON',
  'Map',
  'Number',
  'Object',
  'Promise',
  'Reflect',
  'Set',
  'String',
  'clearTimeout',
  'globalThis',
  'process',
  'setTimeout',
  'undefined',
];

describe('self-contained source (SC2, E11-06)', () => {
  it('finds outside identifiers (the check has teeth)', () => {
    const outside = 1;
    const leaky = function leaky(a: number) {
      const { b = outside } = { b: a };
      return [b, PI_BRIDGE_CONFIG_ENV, (() => missingGlobal)()];
    };
    expect(outside).toBe(1);
    const free = freeIdentifiers(leaky.toString());
    expect(free).toEqual(expect.arrayContaining(['missingGlobal', 'outside']));
    // A module import shows up under its own name or as the test runner's rewrite of it.
    expect(free.some((name) => /^(PI_BRIDGE_CONFIG_ENV|__vite_ssr_import_\d+__)$/.test(name))).toBe(
      true
    );
    expect(
      freeIdentifiers(
        'function f(a, { b }, ...c) { try { return a + b + c } catch (e) { return e } }'
      )
    ).toEqual([]);
  });

  it('the bridge function reads nothing from outside its body but built-ins', () => {
    const free = freeIdentifiers(piBridge.toString());
    expect(free.filter((name) => !BRIDGE_GLOBALS.includes(name))).toEqual([]);
  });

  // R7-C: the rule of where processes are read travels in the generated module as its own source.
  it('the rule of where processes are read reads nothing from outside its body but built-ins', () => {
    const free = freeIdentifiers(piProcSource.toString());
    expect(free.filter((name) => !BRIDGE_GLOBALS.includes(name))).toEqual([]);
  });

  it('the generated module is valid and imports only the Pi SDK and node:util, statically', () => {
    const source = bridgeSource();
    expect(() => parseAst(source)).not.toThrow();
    // Pi 1.4.0 maps the SDK for static imports only (stage 2 probe, phase b).
    expect(source).toContain("import * as piSdk from '@earendil-works/pi-coding-agent';");
    // `isProxy` is taken when the module loads, before any later extension runs (R2-B).
    expect(source).toContain("import { types as nodeUtilTypes } from 'node:util';");
    expect(source).toContain(
      'piBridge(pi, { importPi: async () => piSdk, isProxy, procSource: piProcSource });'
    );
    // R7-C: the very function `pi-bash.ts` decides with, not a copy of it.
    expect(source).toContain(`const piProcSource = ${piProcSource.toString()};`);
    expect(source).not.toMatch(/__vite|__vi_/);
    expect(source.match(/\bimport\b/g)).toHaveLength(2);
  });
});

declare const missingGlobal: unknown;

const STUB_PI_SDK = `
import { spawn } from 'node:child_process';
export function getShellConfig() { return { shell: '/bin/bash', args: ['-c'] }; }
export function createBashToolDefinition(cwd, options = {}) {
  return {
    name: 'bash', label: 'bash', description: 'stub', parameters: { type: 'object' },
    async execute(id, params, signal) {
      if (!options.operations) throw new Error('stub: built-in bash must not run');
      const chunks = [];
      const r = await options.operations.exec(params.command, cwd, { onData: (d) => chunks.push(d), signal, env: process.env });
      return { output: Buffer.concat(chunks).toString(), exitCode: r.exitCode };
    },
  };
}
`;

const DRIVER = `
const summary = { handlers: [], commands: [], tools: [], mcp: [], notify: [], confirm: [], results: {} };
const handlers = new Map();
const pi = {
  on(event, handler) { summary.handlers.push(event); handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  registerCommand(name, options) { summary.commands.push(name); handlers.set('cmd:' + name, [options.handler]); },
  registerTool(tool) { summary.tools.push(tool.name); handlers.set('tool:' + tool.name, [tool]); },
  registerMcpServer(name, config) { summary.mcp.push([name, config]); },
  getAllTools() {
    return [
      { name: 'mcp__s__t', namespace: { name: 'mcp__s', aliases: ['s'] }, sourceInfo: { path: 'builtin:mcp' } },
      ...summary.tools.map((name) => ({ name, sourceInfo: { path: process.argv[2] } })),
    ];
  },
  getCommands() { return summary.commands.map((name) => ({ name, source: 'extension', sourceInfo: { path: process.argv[2] } })); },
};
const answers = { bash: true, mcp: false, other: undefined, thrower: 'throw' };
const ctx = (key) => ({
  signal: new AbortController().signal,
  cwd: process.cwd(),
  ui: {
    notify: (m) => summary.notify.push(m),
    confirm: async (title, message) => {
      summary.confirm.push([title, JSON.parse(message)]);
      if (answers[key] === 'throw') throw new Error('x');
      return answers[key];
    },
  },
});
const emit = async (event, payload, key) => {
  let r;
  for (const h of handlers.get(event) ?? []) { r = await h(payload, ctx(key)); if (r?.block) return r; }
  return r;
};
const { default: factory } = await import(process.argv[2]);
await factory(pi);
await emit('session_start', {}, 'bash');
await emit('before_agent_start', {}, 'bash');
summary.results.bash = await emit('tool_call', { toolName: 'bash', toolCallId: 'b1', input: { command: 'echo fresh' } }, 'bash') ?? null;
summary.results.mcp = await emit('tool_call', { toolName: 'mcp__s__t', toolCallId: 'm1', input: { q: 1 } }, 'mcp') ?? null;
summary.results.other = await emit('tool_call', { toolName: 'read', toolCallId: 'o1', input: {} }, 'other') ?? null;
summary.results.thrower = await emit('tool_call', { toolName: 'write', toolCallId: 'w1', input: {} }, 'thrower') ?? null;
const bash = handlers.get('tool:bash')?.[0];
if (bash) summary.results.exec = await bash.execute('b1', { command: 'echo fresh' }, undefined, undefined, ctx('bash'));
for (const name of summary.commands) summary.results['cmd:' + name] = (await handlers.get('cmd:' + name)[0]('', {})) ?? null;
process.stdout.write(JSON.stringify(summary));
`;

function runFresh(configFile: string | undefined) {
  const root = path.join(dir, 'fresh');
  const sdkDir = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(
    path.join(sdkDir, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      type: 'module',
      exports: './index.js',
    })
  );
  fs.writeFileSync(path.join(sdkDir, 'index.js'), STUB_PI_SDK);
  const bridgeFile = path.join(root, 'bridge-test.mjs');
  fs.writeFileSync(bridgeFile, bridgeSource());
  const driver = path.join(dir, 'driver.mjs');
  fs.writeFileSync(driver, DRIVER);
  const out = execFileSync(process.execPath, [driver, bridgeFile], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(configFile === undefined ? {} : { [PI_BRIDGE_CONFIG_ENV]: configFile }),
    },
    encoding: 'utf8',
  });
  return JSON.parse(out) as {
    handlers: string[];
    commands: string[];
    tools: string[];
    mcp: Array<[string, PiMcpServerConfig]>;
    notify: string[];
    confirm: Array<[string, PiBridgeConfirmMessage]>;
    results: Record<string, unknown>;
  };
}

describe('generated module in a fresh node (SC2, E10-17, E11-06)', () => {
  it('imports, runs the factory and every handler', () => {
    const config = writeConfig(
      baseConfig({
        mcpServers: {
          s: { transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: { a: '!x' } },
        },
      })
    );
    const summary = runFresh(config);
    expect(fs.existsSync(config)).toBe(false);
    expect(summary.handlers).toEqual(['tool_call', 'session_start', 'before_agent_start']);
    expect(summary.commands).toEqual([piBridgeHandshakeCommand(NONCE)]);
    expect(summary.tools).toEqual(['bash']);
    expect(summary.mcp).toEqual([
      [
        's',
        { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { a: '$!x' }, exposure: 'direct' },
      ],
    ]);
    expect(summary.notify).toEqual([piBridgeRunTag(NONCE, 1)]);
    expect(summary.confirm.map(([title]) => title)).toEqual(
      Array(4).fill(piBridgeRunTag(NONCE, 1))
    );
    expect(summary.confirm[1]?.[1]).toMatchObject({
      toolCallId: 'm1',
      server: { namespace: 'mcp__s', aliases: ['s'], sourcePath: 'builtin:mcp' },
      input: { q: 1 },
    });
    expect(summary.results).toEqual({
      bash: null,
      mcp: { block: true, reason: 'switch: not approved' },
      other: { block: true, reason: 'switch: not approved' },
      thrower: { block: true, reason: 'switch: approval failed' },
      exec: { output: 'fresh\n', exitCode: 0 },
      [`cmd:${piBridgeHandshakeCommand(NONCE)}`]: null,
    });
    expect(readPiBashRegistry(registry).groups).toEqual([
      expect.objectContaining({ toolCallId: 'b1', run: 1, shellExited: true }),
    ]);
  });

  it('blocks everything with an unreadable config', () => {
    const summary = runFresh(path.join(dir, 'absent.json'));
    expect(summary.commands).toEqual([]);
    expect(summary.tools).toEqual([]);
    expect(summary.notify).toEqual([`${PI_BRIDGE_ERROR_NOTICE}config_unreadable`]);
    expect(summary.confirm).toEqual([]);
    for (const key of ['bash', 'mcp', 'other', 'thrower']) {
      expect(summary.results[key]).toEqual({
        block: true,
        reason: 'switch: bridge unavailable (config_unreadable)',
      });
    }
  });

  it('does nothing without the variable', () => {
    const summary = runFresh(undefined);
    expect(summary).toMatchObject({ handlers: [], commands: [], tools: [], mcp: [] });
    expect(summary.results).toMatchObject({ bash: null, mcp: null, other: null, thrower: null });
  });
});
