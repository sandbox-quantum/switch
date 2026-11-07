/**
 * The Pi extension ("bridge") Switch loads with `-e <file>` into every `pi --mode rpc` session.
 *
 * Pi runs the bridge from a file the adapter writes next to its state; the shared host reaches
 * the machine that runs it as a single bundle, so a separate `dist/pi/*.mjs` would not travel
 * with it. The bridge is therefore one self-contained function, `piBridge`, serialized with
 * `fn.toString()` (precedent: `readHostSessions` in `../host/session-list.ts`). It must not use
 * anything from outside its own body: Node modules come from `process.getBuiltinModule`, and the
 * Pi SDK (for the `bash` tool definition) arrives through `host.importPi`, which the generated
 * module wires to its static import of `@earendil-works/pi-coding-agent`. `bridge.test.ts` checks
 * the function body for outside identifiers.
 *
 * What the bridge does (READY §2, `ready_errata.md` ER-02, ER-04, ER-05, ER-06):
 * - reads its config from the file named by `SWITCH_PI_BRIDGE`, then removes the file and the
 *   variable. Without the variable it does nothing. With the variable set and a config it cannot
 *   use, it blocks every tool call and never answers the handshake.
 * - registers the handshake command `switch-hello-<nonce>` (the adapter looks for it in
 *   `get_commands` before the first `prompt`).
 * - announces each Pi run in `before_agent_start` with `notify("switch:<nonce>:run:<n>")`.
 * - asks the adapter about every tool call with `ctx.ui.confirm` (tag `switch:<nonce>:run:<n>`,
 *   the full call in the message, `signal: ctx.signal`) and lets the call through only on an
 *   explicit `true`. The adapter loads the bridge first (`-e <bridge> -e builtin:mcp`, decision
 *   D-4 A), so its `tool_call` handler is the first to touch the input Pi executes. It rejects
 *   anything that is not plain data (also any `Proxy`), deep-freezes that original object before
 *   the dialog and checks it again after: a later handler can neither change it nor, by replacing
 *   `event.input`, change what Pi runs (Pi executes its own reference). The bridge's own `bash`
 *   also compares the parameters it is given with the approved snapshot before it starts anything.
 * - registers the session's MCP servers (stdio and HTTP) with `exposure: "direct"`, escaping
 *   `env` and `headers` values so Pi's resolver passes them through literally.
 * - replaces Pi's `bash` tool with the same definition running on its own `BashOperations`. Each
 *   shell starts in its own process group, which is written to the process registry file when it
 *   is created (`toolCallId` → group). `./pi-bash.ts` reads that file and signals the groups; the
 *   stop policy belongs to the adapter.
 *
 * Threat model (decision D-7 A). The only extensions in the Pi process are the bridge and
 * `builtin:mcp`. The adapter enforces this (stage 5): `-ne`, an explicit `-e` list, the bridge
 * first. Any other extension in the process is a known limit. Code in the same process can, in
 * principle, get around every check made in that process, so the checks below are defensive. They
 * detect early that the model's assumption broke. They are not a security boundary:
 * - before asking about `bash` and again after the approval, the active `bash` tool must be the
 *   bridge's own. The bridge compares the `sourceInfo.path` of `bash` in `getAllTools()` with the
 *   `sourceInfo.path` of its own handshake command in `getCommands()` (R3-B);
 * - before asking about any call and again after the approval, JSON serialization must be the one
 *   the bridge took at load. That is `globalThis.JSON` and `JSON.stringify` unchanged, no `toJSON`
 *   on `Object.prototype` or `Array.prototype`, and `Array.prototype` still inheriting from
 *   `Object.prototype`. Pi's MCP transports send the approved input through
 *   `JSON.stringify(message)`, and plain data reaches no other prototype (R3-C);
 * - Pi 1.4.0 gives an extension no list of the loaded extensions or of their `tool_call` handlers.
 *   The bridge cannot check that it is first or alone, so that is the adapter's to enforce (R3-A).
 */

import type { ChildProcess } from 'node:child_process';
import { piProcSource } from './pi-bash';

/** Version of the config file the adapter writes and the bridge reads. */
export const PI_BRIDGE_PROTOCOL_VERSION = 1;
/** Environment variable that names the config file. */
export const PI_BRIDGE_CONFIG_ENV = 'SWITCH_PI_BRIDGE';

/** MCP server as the adapter passes it in the config (the shape of `McpServerSpec`). */
export type PiBridgeMcpServer =
  | {
      transport: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
      envVars?: string[];
    }
  | { transport: 'http'; url: string; headers?: Record<string, string> };

/** The config file, written 0600 by the adapter and removed by the bridge after reading. */
export interface PiBridgeConfig {
  protocolVersion: typeof PI_BRIDGE_PROTOCOL_VERSION;
  /** Session nonce: 16–128 characters of `[A-Za-z0-9_-]`. */
  nonce: string;
  mcpServers: Record<string, PiBridgeMcpServer>;
  /** Absolute path of the process registry file (JSON lines, see `./pi-bash.ts`). */
  processRegistry: string;
  /** Absolute path of the shell for `bash`; Pi's default resolution when absent. */
  shellPath?: string;
}

/** Owner of an MCP tool as Pi reports it (`namespace` of the tool in `getAllTools()`). */
export interface PiBridgeToolServer {
  namespace: string;
  aliases: string[];
  /** `sourceInfo.path` of the tool, `builtin:mcp` for MCP tools. */
  sourcePath: string | null;
}

/** JSON in the `message` of every `confirm` the bridge sends. */
export interface PiBridgeConfirmMessage {
  protocolVersion: typeof PI_BRIDGE_PROTOCOL_VERSION;
  nonce: string;
  run: number;
  toolCallId: string;
  parentToolCallId: string | null;
  toolName: string;
  server: PiBridgeToolServer | null;
  /** The full tool input; only the adapter may shorten it for display. */
  input: unknown;
}

/** Name of the handshake command for a nonce. */
export function piBridgeHandshakeCommand(nonce: string): string {
  return `switch-hello-${nonce}`;
}

/** Tag of a run: the `notify` message at its start and the `confirm` title of its tool calls. */
export function piBridgeRunTag(nonce: string, run: number): string {
  return `switch:${nonce}:run:${run}`;
}

/** Prefix of the `notify` the bridge sends at session start when its config is unusable. */
export const PI_BRIDGE_ERROR_NOTICE = 'switch:bridge:error:';

