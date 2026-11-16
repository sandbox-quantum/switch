import { join, normalize, sep } from 'node:path';
import { net, protocol } from 'electron';
import { APP_NAME_LOWER } from '@shared/app-identity';

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
      return await net.fetch(`file://${resolved}`);
    } catch {
      return net.fetch(`file://${join(root, 'index.html')}`);
    }
  });
}
