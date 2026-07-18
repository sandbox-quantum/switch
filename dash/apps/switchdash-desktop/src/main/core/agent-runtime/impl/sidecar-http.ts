import type { Duplex } from 'node:stream';

/** Opens a duplex stream connected to `127.0.0.1:<port>` on the remote host. */
export interface SidecarChannelOpener {
  openChannel(port: number): Promise<Duplex>;
}

/**
 * Speak HTTP/1.1 GET directly over the provided duplex and parse the JSON body.
 *
 * We can't use `http.request` here: the sidecar listens on the REMOTE host's
 * loopback, reachable only through the SSH-forwarded channel, but `http.request`
 * ignores a per-request `createConnection` and opens its own local TCP socket —
 * which connects to 127.0.0.1 on *this* machine and fails with ECONNREFUSED.
 * `Connection: close` makes the server end the socket after the response, so we
 * read to EOF; the sidecar always sends an explicit `Content-Length`, so we
 * finish as soon as that many body bytes have arrived without de-chunking.
 */
export function httpGetJsonOverChannel<T>(
  channel: Duplex,
  opts: { port: number; token: string; path: string; timeoutMs: number }
): Promise<T> {
  const { port, token, path, timeoutMs } = opts;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];

    const finish = (err: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(() => finish(new Error(`GET ${path} timed out`)), timeoutMs);

    /**
     * Try to parse the accumulated bytes as a complete HTTP response. `atEof` is
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
      if (status !== 200) {
        finish(new Error(`GET ${path} returned status ${status || statusLine}`));
        return;
      }
      const body = raw.slice(sep + 4);
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
      try {
        finish(null, JSON.parse(body) as T);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    channel.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      tryParse(false);
    });
    channel.on('error', (err: Error) => finish(err));
    channel.on('end', () => tryParse(true));
    channel.on('close', () => tryParse(true));

    channel.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `x-switchdash-token: ${token}\r\n` +
        `Connection: close\r\n\r\n`
    );
  });
}

/**
 * Speak HTTP/1.1 POST directly over the provided duplex, sending a JSON body,
 * and resolve once a 2xx response is received. Same transport constraints as
 * `httpGetJsonOverChannel` (the sidecar is on the remote loopback), but we only
 * need the status — the sidecar's `/disconnect` replies with an empty 200 body.
 */
export function httpPostJsonOverChannel(
  channel: Duplex,
  opts: { port: number; token: string; path: string; body: unknown; timeoutMs: number }
): Promise<void> {
  const { port, token, path, body, timeoutMs } = opts;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];

    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => finish(new Error(`POST ${path} timed out`)), timeoutMs);

    const tryParse = (atEof: boolean): void => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const sep = raw.indexOf('\r\n\r\n');
      if (sep === -1) {
        if (atEof) finish(new Error(`malformed HTTP response from sidecar ${path}`));
        return;
      }
      const statusLine = raw.slice(0, raw.indexOf('\r\n'));
      const status = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);
      if (status >= 200 && status < 300) finish(null);
      else finish(new Error(`POST ${path} returned status ${status || statusLine}`));
    };

    channel.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      tryParse(false);
    });
    channel.on('error', (err: Error) => finish(err));
    channel.on('end', () => tryParse(true));
    channel.on('close', () => tryParse(true));

    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    channel.write(
      `POST ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `x-switchdash-token: ${token}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${payload.byteLength}\r\n` +
        `Connection: close\r\n\r\n`
    );
    channel.write(payload);
  });
}
