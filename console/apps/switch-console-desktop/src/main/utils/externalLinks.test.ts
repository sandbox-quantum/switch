import { describe, expect, it, vi } from 'vitest';

// No window of the app opens or moves to local content: a chat attachment's
// object URL, or a local file, there would run with that window's privileges,
// the main window's preload bridge included.

const emit = vi.hoisted(() => vi.fn());
const handleDeeplinkUrl = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }));
vi.mock('@main/app/deeplinks', () => ({ DEEPLINK_SCHEME: 'switchdash', handleDeeplinkUrl }));
vi.mock('@main/app/protocol', () => ({ APP_ORIGIN: 'app://switch' }));
vi.mock('@main/app/window', () => ({ getMainWindow: () => ({ isDestroyed: () => false }) }));
vi.mock('@main/lib/events', () => ({ events: { emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const { guardLocalContent, registerExternalLinkHandlers, registerGuestLinkHandlers } =
  await import('./externalLinks');

type OpenHandler = (details: { url: string }) => { action: 'allow' | 'deny' };
type NavigateHandler = (event: { preventDefault: () => void }, url: string) => void;

/** A web contents whose handlers can be driven: `open` gives the action, `moves` whether a navigation goes ahead. */
function contents(currentUrl = 'app://switch/index.html') {
  let open: OpenHandler = () => ({ action: 'allow' });
  const navigate: NavigateHandler[] = [];
  const wc = {
    getURL: () => currentUrl,
    loadURL: vi.fn(async () => {}),
    setWindowOpenHandler: (handler: OpenHandler) => {
      open = handler;
    },
    on: (_event: 'will-navigate', handler: NavigateHandler) => {
      navigate.push(handler);
    },
  };
  const moves = (url: string) => {
    const preventDefault = vi.fn();
    for (const handler of navigate) handler({ preventDefault }, url);
    return preventDefault.mock.calls.length === 0;
  };
  return { wc, open: (url: string) => open({ url }).action, moves };
}

function mainWindow(isDev = false) {
  const c = contents();
  registerExternalLinkHandlers({ webContents: c.wc } as never, isDev);
  return c;
}

const LOCAL = [
  'blob:app://switch/0b0e7f0a-1111-2222-3333-444455556666',
  'data:text/html,<script>1</script>',
  'javascript:alert(1)',
  'filesystem:app://switch/temporary/x.html',
  'file:///etc/hosts',
];

describe('the main window', () => {
  it.each(LOCAL)('never opens a window on %s', (url) => {
    expect(mainWindow().open(url)).toBe('deny');
  });

  it.each(LOCAL)('never moves to %s', (url) => {
    expect(mainWindow().moves(url)).toBe(false);
  });

  it.each([
    'app://x/page',
    'foo:bar',
    'ftp://example.com/x',
    'mailtox:someone@example.com',
    'chrome://settings',
  ])('refuses any other scheme too: %s', (url) => {
    const win = mainWindow();
    expect(win.open(url)).toBe('deny');
    expect(win.moves(url)).toBe(false);
    expect(emit).not.toHaveBeenCalledWith(expect.anything(), { url });
  });

  it('opens and moves within the app itself, as before', () => {
    const win = mainWindow();
    expect(win.open('app://switch/index.html#/chats')).toBe('allow');
    expect(win.moves('app://switch/index.html#/settings')).toBe(true);
  });

  it('in development, the renderer address is the app', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    expect(mainWindow(true).moves('http://localhost:5173/#/chats')).toBe(true);
    expect(mainWindow(true).open('blob:http://localhost:5173/abc')).toBe('deny');
    vi.unstubAllEnvs();
  });

  it('packaged, a localhost page is a web page: to the browser, never a window with the preload', () => {
    emit.mockClear();
    const win = mainWindow();
    for (const url of ['http://localhost:8080/', 'http://127.0.0.1:5173/#/x']) {
      expect(win.open(url)).toBe('deny');
      expect(win.moves(url)).toBe(false);
    }
    expect(emit).toHaveBeenCalledTimes(4);
  });

  it('in development, only the renderer address is the app; another localhost page goes to the browser', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
    emit.mockClear();
    const win = mainWindow(true);
    expect(win.open('http://localhost:5173/#/chats')).toBe('allow');
    expect(win.open('http://localhost:8080/')).toBe('deny');
    expect(emit).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it('sends a web link to the browser (after a confirm), as before', () => {
    emit.mockClear();
    const win = mainWindow();
    expect(win.open('https://example.com/docs')).toBe('deny');
    expect(win.moves('https://example.com/docs')).toBe(false);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('sends an email link to the same confirm (then the mail app), as it opened before the lockdown', () => {
    emit.mockClear();
    const win = mainWindow();
    for (const url of ['mailto:someone@example.com', 'MAILTO:someone@example.com?subject=Hi']) {
      expect(win.open(url)).toBe('deny');
      expect(win.moves(url)).toBe(false);
      expect(emit).toHaveBeenCalledWith(expect.anything(), { url });
    }
    expect(emit).toHaveBeenCalledTimes(4);
  });

  it('handles our own deeplinks in-process, as for a room-view guest', () => {
    handleDeeplinkUrl.mockClear();
    const win = mainWindow();
    expect(win.open('switchdash://session/abc')).toBe('deny');
    expect(win.moves('switchdash://session/abc')).toBe(false);
    expect(handleDeeplinkUrl).toHaveBeenCalledTimes(2);
  });
});

describe('guardLocalContent (every web contents the app creates)', () => {
  it.each(LOCAL)('never opens a window on, nor moves to, %s', (url) => {
    const c = contents('https://login.example.com/');
    guardLocalContent(c.wc as never);
    expect(c.open(url)).toBe('deny');
    expect(c.moves(url)).toBe(false);
  });

  it('leaves everything else to the window (a sign-in page still moves and opens as before)', () => {
    const c = contents('https://login.example.com/');
    guardLocalContent(c.wc as never);
    expect(c.open('https://login.example.com/popup')).toBe('allow');
    expect(c.moves('https://idp.example.com/authorize')).toBe(true);
  });
});

describe('a room-view guest', () => {
  it.each(LOCAL)('never opens a window on, nor moves to, %s', (url) => {
    const c = contents('https://chat.example.com/team/channels/town');
    registerGuestLinkHandlers(c.wc as never);
    expect(c.open(url)).toBe('deny');
    expect(c.moves(url)).toBe(false);
    expect(c.wc.loadURL).not.toHaveBeenCalled();
  });

  it('still moves within its own site, as before', () => {
    const c = contents('https://chat.example.com/team/channels/town');
    registerGuestLinkHandlers(c.wc as never);
    expect(c.moves('https://chat.example.com/team/channels/other')).toBe(true);
  });
});
