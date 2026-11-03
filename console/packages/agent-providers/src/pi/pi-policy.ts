import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeMode } from '../adapter';
import type { ApprovalOption, RequestType } from '../events';
import { mcpApprovalContent, toolInputDetail } from '../mcp-approval';
import type { PiBridgeToolServer } from './bridge';

/**
 * The approval policy for a Pi session: what the adapter answers when the bridge asks about a
 * tool call (`confirm`, `./bridge.ts`). The bridge only carries the question; every decision is
 * made here, in the adapter's process.
 *
 * Rules, in order (READY §2.2 with `ready_errata.md` ER-03 and ER-05):
 * 1. The request belongs to the current process generation and run, else `cancelled` without a
 *    card. That needs the adapter's state (generations, the announced run, the active turn) and
 *    is checked by the adapter before it calls {@link decidePiToolCall}.
 * 2. A tool of an MCP server the session auto-approves (`mcpServers` minus `connectorMcpServers`,
 *    as `AP/acp/acp-adapter.ts:192-195`) is allowed in every mode, but only when its owner is
 *    established (ER-05): the bridge reports Pi's own `namespace` of the tool, the tool comes
 *    from `builtin:mcp`, its one alias is a server of this session and the namespace and the name
 *    are the ones Pi derives from that alias (Pi 1.4.0 `extensions/mcp/index.js:287-316`,
 *    `core/mcp-servers.js:50-52`, `extensions/mcp/tools.js:45-51`). Nothing about the owner is
 *    taken from the tool's name alone, from `readOnlyHint` or from what the model wrote.
 * 3. `full-access` allows everything.
 * 4. Pi's built-in reads (`read`, `grep`, `find`, `ls`) are allowed (the compromise named in
 *    the PR).
 * 5. `auto-accept-edits` allows Pi's built-in `edit` and `write` only inside the path boundary
 *    (ER-03): the target, resolved the way Pi resolves it (`core/tools/path-utils.js:42-44`,
 *    `utils/paths.js:59-87`) and then through `realpath` of the target or of its nearest existing
 *    parent, lies inside the session's `cwd` (also through `realpath`) and not under Switch's
 *    state (`~/.local/state/switch/**` of the session's `HOME` and of the host's, plus any
 *    `protectedRoots`). Anything that cannot be resolved is outside.
 * 6. Everything else gets a card. `auto` asks like `approval-required`: Pi has no automatic
 *    review (READY §2.2 rule 6).
 *
 * A tool whose owner cannot be established is asked about like a connector's (ER-05). The MCP
 * resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) serve
 * every server with resources, so they never take a server's auto-approval: they follow rules 3
 * and 6, and the card names the connector the call reaches (`input.server` as Pi reads it,
 * {@link piResourceServer}, or, when the call names no server, the session's first connector)
 * (ER-05; R1B-09 in `02_claude_first_pass.md:55`).
 *
 * What is resolved here is a snapshot: the file system can change between this decision and Pi's
 * write (a symlink swapped in afterwards). Rule 5 narrows `auto-accept-edits`; it is not a
 * sandbox.
 */

/** Pi's built-in tools that only read (rule 4). */
export const PI_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'find', 'ls']);
/** Pi's built-in tools that write a file named by `input.path` (rule 5). */
export const PI_FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(['edit', 'write']);
/** Pi's built-in shell tool (the bridge replaces it with its own definition of the same name). */
export const PI_COMMAND_TOOL = 'bash';
/** The MCP resource tools of `builtin:mcp` (Pi 1.4.0 `core/mcp-servers.js:25-27`). */
export const PI_MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);
/** `sourceInfo.path` of every tool `builtin:mcp` registers (recorded: `evidence/probes/p06/`). */
export const PI_MCP_SOURCE_PATH = 'builtin:mcp';
/** Longest tool name Pi gives an MCP tool before it cuts it and adds a hash (`tools.js:29`). */
const PI_MCP_TOOL_NAME_LIMIT = 64;
/** The hash suffix Pi adds to a cut name: `_` and eight hex digits (`tools.js:49-50`). */
const PI_MCP_HASH_SUFFIX = 9;
/** Every character of an MCP tool name Pi gives: the rest becomes `_` (`tools.js:46`). */
const PI_MCP_TOOL_NAME_CHARS = /^[A-Za-z0-9_]+$/;
/** Unicode spaces Pi turns into plain spaces in a path (`utils/paths.js:6`). */
const UNICODE_SPACES = /[  -   　]/g;
const TITLE_LIMIT = 200;
const DETAIL_LIMIT = 1000;

