import { createServer, type Server } from 'node:http';
import { focusMainWindow } from '@main/app/window';

/**
 * The listener on 127.0.0.1 that takes a sign-in's code back to this Console,
 * for every service's browser flow. The vendor sends the browser to it
 * directly, or Core does from its own callback. It takes one code, for the
 * state it was opened with, brings Console to the front so the next step is
 * in view, and hands the code to Core through `complete`. A vendor that sends
 * the browser back with an error instead ends the sign-in the same way, once:
 * the refusal goes to `refuse`, and the browser's page says what the vendor
 * said. Neither it nor the browser ever sees a token: Core exchanges the code.
 */
export type SignInListener = {
  port: number;
  close: () => void;
};

/** What the vendor sent back in place of a code, fit to show and to send on. */
export type VendorRefusal = {
  /** Its OAuth `error` code. */
  error: string;
  /** Its `error_description`, when it gave one. */
  description: string | null;
  /** The refusal as the person reads it. */
  message: string;
};

const MAX_VENDOR_DESCRIPTION = 300;
const MAX_VENDOR_ERROR = 64;

export async function listenForSignIn({
  name,
  path,
  state,
  maxCodeLength,
  ports,
  complete,
  refuse,
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
  /** Records the vendor's refusal; the browser is shown it whatever the outcome. */
  refuse: (refusal: VendorRefusal) => Promise<void>;
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
    const ours =
      !received &&
      request.method === 'GET' &&
      url.origin === `http://127.0.0.1:${port}` &&
      request.headers.host === `127.0.0.1:${port}` &&
      url.pathname === path &&
      url.searchParams.get('state') === state;
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (ours && code === null && error !== null) {
      received = true;
      listener.close();
      focusMainWindow();
      const refusal = vendorRefusal(name, error, url.searchParams.get('error_description'));
      const show = () => reply(400, `${refusal.message} Return to Switch Console.`);
      void refuse(refusal).then(show, show);
      return;
    }
    if (!ours || !code || code.length > maxCodeLength) {
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

/**
 * The vendor's refusal, worded as Core words it (`vendor_refusal` in
 * `connections/sign_in_flows.py`): a bare `access_denied` is the person
 * declining at the vendor; anything else is the vendor refusing, in its own
 * words where it gave any.
 */
export function vendorRefusal(
  name: string,
  error: string,
  description: string | null
): VendorRefusal {
  const said = vendorText(description ?? '', MAX_VENDOR_DESCRIPTION);
  const code = vendorText(error, MAX_VENDOR_ERROR);
  let message: string;
  if (said) message = `${name} refused the sign-in: ${said}${/[.!?…]$/.test(said) ? '' : '.'}`;
  else if (code === '' || code === 'access_denied') message = `${name} sign-in was cancelled.`;
  else message = `${name} refused the sign-in (${code}).`;
  return { error: code, description: said || null, message };
}

/**
 * What a vendor wrote, fit to show a person: without markup or control
 * characters, on one line, and at most `limit` characters long.
 */
function vendorText(text: string, limit: number): string {
  const plain = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(plain);
  return chars.length <= limit
    ? plain
    : `${chars
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`;
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
