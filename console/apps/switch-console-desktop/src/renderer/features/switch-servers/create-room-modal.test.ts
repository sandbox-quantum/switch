import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreateRoomModal } from './CreateRoomModal';

const flags = vi.hoisted(() => ({ group_chats: true }));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => flags }));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/features/chats/stores/chats', () => ({ chatsStore: {} }));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    workspaces: [{ id: 'ws', tenantId: null }],
    idOnServerInScope: (serverId: string | null) => (serverId ? 'ws' : null),
  },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

// The dialog's frame needs an open dialog around it; its contents are the subject here.
vi.mock('@renderer/lib/ui/dialog', () => {
  const pass = ({ children }: { children?: unknown }) => children;
  return {
    DialogContentArea: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
  };
});

describe('CreateRoomModal', () => {
  it('labels its fields as the other forms do: Name, then Participants', () => {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(CreateRoomModal, { onSuccess: () => {}, onClose: () => {} })
      )
    );
    expect(html).toMatch(/<label[^>]*for="new-room-name"[^>]*>Name<\/label>/);
    expect(html).toContain('placeholder="Name this room"');
    expect(html).toMatch(/<label[^>]*for="new-room-participants"[^>]*>Participants<\/label>/);
    expect(html).not.toContain('uppercase');
    expect(html).not.toContain('can’t create rooms yet');
  });

  it('explains, instead of the form, that no room can be created without group chats or a messaging app', () => {
    flags.group_chats = false;
    try {
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(CreateRoomModal, { onSuccess: () => {}, onClose: () => {} })
        )
      );
      expect(html).toContain('This server can’t create rooms yet.');
      expect(html).toContain('start a 1-1 chat from an agent’s page');
      expect(html).toContain('>Close</button>');
      expect(html).not.toContain('new-room-name');
      expect(html).not.toContain('Create room');
    } finally {
      flags.group_chats = true;
    }
  });

  const render = (client: QueryClient) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CreateRoomModal, {
          serverId: 'srv',
          agentId: 'a1',
          onSuccess: () => {},
          onClose: () => {},
        })
      )
    );

  it('starts with the agent it is made from picked, once the agents are read', () => {
    const client = new QueryClient();
    client.setQueryData(
      ['remote-agents', 'ws'],
      [{ id: 'a1', name: 'agent-one', displayName: null, iconUrl: null, knownAgentType: null }]
    );
    client.setQueryData(['chat-agent-candidates', 'srv', 'ws', null], ['a1']);
    expect(render(client)).toContain('aria-label="Remove agent-one"');
  });
  it('labels a bridged room’s description and instructions as optional', () => {
    flags.group_chats = false;
    try {
      const client = new QueryClient();
      client.setQueryData(
        ['remote-bridges', 'ws'],
        [
          {
            id: 'b1',
            displayName: 'Discord',
            type: 'discord',
            status: 'active',
            canCreateChannels: true,
          },
        ]
      );
      const html = render(client);
      expect(html).toMatch(
        /<label[^>]*for="new-room-description"[^>]*>Description \(optional\)<\/label>/
      );
      expect(html).toMatch(
        /<label[^>]*for="new-room-instructions"[^>]*>Instructions \(optional\)<\/label>/
      );
    } finally {
      flags.group_chats = true;
    }
  });
});