/** What every Pi approval card offers (READY §2.2; `AP/codex/codex-adapter.ts:1042`). */
export const PI_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'decline', label: 'Decline' },
  { decision: 'cancel', label: 'Cancel' },
];

/** The session facts the policy needs; all of them come from `ProviderSessionStartInput`. */
export interface PiPolicySession {
  runtimeMode: RuntimeMode;
  /** `input.cwd`. */
  cwd: string;
  /** `Object.keys(input.mcpServers)`. */
  mcpServers: readonly string[];
  /** `input.connectorMcpServers`. */
  connectorMcpServers: readonly string[];
  /** `input.env`: Pi expands `~` with its `HOME`, and Switch's state lives under it. */
  env: Readonly<Record<string, string>>;
  /** Home of the host process; `os.homedir()` when absent. */
  hostHome?: string;
  /** More directories of Switch's own state that `auto-accept-edits` must not write. */
  protectedRoots?: readonly string[];
}

/** The tool call the bridge asks about (the fields of `PiBridgeConfirmMessage` that decide). */
export interface PiPolicyCall {
  toolName: string;
  toolCallId: string;
  server: PiBridgeToolServer | null;
  input: unknown;
}

/** Which rule decided; tests and logs name it. */
export type PiPolicyRule =
  | 'auto-approved-server'
  | 'full-access'
  | 'read-only'
  | 'edit-inside-cwd'
  | 'edit-outside-boundary'
  | 'connector'
  | 'mcp-unresolved-owner'
  | 'mcp-resource'
  | 'approval-required'
  | 'invalid-call';

export type PiPolicyDecision =
  | { kind: 'allow'; rule: PiPolicyRule }
  | {
      kind: 'ask';
      rule: PiPolicyRule;
      requestType: RequestType;
      title: string;
      detail?: string;
      options: readonly ApprovalOption[];
      /** The connector server the call reaches, one of the session's `connectorMcpServers`. */
      connector?: string;
    }
  /** Not a call the bridge can send: answered `false` without a card. */
  | { kind: 'deny'; rule: 'invalid-call'; reason: string };

/** File-system reads the policy makes; tests can replace them. */
export interface PiPolicyFs {
  /** `fs.lstatSync`; throws like it. */
  lstat(path: string): unknown;
  /** `fs.realpathSync.native`; throws like it. */
  realpath(path: string): string;
}

const nodeFs: PiPolicyFs = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
};

