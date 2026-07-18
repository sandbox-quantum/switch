import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionCommandProvider } from './commands';

const mocks = vi.hoisted(() => ({
  getRegisteredSessionData: vi.fn(),
  getSessionStore: vi.fn(),
  navigate: vi.fn(),
  setPinned: vi.fn(),
  visibleSessionEntries: [
    { locationId: 'project-1', sessionId: 'session-1' },
    { locationId: 'project-1', sessionId: 'session-2' },
  ],
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getRegisteredSessionData: mocks.getRegisteredSessionData,
  getSessionStore: mocks.getSessionStore,
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      navigate: mocks.navigate,
    },
  },
  sidebarStore: {
    get visibleSessionEntries() {
      return mocks.visibleSessionEntries;
    },
  },
}));

describe('createSessionCommandProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionStore.mockReturnValue({
      state: 'provisioned',
      setPinned: mocks.setPinned,
    });
    mocks.getRegisteredSessionData.mockReturnValue({
      id: 'session-1',
      isPinned: false,
    });
    mocks.visibleSessionEntries = [
      { locationId: 'project-1', sessionId: 'session-1' },
      { locationId: 'project-1', sessionId: 'session-2' },
    ];
  });

  it('returns no commands when the session is not provisioned', () => {
    mocks.getSessionStore.mockReturnValue({ state: 'unprovisioned' });
    const provider = createSessionCommandProvider('project-1', 'session-1');
    expect(provider.getCommands()).toEqual([]);
  });

  it('exposes a pin command that toggles the pinned state', () => {
    const provider = createSessionCommandProvider('project-1', 'session-1');

    const command = provider.getCommands().find((candidate) => candidate.id === 'session.pin');

    expect(command?.label).toBe('Pin Session');
    command?.execute();
    expect(mocks.setPinned).toHaveBeenCalledWith(true);
  });

  it('navigates to the next visible session across project boundaries', () => {
    mocks.visibleSessionEntries = [
      { locationId: 'project-1', sessionId: 'session-1' },
      { locationId: 'project-2', sessionId: 'session-2' },
    ];
    const provider = createSessionCommandProvider('project-1', 'session-1');

    const command = provider
      .getCommands()
      .find((candidate) => candidate.id === 'session.nextSession');

    expect(command?.enabled).toBe(true);
    command?.execute();

    expect(mocks.navigate).toHaveBeenCalledWith('session', {
      locationId: 'project-2',
      sessionId: 'session-2',
    });
  });

  it('navigates to the previous visible session across project boundaries', () => {
    mocks.visibleSessionEntries = [
      { locationId: 'project-1', sessionId: 'session-1' },
      { locationId: 'project-2', sessionId: 'session-2' },
    ];
    const provider = createSessionCommandProvider('project-2', 'session-2');

    const command = provider
      .getCommands()
      .find((candidate) => candidate.id === 'session.prevSession');

    expect(command?.enabled).toBe(true);
    command?.execute();

    expect(mocks.navigate).toHaveBeenCalledWith('session', {
      locationId: 'project-1',
      sessionId: 'session-1',
    });
  });
});
