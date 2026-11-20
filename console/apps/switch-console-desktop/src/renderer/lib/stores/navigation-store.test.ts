import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/modal/modal-store', () => ({
  modalStore: { closeModal: vi.fn() },
}));

vi.mock('./app-state', () => ({
  appState: {
    history: { push: vi.fn() },
  },
}));

const { NavigationStore } = await import('./navigation-store');
const { appState } = await import('./app-state');

function buildStore() {
  const store = new NavigationStore();
  store.registerView('noServer');
  store.registerView('location');
  store.registerView('session');
  store.registerView('settings');
  store.registerView('managedAgent');
  return store;
}

describe('NavigationStore.restoreSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores a snapshot whose view is registered', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'location',
      viewParams: { location: { locationId: 'p1' } },
    });
    expect(store.currentViewId).toBe('location');
    expect(store.viewParamsStore.location).toEqual({ locationId: 'p1' });
    expect(store.lastNonSettingsView).toBe('location');
  });

  it('falls back to home when the persisted view is not in the registry', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'phantom-view-from-old-build',
      viewParams: { location: { locationId: 'p1' } },
    });
    expect(store.currentViewId).toBe('noServer');
    expect(store.lastNonSettingsView).toBe('noServer');
  });

  it('strips viewParams entries whose key is not a registered view', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'noServer',
      viewParams: {
        location: { locationId: 'p1' },
        ghostView: { stale: true },
      },
    });
    expect(store.viewParamsStore.location).toEqual({ locationId: 'p1' });
    expect((store.viewParamsStore as Record<string, unknown>).ghostView).toBeUndefined();
  });

  it('does not touch lastNonSettingsView when the persisted view is settings', () => {
    const store = buildStore();
    store.restoreSnapshot({ currentViewId: 'settings' });
    expect(store.currentViewId).toBe('settings');
    expect(store.lastNonSettingsView).toBe('noServer');
  });

  it('honors a guard redirect after a valid view is restored', () => {
    const store = buildStore();
    store.registerGuard('location', () => ({ ok: false, redirect: 'noServer' }));
    store.restoreSnapshot({
      currentViewId: 'location',
      viewParams: { location: { locationId: 'gone' } },
    });
    expect(store.currentViewId).toBe('noServer');
  });
});

