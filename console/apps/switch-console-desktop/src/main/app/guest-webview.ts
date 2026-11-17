import type { WebPreferences } from 'electron';

/**
 * Overwrite what a `<webview>` the renderer is about to attach asked for, and
 * say why it may not attach at all, or null when it may.
 *
 * `webviewTag: true` lets renderer markup ask for a guest with whatever
 * webPreferences it likes, so the markup is not trusted: every setting that
 * widens what the guest can do is pinned here, whatever the tag said. The only
 * guest the app makes is the room view's Mattermost, so that is the only one
 * allowed: real web content, in the partition the main process prepared for
 * it and from the origin it signed in to there — never the app's own session,
 * nor one the markup chose. `embedOrigin` answers which origin a prepared
 * partition loads (`roomEmbedOrigin`).
 */
export function constrainGuest(
  webPreferences: WebPreferences,
  params: Record<string, string>,
  guestPreload: string,
  devTools: boolean,
  embedOrigin: (partition: string) => string | undefined
): string | null {
  // Never honour a preload named in markup — pin it to the one we ship.
  webPreferences.preload = guestPreload;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.experimentalFeatures = false;
  webPreferences.webviewTag = false;
  webPreferences.devTools = devTools;
  delete webPreferences.enableBlinkFeatures;
  delete webPreferences.disableBlinkFeatures;

  // Only ever embed real web content. A file:// or custom-scheme guest would
  // be running local content with a preload attached, which is not something
  // this feature needs.
  let protocol: string | null = null;
  try {
    protocol = params.src ? new URL(params.src).protocol : null;
  } catch {
    protocol = null;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return 'its source is not an http(s) page';
  const origin = params.partition ? embedOrigin(params.partition) : undefined;
  if (origin === undefined) return 'its partition is not one prepared for a room view';
  if (new URL(params.src!).origin !== origin) {
    return 'its source is not the Mattermost its partition was prepared for';
  }
  return null;
}