/** Why a bridge blocks everything (sent after `PI_BRIDGE_ERROR_NOTICE`). */
export type PiBridgeFailure =
  | 'config_unreadable'
  | 'config_not_removed'
  | 'config_invalid'
  | 'pi_sdk_unavailable'
  | 'setup_failed';

// The parts of Pi's extension API the bridge uses (`dist/core/extensions/types.d.ts` in Pi 1.4.0).

export interface PiBridgeContext {
  ui: {
    confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<unknown>;
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
  signal?: AbortSignal;
  cwd?: string;
}

export interface PiBridgeToolCallEvent {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: unknown;
}

export interface PiBridgeBlock {
  block: true;
  reason: string;
}

export interface PiBridgeBashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }
  ): Promise<{ exitCode: number | null }>;
}

export interface PiBridgeToolDefinition {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: PiBridgeContext | undefined
  ): Promise<unknown>;
  [key: string]: unknown;
}

/** The parts of `@earendil-works/pi-coding-agent` the bridge uses. */
export interface PiBridgeSdk {
  createBashToolDefinition(
    cwd: string,
    options?: { operations?: PiBridgeBashOperations }
  ): PiBridgeToolDefinition;
  getShellConfig?(shellPath?: string): {
    shell: string;
    args: string[];
    commandTransport?: 'stdin';
  };
}

export type PiMcpServerConfig =
  | {
      type: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
      exposure: 'direct';
    }
  | { type: 'http'; url: string; headers?: Record<string, string>; exposure: 'direct' };

export interface PiBridgeApi {
  on(event: 'session_start', handler: (event: unknown, ctx: PiBridgeContext) => unknown): unknown;
  on(
    event: 'before_agent_start',
    handler: (event: unknown, ctx: PiBridgeContext) => unknown
  ): unknown;
  on(
    event: 'tool_call',
    handler: (
      event: PiBridgeToolCallEvent,
      ctx: PiBridgeContext
    ) => Promise<PiBridgeBlock | undefined>
  ): unknown;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }
  ): void;
  registerTool(tool: PiBridgeToolDefinition): void;
  registerMcpServer(name: string, config: PiMcpServerConfig): void;
  getAllTools(): Array<{
    name: string;
    namespace?: { name: string; aliases?: readonly string[] };
    sourceInfo?: { path?: string };
  }>;
  /** Slash commands; `name` is the invocation name (`<name>:<n>` when several share a name). */
  getCommands(): Array<{ name: string; source?: string; sourceInfo?: { path?: string } }>;
}

/** What the generated module passes next to Pi's API. */
export interface PiBridgeHost {
  importPi?: () => Promise<PiBridgeSdk>;
  /** `types.isProxy` of `node:util`, imported statically by the generated module. */
  isProxy?: (value: unknown) => boolean;
  /** Root of procfs for the shells' start times; `/proc` by default (tests hide it, D-15). */
  procRoot?: string;
  /** `ps` command for the shells' start times where there is no procfs; `ps` by default. */
  ps?: string;
  /**
   * R7-C: the one rule of where processes are read, `piProcSource` of `./pi-bash.ts` (the generated
   * module defines it from that very function's source and passes it). Without it the bridge
   * records no start time: a group it cannot record is never verified, so nothing is sent to it.
   */
  procSource?: (
    root: string,
    psGiven: boolean,
    list: (root: string) => string[]
  ) => { source: 'procfs' | 'ps' | 'none' };
}

/**
 * The bridge. Self-contained: see the module comment. Pi calls the generated default export with
 * its API; that export calls this with `host.importPi` set.
 */
