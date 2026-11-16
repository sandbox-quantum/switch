import { beforeEach, describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
const getMainWindow = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }));
vi.mock('@main/app/deeplinks', () => ({
  DEEPLINK_SCHEME: 'switchdash',
  handleDeeplinkUrl: vi.fn(),
}));
vi.mock('@main/app/window', () => ({ getMainWindow }));
vi.mock('@main/lib/events', () => ({ events: { emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const { registerServerPageLinkHandlers } = await import('./externalLinks');
const { externalLinkOpenRequestedChannel } = await import('@shared/events/appEvents');

type Navigation = { url: string; isMainFrame: boolean; preventDefault: () => void };

/** A stand-in for a window's web contents that records what was registered on it. */
function fakeContents() {
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  const listeners = new Map<string, (navigation: Navigation) => void>();
  const contents = {
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler;
    },
    on: (event: string, listener: (navigation: Navigation) => void) => {
      listeners.set(event, listener);
    },
  };
  return {
    contents,
    open: (url: string) => openHandler!({ url }),
    /** Whether the named navigation event was refused for `url`. */
    refused(event: string, url: string, isMainFrame = true): boolean {
      const preventDefault = vi.fn();
      listeners.get(event)!({ url, isMainFrame, preventDefault });
      return preventDefault.mock.calls.length > 0;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMainWindow.mockReturnValue({ isDestroyed: () => false });
});

describe('registerServerPageLinkHandlers', () => {
  it('opens no window, sending a web link to the browser through the confirmation', () => {
    const page = fakeContents();
    registerServerPageLinkHandlers(page.contents as never);

    expect(page.open('https://example.com/help')).toEqual({ action: 'deny' });
    expect(emit).toHaveBeenCalledExactlyOnceWith(externalLinkOpenRequestedChannel, {
      url: 'https://example.com/help',
    });
  });

  it('drops a window for any other scheme', () => {
    const page = fakeContents();
    registerServerPageLinkHandlers(page.contents as never);

    expect(page.open('some-app://run?x=1')).toEqual({ action: 'deny' });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each(['will-frame-navigate', 'will-redirect'])(
    'refuses %s to a scheme the OS would hand to another app, in any frame',
    (event) => {
      const page = fakeContents();
      registerServerPageLinkHandlers(page.contents as never);

      expect(page.refused(event, 'some-app://run?x=1')).toBe(true);
      expect(page.refused(event, 'some-app://run?x=1', false)).toBe(true);
      expect(page.refused(event, 'file:///etc/passwd', false)).toBe(true);
    }
  );

  it.each(['will-frame-navigate', 'will-redirect'])(
    'lets %s cross to any web origin, as a sign-in does',
    (event) => {
      const page = fakeContents();
      registerServerPageLinkHandlers(page.contents as never);

      expect(page.refused(event, 'https://idp.example/authorize?state=s')).toBe(false);
      expect(page.refused(event, 'http://localhost:41000/gateway/auth/oidc/callback')).toBe(false);
      expect(page.refused(event, 'about:blank', false)).toBe(false);
    }
  );
});
