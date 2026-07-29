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
 * Event type emitted by the `connect_to_room` PostToolUse hook that switchdash
 * registers for both Claude and Codex (`buildClaudeHookConfig` and
 * `buildCodexHookConfig` in `@switchdash/plugins`). Both scope it to the Switch
 * MCP tool with the same `mcp__.*__connect_to_room` matcher.
 */
const SWITCH_ROOM_CONNECT_EVENT = 'switch_room_connect';

/** The value as a plain object, or null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The value as a Switch `connect_to_room` result — a plain object carrying a
 * string `room_id` — or null. The `room_id` probe is what tells the payload
 * apart from an MCP envelope wrapping it, since both are plain objects.
 */
function asRoomResult(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return record && typeof record.room_id === 'string' ? record : null;
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
 * non-dict) and repeats it as JSON in the first `text` content block.
 * Malformed input yields null rather than throwing.
 */
function parseToolResponse(body: Record<string, unknown>): Record<string, unknown> | null {
  let value = body.tool_response;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }

  const direct = asRoomResult(value);
  if (direct) return direct;

  const envelope = asRecord(value);
  if (!envelope) return null;

  const structured = asRecord(envelope.structuredContent);
  const fromStructured = asRoomResult(structured) ?? asRoomResult(structured?.result);
  if (fromStructured) return fromStructured;

  const content: unknown[] = Array.isArray(envelope.content) ? envelope.content : [];
  const text = content.map(asRecord).find((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try {
    return asRoomResult(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
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
