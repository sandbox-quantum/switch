import { join, normalize, sep } from 'node:path';
import { net, protocol, session } from 'electron';
import { APP_NAME_LOWER } from '@shared/app-identity';
import { devRendererCsp, RENDERER_CSP } from './content-security-policy';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_NAME_LOWER}`;

/**
 * Whether `url` is a page of the app's own renderer: the Vite dev server in
 * development, the app scheme in a build.
 */
export function isAppRendererUrl(url: string): boolean {
  const renderer = new URL(import.meta.env.DEV ? process.env.ELECTRON_RENDERER_URL! : APP_ORIGIN);
  try {
    const candidate = new URL(url);
    return candidate.protocol === renderer.protocol && candidate.host === renderer.host;
  } catch {
    return false;
  }
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** Serve the response with the window's Content-Security-Policy attached. */
function withRendererCsp(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', RENDERER_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function setupAppProtocol(rendererRoot: string): void {
  const root = normalize(rendererRoot);

  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const relPath = decodeURIComponent(pathname).replace(/^\/+/, '');
    const resolved = normalize(join(root, relPath || 'index.html'));

    if (!resolved.startsWith(root + sep) && resolved !== root) {
      return new Response(null, { status: 403 });
    }

    try {
      return withRendererCsp(await net.fetch(`file://${resolved}`));
    } catch {
      return withRendererCsp(await net.fetch(`file://${join(root, 'index.html')}`));
    }
  });
}

/**
 * In development the window loads from the Vite dev server rather than the
 * app scheme, so the policy is attached to that server's responses instead.
 */
export function setupDevRendererCsp(devServerUrl: string): void {
  const policy = devRendererCsp(devServerUrl);
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${new URL(devServerUrl).origin}/*`] },
    (details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
      });
    }
  );
}
