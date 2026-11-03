import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isTestBuild: false,
  setAsDefaultProtocolClient: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    isDefaultProtocolClient: () => false,
    setAsDefaultProtocolClient: h.setAsDefaultProtocolClient,
    on: vi.fn(),
  },
}));
vi.mock('@shared/app-identity', () => ({
  get IS_TEST_BUILD() {
    return h.isTestBuild;
  },
}));
vi.mock('../lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('../lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('./window', () => ({ focusMainWindow: vi.fn(), getMainWindow: vi.fn() }));

import { setupDeeplinks } from './deeplinks';

beforeEach(() => {
  h.setAsDefaultProtocolClient.mockClear();
});

describe('the switchdash:// scheme in a packaged build', () => {
  it('is claimed by the everyday Console', () => {
    h.isTestBuild = false;
    setupDeeplinks();
    expect(h.setAsDefaultProtocolClient).toHaveBeenCalledWith('switchdash');
  });

  it('is never claimed by a test build, so links keep opening the everyday Console', () => {
    h.isTestBuild = true;
    setupDeeplinks();
    expect(h.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});
