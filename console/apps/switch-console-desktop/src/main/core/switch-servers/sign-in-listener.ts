import { createServer, type Server } from 'node:http';
import { focusMainWindow } from '@main/app/window';

/**
 * The listener on 127.0.0.1 that takes a sign-in's code back to this Console,
 * for every service's browser flow. The vendor sends the browser to it
 * directly, or Core does from its own callback. It takes one code, for the
 * state it was opened with, brings Console to the front so the next step is
 * in view, and hands the code to Core through `complete`. Neither it nor the
 * browser ever sees a token: Core exchanges the code.
 */
export type SignInListener = {
  port: number;
  close: () => void;
};

export async function listenForSignIn({
  name,
  path,
  state,
  maxCodeLength,
  ports,
  complete,
}: {
  /** The service, as the browser's page names it. */
  name: string;
  path: string;
  state: string;
  maxCodeLength: number;
  /** The ports the vendor takes a sign-in back on, or null for any. */
  ports: number[] | null;
  /** Hands the code to Core; what the browser is shown follows its outcome. */
  complete: (code: string) => Promise<void>;
}): Promise<SignInListener> {
  let received = false;
  let port = 0;
  const listener = createServer((request, response) => {
    const reply = (status: number, message: string) => {
      response.writeHead(status, {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Content-Type': 'text/html; charset=utf-8',
      });
      response.end(page(name, message));
    };
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      reply(400, 'Invalid sign-in response.');
      return;
    }
    const code = url.searchParams.get('code');
    if (
      received ||
      request.method !== 'GET' ||
      url.origin !== `http://127.0.0.1:${port}` ||
      request.headers.host !== `127.0.0.1:${port}` ||
      url.pathname !== path ||
      url.searchParams.get('state') !== state ||
      !code ||
      code.length > maxCodeLength
    ) {
      reply(
        400,
        'This connection was not started by this Switch Console. Return to the computer where you started it.'
      );
      return;
    }
    received = true;
    listener.close();
    focusMainWindow();
    void complete(code).then(
      () => reply(200, `Signed in to ${name}, and connected to Switch. This tab can be closed.`),
      () =>
        reply(
          400,
          `Switch could not finish signing in to ${name}. Switch Console says what happened.`
        )
    );
  });
  await listenOn(listener, name, ports);
  const address = listener.address();
  if (!address || typeof address === 'string') {
    listener.close();
    throw new Error('Could not open the local sign-in callback.');
  }
  port = address.port;
  return { port, close: () => listener.close() };
}

/**
 * Listen on loopback: on any port, or on the first free one of `ports`, for a
 * vendor that takes a sign-in back only on the ports Switch registered.
 */
async function listenOn(listener: Server, name: string, ports: number[] | null): Promise<void> {
  for (const port of ports ?? [0]) {
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', () => {
          listener.off('error', reject);
          resolve();
        });
      });
      return;
    } catch (error) {
      if (ports === null || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(
    `${name} takes a sign-in back only on port ${(ports ?? []).join(', ')} of this computer, and all are in use. Close whatever is using them, and connect again.`
  );
}

function page(name: string, message: string): string {
  const title = escapeHtml(`Switch · ${name}`);
  return (
    '<!doctype html><html lang=en><meta charset=utf-8>' +
    "<meta name=viewport content='width=device-width'>" +
    `<title>${title}</title><body><main><h1>${title}</h1><p>${escapeHtml(message)}</p></main></body></html>`
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
