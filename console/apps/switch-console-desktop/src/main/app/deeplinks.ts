import { resolve } from 'node:path';
import { app } from 'electron';
import { sessionDeeplinkChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { events } from '../lib/events';
import { log } from '../lib/logger';
import { getMainWindow } from './window';

/**
 * Custom URL scheme Switch Console registers with the OS. Matches the scheme the
 * Switch gateway builds (`switch_core.deeplinks.SWITCHDASH_SCHEME`): a click on
 * an https `/dl/...` link bounces here as `switchdash://session?…` and the OS
 * launches (or focuses) this app with that URL.
 */
export const DEEPLINK_SCHEME = 'switchdash';

/**
 * Opt-in env var to let an un-packaged dev build claim the `switchdash://` OS
 * handler. Off by default: registering in dev points the scheme at the bare
 * Electron binary and that registration persists in the OS (macOS Launch
 * Services) after the dev process exits, hijacking deeplinks from the installed
 * app. Set to `1` only when you specifically want to test deeplinks against the
 * dev build (and run `pnpm run deeplink:reset` afterwards to hand the scheme
 * back to the installed app).
 */
const DEV_REGISTER_DEEPLINK_ENV = 'SWITCHDASH_REGISTER_DEEPLINK';

type ParsedDeeplink = {
  server: string;
  agentId: string;
  roomId: string;
  /** Shared session id; present on links from current Switch Console builds and
   * preferred for resolution (works on any client). Empty for older links. */
  sessionId: string;
};

// A deeplink that arrived before the renderer was ready (cold start). Flushed
// once the window finishes loading; see flushPendingDeeplink.
let pending: ParsedDeeplink | null = null;

function parseSessionDeeplink(rawUrl: string): ParsedDeeplink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    log.warn('deeplink: could not parse url', { rawUrl });
    return null;
  }
  if (url.protocol !== `${DEEPLINK_SCHEME}:`) return null;
  if (url.hostname !== 'session') {
    log.warn('deeplink: unsupported target', { host: url.hostname });
    return null;
  }
  const server = url.searchParams.get('server') ?? '';
  const agentId = url.searchParams.get('agent') ?? '';
  const roomId = url.searchParams.get('room') ?? '';
  const sessionId = url.searchParams.get('session') ?? '';
  if (!server || !agentId || !roomId) {
    log.warn('deeplink: missing server/agent/room', { rawUrl });
    return null;
  }
  return { server, agentId, roomId, sessionId };
}

function focusWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Parse, focus the app, and hand the deeplink to the renderer (or buffer it
 * when the renderer isn't up yet). */
export function handleDeeplinkUrl(rawUrl: string): void {
  const parsed = parseSessionDeeplink(rawUrl);
  if (!parsed) return;
  focusWindow();
  const win = getMainWindow();
  if (win && !win.webContents.isLoading()) {
    events.emit(sessionDeeplinkChannel, parsed);
  } else {
    pending = parsed;
  }
}

/** Emit any deeplink buffered during a cold start, once the window has loaded. */
export function flushPendingDeeplink(): void {
  if (pending === null) return;
  events.emit(sessionDeeplinkChannel, pending);
  pending = null;
}

/** Pull a `switchdash://…` arg out of a process argv list (Windows/Linux pass
 * the deeplink as a launch argument rather than via the open-url event). */
function deeplinkFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${DEEPLINK_SCHEME}://`));
}

/**
 * Register the `switchdash://` scheme and wire the OS entry points:
 * - macOS delivers deeplinks via the `open-url` event (running or cold start).
 * - Windows/Linux deliver them as a process argument: on first launch in
 *   `process.argv`, and for an already-running instance via `second-instance`.
 */
export function setupDeeplinks(): void {
  // In a packaged build the OS registers the scheme from Info.plist
  // (electron-builder `protocols`). An un-packaged dev build only becomes the
  // handler via this runtime call — but doing so hijacks the scheme from the
  // installed app and the registration outlives the dev process, so it is
  // gated behind an explicit opt-in (see DEV_REGISTER_DEEPLINK_ENV). When opted
  // in, point the registration at the app entry rather than the bare Electron
  // binary — otherwise the OS launches Electron with no app (the welcome screen).
  if (!app.isPackaged) {
    if (process.env[DEV_REGISTER_DEEPLINK_ENV] === '1' && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [resolve(process.argv[1])]);
    }
  } else if (!app.isDefaultProtocolClient(DEEPLINK_SCHEME)) {
    if (!app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)) {
      log.warn('deeplink: failed to register as default protocol client');
    }
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeeplinkUrl(url);
  });

  app.on('second-instance', (_event, argv) => {
    const url = deeplinkFromArgv(argv);
    if (url) handleDeeplinkUrl(url);
  });

  const initial = deeplinkFromArgv(process.argv);
  if (initial) handleDeeplinkUrl(initial);
}
