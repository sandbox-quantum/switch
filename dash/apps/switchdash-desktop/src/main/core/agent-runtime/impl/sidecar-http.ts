import type { Duplex } from 'node:stream';

/** Opens a duplex stream connected to `127.0.0.1:<port>` on the remote host. */
export interface SidecarChannelOpener {
  openChannel(port: number): Promise<Duplex>;
}

/**
 * A response the sidecar answered with that was not a success. Carries the
 * status because callers act on it: a 404 means the running sidecar predates
 * the endpoint, which is a different problem from an unreachable host and has a
 * different remedy.
 */
export class SidecarHttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'SidecarHttpStatusError';
  }
}

/**
 * Speak one HTTP/1.1 request directly over the provided duplex and read the
 * reply.
 *
 * We can't use `http.request` here: the sidecar listens on the REMOTE host's
 * loopback, reachable only through the SSH-forwarded channel, but `http.request`
 * ignores a per-request `createConnection` and opens its own local TCP socket —
 * which connects to 127.0.0.1 on *this* machine and fails with ECONNREFUSED.
 * `Connection: close` makes the server end the socket after the response, so we
 * read to EOF; the sidecar always sends an explicit `Content-Length`, so we
 * finish as soon as that many body bytes have arrived without de-chunking.
 *
 * `wantBody` false resolves the moment the status line has arrived, for an
 * endpoint whose reply carries nothing worth waiting for.
 */
function exchangeOverChannel(
  channel: Duplex,
  opts: { method: string; path: string; timeoutMs: number; wantBody: boolean; request: Buffer[] }
): Promise<{ status: number; body: string }> {
  const { method, path, timeoutMs, wantBody, request } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];

    const finish = (err: Error | null, value?: { status: number; body: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(() => finish(new Error(`${method} ${path} timed out`)), timeoutMs);

    /**
     * Try to read the accumulated bytes as a complete HTTP response. `atEof` is
     * true when the readable side has ended and no more bytes will arrive — only
     * then is an incomplete buffer an error. While still streaming we return
     * quietly and wait for the next chunk.
     */
    const tryParse = (atEof: boolean): void => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const sep = raw.indexOf('\r\n\r\n');
      if (sep === -1) {
        if (atEof) finish(new Error(`malformed HTTP response from sidecar ${path}`));
        return;
      }
      const head = raw.slice(0, sep);
      const statusLine = head.slice(0, head.indexOf('\r\n'));
      const status = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);
      if (!Number.isFinite(status) || status === 0) {
        finish(new Error(`${method} ${path} returned an unparseable status: ${statusLine}`));
        return;
      }
      const body = raw.slice(sep + 4);
      if (wantBody) {
        const contentLength = /content-length:\s*(\d+)/i.exec(head);
        if (contentLength) {
          if (Buffer.byteLength(body, 'utf8') < Number.parseInt(contentLength[1]!, 10)) {
            if (atEof) finish(new Error(`truncated HTTP response from sidecar ${path}`));
            return;
          }
        } else if (!atEof) {
          // No Content-Length: the body runs to EOF, so wait for end/close.
          return;
        }
      }
      finish(null, { status, body });
    };

    channel.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      tryParse(false);
    });
    channel.on('error', (err: Error) => finish(err));
    channel.on('end', () => tryParse(true));
    channel.on('close', () => tryParse(true));

    for (const part of request) channel.write(part);
  });
}

function requestHead(
  method: string,
  opts: { port: number; token: string; path: string },
  contentLength: number | null
): Buffer {
  const { port, token, path } = opts;
  return Buffer.from(
    `${method} ${path} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `x-switchdash-token: ${token}\r\n` +
      (contentLength === null
        ? ''
        : `Content-Type: application/json\r\nContent-Length: ${contentLength}\r\n`) +
      `Connection: close\r\n\r\n`,
    'utf8'
  );
}

function parseJsonBody<T>(path: string, body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(`malformed JSON body from sidecar ${path}: ${String(error)}`);
  }
}

/** GET a JSON document from the sidecar over an SSH-forwarded channel. */
export async function httpGetJsonOverChannel<T>(
  channel: Duplex,
  opts: { port: number; token: string; path: string; timeoutMs: number }
): Promise<T> {
  const { status, body } = await exchangeOverChannel(channel, {
    method: 'GET',
    path: opts.path,
    timeoutMs: opts.timeoutMs,
    wantBody: true,
    request: [requestHead('GET', opts, null)],
  });
  if (status !== 200) {
    throw new SidecarHttpStatusError(status, `GET ${opts.path} returned status ${status}`);
  }
  return parseJsonBody<T>(opts.path, body);
}

/**
 * POST a JSON body to the sidecar and resolve once a 2xx comes back. For an
 * endpoint whose reply is empty — `/disconnect` answers with a bare 200.
 */
export async function httpPostJsonOverChannel(
  channel: Duplex,
  opts: { port: number; token: string; path: string; body: unknown; timeoutMs: number }
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
  const { status } = await exchangeOverChannel(channel, {
    method: 'POST',
    path: opts.path,
    timeoutMs: opts.timeoutMs,
    wantBody: false,
    request: [requestHead('POST', opts, payload.byteLength), payload],
  });
  if (status < 200 || status >= 300) {
    throw new SidecarHttpStatusError(status, `POST ${opts.path} returned status ${status}`);
  }
}

/**
 * POST a JSON body to the sidecar and parse the JSON document it answers with.
 * For an endpoint whose reply is the point of the call — `/connection` returns
 * the id the session must be launched with.
 */
export async function httpPostForJsonOverChannel<T>(
  channel: Duplex,
  opts: { port: number; token: string; path: string; body: unknown; timeoutMs: number }
): Promise<T> {
  const payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
  const { status, body } = await exchangeOverChannel(channel, {
    method: 'POST',
    path: opts.path,
    timeoutMs: opts.timeoutMs,
    wantBody: true,
    request: [requestHead('POST', opts, payload.byteLength), payload],
  });
  if (status < 200 || status >= 300) {
    throw new SidecarHttpStatusError(status, `POST ${opts.path} returned status ${status}`);
  }
  return parseJsonBody<T>(opts.path, body);
}
