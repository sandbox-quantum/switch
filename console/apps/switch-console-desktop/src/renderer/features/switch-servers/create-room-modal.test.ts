import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreateRoomModal } from './CreateRoomModal';

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/features/chats/stores/chats', () => ({ chatsStore: {} }));
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
  });
});
