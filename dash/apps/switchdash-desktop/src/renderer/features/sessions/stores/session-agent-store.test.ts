import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAgentStore } from './session-agent-store';

const hydrateSession = vi.hoisted(() => vi.fn());
const dehydrateSession = vi.hoisted(() => vi.fn());
const frontendConnect = vi.hoisted(() => vi.fn());
const frontendDispose = vi.hoisted(() => vi.fn());

vi.mock('@renderer/features/sessions/stores/open-file-in-file-editor', () => ({
  makeFileLinkHandlers: () => ({
    onOpenExternal: vi.fn(),
    onOpenFile: vi.fn(),
  }),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    sessions: {
      dehydrateSession,
      getSession: vi.fn(),
      hydrateSession,
    },
  },
}));

vi.mock('@renderer/lib/pty/pty', () => ({
  FrontendPty: class {
    constructor(readonly sessionId: string) {}

    connect = frontendConnect;
    dispose = frontendDispose;
  },
}));

describe('SessionAgentStore hydration', () => {
  beforeEach(() => {
    hydrateSession.mockReset();
    dehydrateSession.mockReset();
    frontendConnect.mockReset();
    frontendDispose.mockReset();

    hydrateSession.mockResolvedValue(undefined);
    dehydrateSession.mockResolvedValue(undefined);
    frontendConnect.mockResolvedValue(undefined);
  });

  const now = '2024-01-01T00:00:00.000Z';
  const sessionRecord = {
    id: 'session-1',
    agentId: 'agent-1',
    providerId: 'codex' as const,
    title: 'Session 1',
    shellId: 'system' as const,
    status: 'in_progress' as const,
    statusChangedAt: now,
    agentSessionId: null,
    isInitialSession: false,
    isPinned: false,
    createdAt: now,
    updatedAt: now,
  };

  it('does not hydrate the session from the PTY session connect path', async () => {
    const store = new SessionAgentStore('location-1', 'session-1', [sessionRecord]);

    const session = store.pty;
    expect(session).toBeDefined();

    await session?.connect();

    expect(hydrateSession).not.toHaveBeenCalled();
    expect(frontendConnect).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it('hydrates when desired and dehydrates when released', async () => {
    const store = new SessionAgentStore('location-1', 'session-1', [sessionRecord]);

    store.setHydrationDesired(true);
    await vi.waitFor(() => expect(hydrateSession).toHaveBeenCalledTimes(1));

    store.setHydrationDesired(false);
    await vi.waitFor(() => expect(dehydrateSession).toHaveBeenCalledTimes(1));

    store.dispose();
  });

  it('tears back down when intent flips while a hydrate is in flight', async () => {
    let resolveHydrate: (() => void) | undefined;
    hydrateSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveHydrate = resolve;
        })
    );
    const store = new SessionAgentStore('location-1', 'session-1', [sessionRecord]);

    store.setHydrationDesired(true);
    await vi.waitFor(() => expect(hydrateSession).toHaveBeenCalledTimes(1));
    store.setHydrationDesired(false);
    resolveHydrate?.();
    await vi.waitFor(() => expect(dehydrateSession).toHaveBeenCalledTimes(1));

    store.dispose();
  });
});
