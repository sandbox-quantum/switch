/**
 * The Content-Security-Policy of the app's own window: the second layer
 * behind the markdown, Mermaid and SVG sanitizers, so a gap in one of them is
 * markup rather than script with the whole main-process bridge in reach.
 *
 * Script comes only from the app's own files — no inline script and no
 * `eval` — and nothing is sent anywhere directly: the renderer reaches every
 * server through the main process. What stays open is what the window shows:
 * inline styles (KaTeX, Mermaid and the UI library set them), images from
 * anywhere (agents' and members' messages show remote images today), and
 * http(s) frames, which is how the room view's `<webview>` attaches to its
 * Mattermost.
 */
const DIRECTIVES: Record<string, string> = {
  'default-src': "'self'",
  'script-src': "'self'",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data: blob: http: https:",
  'font-src': "'self' data:",
  'media-src': "'self' data: blob:",
  'connect-src': "'self' data: blob:",
  'frame-src': "'self' http: https:",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'frame-ancestors': "'none'",
};

function serialize(directives: Record<string, string>): string {
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

export const RENDERER_CSP = serialize(DIRECTIVES);

/**
 * The same policy for the Vite dev server, loosened only where it has to be:
 * React Fast Refresh injects an inline script, and hot reload talks over a
 * WebSocket. `eval` stays refused, so a dependency that needs it fails in
 * development rather than first in a build.
 */
export function devRendererCsp(devServerUrl: string): string {
  const { host } = new URL(devServerUrl);
  return serialize({
    ...DIRECTIVES,
    'script-src': "'self' 'unsafe-inline'",
    'connect-src': `${DIRECTIVES['connect-src']} ws://${host}`,
  });
}