/** The decision for one tool call. Rule 1 (generation and run) is the adapter's, before this. */
export function decidePiToolCall(
  session: PiPolicySession,
  call: PiPolicyCall,
  fs: PiPolicyFs = nodeFs
): PiPolicyDecision {
  if (typeof call.toolName !== 'string' || call.toolName === '')
    return { kind: 'deny', rule: 'invalid-call', reason: 'tool call without a tool name' };
  if (typeof call.toolCallId !== 'string' || call.toolCallId === '')
    return { kind: 'deny', rule: 'invalid-call', reason: 'tool call without an id' };

  const input = isRecord(call.input) ? call.input : {};
  const connectors = new Set(session.connectorMcpServers);
  const autoApproved = new Set(session.mcpServers.filter((name) => !connectors.has(name)));
  const { toolName } = call;

  // MCP resource tools: one tool for every server with resources (ER-05, R1B-09).
  if (call.server === null && PI_MCP_RESOURCE_TOOLS.has(toolName)) {
    if (session.runtimeMode === 'full-access') return { kind: 'allow', rule: 'full-access' };
    // The server as Pi reads it; the card's detail keeps what the model wrote.
    const named = piResourceServer(input.server);
    const connector =
      named !== undefined
        ? connectors.has(named)
          ? named
          : undefined
        : session.connectorMcpServers.find((name) => session.mcpServers.includes(name));
    return ask('mcp-resource', 'mcp_tool_approval', {
      ...mcpApprovalContent(named ?? 'MCP resources', toolName, input),
      ...(connector !== undefined ? { connector } : {}),
    });
  }

  if (call.server !== null || toolName.startsWith('mcp__')) {
    const owner = piMcpToolOwner(call, session.mcpServers);
    // Rule 2: only an established owner can carry auto-approval.
    if (owner !== undefined && autoApproved.has(owner))
      return { kind: 'allow', rule: 'auto-approved-server' };
    if (session.runtimeMode === 'full-access') return { kind: 'allow', rule: 'full-access' };
    if (owner === undefined)
      return ask('mcp-unresolved-owner', 'mcp_tool_approval', {
        title: cut(`A tool of an unverified MCP server wants to run ${toolName}`, TITLE_LIMIT),
        ...detailOf(toolInputDetail(input)),
      });
    return ask('connector', 'mcp_tool_approval', {
      ...mcpApprovalContent(owner, mcpToolShortName(toolName, call.server), input),
      ...(connectors.has(owner) ? { connector: owner } : {}),
    });
  }

  // Pi's own tools (no namespace).
  if (session.runtimeMode === 'full-access') return { kind: 'allow', rule: 'full-access' };
  if (PI_READ_ONLY_TOOLS.has(toolName)) return { kind: 'allow', rule: 'read-only' };

  if (PI_FILE_CHANGE_TOOLS.has(toolName)) {
    const target = piWriteTarget(session, input.path, fs);
    if (session.runtimeMode === 'auto-accept-edits' && target.within)
      return { kind: 'allow', rule: 'edit-inside-cwd' };
    const where = target.resolved ?? (typeof input.path === 'string' ? input.path : 'a file');
    const verb = toolName === 'edit' ? 'edit' : 'write';
    const why =
      session.runtimeMode !== 'auto-accept-edits'
        ? ''
        : target.reason === 'switch-state'
          ? " in Switch's own state"
          : ' outside the working directory';
    return ask(
      session.runtimeMode === 'auto-accept-edits' ? 'edit-outside-boundary' : 'approval-required',
      'file_change_approval',
      {
        title: cut(`Pi wants to ${verb} ${where}${why}`, TITLE_LIMIT),
        ...detailOf(toolInputDetail(input)),
      }
    );
  }

  if (toolName === PI_COMMAND_TOOL) {
    const command = typeof input.command === 'string' ? input.command : undefined;
    return ask('approval-required', 'command_execution_approval', {
      title: cut(`Pi wants to run ${command ?? 'a command'}`, TITLE_LIMIT),
      ...detailOf(command !== undefined ? cut(command, DETAIL_LIMIT) : toolInputDetail(input)),
    });
  }

  return ask('approval-required', 'tool_approval', {
    title: cut(`Pi wants to use ${toolName}`, TITLE_LIMIT),
    ...detailOf(toolInputDetail(input)),
  });
}

/**
 * The session server that owns an MCP tool, or undefined when that cannot be established
 * (ER-05). Every condition is one Pi 1.4.0 itself guarantees for a tool `builtin:mcp`
 * registered for a server of this session; a tool that fails one is not that.
 */
