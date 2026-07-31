import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ContextResolver, type AgentHookContext, parseHookEvent } from './event-enricher';
import type { RawHookRequest } from './hook-server';

const ctx: AgentHookContext = {
  sessionId: 'session-1',
  providerId: 'claude-code',
  ptyId: 'claude-code::session-1',
};

const fixedResolver: ContextResolver = async () => ctx;

const log = { warn: vi.fn() };

function raw(type: string, body: Record<string, unknown>): RawHookRequest {
  return { ptyId: ctx.ptyId, type, body: JSON.stringify(body) } as RawHookRequest;
}

/** The Switch `connect_to_room` result as the tool itself returns it. */
const roomResult = { room_id: 'room-1', agent_id: 'agent-1', name: 'Room One' };

const expectedRoom = {
  kind: 'switch-room',
  ctx,
  roomId: 'room-1',
  agentId: 'agent-1',
  roomName: 'Room One',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseHookEvent', () => {
  it('parses a switch_room_connect event using the injected context', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', { tool_response: roomResult }),
      fixedResolver,
      log
    );

    expect(parsed).toEqual(expectedRoom);
  });

  it('unwraps the CallToolResult Codex actually forwards', async () => {
    // Verbatim `tool_response` captured from Codex CLI 0.146.0 via
    // `scripts/codex-hook-probe/run.sh`, calling a FastMCP tool declared like
    // the real `connect_to_room` (async, returning `dict[str, Any]`). Codex
    // forwards the envelope rather than unwrapping it the way Claude Code does,
    // so reading `tool_response.room_id` finds nothing — kept literal so a
    // future Codex change fails here rather than silently stranding the poller
    // on the room the session spawned in.
    const parsed = await parseHookEvent(
      raw('switch_room_connect', {
        tool_name: 'mcp__switch__connect_to_room',
        tool_response: {
          content: [
            {
              type: 'text',
              text: '{"room_id":"room-1","agent_id":"agent-1","name":"Room One","participants":[]}',
            },
          ],
          structuredContent: { ...roomResult, participants: [] },
          isError: false,
        },
      }),
      fixedResolver,
      log
    );

    expect(parsed).toEqual({ ...expectedRoom, ctx });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('unwraps structuredContent on its own', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', { tool_response: { structuredContent: roomResult } }),
      fixedResolver,
      log
    );

    expect(parsed).toEqual(expectedRoom);
  });

  it('falls through to the text block when structuredContent is missing agent_id', async () => {
    // structuredContent is tried before the text block and the first match wins,
    // so a probe satisfied by room_id alone would take this partial envelope and
    // then drop the event for a missing agent_id the text block was carrying.
    const parsed = await parseHookEvent(
      raw('switch_room_connect', {
        tool_response: {
          structuredContent: { room_id: 'room-1' },
          content: [{ type: 'text', text: JSON.stringify(roomResult) }],
        },
      }),
      fixedResolver,
      log
    );

    expect(parsed).toEqual(expectedRoom);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('unwraps structuredContent.result when the tool return was wrapped', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', {
        tool_response: { structuredContent: { result: roomResult } },
      }),
      fixedResolver,
      log
    );

    expect(parsed).toEqual(expectedRoom);
  });

  it('unwraps the first text content block on its own', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', {
        tool_response: {
          content: [
            { type: 'image', data: 'ignored' },
            { type: 'text', text: JSON.stringify(roomResult) },
          ],
        },
      }),
      fixedResolver,
      log
    );

    expect(parsed).toEqual(expectedRoom);
  });

  it('parses a tool_response delivered as a JSON string', async () => {
    const asPayload = await parseHookEvent(
      raw('switch_room_connect', { tool_response: JSON.stringify(roomResult) }),
      fixedResolver,
      log
    );
    expect(asPayload).toEqual(expectedRoom);

    const asEnvelope = await parseHookEvent(
      raw('switch_room_connect', {
        tool_response: JSON.stringify({ structuredContent: roomResult }),
      }),
      fixedResolver,
      log
    );
    expect(asEnvelope).toEqual(expectedRoom);
  });

  it('ignores a switch_room_connect event missing room/agent ids', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', { tool_response: { room_id: 'room-1' } }),
      fixedResolver,
      log
    );
    expect(parsed).toEqual({ kind: 'ignore' });
  });

  it('warns and ignores when the tool result shape is unrecognisable', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', { tool_response: { isError: true, content: 'nope' } }),
      fixedResolver,
      log
    );

    expect(parsed).toEqual({ kind: 'ignore' });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
      providerId: ctx.providerId,
      ptyId: ctx.ptyId,
      toolResponseType: 'object',
      toolResponseKeys: ['isError', 'content'],
    });
  });

  it('warns without keys when the tool result is not an object', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', { tool_response: 'not json' }),
      fixedResolver,
      log
    );

    expect(parsed).toEqual({ kind: 'ignore' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ toolResponseType: 'string', toolResponseKeys: undefined })
    );
  });

  it('throws when the context resolver cannot resolve the ptyId', async () => {
    const nullResolver: ContextResolver = async () => null;
    await expect(parseHookEvent(raw('Stop', {}), nullResolver, log)).rejects.toThrow(
      'Unrecognised ptyId'
    );
  });

  it('does not consult the database — the resolver is the only context source', async () => {
    const resolver = vi.fn(fixedResolver);
    await parseHookEvent(raw('switch_room_connect', { tool_response: {} }), resolver, log);
    expect(resolver).toHaveBeenCalledWith(ctx.ptyId);
  });
});
