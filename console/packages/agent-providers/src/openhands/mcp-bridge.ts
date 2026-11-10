import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Private environment passed only to the stdio MCP child, never in its arguments. */
export const OPENHANDS_MCP_SPEC = 'SWITCH_OPENHANDS_MCP_SPEC';

// A real MCP client ordinarily has at most a few list requests in flight. Bound
// our correlation state even if a malformed client sends requests indefinitely.
const MAX_TRACKED_REQUESTS = 1024;
const MAX_ALIASED_TOOLS = 4096;
const ALIAS_BASE = 'switch_mcp_kind';
// These root-level JSON Schema keywords can constrain property names or the
// entire object in ways that are not preserved by a simple rename. Rather
// than change a tool's meaning, refuse a `kind` schema that uses them.
const UNSUPPORTED_KIND_SCHEMA_KEYS = [
  '$ref',
  '$dynamicRef',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'enum',
  'const',
] as const;

// Any reference in a renamed schema might resolve to the old property path.
// We cannot prove that a general JSON Schema reference is independent of it.
function containsReference(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((item) => containsReference(item, depth + 1));
  if (!object(value)) return false;
  if ('$ref' in value || '$dynamicRef' in value || '$recursiveRef' in value) return true;
  return Object.values(value).some((item) => containsReference(item, depth + 1));
}

// A branch without `kind` or references needs no translation. References in
// a root branch may introduce `kind` at the tool's top level; without fully
// resolving them we cannot safely decide whether the argument needs renaming.
function hasBranchKind(schema: JsonObject, depth = 0): boolean {
  if (depth > 32) return true;
  for (const key of ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'] as const) {
    const value = schema[key];
    for (const branch of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      if (
        object(branch) &&
        ((object(branch.properties) && Object.hasOwn(branch.properties, 'kind')) ||
          '$ref' in branch ||
          '$dynamicRef' in branch ||
          '$recursiveRef' in branch ||
          hasBranchKind(branch, depth + 1))
      )
        return true;
    }
  }
  return false;
}
type RequestId = string | number;
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasId(value: JsonObject): value is JsonObject & { id: RequestId } {
  return typeof value.id === 'string' || typeof value.id === 'number';
}
function rpcError(id: RequestId, message: string): JSONRPCMessage {
  return { jsonrpc: '2.0', id, error: { code: -32603, message } };
}

/**
 * Relay a complete MCP JSON-RPC stream between a stdio client and an HTTP
 * transport. The upstream transport owns the HTTP session and SSE handling;
 * requests, responses, server requests, notifications, progress and cancel
 * messages are otherwise forwarded unchanged.
 *
 * OpenHands 1.16's SDK reserves `kind` in dynamically generated tool models.
 * Advertise that *top-level* input property under a stable, collision-free
 * alias, and restore it on calls. Nested data is not touched. If a later schema
 * collides with an alias already advertised, fail the list rather than risk
 * silently changing the meaning of an in-flight call.
 */