export async function piBridge(pi: PiBridgeApi, host: PiBridgeHost = {}): Promise<void> {
  // The built-ins the input checks rely on, taken before any other extension's code runs (the
  // bridge loads first): a later extension that replaces them does not change these.
  const { freeze, isFrozen, getOwnPropertyDescriptor, getPrototypeOf } = Object;
  const ownKeys = Reflect.ownKeys;
  const isArray = Array.isArray;
  const globalObject = globalThis;
  const jsonObject = JSON;
  const stringify = JSON.stringify;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;
  const isProxy = host.isProxy ?? process.getBuiltinModule('node:util').types.isProxy;
  const CONFIG_ENV = 'SWITCH_PI_BRIDGE';
  const MARKER_ENV = 'SWITCH_PI_TC';
  // How long a timed-out or aborted call waits for the shell's `exit` after SIGKILL was sent to its
  // group (R6-A). A killed process normally exits within milliseconds; one that does not (e.g.
  // stuck in uninterruptible I/O) must not hold the call. Ten times the 100 ms the pipes get to
  // fall idle after `exit` (`waitForChild`), and short next to any deadline the caller sets.
  const KILL_CONFIRM_MS = 1_000;
  const configPath = process.env[CONFIG_ENV];
  // Not started by Switch: the bridge stays out of the way.
  if (configPath === undefined) return;
  // Shells and MCP servers inherit Pi's environment; none of them needs to find the config.
  delete process.env[CONFIG_ENV];

  const fs = process.getBuiltinModule('node:fs');
  const nodePath = process.getBuiltinModule('node:path');
  const childProcess = process.getBuiltinModule('node:child_process');
  const os = process.getBuiltinModule('node:os');
  const crypto = process.getBuiltinModule('node:crypto');
  const { Buffer } = process.getBuiltinModule('node:buffer');

  let failure: string | undefined;
  const fail = (code: string) => {
    if (failure === undefined) failure = code;
  };
  // Every tool call goes through this handler, also when the config is unusable. Pi runs tool_call
  // handlers in load order and stops at the first block; the bridge loads first, so a later
  // handler may still block a call the bridge let through, but cannot change it.
  const block = (reason: string): PiBridgeBlock => ({ block: true, reason: `switch: ${reason}` });

  // 1. Config: read once, remove at once. The file holds header and env values; error messages
  // never quote it.
  let raw: string | undefined;
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('not a config file');
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    fail('config_unreadable');
  }
  try {
    fs.rmSync(configPath, { force: true });
  } catch {
    fail('config_not_removed');
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const isStringRecord = (value: unknown): value is Record<string, string> =>
    isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

  let nonce = '';
  let registryPath = '';
  let shellPath: string | undefined;
  const servers: Array<[string, PiMcpServerConfig]> = [];
  // Pi resolves `$NAME`, `${NAME}` and a leading `!command` in MCP `env` and `headers` values;
  // `$$` stands for `$` and `$!` for `!` (Pi 1.4.0 `core/resolve-config-value.js`).
  const escapeValue = (value: string) => {
    const doubled = value.replace(/\$/g, () => '$$');
    return doubled.startsWith('!') ? `$${doubled}` : doubled;
  };
  const escapeValues = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, escapeValue(value)]));

  if (failure === undefined && raw !== undefined) {
    const text = raw;
    const config: unknown = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    })();
    const valid =
      isRecord(config) &&
      config.protocolVersion === 1 &&
      typeof config.nonce === 'string' &&
      /^[A-Za-z0-9_-]{16,128}$/.test(config.nonce) &&
      typeof config.processRegistry === 'string' &&
      nodePath.isAbsolute(config.processRegistry) &&
      (config.shellPath === undefined ||
        (typeof config.shellPath === 'string' && nodePath.isAbsolute(config.shellPath))) &&
      isRecord(config.mcpServers);
    if (valid) {
      nonce = config.nonce as string;
      registryPath = config.processRegistry as string;
      shellPath = config.shellPath as string | undefined;
      // Server names: Pi's grammar (`SERVER_NAME` in Pi 1.4.0 `core/mcp-servers.js`), plus the
      // limits that keep tool owners unambiguous (ER-05): Pi names tools
      // `mcp__<name with - as _>__<tool>`, so no name may contain `__` once `-` becomes `_`, no
      // two names may share that form, and no form may start with another one followed by `_`.
      const namespaces = Object.keys(config.mcpServers as Record<string, unknown>).map((name) =>
        name.replace(/-/g, '_')
      );
      const nameOk = (name: string) => {
        const own = name.replace(/-/g, '_');
        return (
          /^[A-Za-z0-9_-]+$/.test(name) &&
          !own.includes('__') &&
          namespaces.filter((other) => other === own).length === 1 &&
          !namespaces.some((other) => own.startsWith(`${other}_`))
        );
      };
      for (const [name, spec] of Object.entries(config.mcpServers as Record<string, unknown>)) {
        if (!nameOk(name) || !isRecord(spec)) {
          fail('config_invalid');
        } else if (
          spec.transport === 'stdio' &&
          typeof spec.command === 'string' &&
          spec.command !== '' &&
          isStringArray(spec.args) &&
          (spec.env === undefined || isStringRecord(spec.env)) &&
          (spec.envVars === undefined || isStringArray(spec.envVars))
        ) {
          // `envVars` names variables to pass through; Pi's stdio servers inherit its environment.
          servers.push([
            name,
            {
              type: 'stdio',
              command: spec.command,
              args: [...spec.args],
              ...(spec.env ? { env: escapeValues(spec.env) } : {}),
              exposure: 'direct',
            },
          ]);
        } else if (
          spec.transport === 'http' &&
          typeof spec.url === 'string' &&
          spec.url !== '' &&
          (spec.headers === undefined || isStringRecord(spec.headers))
        ) {
          servers.push([
            name,
            {
              type: 'http',
              url: spec.url,
              ...(spec.headers ? { headers: escapeValues(spec.headers) } : {}),
              exposure: 'direct',
            },
          ]);
        } else {
          fail('config_invalid');
        }
      }
    } else {
      fail('config_invalid');
    }
  }

  // 2. The Pi SDK, for the definition of the `bash` tool.
  let sdk: PiBridgeSdk | undefined;
  if (failure === undefined) {
    try {
      sdk = host.importPi ? await host.importPi() : undefined;
    } catch {
      sdk = undefined;
    }
    if (!sdk || typeof sdk.createBashToolDefinition !== 'function') fail('pi_sdk_unavailable');
  }

  let run = 0;
  /** Approved `bash` calls waiting for `execute`: toolCallId → run and approved input. */
  const approvedBash = new Map<string, { run: number; snapshot: string }>();
  /**
   * Every `bash` toolCallId this bridge has been asked about. The process registry keys groups by
   * instance and toolCallId, so a second shell under the same id would hide the first one's group
   * from the adapter: a reused id is refused before anything starts (R2-D).
   */
  const bashCallIds = new Set<string>();

  /**
   * The input as JSON text, read only through property descriptors, so no getter or `toJSON` runs.
   * Throws unless the input is plain JSON data: no `Proxy` anywhere (checked before anything else
   * is read from the object), every own key a string, enumerable and a data property; objects with
   * `Object.prototype` or `null` as prototype, arrays with `Array.prototype`, dense, without extra
   * keys; values JSON can carry unchanged. Anything else (a proxy, an accessor, an inherited or
   * hidden field, a function, a cycle) could make Pi read something other than what the dialog
   * showed.
   */
  const plainJson = (root: unknown): string => {
    const ancestors = new Set<object>();
    const write = (value: unknown): string => {
      if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return stringify(value);
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('number');
        return stringify(value);
      }
      if (typeof value !== 'object') throw new Error('value');
      // Before any other read: every operation on a proxy may run its traps.
      if (isProxy(value)) throw new Error('proxy');
      if (ancestors.has(value)) throw new Error('cycle');
      ancestors.add(value);
      const valueIsArray = isArray(value);
      const prototype = getPrototypeOf(value);
      if (
        valueIsArray
          ? prototype !== arrayPrototype
          : prototype !== objectPrototype && prototype !== null
      ) {
        throw new Error('prototype');
      }
      const keys = ownKeys(value);
      const items: string[] = [];
      let length = 0;
      if (valueIsArray) {
        const descriptor = getOwnPropertyDescriptor(value, 'length');
        if (!descriptor || !('value' in descriptor)) throw new Error('length');
        length = Number(descriptor.value);
        if (keys.length !== length + 1) throw new Error('array keys');
      }
      for (const key of keys) {
        if (valueIsArray && key === 'length') continue;
        if (typeof key !== 'string') throw new Error('symbol key');
        const descriptor = getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new Error('not a data field');
        }
        if (valueIsArray) {
          if (key !== String(items.length) || items.length >= length) throw new Error('index');
          items.push(write(descriptor.value));
        } else {
          items.push(`${stringify(key)}:${write(descriptor.value)}`);
        }
      }
      ancestors.delete(value);
      return valueIsArray ? `[${items.join(',')}]` : `{${items.join(',')}}`;
    };
    return write(root);
  };
  /** `plainJson`, or `undefined` for input that is not plain data. */
  const plainJsonOrNothing = (value: unknown): string | undefined => {
    try {
      return plainJson(value);
    } catch {
      return undefined;
    }
  };
  /** Freezes plain data (checked by `plainJson`) deeply; false if any object stays unfrozen. */
  const deepFreeze = (root: unknown): boolean => {
    const seen = new Set<object>();
    const pending: unknown[] = [root];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== 'object' || value === null || seen.has(value)) continue;
      seen.add(value);
      freeze(value);
      if (!isFrozen(value)) return false;
      for (const key of ownKeys(value)) {
        const descriptor = getOwnPropertyDescriptor(value, key);
        if (descriptor && 'value' in descriptor) pending.push(descriptor.value);
      }
    }
    return true;
  };

  // Defensive checks (D-7 A, see the module comment): they detect a broken threat model early,
  // they cannot stop code in the same process.
  /**
   * Whether `JSON.stringify` still serializes plain data the way the bridge checked it. The bridge
   * reads the global, the function and the prototypes through descriptors only, so no getter runs.
   * Pi's MCP transports call `JSON.stringify(message)` on a message that holds the approved
   * input. That reaches `toJSON` on `Object.prototype` and on `Array.prototype` and its own
   * prototype, and nothing else for plain data (R3-C).
   */
  const serializationIntact = (): boolean => {
    try {
      const json = getOwnPropertyDescriptor(globalObject, 'JSON');
      if (!json || !('value' in json) || json.value !== jsonObject) return false;
      const method = getOwnPropertyDescriptor(jsonObject, 'stringify');
      if (!method || !('value' in method) || method.value !== stringify) return false;
      if (getPrototypeOf(arrayPrototype) !== objectPrototype) return false;
      return [objectPrototype, arrayPrototype].every(
        (prototype) => getOwnPropertyDescriptor(prototype, 'toJSON') === undefined
      );
    } catch {
      return false;
    }
  };
  /**
   * Whether the `bash` tool Pi runs is the bridge's own: its `sourceInfo.path` is the one Pi gave
   * the bridge's handshake command, which only this bridge registers. Pi sets both from the
   * extension that registered them (Pi 1.4.0 `core/extensions/loader.js`, `registerTool` and
   * `registerCommand`). A second command of that name changes the invocation names, so the check
   * fails then too (R3-B).
   */
  const bashIsOwn = (): boolean => {
    try {
      const own = pi.getCommands().filter((command) => command.name === `switch-hello-${nonce}`);
      const tools = pi.getAllTools().filter((tool) => tool.name === 'bash');
      if (own.length !== 1 || tools.length !== 1) return false;
      const ownPath = own[0]?.sourceInfo?.path;
      return (
        typeof ownPath === 'string' && ownPath !== '' && tools[0]?.sourceInfo?.path === ownPath
      );
    } catch {
      return false;
    }
  };
  /** Why the process breaks the threat model for this call, if it does. */
  const brokenAssumption = (toolName: string): string | undefined => {
    if (!serializationIntact()) {
      return 'JSON serialization was changed in this process (toJSON or JSON.stringify)';
    }
    if (toolName === 'bash' && !bashIsOwn()) return "the active bash tool is not the bridge's own";
    return undefined;
  };

  pi.on('tool_call', async (event, ctx) => {
    if (failure !== undefined) return block(`bridge unavailable (${failure})`);
    const myRun = run;
    const toolCallId = String(event.toolCallId);
    if (event.toolName === 'bash') {
      if (bashCallIds.has(toolCallId)) return block('tool call id reused');
      bashCallIds.add(toolCallId);
    }
    // Pi executes this very object (`args` in `_beforeToolCall`), so the bridge keeps its reference
    // rather than reading `event.input` again. The bridge is the first handler to see it: it checks
    // it, then freezes it before anything else (the dialog, a later handler) can run.
    const input = event.input;
    const snapshot = plainJsonOrNothing(input);
    if (typeof snapshot !== 'string') return block('tool input cannot be checked');
    try {
      if (!deepFreeze(input)) return block('tool input cannot be frozen');
    } catch {
      return block('tool input cannot be frozen');
    }
    // Frozen, the input is fixed data; this check, made through the descriptors, covers what Pi
    // will read.
    const unchanged = () => plainJsonOrNothing(input) === snapshot;
    if (!unchanged()) return block('tool input changed while it was frozen');
    let server: PiBridgeToolServer | null = null;
    // Fields the tool requires; they must be the input's own, never inherited.
    const required: string[] = event.toolName === 'bash' ? ['command'] : [];
    const declared: string[] = [];
    try {
      const info = pi.getAllTools().find((tool) => tool.name === event.toolName);
      if (info?.namespace) {
        server = {
          namespace: String(info.namespace.name),
          aliases: [...(info.namespace.aliases ?? [])].map(String),
          sourcePath: info.sourceInfo?.path === undefined ? null : String(info.sourceInfo.path),
        };
      }
      const schema = (info as { parameters?: { required?: unknown; properties?: unknown } })
        ?.parameters;
      if (Array.isArray(schema?.required)) required.push(...schema.required.map(String));
      if (typeof schema?.properties === 'object' && schema.properties !== null) {
        declared.push(...Object.keys(schema.properties));
      }
    } catch {
      server = null;
    }
    try {
      const own = (key: string) => getOwnPropertyDescriptor(input, key) !== undefined;
      if (typeof input !== 'object' || input === null || isArray(input)) {
        return block('tool input is not an object');
      }
      if (required.some((key) => !own(key))) return block('tool input lacks a required field');
      // A field the tool declares but the input does not hold must not be inherited either.
      const prototype = getPrototypeOf(input);
      if (
        prototype !== null &&
        declared.some((key) => !own(key) && getOwnPropertyDescriptor(prototype, key))
      ) {
        return block('tool input inherits a field');
      }
    } catch {
      return block('tool input cannot be checked');
    }
    const broken = brokenAssumption(String(event.toolName));
    if (broken !== undefined) return block(broken);
    const message: PiBridgeConfirmMessage = {
      protocolVersion: 1,
      nonce,
      run: myRun,
      toolCallId,
      parentToolCallId:
        event.parentToolCallId === undefined ? null : String(event.parentToolCallId),
      toolName: String(event.toolName),
      server,
      input: JSON.parse(snapshot),
    };
    let answer: unknown;
    try {
      answer = await ctx.ui.confirm(`switch:${nonce}:run:${myRun}`, stringify(message), {
        signal: ctx.signal,
      });
    } catch {
      return block('approval failed');
    }
    if (answer !== true) return block('not approved');
    if (!unchanged()) return block('tool input changed during approval');
    // The dialog awaited: other code may have run meanwhile.
    const brokenAfter = brokenAssumption(String(event.toolName));
    if (brokenAfter !== undefined) return block(brokenAfter);
    if (event.toolName === 'bash') approvedBash.set(toolCallId, { run: myRun, snapshot });
    return undefined;
  });

  pi.on('session_start', (_event, ctx) => {
    if (failure !== undefined) ctx.ui.notify(`switch:bridge:error:${failure}`, 'error');
  });

  if (failure !== undefined || !sdk) return;
  const piSdk = sdk;

  // 3. Own `bash`: Pi's definition, executed by the bridge's operations.
  const instance = crypto.randomUUID();
  /**
   * Appends one record, all of its bytes or an error (R5-A): `writeSync` may write fewer bytes
   * than asked, so the rest is written until the line is complete, and a write that makes no
   * progress throws. A record that throws is a failed record, whatever part of it reached the file
   * (the parser counts such a line as invalid).
   */
  const record = (entry: Record<string, unknown>) => {
    const line = Buffer.from(
      `${JSON.stringify({ v: 1, t: Date.now(), instance, ...entry })}\n`,
      'utf8'
    );
    const fd = fs.openSync(registryPath, 'a', 0o600);
    try {
      let offset = 0;
      while (offset < line.length) {
        const written = fs.writeSync(fd, line, offset, line.length - offset);
        if (!Number.isInteger(written) || written <= 0) {
          throw new Error(
            `switch: process registry write made no progress (${offset} of ${line.length} bytes)`
          );
        }
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const procRoot = host.procRoot ?? '/proc';
  const psCommand = host.ps ?? 'ps';
  const procSource = host.procSource;
  /**
   * Where the shell's start is read (R11-C, R7-C): `piProcSource` of `./pi-bash.ts`, the rule the
   * check uses, passed in by the generated module (the bridge cannot import it, see the module
   * comment), so the record and the check read the same source. `none` (no rule, or no source the
   * rule trusts): no start is recorded, and the group is never verified.
   */
  const processView = (): 'procfs' | 'ps' | 'none' => {
    if (typeof procSource !== 'function') return 'none';
    try {
      return procSource(procRoot, host.ps !== undefined, (root) => fs.readdirSync(root)).source;
    } catch {
      return 'none';
    }
  };
  const startTime = (pid: number) => {
    try {
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    } catch {
      return null;
    }
  };
  /**
   * `piBashArgsFingerprint` of `./pi-bash.ts` (R11-A): SHA-256 of the ASCII letters and digits of
   * the command line the shell is spawned with.
   */
  const argsFingerprint = (argv: readonly string[]) =>
    crypto
      .createHash('sha256')
      .update(argv.join(' ').replace(/[^A-Za-z0-9]/g, ''))
      .digest('hex');
  // `lstart` as `ps` prints it with `LC_ALL=C`, collapsed (R11-B): anything else is no start.
  const LSTART =
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;
  /** R12-C: a decimal id in `min…max` (`pid_t`: 2147483647), as `ps` prints it; else `undefined`. */
  const boundedId = (text: string, min: number): number | undefined => {
    if (!/^\d{1,10}$/.test(text)) return undefined;
    const value = Number(text);
    return value >= min && value <= 2_147_483_647 ? value : undefined;
  };
  /**
   * D-18: `piBashPsArgsDigest` of `./pi-bash.ts`: SHA-256 (hex) of a command line exactly as
   * `ps -o args=` printed it.
   */
  const psArgsDigest = (args: string) =>
    crypto.createHash('sha256').update(args, 'utf8').digest('hex');
  /** Runs `ps` with `args` like `./pi-bash.ts` does; `done` gets its output, or null when it failed. */
  const runPsAsync = (args: string[], done: (stdout: string | null) => void): (() => void) => {
    let ps: ChildProcess;
    try {
      ps = childProcess.spawn(psCommand, args, {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      done(null);
      return () => {};
    }
    let settled = false;
    const settle = (stdout: string | null) => {
      if (settled) return;
      settled = true;
      done(stdout);
    };
    const stop = () => {
      if (ps.exitCode === null && ps.signalCode === null) ps.kill('SIGKILL');
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let broken = false;
    ps.once('error', () => settle(null));
    ps.stdout?.on('error', () => {
      broken = true;
    });
    ps.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      chunks.push(chunk);
      if (size > 65_536) {
        broken = true;
        stop();
      }
    });
    ps.once('close', (code) => {
      // Decoded whole, as `./pi-bash.ts` decodes `spawnSync`'s output (`utf8`).
      settle(broken || code !== 0 ? null : Buffer.concat(chunks).toString('utf8'));
    });
    return stop;
  };
  /**
   * The rows of `ps -o pid=,ppid=,pgid=,lstart=` for the shell and this process, when they are
   * exactly those two, whole, in range (R12-C: every number an id that fits `pid_t`, before the row
   * is used) and in `ps`'s format (R11-B), the shell leading its own group as this process's child.
   */
  const parseStarts = (pid: number, text: string) => {
    const rows = new Map<number, { ppid: number; pgid: number; lstart: string }>();
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const row = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S.*)$/.exec(line);
      if (!row) return undefined;
      const seen = boundedId(row[1] as string, 1);
      const ppid = boundedId(row[2] as string, 0);
      const pgid = boundedId(row[3] as string, 0);
      const lstart = (row[4] as string).trim().replace(/\s+/g, ' ');
      if (seen === undefined || ppid === undefined || pgid === undefined) return undefined;
      if (!LSTART.test(lstart) || rows.has(seen)) return undefined;
      rows.set(seen, { ppid, pgid, lstart });
    }
    const shellRow = rows.get(pid);
    const ownRow = rows.get(process.pid);
    if (rows.size !== 2 || !shellRow || !ownRow) return undefined;
    if (shellRow.ppid !== process.pid || shellRow.pgid !== pid) return undefined;
    return { lstart: shellRow.lstart, plstart: ownRow.lstart };
  };
  /**
   * D-18: the digest of the shell's command line as `ps -o pid=,ppid=,lstart=,args= -p <shell>`
   * prints it, read the way `readPiPsCommand` of `./pi-bash.ts` reads it, when that is the shell
   * (PID, this process as its parent, its start) and carries its label as a word; else
   * `undefined` (the `ps` path then refuses the leader).
   */
  const argsOf = (pid: number, lstart: string, label: string | undefined, text: string) => {
    if (label === undefined) return undefined;
    const [first = '', ...rest] = text.replace(/\n$/, '').split('\n');
    const row = /^\s*(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s(.*))?$/.exec(first);
    if (!row) return undefined;
    const seen = boundedId(row[1] as string, 1);
    const ppid = boundedId(row[2] as string, 0);
    const start = (row[3] as string).trim().replace(/\s+/g, ' ');
    if (seen !== pid || ppid !== process.pid || !LSTART.test(start) || start !== lstart) {
      return undefined;
    }
    const args = [row[4] ?? '', ...rest].join('\n');
    return args.split(/\s+/).includes(label) ? psArgsDigest(args) : undefined;
  };
  /**
   * Without procfs (macOS, D-15): the starts of the shell and of this process (its parent) as
   * `ps -o lstart=` prints them, with the environment `./pi-bash.ts` reads them with (`LC_ALL=C`,
   * `TZ=UTC`, `-ww`), whitespace collapsed; then (D-18) the shell's command line. Asynchronous
   * (R11-D): the call's timeout and abort hold meanwhile, and the returned function ends `ps` (the
   * call ended; both reads have 5 s at most). `found` gets the starts only when `ps` succeeded and
   * printed exactly the two rows (`parseStarts`), and the digest of the command line (`argsOf`) only
   * when that read too showed the shell with its label; otherwise nothing, or the starts alone, is
   * recorded: the group's leader cannot be verified, and nothing is sent to it.
   */
  const readStarts = (
    pid: number,
    label: string | undefined,
    found: (lstart: string, plstart: string, cmd: string | undefined) => void
  ) => {
    let ended = false;
    let stop = () => {};
    const end = () => {
      ended = true;
      clearTimeout(limit);
      stop();
    };
    const limit = setTimeout(end, 5_000);
    stop = runPsAsync(
      ['-ww', '-o', 'pid=,ppid=,pgid=,lstart=', '-p', `${pid},${process.pid}`],
      (text) => {
        const starts = ended || text === null ? undefined : parseStarts(pid, text);
        if (!starts) {
          clearTimeout(limit);
          return;
        }
        stop = runPsAsync(['-ww', '-o', 'pid=,ppid=,lstart=,args=', '-p', String(pid)], (args) => {
          clearTimeout(limit);
          if (ended) return;
          found(
            starts.lstart,
            starts.plstart,
            args === null ? undefined : argsOf(pid, starts.lstart, label, args)
          );
        });
      }
    );
    return end;
  };
  /**
   * Sends SIGKILL to the shell's group, and only the group: never the bare PID, which another
   * process may hold by now. Returns the `code` of the error when the signal could not be sent; the
   * group's state is then unknown and the registry says so (ER-06). A sent signal does not confirm
   * that the group is gone (`kill(2)` succeeds once any member got it, R5-B): only `exit` of the
   * shell, or the adapter checking the group, says that.
   *
   * `ESRCH` is the exception among the errors (R7-C): `kill(2)` on a group returns it only when no
   * process, not even a zombie, is left in the group, and the shell leads its group (`detached`:
   * its own session, so it cannot leave the group). So the shell was already reaped and nothing is
   * left: the group is gone, its state is known. `./pi-bash.ts` reads `ESRCH` the same way (`isGone`).
   */
  const killGroup = (pid: number): string | undefined => {
    try {
      process.kill(-pid, 'SIGKILL');
      return undefined;
    } catch (error) {
      return String((error as { code?: unknown }).code ?? 'unknown');
    }
  };
  /** What a `killGroup` result says about the group, for messages. */
  const groupAfterKill = (error: string | undefined) =>
    error === undefined
      ? 'its process group: SIGKILL sent; termination not confirmed'
      : error === 'ESRCH'
        ? 'its process group no longer exists (ESRCH)'
        : `its process group could not be stopped (${error}); the state of its process group is unknown`;
  /**
   * Like Pi's `waitForChildProcess`: ends on `close`, or once the pipes fall idle after `exit`.
   * `onEnd` receives a function that ends the wait at once (the call's deadline after `exit`).
   */
  const waitForChild = (child: ChildProcess, onEnd: (end: () => void) => void) =>
    new Promise<number | null>((resolve, reject) => {
      let settled = false;
      let exited = false;
      let exitCode: number | null = null;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let stdoutEnded = child.stdout === null;
      let stderrEnded = child.stderr === null;
      const finish = (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        if (idle) clearTimeout(idle);
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (error) reject(error);
        else resolve(code);
      };
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => finish(exitCode), 100);
      };
      const afterExit = () => {
        if (exited && stdoutEnded && stderrEnded) finish(exitCode);
      };
      child.stdout?.on('data', () => exited && arm());
      child.stderr?.on('data', () => exited && arm());
      child.stdout?.once('end', () => {
        stdoutEnded = true;
        afterExit();
      });
      child.stderr?.once('end', () => {
        stderrEnded = true;
        afterExit();
      });
      child.once('error', (error) => finish(null, error));
      child.once('exit', (code) => {
        exited = true;
        exitCode = code;
        afterExit();
        if (!settled) arm();
      });
      child.once('close', (code) => finish(code));
      onEnd(() => finish(exitCode));
    });

  const operations = (toolCallId: string, callRun: number): PiBridgeBashOperations => ({
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error('aborted');
      let timeoutMs: number | undefined;
      if (timeout !== undefined) {
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new Error('Invalid timeout: must be a finite number of seconds');
        }
        timeoutMs = timeout * 1000;
        if (timeoutMs > 2_147_483_647) {
          throw new Error(`Invalid timeout: maximum is ${2_147_483_647 / 1000} seconds`);
        }
      }
      try {
        await fs.promises.access(cwd);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      // Cancelled while waiting: nothing has started yet, so nothing starts. From here to `spawn`
      // the code is synchronous.
      if (signal?.aborted) throw new Error('aborted');
      const shell = piSdk.getShellConfig
        ? piSdk.getShellConfig(shellPath)
        : { shell: shellPath ?? '/bin/bash', args: ['-c'] };
      const viaStdin = shell.commandTransport === 'stdin';
      const marker = `${instance}:${toolCallId}`;
      const childEnv: NodeJS.ProcessEnv = { ...(env ?? process.env), [MARKER_ENV]: marker };
      delete childEnv[CONFIG_ENV];
      // D-18: a label of this shell's own (128 random bits, hex) in its command line, where `ps`
      // shows it for as long as the shell runs; the environment, which carries the marker, is
      // not shown by `ps`. It is a positional parameter the command does not run: with `-c`
      // after the command, as `$1`, with `$0` the shell's path as before (so messages read as
      // before); with `-s` (command on stdin) as `$1`. A shell started another way gets none (its
      // arguments may not be positional parameters): the `ps` path then never verifies it.
      const last = shell.args[shell.args.length - 1];
      const label =
        last === (viaStdin ? '-s' : '-c') ? crypto.randomBytes(16).toString('hex') : undefined;
      const labelArgs = label === undefined ? [] : viaStdin ? [label] : [shell.shell, label];
      // The label is in the registry before the shell, so before anything of the command runs.
      record({
        event: 'intent',
        toolCallId,
        run: callRun,
        marker,
        ...(label === undefined ? {} : { label }),
      });
      const argv = viaStdin
        ? [...shell.args, ...labelArgs]
        : [...shell.args, command, ...labelArgs];
      // R11-C: one choice of source per shell, by the rule the check uses.
      const view = processView();
      const child = childProcess.spawn(shell.shell, argv, {
        cwd,
        detached: true,
        env: childEnv,
        stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          record({
            event: 'spawn',
            toolCallId,
            run: callRun,
            marker,
            pid,
            pgid: pid,
            // Without procfs the start follows in an `lstart` record (`readStarts` below).
            starttime: view === 'procfs' ? startTime(pid) : null,
            // R11-A: the shell's parent (this process) and its command line, for the `ps` path.
            ppid: process.pid,
            args: argsFingerprint([shell.shell, ...argv]),
            ...(label === undefined ? {} : { label }),
          });
        } catch {
          // The shell is running but the adapter cannot see its group (R4-A). The bridge sends
          // SIGKILL to its group and closes the pipes; the error says what is known, and a sent
          // signal is not a confirmed end (R5-B). With the command passed as an argument the shell
          // may already have run it. With stdin transport the command has not been written yet
          // (that happens below) and never is: closing stdin gives the shell EOF.
          const error = killGroup(pid);
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          const group = groupAfterKill(error);
          throw new Error(
            viaStdin
              ? `switch: process registry unavailable, command not run; ${group}`
              : `switch: process registry unavailable after the shell started, the command may have run; ${group}`
          );
        }
        // R12-D (D-18): `exit` is recorded as the shell is reaped, in the handler of its `exit`,
        // synchronously, before anything of the call's end awaits: from here its PID may be another
        // process's, and the checks honour `exit` (`./pi-bash.ts`). A failed record leaves the
        // group as running; the label still tells it from any other shell.
        child.once('exit', (code, signalCode) => {
          try {
            record({ event: 'exit', toolCallId, pid, code, signal: signalCode });
          } catch {
            // the group stays in the registry as running; the adapter checks it
          }
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Ends the `ps` of `readStarts`, if one runs (D-15).
      let stopStarts = () => {};
      // Once the shell has exited its PID may be reused, so the bridge sends it nothing more. The
      // call's deadline still holds: an abort or a timeout after `exit` ends the wait for the pipes
      // at once (a process left in the group may keep them open), and so does `exit` after an abort
      // or a timeout. What is left of the group is the adapter's, through the registry and
      // `./pi-bash.ts`.
      let exited = false;
      let endWait = () => {};
      // The first of the ends the shell did not choose: the timeout, an abort, or a failed pipe or
      // output callback (R7-A). Only the first counts (R7-C): it alone signals the group, writes the
      // one `kill` record and decides the call's error; later ones change nothing. `why` goes to
      // the registry, `text` to messages.
      let trigger: { why: string; text: string } | undefined;
      // The result of the call's one `killGroup`, when it was sent: `undefined` = signal sent.
      // `ESRCH` = the group no longer exists (see `killGroup`). Any other code (R3-D): the shell may
      // live on and keep its pipes open, so the call ends at once with an error; the registry
      // holds the failed `kill`, no `exit`, and for the adapter the group's state is unknown.
      let killed: { error: string | undefined } | undefined;
      // Set when the shell's `exit` did not follow the `kill` within `KILL_CONFIRM_MS` (R6-A): the
      // call ends with an error, and the registry holds the `kill`, no `exit`.
      let unconfirmed = false;
      let confirmTimer: ReturnType<typeof setTimeout> | undefined;
      // A failed pipe or output callback: no more output goes to `onData` (R7-A).
      let channelFailed = false;
      const end = (why: string, text: string) => {
        if (trigger !== undefined) return;
        trigger = { why, text };
        if (exited) {
          endWait();
          return;
        }
        // The shell is gone and its `exit` is on its way: the handler below ends the wait.
        if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        const error = killGroup(pid);
        killed = { error };
        try {
          record({
            event: 'kill',
            toolCallId,
            pid,
            why,
            sent: error === undefined,
            ...(error === undefined ? {} : { error }),
          });
        } catch {
          // the kill matters more than its record
        }
        if (error !== undefined && error !== 'ESRCH') {
          endWait();
          return;
        }
        // `exit` within the limit ends the wait as before (the handler below). After `ESRCH` the
        // shell was already reaped, so its `exit` is due at once.
        confirmTimer = setTimeout(() => {
          if (!exited) unconfirmed = true;
          endWait();
        }, KILL_CONFIRM_MS);
      };
      const describe = (error: unknown) => {
        try {
          const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
          return String(code ?? message ?? error);
        } catch {
          return 'unknown';
        }
      };
      const channelError = (why: string, text: string) => {
        channelFailed = true;
        end(why, text);
      };
      const waiting = waitForChild(child, (finish) => {
        endWait = finish;
      });
      const onAbort = () => end('abort', 'abort');
      // A failed write of the command (R7-A; R9-A, D-11 A). EPIPE means the reading end of the pipe
      // is closed: by the command itself (`exec 0<&-`) or because the shell has ended. bash runs
      // only the lines it has read, so what runs is what the command chose, as with any `bash -s`.
      // Pi ignores the error and returns the shell's result (`PKG/dist/core/tools/bash.js:70-72`),
      // and so does the bridge for EPIPE, whether the shell has exited or lives on: the result is
      // the shell's own, and a shell that hangs is ended only by the timeout or an abort. Any
      // other error (EBADF, EIO, an unknown code) may mean the command did not reach the shell as
      // approved: the call ends under control like on any failed pipe, through `end` (the group is
      // signalled, one `kill` record, R6-A's limit for its `exit`).
      const stdinError = (error: unknown) => {
        let code: unknown;
        try {
          code = (error as { code?: unknown } | null | undefined)?.code;
        } catch {
          code = undefined;
        }
        if (code === 'EPIPE') return;
        channelError('stdin_error', `stdin failed (${describe(error)})`);
      };
      child.once('exit', () => {
        exited = true;
        if (trigger !== undefined) endWait();
      });
      // An exception from `onData` or an `error` on a pipe would otherwise escape the call (an
      // uncaught exception or an unhandled `error` event in Pi's process) and leave the group
      // running. Both end the call like an abort, through `end` (R7-A).
      const forward = (data: Buffer) => {
        if (channelFailed) return;
        try {
          onData(data);
        } catch (error) {
          channelError('output_callback_error', `output callback failed (${describe(error)})`);
        }
      };
      child.stdout?.on('error', (error) =>
        channelError('stdout_error', `stdout failed (${describe(error)})`)
      );
      child.stderr?.on('error', (error) =>
        channelError('stderr_error', `stderr failed (${describe(error)})`)
      );
      try {
        if (viaStdin) {
          // Decided by `stdinError`: EPIPE is ignored, any other error is a failed pipe.
          child.stdin?.on('error', stdinError);
          child.stdin?.end(command);
        }
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => end('timeout', 'timeout'), timeoutMs);
        }
        child.stdout?.on('data', forward);
        child.stderr?.on('data', forward);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        // D-15: without procfs the starts come from `ps`, read while the call's deadline and abort
        // hold (R11-D). Recorded only while the shell is not reaped: until its parent (this
        // process) reaps it, no other process can have its PID, and libuv reaps a child only after
        // the processes that ended with it, so the row `ps` printed was the shell's (R11-A).
        if (view === 'ps' && pid !== undefined && trigger === undefined) {
          stopStarts = readStarts(pid, label, (lstart, plstart, cmd) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            try {
              record({
                event: 'lstart',
                toolCallId,
                pid,
                lstart,
                plstart,
                ...(cmd === undefined ? {} : { cmd }),
              });
            } catch {
              // No start recorded: the group cannot be verified without procfs, nothing is sent.
            }
          });
        }
        const exitCode = await waiting;
        if (trigger !== undefined && killed !== undefined) {
          if (killed.error !== undefined && killed.error !== 'ESRCH') {
            throw new Error(
              `switch: ${trigger.text}, but the command could not be stopped (${killed.error}); the state of its process group is unknown`
            );
          }
          if (unconfirmed) {
            throw new Error(`switch: ${trigger.text}; ${groupAfterKill(killed.error)}`);
          }
        }
        // The shell's `exit` was recorded when it was reaped (above, R12-D).
        if (trigger?.why === 'abort') throw new Error('aborted');
        if (trigger?.why === 'timeout') throw new Error(`timeout:${timeout}`);
        if (trigger !== undefined) throw new Error(`switch: ${trigger.text}`);
        if (signal?.aborted) throw new Error('aborted');
        const signalCode = child.signalCode;
        return {
          exitCode:
            exitCode ??
            (signalCode
              ? 128 + ((os.constants.signals as Record<string, number>)[signalCode] ?? 0)
              : 1),
        };
      } finally {
        if (timer) clearTimeout(timer);
        if (confirmTimer) clearTimeout(confirmTimer);
        signal?.removeEventListener('abort', onAbort);
        stopStarts();
      }
    },
  });

  try {
    const base = piSdk.createBashToolDefinition(process.cwd());
    pi.registerTool({
      ...base,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const approved = approvedBash.get(String(toolCallId));
        // Only calls this bridge approved run, whatever reaches `execute`.
        if (approved === undefined) throw new Error('switch: bash call was not approved');
        approvedBash.delete(String(toolCallId));
        // And only with the input that was approved: Pi passes the object the bridge froze, so
        // anything else here is not the approved call.
        if (plainJsonOrNothing(params) !== approved.snapshot) {
          throw new Error('switch: bash input differs from the approved one, command not run');
        }
        const definition = piSdk.createBashToolDefinition(ctx?.cwd || process.cwd(), {
          operations: operations(String(toolCallId), approved.run),
        });
        return definition.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    });

    // 4. The session's MCP servers.
    for (const [name, config] of servers) pi.registerMcpServer(name, config);
  } catch {
    fail('setup_failed');
    return;
  }

  // 5. Runs and the handshake, last: the adapter sends no prompt before it sees the handshake.
  pi.on('before_agent_start', (_event, ctx) => {
    run += 1;
    ctx.ui.notify(`switch:${nonce}:run:${run}`, 'info');
  });
  pi.registerCommand(`switch-hello-${nonce}`, {
    description: 'Switch bridge handshake (protocol 1)',
    handler: async () => {},
  });
}

