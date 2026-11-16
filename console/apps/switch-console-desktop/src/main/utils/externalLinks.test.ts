import { beforeEach, describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
const getMainWindow = vi.hoisted(() => vi.fn());
const handleDeeplinkUrl = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }));
vi.mock('@main/app/deeplinks', () => ({ DEEPLINK_SCHEME: 'switchdash', handleDeeplinkUrl }));
vi.mock('@main/app/protocol', () => ({
  isAppRendererUrl: (url: string) => url.startsWith('app://switchdash/'),
}));
vi.mock('@main/app/window', () => ({ getMainWindow }));
vi.mock('@main/lib/events', () => ({ events: { emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const { registerExternalLinkHandlers, registerGuestLinkHandlers, registerServerPageLinkHandlers } =
  await import('./externalLinks');
const { externalLinkOpenRequestedChannel } = await import('@shared/events/appEvents');

type Navigation = { url: string; isMainFrame: boolean; preventDefault: () => void };
type NavigationListener = (navigation: Navigation, url?: string) => void;

/** A stand-in for a window's web contents that records what was registered on it. */
function fakeContents() {
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  const listeners = new Map<string, NavigationListener>();
  const contents = {
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler;
    },
    on: (event: string, listener: NavigationListener) => {
      listeners.set(event, listener);
    },
    getURL: () => 'https://chat.example.com/team/channels/room',
    loadURL: vi.fn(async () => {}),
  };
  return {
    contents,
    open: (url: string) => openHandler!({ url }),
    /** Whether the named navigation event was refused for `url`. */
    refused(event: string, url: string, isMainFrame = true): boolean {
      const preventDefault = vi.fn();
      // `will-navigate` still passes the URL as its second argument.
      listeners.get(event)!({ url, isMainFrame, preventDefault }, url);
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

describe('registerExternalLinkHandlers', () => {
  function appWindow() {
    const page = fakeContents();
    registerExternalLinkHandlers({ webContents: page.contents } as never);
    return page;
  }

  it('never opens a window, whatever the link', () => {
    const page = appWindow();
    for (const url of [
      'https://example.com',
      'app://switchdash/index.html',
      'mailto:someone@example.com',
      'some-app://run',
      'switchdash://open/rooms/r1',
    ]) {
      expect(page.open(url)).toEqual({ action: 'deny' });
    }
  });

  it('sends a web link to the browser through the confirmation', () => {
    const page = appWindow();
    page.open('https://example.com/docs');
    expect(emit).toHaveBeenCalledExactlyOnceWith(externalLinkOpenRequestedChannel, {
      url: 'https://example.com/docs',
    });
  });

  it('follows a link to a Console page in the app rather than through the OS', () => {
    const page = appWindow();
    page.open('switchdash://open/rooms/r1');
    expect(handleDeeplinkUrl).toHaveBeenCalledExactlyOnceWith('switchdash://open/rooms/r1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('drops a window for any other scheme', () => {
    const page = appWindow();
    page.open('some-app://run');
    expect(emit).not.toHaveBeenCalled();
    expect(handleDeeplinkUrl).not.toHaveBeenCalled();
  });

  it('keeps the window on the app, routing web and Console links away from it', () => {
    const page = appWindow();
    expect(page.refused('will-navigate', 'app://switchdash/index.html#/rooms')).toBe(false);
    expect(page.refused('will-navigate', 'https://example.com')).toBe(true);
    expect(page.refused('will-navigate', 'switchdash://open/rooms/r1')).toBe(true);
    expect(handleDeeplinkUrl).toHaveBeenCalledOnce();
  });
});

describe('registerGuestLinkHandlers', () => {
  it('refuses a subframe navigating to a custom scheme', () => {
    const guest = fakeContents();
    registerGuestLinkHandlers(guest.contents as never);

    expect(guest.refused('will-frame-navigate', 'some-app://run', false)).toBe(true);
    expect(guest.refused('will-frame-navigate', 'https://cdn.example.com/embed', false)).toBe(
      false
    );
  });

  it('leaves the main frame to will-navigate, which routes Console links', () => {
    const guest = fakeContents();
    registerGuestLinkHandlers(guest.contents as never);

    expect(guest.refused('will-frame-navigate', 'switchdash://open/rooms/r1')).toBe(false);
    expect(guest.refused('will-navigate', 'switchdash://open/rooms/r1')).toBe(true);
    expect(handleDeeplinkUrl).toHaveBeenCalledExactlyOnceWith('switchdash://open/rooms/r1');
  });

  it('refuses a redirect to a custom scheme in any frame', () => {
    const guest = fakeContents();
    registerGuestLinkHandlers(guest.contents as never);

    expect(guest.refused('will-redirect', 'some-app://run')).toBe(true);
    expect(guest.refused('will-redirect', 'some-app://run', false)).toBe(true);
    expect(guest.refused('will-redirect', 'https://chat.example.com/login')).toBe(false);
  });
});