describe('NavigationStore agent selection', () => {
  const first = { serverId: 'server', agentId: 'first', name: 'First' };
  const second = { serverId: 'server', agentId: 'second', name: 'Second' };

  it('returns to each agent’s last open chat and keeps its current name', () => {
    const store = buildStore();
    store.navigate('managedAgent', first);
    store.updateViewParams('managedAgent', { roomId: 'older-chat' });
    store.navigate('managedAgent', second);
    expect(store.viewParamsStore.managedAgent).toEqual(second);
    store.updateViewParams('managedAgent', { roomId: 'second-chat' });
    store.navigate('managedAgent', { ...first, name: 'Renamed' });
    expect(store.viewParamsStore.managedAgent).toEqual({
      ...first,
      name: 'Renamed',
      roomId: 'older-chat',
    });
    expect(appState.history.push).toHaveBeenLastCalledWith({
      kind: 'view',
      viewId: 'managedAgent',
      params: store.viewParamsStore.managedAgent,
    });
    store.navigate('managedAgent', second);
    expect(store.viewParamsStore.managedAgent?.roomId).toBe('second-chat');
  });

  it('does not reuse a selection from another server', () => {
    const store = buildStore();
    store.navigate('managedAgent', { ...first, roomId: 'chat' });
    store.navigate('managedAgent', { ...first, serverId: 'another-server' });
    expect(store.viewParamsStore.managedAgent?.roomId).toBeUndefined();
  });

  it('honors explicit chats, rooms, sections, and cleared selections', () => {
    const store = buildStore();
    for (const selection of [
      { roomId: 'linked-chat' },
      { room: 'linked-room' },
      { section: 'connections' as const },
      { roomId: undefined },
    ]) {
      store.navigate('managedAgent', { ...first, roomId: 'old-chat' });
      store.navigate('managedAgent', second);
      store.navigate('managedAgent', { ...first, ...selection });
      expect(store.viewParamsStore.managedAgent).toEqual({ ...first, ...selection });
    }
  });

  it('does not remember a navigation refused by a leave guard', async () => {
    const store = buildStore();
    store.navigate('managedAgent', { ...first, roomId: 'kept' });
    store.setLeaveGuard(() => Promise.resolve(false));
    store.navigate('managedAgent', { ...first, roomId: 'refused' });
    await Promise.resolve();
    store.setLeaveGuard(null);
    store.navigate('managedAgent', second);
    store.navigate('managedAgent', first);
    expect(store.viewParamsStore.managedAgent?.roomId).toBe('kept');
  });

  it('keeps a background chat when its unsaved id becomes a saved room id', () => {
    const store = buildStore();
    store.navigate('managedAgent', { ...first, roomId: 'unsaved:first' });
    store.navigate('managedAgent', {
      ...second,
      serverId: 'other-server',
      roomId: 'unsaved:first',
    });
    store.replaceAgentChatRoomId('server', 'unsaved:first', 'saved-chat');
    store.navigate('managedAgent', first);
    expect(store.viewParamsStore.managedAgent?.roomId).toBe('saved-chat');
    store.navigate('managedAgent', { ...second, serverId: 'other-server' });
    expect(store.viewParamsStore.managedAgent?.roomId).toBe('unsaved:first');
  });

  it('keeps both agents’ new draft chats instead of opening their saved chats', () => {
    const store = buildStore();
    store.navigate('managedAgent', { ...first, roomId: 'saved-first' });
    store.updateViewParams('managedAgent', { roomId: 'unsaved-chat:first' });
    store.navigate('managedAgent', { ...second, roomId: 'saved-second' });
    store.updateViewParams('managedAgent', { roomId: 'unsaved-chat:second' });
    store.navigate('managedAgent', first);
    expect(store.viewParamsStore.managedAgent?.roomId).toBe('unsaved-chat:first');
    store.navigate('managedAgent', second);
    expect(store.viewParamsStore.managedAgent?.roomId).toBe('unsaved-chat:second');
  });

  it('restores the selected chat from a navigation snapshot', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'managedAgent',
      viewParams: { managedAgent: { ...first, roomId: 'restored-chat' } },
    });
    store.navigate('managedAgent', second);
    store.navigate('managedAgent', first);
    expect(store.viewParamsStore.managedAgent?.roomId).toBe('restored-chat');
  });

  it('remembers room and section selections without carrying a previous chat', () => {
    const store = buildStore();
    store.navigate('managedAgent', { ...first, roomId: 'chat' });
    store.updateViewParams('managedAgent', { roomId: undefined, room: 'room' });
    store.navigate('managedAgent', second);
    store.navigate('managedAgent', first);
    expect(store.viewParamsStore.managedAgent).toEqual({
      ...first,
      roomId: undefined,
      room: 'room',
    });
    store.updateViewParams('managedAgent', { room: undefined, section: 'connections' });
    store.navigate('managedAgent', second);
    store.navigate('managedAgent', first);
    expect(store.viewParamsStore.managedAgent?.section).toBe('connections');
    expect(store.viewParamsStore.managedAgent?.room).toBeUndefined();
  });
});

describe('NavigationStore leave guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates at once when no guard is set', () => {
    const store = buildStore();
    store.navigate('location', { locationId: 'p1' });
    expect(store.currentViewId).toBe('location');
  });

  it('holds a navigation until the guard lets it through', async () => {
    const store = buildStore();
    let answer!: (ok: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    store.setLeaveGuard(guard);
    store.navigate('location', { locationId: 'p1' });
    expect(guard).toHaveBeenCalledWith('location', { locationId: 'p1' });
    expect(store.currentViewId).toBe('noServer');
    answer(true);
    await vi.waitFor(() => expect(store.currentViewId).toBe('location'));
  });

  it('stays when the guard refuses', async () => {
    const store = buildStore();
    store.setLeaveGuard(() => Promise.resolve(false));
    store.navigate('location', { locationId: 'p1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.currentViewId).toBe('noServer');
  });

  it("guards a change to the current view's params, and not to another view's", async () => {
    const store = buildStore();
    store.navigate('location', { locationId: 'p1' });
    store.setLeaveGuard(() => Promise.resolve(false));
    store.updateViewParams('location', { locationId: 'p2' });
    store.updateViewParams('session', { sessionId: 's1' } as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.viewParamsStore.location).toEqual({ locationId: 'p1' });
    expect(store.viewParamsStore.session).toEqual({ sessionId: 's1' });
  });
});
