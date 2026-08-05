import type { CanonicalHookEvent } from '@switchdash/core/agents/plugins';
import { defaultHookEventParser } from '@switchdash/core/agents/plugins/helpers';
import { getPlugin } from '@main/core/providers/plugin-registry';
import type { AgentEvent } from '@shared/core/providers/agentEvents';
import type { RawHookRequest } from './hook-server';

export type AgentHookContext = {
  sessionId: string;
  providerId: string;
  ptyId: string;
};

/**
 * Resolves the session context for an incoming hook's `ptyId`. Injected so
 * the parser stays free of the database: the local main process supplies a
 * DB-backed resolver, the remote sidecar a fixed one for its single agent.
 */
export type ContextResolver = (ptyId: string) => Promise<AgentHookContext | null>;

export type ParsedHookEvent =
  | { kind: 'status'; event: AgentEvent }
  | { kind: 'session'; ctx: AgentHookContext; providerSessionId: string }
  | { kind: 'activity'; ctx: AgentHookContext; detail: string }
  | {
      kind: 'switch-room';
      ctx: AgentHookContext;
      roomId: string;
      agentId: string;
      roomName: string | null;
    }
  | { kind: 'ignore' };

/**
 * Minimal logger the parser needs. Injected rather than imported so the parser
 * can run in the remote sidecar bundle, which must not pull in the
 * Electron-bound main-process file logger.
 */
export interface HookEventLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Event type emitted by the `connect_to_room` PostToolUse hook that
 * `buildClaudeHookConfig` in `@switchdash/plugins` registers, scoped to the
 * Switch MCP tool by an `mcp__.*__connect_to_room` matcher.
 *
 * Claude only. A session switchdash launched learns its room from the server
 * instead: it carries a `SWITCH_CONNECTION_ID` and its `connect_to_room` claims
 * the room on that connection. The hook covers what that path misses — a Claude
 * session started outside switchdash and adopted afterwards, which joined a room
 * on a connection of its own.
 *
 * `buildCodexHookConfig` registers no room hook. Note the case is no longer
 * impossible: the Codex connector plugin now ships the Switch MCP server, so a
 * Codex session started outside switchdash does have `connect_to_room`. An
 * adopted Codex session is therefore untracked rather than inconceivable.
 */
const SWITCH_ROOM_CONNECT_EVENT = 'switch_room_connect';

/** The value as a plain object, or null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * A string is decoded as JSON; anything else passes through untouched. Applied
 * at each level of the response because an agent CLI that re-serialises a nested
 * field hands it over as a string rather than as the object it stands for.
 */
function decodeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * The value as a Switch `connect_to_room` result — a plain object carrying both
 * a string `room_id` and a string `agent_id` — or null. Those two fields are
 * what tell the payload apart from an MCP envelope wrapping it, since both are
 * plain objects.
 *
 * Both are required because the caller returns on the first match: a partial
 * `structuredContent` that satisfied a `room_id`-only probe would win over the
 * text block that carries the whole result, and the event would then be dropped
 * for a missing `agent_id` that was available all along.
 */
function asRoomResult(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  return typeof record.room_id === 'string' && typeof record.agent_id === 'string' ? record : null;
}

/**
 * Extract the Switch `connect_to_room` result — which carries `room_id`,
 * `agent_id` and `name` — from the hook's `tool_response`.
 *
 * How deeply it is wrapped depends on how far the agent CLI unwraps the MCP
 * `CallToolResult` before handing it to the hook. Claude reports the payload
 * itself (as an object or a JSON string); an envelope-aware CLI such as Codex
 * may pass the `CallToolResult` through, which puts the payload under
 * `structuredContent` (or `structuredContent.result` when the tool returned a
 * non-dict) and repeats it as JSON in a `text` content block; a CLI that unwraps
 * the result but not its content list hands over the bare content array.
 *
 * Every content block is tried, so a server that narrates before returning its
 * JSON still parses. Malformed input yields null rather than throwing.
 */
function parseToolResponse(body: Record<string, unknown>): Record<string, unknown> | null {
  const value = decodeJson(body.tool_response);

  const direct = asRoomResult(value);
  if (direct) return direct;

  const envelope = asRecord(value);
  const structured = asRecord(decodeJson(envelope?.structuredContent));
  const fromStructured = asRoomResult(structured) ?? asRoomResult(decodeJson(structured?.result));
  if (fromStructured) return fromStructured;

  const blocks = Array.isArray(value) ? value : envelope?.content;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    const text = asRecord(block)?.text;
    if (typeof text !== 'string') continue;
    const fromText = asRoomResult(decodeJson(text));
    if (fromText) return fromText;
  }
  return null;
}

function parseBody(raw: RawHookRequest): Record<string, unknown> {
  if (!raw.body) return {};
  try {
    const value: unknown = JSON.parse(raw.body);
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  } catch {}
  return {};
}

function canonicalToAgentEvent(
  canonical: CanonicalHookEvent & { kind: 'status' },
  ctx: AgentHookContext
): AgentEvent {
  return {
    type: canonical.type,
    source: 'hook',
    ptyId: ctx.ptyId,
    providerId: ctx.providerId,
    sessionId: ctx.sessionId,
    timestamp: Date.now(),
    payload: {
      notificationType: canonical.notificationType,
      title: canonical.title,
      message: canonical.message,
      lastAssistantMessage: canonical.lastAssistantMessage,
    },
  };
}

export async function parseHookEvent(
  raw: RawHookRequest,
  resolveContext: ContextResolver,
  log: HookEventLogger
): Promise<ParsedHookEvent> {
  const ctx = await resolveContext(raw.ptyId);
  if (!ctx) {
    throw new Error(`Unrecognised ptyId: ${raw.ptyId}`);
  }

  const body = parseBody(raw);

  if (raw.type === SWITCH_ROOM_CONNECT_EVENT) {
    const response = parseToolResponse(body);
    const roomId = typeof response?.room_id === 'string' ? response.room_id : null;
    const agentId = typeof response?.agent_id === 'string' ? response.agent_id : null;
    const roomName = typeof response?.name === 'string' ? response.name : null;
    if (!roomId || !agentId) {
      const toolResponse = body.tool_response;
      log.warn('event-enricher: switch_room_connect carried no usable connect_to_room result', {
        providerId: ctx.providerId,
        ptyId: ctx.ptyId,
        toolResponseType: typeof toolResponse,
        toolResponseKeys:
          toolResponse !== null && typeof toolResponse === 'object'
            ? Object.keys(toolResponse)
            : undefined,
      });
      return { kind: 'ignore' };
    }
    return { kind: 'switch-room', ctx, roomId, agentId, roomName };
  }

  const plugin = getPlugin(ctx.providerId);
  const parser = plugin?.behavior.hooks?.parseHookEvent ?? defaultHookEventParser;
  const canonical = parser(raw.type, body);

  if (canonical.kind === 'ignore') return { kind: 'ignore' };

  if (canonical.kind === 'session') {
    return { kind: 'session', ctx, providerSessionId: canonical.providerSessionId };
  }

  if (canonical.kind === 'activity') {
    return { kind: 'activity', ctx, detail: canonical.detail };
  }

  return { kind: 'status', event: canonicalToAgentEvent(canonical, ctx) };
}
