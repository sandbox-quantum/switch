import type { McpServerSpec, RuntimeMode } from '../adapter';

/** The environment variable a session's settings reach the extension in. */
export const PI_SESSION_ENV = 'SWITCH_PI_SESSION';

/** What starts the title of an approval the extension asks for, ahead of its JSON. */
export const PI_APPROVAL_PREFIX = 'switch-approval ';

/** The answers an approval offers, as the extension reads them back. */
export const PI_APPROVAL_ANSWERS = ['accept', 'acceptForSession', 'decline'] as const;

/** An MCP server as Pi's `registerMcpServer` takes it. */
export type PiMcpServer =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

/** The session settings the adapter hands the extension. */
export interface PiExtensionSession {
  runtimeMode: RuntimeMode;
  mcpServers: Record<string, PiMcpServer>;
  /** The servers whose tools follow `runtimeMode`; every other one is the session's own. */
  connectorMcpServers: string[];
}

/** One approval the extension asks for, as the adapter reads it from the title. */
export interface PiApprovalAsk {
  kind: 'command' | 'file' | 'mcp' | 'tool';
  toolName: string;
  toolCallId: string;
  /** The command or path the call names, where it names one. */
  detail?: string;
  /** The connector server the tool is on, for an MCP tool. */
  server?: string;
}

/**
 * Pi's shape for a session's MCP server. Pi passes a stdio server only the
 * variables its entry names, so `envVars` are looked up here, in the
 * environment the session was started with.
 */
export function piMcpServer(spec: McpServerSpec, env: Record<string, string>): PiMcpServer {
  if (spec.transport === 'http')
    return { url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) };
  const passed: Record<string, string> = {};
  for (const name of spec.envVars ?? []) {
    const value = env[name];
    if (value !== undefined) passed[name] = value;
  }
  const merged = { ...passed, ...spec.env };
  return {
    command: spec.command,
    args: spec.args,
    ...(Object.keys(merged).length > 0 ? { env: merged } : {}),
  };
}

/**
 * The extension Switch loads into every Pi session with `-e`, as source: it
 * is written to the session's own directory when the session starts, so it
 * can never be missing, and nothing is installed into Pi's own configuration.
 *
 * It registers the session's MCP servers for that session alone, and gates
 * every tool call by the session's runtime mode, asking through Pi's extension
 * UI (`ctx.ui.select`), which RPC mode forwards to the adapter. It fails
 * closed: no settings, a dismissed dialog or any other answer blocks the
 * call, and Pi itself blocks a call whose handler throws.
 *
 * The settings arrive in `SWITCH_PI_SESSION` and are removed from the
 * environment at once, so commands the model runs never see the servers'
 * credentials. They are kept on `globalThis` for a reload of the extension in
 * the same process.
 */
export const PI_EXTENSION_SOURCE = `// Written by Switch for one Pi session. Do not edit: it is replaced on every start.
const SESSION = Symbol.for('switch.pi.session');
const PREFIX = ${JSON.stringify(PI_APPROVAL_PREFIX)};
const READS = new Set(['read', 'grep', 'find', 'ls', 'tool_search', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
const EDITS = new Set(['edit', 'write']);
const COMMANDS = new Set(['bash', 'powershell']);

function namespace(server) {
  return 'mcp__' + server.replace(/[^A-Za-z0-9_]/g, '_') + '__';
}

function serverOf(toolName, servers) {
  for (const server of servers) if (toolName.startsWith(namespace(server))) return server;
  return undefined;
}

function ask(session, event) {
  const name = event.toolName;
  const server = serverOf(name, Object.keys(session.mcpServers));
  if (server !== undefined && !session.connectorMcpServers.includes(server)) return undefined;
  if (session.runtimeMode === 'full-access') return undefined;
  if (server === undefined && READS.has(name)) return undefined;
  if (EDITS.has(name) && session.runtimeMode === 'auto-accept-edits') return undefined;
  const input = event.input || {};
  if (COMMANDS.has(name))
    return { kind: 'command', toolName: name, toolCallId: event.toolCallId, detail: String(input.command ?? '') };
  if (EDITS.has(name))
    return { kind: 'file', toolName: name, toolCallId: event.toolCallId, detail: String(input.path ?? '') };
  if (server !== undefined) return { kind: 'mcp', toolName: name, toolCallId: event.toolCallId, server };
  return { kind: 'tool', toolName: name, toolCallId: event.toolCallId };
}

export default function switchSession(pi) {
  const raw = process.env.${PI_SESSION_ENV};
  delete process.env.${PI_SESSION_ENV};
  if (raw) globalThis[SESSION] = JSON.parse(raw);
  const session = globalThis[SESSION];
  if (!session) {
    pi.on('tool_call', () => ({ block: true, reason: 'Switch could not read this session\\'s settings, so no tool may run.' }));
    return;
  }
  for (const [name, server] of Object.entries(session.mcpServers))
    pi.registerMcpServer(name, { ...server, exposure: 'direct' });
  const allowed = new Set();
  pi.on('tool_call', async (event, ctx) => {
    const request = ask(session, event);
    if (!request) return undefined;
    const key = request.kind === 'command' ? request.toolName + ':' + request.detail : request.toolName;
    if (allowed.has(key)) return undefined;
    const answer = await ctx.ui.select(PREFIX + JSON.stringify(request), ${JSON.stringify([...PI_APPROVAL_ANSWERS])});
    if (answer === 'acceptForSession') allowed.add(key);
    if (answer === 'accept' || answer === 'acceptForSession') return undefined;
    return { block: true, reason: 'The user did not allow ' + request.toolName + '.' };
  });
}
`;
