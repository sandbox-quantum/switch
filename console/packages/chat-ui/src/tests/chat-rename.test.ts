import { describe, it, expect, vi } from 'vitest';
import type { ChatHost } from '../host';
import { chatActions } from '../components/chat-actions';

describe('chat rename', () => {
  it('includes rename action for chats the user can manage', () => {
    const mockHost: ChatHost = {
      chats: {
        rename: vi.fn(),
        archived: new Map(),
      } as any,
      rename: vi.fn(),
      confirm: vi.fn(),
      toast: vi.fn(),
    } as any;

    const chat = {
      roomId: 'room-1',
      name: 'Test Chat',
      canManage: true,
      agents: [],
      memberUserIds: [],
    } as any;

    const context = {
      currentViewId: 'room-1',
    };

    const actions = chatActions('server-1', chat, context, mockHost);
    expect(actions.some((a) => a.key === 'rename')).toBe(true);
  });

  it('excludes rename action for chats the user cannot manage', () => {
    const mockHost: ChatHost = {
      chats: {
        archived: new Map(),
      } as any,
      rename: vi.fn(),
      confirm: vi.fn(),
      toast: vi.fn(),
    } as any;

    const chat = {
      roomId: 'room-1',
      name: 'Test Chat',
      canManage: false,
      agents: [],
      memberUserIds: [],
    } as any;

    const context = {
      currentViewId: 'room-1',
    };

    const actions = chatActions('server-1', chat, context, mockHost);
    expect(actions.some((a) => a.key === 'rename')).toBe(false);
  });
});