export function createOpenHandsMcpBridge(inbound: Transport, outbound: Transport) {
  const pending = new Map<RequestId, 'initialize' | 'tools/list'>();
  const aliases = new Map<string, { alias: string; active: boolean }>();
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = (): Promise<void> => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        try {
          await Promise.allSettled([inbound.close(), outbound.close()]);
        } finally {
          resolveClosed();
        }
      });
    }
    return closing;
  };
  const deliver = (message: JSONRPCMessage) => {
    if (!closing) void inbound.send(message).catch(() => void close());
  };

  const rewriteTools = (result: unknown): unknown => {
    if (!object(result) || !Array.isArray(result.tools)) return result;
    const nextAliases = new Map([...aliases].map(([name, mapping]) => [name, { ...mapping }]));
    const tools = result.tools.map((tool: unknown) => {
      if (!object(tool) || typeof tool.name !== 'string' || !object(tool.inputSchema)) return tool;
      const schema = tool.inputSchema;
      const properties = object(schema.properties) ? schema.properties : {};
      const hasKind = Object.hasOwn(properties, 'kind');
      if (
        (!hasKind &&
          (hasBranchKind(schema) ||
            '$ref' in schema ||
            '$dynamicRef' in schema ||
            '$recursiveRef' in schema)) ||
        (hasKind &&
          (UNSUPPORTED_KIND_SCHEMA_KEYS.some((key) => key in schema) || containsReference(schema)))
      ) {
        throw new Error('An MCP tool schema cannot be safely translated.');
      }
      const known = nextAliases.get(tool.name);
      if (known && Object.hasOwn(properties, known.alias)) {
        throw new Error('An MCP tool schema collides with its previously advertised alias.');
      }
      if (!hasKind) {
        if (known) known.active = false;
        return tool;
      }
      let alias = known?.alias;
      if (!alias) {
        if (nextAliases.size >= MAX_ALIASED_TOOLS) throw new Error('Too many aliased MCP tools.');
        alias = ALIAS_BASE;
        while (Object.hasOwn(properties, alias)) alias += '_';
        nextAliases.set(tool.name, { alias, active: true });
      } else if (known) known.active = true;
      const renamed = { ...properties, [alias]: properties.kind };
      delete renamed.kind;
      const required = Array.isArray(schema.required)
        ? schema.required.map((name) => (name === 'kind' ? alias : name))
        : schema.required;
      return {
        ...tool,
        inputSchema: {
          ...schema,
          properties: renamed,
          ...(required === undefined ? {} : { required }),
        },
      };
    });
    aliases.clear();
    for (const [name, mapping] of nextAliases) aliases.set(name, mapping);
    return { ...result, tools };
  };

  inbound.onmessage = (raw) => {
    if (closing || !object(raw)) return;
    let message: JsonObject = raw;
    const method = message.method;
    if (hasId(message) && (method === 'initialize' || method === 'tools/list')) {
      if (pending.size >= MAX_TRACKED_REQUESTS || pending.has(message.id)) {
        deliver(rpcError(message.id, 'Too many outstanding MCP requests.'));
        return;
      }
      pending.set(message.id, method);
    }
    if (
      method === 'tools/call' &&
      object(message.params) &&
      typeof message.params.name === 'string'
    ) {
      const mapping = aliases.get(message.params.name);
      const args = message.params.arguments;
      if (mapping && object(args)) {
        const hasAlias = Object.hasOwn(args, mapping.alias);
        if ((hasAlias && !mapping.active) || (mapping.active && Object.hasOwn(args, 'kind'))) {
          if (hasId(message)) deliver(rpcError(message.id, 'Ambiguous MCP tool arguments.'));
          return;
        }
        if (hasAlias) {
          const restored: JsonObject = { ...args, kind: args[mapping.alias] };
          delete restored[mapping.alias];
          message = { ...message, params: { ...message.params, arguments: restored } };
        }
      }
    }
    void outbound.send(message as JSONRPCMessage).catch(() => {
      if (hasId(message) && typeof message.method === 'string') {
        pending.delete(message.id);
        // Transport errors can contain URLs or authorization headers. Do not
        // pass their text to the model or write it to stderr.
        deliver(rpcError(message.id, 'The MCP upstream transport failed.'));
      } else {
        void close();
      }
    });
  };
  outbound.onmessage = (raw) => {
    if (closing || !object(raw)) return;
    let message: JsonObject = raw;
    if (hasId(message) && !('method' in message)) {
      const method = pending.get(message.id);
      pending.delete(message.id);
      if (
        method === 'initialize' &&
        object(message.result) &&
        typeof message.result.protocolVersion === 'string'
      ) {
        outbound.setProtocolVersion?.(message.result.protocolVersion);
      }
      if (method === 'tools/list' && 'result' in message) {
        const responseId = message.id;
        try {
          message = { ...message, result: rewriteTools(message.result) };
        } catch {
          deliver(rpcError(responseId, 'The MCP tool schema changed incompatibly.'));
          return;
        }
      }
    }
    deliver(message as JSONRPCMessage);
  };
  inbound.onclose = () => void close();
  outbound.onclose = () => void close();
  // The SDK also invokes onerror on send failures, handled above. Closing here
  // handles asynchronous SSE errors, which otherwise leave a client waiting.
  inbound.onerror = () => void close();
  outbound.onerror = () => void close();

  return {
    closed,
    async start() {
      try {
        await outbound.start();
        if (closing) return;
        await inbound.start();
        if (closing) await inbound.close();
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
  };
}

/** Entrypoint for the shared-host private stdio MCP bridge mode. */
export async function runOpenHandsMcpBridge(env: NodeJS.ProcessEnv = process.env) {
  const invalid = () => new Error('Missing or invalid OpenHands MCP bridge configuration.');
  const raw = env[OPENHANDS_MCP_SPEC];
  if (!raw || raw.length > 128 * 1024) throw invalid();
  let spec: unknown;
  try {
    spec = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!object(spec)) throw invalid();
  let outbound: Transport;
  if (spec.transport === 'http') {
    if (
      typeof spec.url !== 'string' ||
      !object(spec.headers) ||
      Object.values(spec.headers).some((value) => typeof value !== 'string')
    )
      throw invalid();
    let url: URL;
    try {
      url = new URL(spec.url);
    } catch {
      throw invalid();
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw invalid();
    outbound = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: spec.headers as Record<string, string>, redirect: 'error' },
    });
  } else if (spec.transport === 'stdio') {
    if (
      typeof spec.command !== 'string' ||
      !spec.command ||
      !Array.isArray(spec.args) ||
      spec.args.some((value) => typeof value !== 'string') ||
      !object(spec.env) ||
      Object.values(spec.env).some((value) => typeof value !== 'string')
    )
      throw invalid();
    // A configured MCP server may log credentials. Drain its stderr without
    // copying unredacted bytes into Switch logs or the model's protocol.
    const stdio = new StdioClientTransport({
      command: spec.command,
      args: spec.args as string[],
      env: Object.fromEntries(
        Object.entries(spec.env).filter(([key]) => key !== OPENHANDS_MCP_SPEC)
      ) as Record<string, string>,
      stderr: 'pipe',
    });
    stdio.stderr?.on('data', () => {});
    outbound = stdio;
  } else throw invalid();
  const bridge = createOpenHandsMcpBridge(new StdioServerTransport(), outbound);
  let deadline: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (deadline) return;
    // The SDK closes a stubborn stdio child in at most four seconds. Bound the
    // entire shutdown as a last resort so a broken transport cannot orphan a
    // permanent bridge. This entry point runs only in its own private process.
    deadline = setTimeout(() => process.exit(1), 8_000);
    void bridge.close();
  };
  // StdioServerTransport does not itself subscribe to EOF. Without these
  // handlers the transport can keep its HTTP session or stdio child alive.
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await bridge.start();
  } catch {
    await bridge.close();
    // Child-process and transport errors can contain command arguments, URLs,
    // and credentials. Never print those through the host sidecar stderr.
    throw new Error('OpenHands MCP bridge could not start.');
  } finally {
    void bridge.closed.then(() => {
      if (deadline) clearTimeout(deadline);
      process.stdin.off('end', shutdown);
      process.stdin.off('close', shutdown);
      process.off('SIGTERM', shutdown);
      process.off('SIGINT', shutdown);
    });
  }
  return bridge;
}