export function piMcpToolOwner(
  call: Pick<PiPolicyCall, 'toolName' | 'server'>,
  sessionServers: readonly string[]
): string | undefined {
  const { server, toolName } = call;
  if (server === null || typeof server !== 'object') return undefined;
  if (server.sourcePath !== PI_MCP_SOURCE_PATH) return undefined;
  if (!Array.isArray(server.aliases) || server.aliases.length !== 1) return undefined;
  const alias = server.aliases[0];
  if (typeof alias !== 'string' || !sessionServers.includes(alias)) return undefined;
  // Two session servers with one namespace would make the owner ambiguous; the bridge refuses
  // such a config, and this does not rely on it.
  const namespace = piMcpNamespace(alias);
  if (sessionServers.filter((name) => piMcpNamespace(name) === namespace).length !== 1)
    return undefined;
  if (server.namespace !== namespace) return undefined;
  if (PI_MCP_RESOURCE_TOOLS.has(toolName)) return undefined;
  if (!isPiMcpToolName(toolName, `${namespace}__`)) return undefined;
  return alias;
}

/**
 * Whether `toolName` is a name Pi 1.4.0 can give a tool of the server whose name starts with
 * `prefix` (`createMcpToolName`, `extensions/mcp/tools.js:45-51`). Pi passes the server's own name
 * (`connection.entry.name`, `extensions/mcp/index.js:284`, `:298`, `:300`), which may only hold
 * `[A-Za-z0-9_-]` (`core/mcp-servers.js:48`, `:142-143`), and turns everything but `[A-Za-z0-9_]`
 * in `mcp__<server>__<tool>`, tool included, into `_` (`tools.js:46`); so the name starts with
 * the namespace Pi reports (`mcpNamespace(server)`, `index.js:288`, `core/mcp-servers.js:50-52`)
 * and `__`, and the rest is the sanitized tool.
 * - Kept: the whole name when it has at most 64 characters and is not taken (`tools.js:29`,
 *   `:47`), whatever the length of the prefix.
 * - Cut: the first 55 characters of the whole name, `_` and eight hex digits (`tools.js:48-50`).
 *   A whole name of up to 55 characters is cut only when another tool took it (`:47`); the cut
 *   name then still starts with the whole prefix and has under 64 characters, so the first rule
 *   matches it. Any other cut name has exactly 64 characters and starts with the part of the
 *   prefix Pi keeps, which is the whole prefix only when that has at most 55 characters.
 * - Either way the name holds only `[A-Za-z0-9_]` (`tools.js:46`; the hash is hex, `:49`), so a
 *   name with any other character is none Pi gives, whatever its start, before either rule.
 */
function isPiMcpToolName(toolName: string, prefix: string): boolean {
  if (!PI_MCP_TOOL_NAME_CHARS.test(toolName)) return false;
  if (
    toolName.length > prefix.length &&
    toolName.length <= PI_MCP_TOOL_NAME_LIMIT &&
    toolName.startsWith(prefix)
  )
    return true;
  return (
    toolName.length === PI_MCP_TOOL_NAME_LIMIT &&
    /_[0-9a-f]{8}$/.test(toolName) &&
    toolName.startsWith(prefix.slice(0, PI_MCP_TOOL_NAME_LIMIT - PI_MCP_HASH_SUFFIX))
  );
}

/**
 * The server an MCP resource tool call names, read the way Pi reads it (`stringArgument`, Pi 1.4.0
 * `extensions/mcp/resources.js:130-136`): a string is trimmed and a blank one names none, so
 * `" atlassian "` is `atlassian` and `""` or `"   "` lists every server (`:163-179`). Pi refuses
 * any other value before it reaches a server (`:134-135`); it names none here either, and the card
 * then takes the fallback of a call that names none.
 */