/**
 * Source of the bridge module Pi loads with `-e`. Pi's extension loader (jiti) maps
 * `@earendil-works/pi-coding-agent` to Pi's own SDK for static imports only: in Pi 1.4.0 a dynamic
 * `import()` of it from an extension fails with "Cannot find package" (stage 2 probe, phase b). So
 * the generated module imports it statically and hands it to `piBridge`. If the import fails, Pi
 * does not load the bridge at all, the handshake never appears and the adapter sends no prompt.
 * `isProxy` comes the same way, taken when the module loads. R7-C: `procSource`, the rule of where
 * processes are read, is `piProcSource` of `./pi-bash.ts`, defined from that function's own source
 * (it is self-contained like the bridge), so the bridge decides as the checks do.
 *
 * The adapter must load this module first: `-e <bridge> -e builtin:mcp` (decision D-4 A; this
 * replaces the order of ER-04). With `-ne`, and with no other extension (D-7 A): the bridge cannot
 * see which extensions Pi loaded, so this list is the adapter's to enforce and to test.
 */
export function bridgeSource(): string {
  return [
    '// Generated by Switch (@switch-console/agent-providers, src/pi/bridge.ts). Do not edit.',
    "import * as piSdk from '@earendil-works/pi-coding-agent';",
    "import { types as nodeUtilTypes } from 'node:util';",
    'const isProxy = nodeUtilTypes.isProxy;',
    `const piProcSource = ${piProcSource.toString()};`,
    `const piBridge = ${piBridge.toString()};`,
    'export default function switchPiBridge(pi) {',
    '  return piBridge(pi, { importPi: async () => piSdk, isProxy, procSource: piProcSource });',
    '}',
    '',
  ].join('\n');
}
