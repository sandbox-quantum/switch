import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  workspace: { id: 'ws-1', tenantId: 'tenant-1' as string | null },
  emitted: [] as { name: string; data: unknown }[],
  opened: [] as { workspaceId: string; signal: AbortSignal }[],
}));

vi.mock('@main/core/workspaces/workspaces-store', () => ({
  requireWorkspaceForServer: async () => ({ ...state.workspace, serverId: 'server-1' }),
}));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withWorkspaceSession: async (workspaceId: string, fn: (server: unknown) => unknown) =>
    fn({ id: 'server-1', workspaceId }),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: class GatewayError extends Error {},
  gatewayRequest: async (
    server: { workspaceId: string },
    _path: string,
    options: { signal: AbortSignal }
  ) => {
    state.opened.push({ workspaceId: server.workspaceId, signal: options.signal });
    return new Response(new ReadableStream({ start: () => {} }), { status: 200 });
  },
}));
vi.mock('./gateway', () => ({ listChats: async () => [] }));
vi.mock('@main/lib/events', () => ({
  events: {
    emit: (event: { name: string }, data: unknown) =>
      state.emitted.push({ name: event.name, data }),
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => {} } }));

const { connectChatStream, resetChatStream } = await import('./chat-streams');

describe('chat streams', () => {
  beforeEach(() => {
    state.emitted.length = 0;
    state.opened.length = 0;
    state.workspace = { id: 'ws-1', tenantId: 'tenant-1' };
    resetChatStream('server-1');
    state.emitted.length = 0;
  });

  it('keeps one feed for the same tenant', async () => {
    await connectChatStream('server-1');
    await vi.waitFor(() => expect(state.opened).toHaveLength(1));
    await connectChatStream('server-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.opened).toHaveLength(1);
    expect(state.emitted.some((each) => each.name === 'chat:reset')).toBe(false);
  });

  it('drops the feed and resets the renderer when the tenant changes', async () => {
    await connectChatStream('server-1');
    await vi.waitFor(() => expect(state.opened).toHaveLength(1));
    state.workspace = { id: 'ws-2', tenantId: 'tenant-2' };
    await connectChatStream('server-1');
    await vi.waitFor(() => expect(state.opened).toHaveLength(2));
    expect(state.opened[0]!.signal.aborted).toBe(true);
    expect(state.opened[1]!.workspaceId).toBe('ws-2');
    expect(state.emitted).toContainEqual({ name: 'chat:reset', data: { serverId: 'server-1' } });
  });

  it('resets on sign-out', async () => {
    await connectChatStream('server-1');
    await vi.waitFor(() => expect(state.opened).toHaveLength(1));
    resetChatStream('server-1');
    expect(state.opened[0]!.signal.aborted).toBe(true);
    expect(state.emitted).toContainEqual({ name: 'chat:reset', data: { serverId: 'server-1' } });
  });
});
