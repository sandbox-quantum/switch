import type { CanonicalHookEvent } from '@switchdash/core/agents/plugins';
import { defaultHookEventParser } from '@switchdash/core/agents/plugins/helpers';
import { getPlugin } from '@main/core/providers/plugin-registry';
import type { AgentEvent } from '@shared/core/providers/agentEvents';
import type { RawHookRequest } from './hook-server';

export type AgentHookContext = {
  sessionId: string;
  projectId: string;
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
 * Event type emitted by the Claude `connect_to_room` PostToolUse hook (see the
 * claude plugin hook config). The hook fires for the Switch MCP tool only, via
 * its `mcp__.*__connect_to_room` matcher.
 */
const SWITCH_ROOM_CONNECT_EVENT = 'switch_room_connect';

/**
 * Claude reports the tool result under `tool_response`, which may arrive as an
 * already-parsed object or a JSON string. The Switch `connect_to_room` result
 * carries `room_id` and `agent_id`.
 */
function parseToolResponse(body: Record<string, unknown>): Record<string, unknown> | null {
  const raw = body.tool_response;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object') return value as Record<string, unknown>;
    } catch {}
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
    projectId: ctx.projectId,
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
  resolveContext: ContextResolver
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
    if (!roomId || !agentId) return { kind: 'ignore' };
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
