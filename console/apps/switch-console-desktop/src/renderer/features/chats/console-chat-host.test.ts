import { describe, it, expect, vi } from 'vitest';
import { appState } from '@renderer/lib/stores/app-state';

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {},
  events: { on: vi.fn() },
}));

vi.mock('@renderer/features/switch-servers/home-target', () => ({
  navigateHome: vi.fn(),
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { activeServerId: 'test-server', statusFor: () => null },
}));

vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => null },
}));

vi.mock('@renderer/features/chats/chat-people', () => ({
  useChatPeople: () => ({ members: [], known: [] }),
}));

vi.mock('@renderer/features/chats/start-direct-chat', () => ({
  directChats: { unsavedChat: () => undefined },
}));

vi.mock('@renderer/features/chats/stores/activities', () => ({
  agentActivities: { peek: () => undefined, feedDown: new Map() },
}));

vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatsStore: { userId: 'me' },
  chatTitler: { sent: vi.fn() },
}));

vi.mock('@renderer/lib/components/agent-accent', () => ({
  useAgentAccent: () => null,
}));

vi.mock('@renderer/lib/components/agent-avatar', () => ({
  AgentAvatar: () => null,
}));

vi.mock('@renderer/lib/components/bridge-icon', () => ({
  BridgeIcon: () => null,
  hasBridgeIcon: () => false,
}));

vi.mock('@renderer/lib/components/bridge-platform', () => ({
  bridgePlatformLabel: () => 'platform',
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ group_chats: true }),
}));

vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'light' }),
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  showModal: vi.fn(),
}));

vi.mock('@renderer/lib/modal/modal-store', () => ({
  modalStore: { isOpen: false, closeModal: vi.fn() },
}));

vi.mock('@renderer/lib/open-external-link', () => ({
  confirmOpenExternalLink: vi.fn(),
}));

vi.mock('@switch-console/chat-ui/components/chat-attachments', () => ({
  dropMedia: vi.fn(),
}));

import { consoleChatHost } from './console-chat-host';

describe('Console chat host chat removal', () => {
  it('isOpenChat returns true when on agent page with matching roomId', () => {
    appState.navigation.navigate('managedAgent', {
      serverId: 'test-server',
      agentId: 'test-agent',
      name: 'Test Agent',
      roomId: 'test-room',
    });

    expect(consoleChatHost.isOpenChat('test-room')).toBe(true);
    expect(consoleChatHost.isOpenChat('other-room')).toBe(false);
  });

  it('isOpenChat returns false when on a different view', () => {
    appState.navigation.navigate('managedAgent', {
      serverId: 'test-server',
      agentId: 'test-agent',
      name: 'Test Agent',
      roomId: 'test-room',
    });
    appState.navigation.navigate('settings', {});

    expect(consoleChatHost.isOpenChat('test-room')).toBe(false);
  });

  it('leaveOpenChat clears roomId when on agent page with matching roomId', () => {
    appState.navigation.navigate('managedAgent', {
      serverId: 'test-server',
      agentId: 'test-agent',
      name: 'Test Agent',
      roomId: 'test-room',
    });

    expect(appState.navigation.viewParamsStore.managedAgent?.roomId).toBe('test-room');

    consoleChatHost.leaveOpenChat('test-room');

    expect(appState.navigation.currentViewId).toBe('managedAgent');
    expect(appState.navigation.viewParamsStore.managedAgent?.roomId).toBeUndefined();
    expect(appState.navigation.viewParamsStore.managedAgent?.agentId).toBe('test-agent');
  });

  it('leaveOpenChat does nothing when roomId does not match', () => {
    appState.navigation.navigate('managedAgent', {
      serverId: 'test-server',
      agentId: 'test-agent',
      name: 'Test Agent',
      roomId: 'test-room',
    });

    consoleChatHost.leaveOpenChat('other-room');

    expect(appState.navigation.viewParamsStore.managedAgent?.roomId).toBe('test-room');
  });

  it('leaveOpenChat does nothing when on a different view', () => {
    appState.navigation.navigate('managedAgent', {
      serverId: 'test-server',
      agentId: 'test-agent',
      name: 'Test Agent',
      roomId: 'test-room',
    });
    const initialRoomId = appState.navigation.viewParamsStore.managedAgent?.roomId;

    appState.navigation.navigate('settings', {});

    consoleChatHost.leaveOpenChat('test-room');

    expect(appState.navigation.currentViewId).toBe('settings');
    expect(appState.navigation.viewParamsStore.managedAgent?.roomId).toBe(initialRoomId);
  });
});
