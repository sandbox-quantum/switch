import { describe, expect, it, vi } from 'vitest';
import { type ContextResolver, type AgentHookContext, parseHookEvent } from './event-enricher';
import type { RawHookRequest } from './hook-server';

const ctx: AgentHookContext = {
  sessionId: 'session-1',
  projectId: 'proj-1',
  providerId: 'claude-code',
  ptyId: 'claude-code::session-1',
};

const fixedResolver: ContextResolver = async () => ctx;

function raw(type: string, body: Record<string, unknown>): RawHookRequest {
  return { ptyId: ctx.ptyId, type, body: JSON.stringify(body) } as RawHookRequest;
}

describe('parseHookEvent', () => {
  it('parses a switch_room_connect event using the injected context', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', {
        tool_response: { room_id: 'room-1', agent_id: 'agent-1', name: 'Room One' },
      }),
      fixedResolver
    );

    expect(parsed).toEqual({
      kind: 'switch-room',
      ctx,
      roomId: 'room-1',
      agentId: 'agent-1',
      roomName: 'Room One',
    });
  });

  it('ignores a switch_room_connect event missing room/agent ids', async () => {
    const parsed = await parseHookEvent(
      raw('switch_room_connect', { tool_response: { room_id: 'room-1' } }),
      fixedResolver
    );
    expect(parsed).toEqual({ kind: 'ignore' });
  });

  it('throws when the context resolver cannot resolve the ptyId', async () => {
    const nullResolver: ContextResolver = async () => null;
    await expect(parseHookEvent(raw('Stop', {}), nullResolver)).rejects.toThrow(
      'Unrecognised ptyId'
    );
  });

  it('does not consult the database — the resolver is the only context source', async () => {
    const resolver = vi.fn(fixedResolver);
    await parseHookEvent(raw('switch_room_connect', { tool_response: {} }), resolver);
    expect(resolver).toHaveBeenCalledWith(ctx.ptyId);
  });
});
