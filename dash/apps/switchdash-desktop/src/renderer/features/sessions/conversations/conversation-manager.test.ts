import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationManagerStore } from './conversation-manager';

const hydrateConversation = vi.hoisted(() => vi.fn());
const dehydrateConversation = vi.hoisted(() => vi.fn());
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
    conversations: {
      dehydrateConversation,
      getConversationsForSession: vi.fn(),
      hydrateConversation,
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

describe('ConversationManagerStore session hydration', () => {
  beforeEach(() => {
    hydrateConversation.mockReset();
    dehydrateConversation.mockReset();
    frontendConnect.mockReset();
    frontendDispose.mockReset();

    hydrateConversation.mockResolvedValue(undefined);
    dehydrateConversation.mockResolvedValue(undefined);
    frontendConnect.mockResolvedValue(undefined);
  });

  it('does not hydrate sessions from the PTY session connect path', async () => {
    const now = '2024-01-01T00:00:00.000Z';
    const store = new ConversationManagerStore('project-1', 'session-1', [
      {
        id: 'session-1',
        agentId: 'agent-1',
        providerId: 'codex',
        title: 'Session 1',
        shellId: 'system',
        status: 'in_progress',
        statusChangedAt: now,
        agentSessionId: null,
        isInitialSession: false,
        isPinned: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const session = store.sessions.get('session-1');
    expect(session).toBeDefined();

    await session?.connect();

    expect(hydrateConversation).not.toHaveBeenCalled();
    expect(frontendConnect).toHaveBeenCalledTimes(1);

    store.dispose();
  });
});