export function piResourceServer(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

/** Pi's namespace for a server (`core/mcp-servers.js:50-52`). */
export function piMcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, '_')}`;
}

export interface PiWriteTarget {
  /** Whether rule 5 may allow the write. */
  within: boolean;
  /** The target after `realpath`; undefined when it could not be resolved. */
  resolved?: string;
  reason: 'inside-cwd' | 'outside-cwd' | 'switch-state' | 'unresolved';
}

/**
 * Where Pi's `edit` or `write` would write, and whether that is inside the boundary of rule 5
 * (ER-03). Mirrors Pi's own resolution (`resolveToCwd`): Unicode spaces become spaces, a leading
 * `@` is dropped, `~` is the session's `HOME`, a `file://` URL is a path, and a relative path is
 * taken from `cwd`. Then `realpath` of the target, or of its nearest existing parent when the
 * target does not exist yet; an existing name that does not resolve (a dangling symlink, a loop,
 * no permission) is outside.
 *
 * Case: the comparison with `cwd` is exact, so a name that differs only in case is outside (on a
 * case-insensitive file system `realpath.native` gives the stored case). The comparison with
 * Switch's state ignores case, so on such a file system no spelling reaches the state.
 */
export function piWriteTarget(
  session: Pick<PiPolicySession, 'cwd' | 'env' | 'hostHome' | 'protectedRoots'>,
  rawPath: unknown,
  fs: PiPolicyFs = nodeFs
): PiWriteTarget {
  if (typeof rawPath !== 'string' || rawPath === '' || rawPath.includes('\0'))
    return { within: false, reason: 'unresolved' };
  const hostHome = session.hostHome ?? homedir();
  const home = session.env.HOME || hostHome;
  let path = rawPath.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (path === '~') path = home;
  else if (path.startsWith('~/')) path = join(home, path.slice(2));
  if (/^file:\/\//.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return { within: false, reason: 'unresolved' };
    }
  }
  if (!isAbsolute(session.cwd)) return { within: false, reason: 'unresolved' };
  const absolute = isAbsolute(path) ? resolve(path) : resolve(session.cwd, path);
  const real = realOrParent(absolute, fs);
  if (real === undefined) return { within: false, reason: 'unresolved' };

  const roots = [
    join(home, '.local', 'state', 'switch'),
    join(hostHome, '.local', 'state', 'switch'),
    ...(session.protectedRoots ?? []),
  ];
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    const forms = [resolve(root), realOrParent(resolve(root), fs)];
    for (const form of forms) {
      if (form === undefined) continue;
      if (underFolded(real, form) || underFolded(absolute, form))
        return { within: false, resolved: real, reason: 'switch-state' };
    }
  }

  let cwd: string;
  try {
    cwd = fs.realpath(session.cwd);
  } catch {
    return { within: false, resolved: real, reason: 'outside-cwd' };
  }
  const rel = relative(cwd, real);
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  return inside
    ? { within: true, resolved: real, reason: 'inside-cwd' }
    : { within: false, resolved: real, reason: 'outside-cwd' };
}

/** `realpath` of `path`, or of its nearest existing parent with the missing names appended. */
function realOrParent(path: string, fs: PiPolicyFs): string | undefined {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    let exists: boolean;
    try {
      fs.lstat(current);
      exists = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      exists = false;
    }
    if (exists) {
      try {
        return join(fs.realpath(current), ...missing.reverse());
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    missing.push(basename(current));
    current = parent;
  }
}

/** `path` is `root` or below it, ignoring case. */
function underFolded(path: string, root: string): boolean {
  const p = path.toLowerCase();
  const r = root.toLowerCase();
  return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

function mcpToolShortName(toolName: string, server: PiBridgeToolServer | null): string {
  const prefix = server ? `${server.namespace}__` : '';
  return prefix && toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

function ask(
  rule: PiPolicyRule,
  requestType: RequestType,
  content: { title: string; detail?: string; connector?: string }
): PiPolicyDecision {
  return { kind: 'ask', rule, requestType, ...content, options: PI_APPROVAL_OPTIONS };
}

function detailOf(detail: string | undefined): { detail?: string } {
  return detail === undefined ? {} : { detail };
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit === TITLE_LIMIT) return `${text.slice(0, limit - 1)}…`;
  return `${text.slice(0, limit)}… (${text.length - limit} more characters not shown)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
