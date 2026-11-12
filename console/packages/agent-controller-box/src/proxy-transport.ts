/**
 * The provider gateway's way out of a box: its upstream calls and its token
 * posts, through the box's HTTPS proxy when one is set.
 *
 * A box reaches the internet only through its egress proxy (`HTTPS_PROXY`),
 * with `NO_PROXY` naming what it reaches directly. Node's own clients ignore
 * both, so the gateway couldn't reach a provider from a box. These two
 * transports honour them: an https call to a host not in `NO_PROXY` opens a
 * tunnel through the proxy (`CONNECT host:443`), then speaks TLS to the
 * provider inside it, checking the provider's certificate as usual. The proxy
 * sees only the host name and encrypted bytes.
 *
 * Proxy credentials (`http://user:pass@proxy:3128`) are sent only as the
 * tunnel's `Proxy-Authorization` and never appear in an error or a log line:
 * every message here names the proxy by host and port at most.
 *
 * The two shapes match the gateway's `UpstreamSend` (provider-gateway.ts) and
 * `TokenPost` (vertex-tokens.ts), so either plugs in as the default.
 */
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { GATEWAY_PROXY_ENV, heldGatewayProxy } from './gateway-proxy';
import type { UpstreamSend } from './provider-gateway';
import type { TokenPost } from './vertex-tokens';

export type ProxyEnv = Readonly<Record<string, string | undefined>>;

export type ProxyTransportDeps = {
  /** Where `HTTPS_PROXY` and `NO_PROXY` are read, on every call. */
  env?: () => ProxyEnv;
  /**
   * The gateway's own proxy, used in place of `HTTPS_PROXY` when set: by
   * default the one taken from `SWITCH_CONTROLLER_GATEWAY_PROXY` at start
   * (gateway-proxy.ts). `NO_PROXY` still applies.
   */
  gatewayProxy?: () => string | null;
  /** Extra TLS options for the provider connection; only tests set these. */
  tls?: Pick<ConnectionOptions, 'ca'>;
  /** Only for tests: what to speak inside the tunnel instead of TLS. */
  secure?: (socket: Socket, host: string) => Duplex;
  /** How long a token post may take in all. */
  tokenTimeoutMs?: number;
};

/** Why a call couldn't go out; says nothing of the proxy's credentials. */
export class ProxyError extends Error {
  override name = 'ProxyError';
}

const TOKEN_TIMEOUT_MS = 30_000;
const TOKEN_BODY_MAX = 1024 * 1024;

/**
 * The proxy for this URL, or null to go direct: only https URLs use one,
 * from the gateway's own proxy when given, otherwise `HTTPS_PROXY` (or
 * `https_proxy`), unless `NO_PROXY` names the host. A proxy setting that
 * isn't an http(s) URL is refused rather than ignored, so a typo can't
 * quietly send traffic direct.
 */
export function proxyFor(url: URL, env: ProxyEnv, gatewayProxy: string | null = null): URL | null {
  if (url.protocol !== 'https:') return null;
  const own = (gatewayProxy ?? '').trim();
  const raw = own || (env.HTTPS_PROXY ?? env.https_proxy ?? '').trim();
  const name = own ? GATEWAY_PROXY_ENV : 'HTTPS_PROXY';
  if (!raw) return null;
  if (bypassed(url, env.NO_PROXY ?? env.no_proxy ?? '')) return null;
  let proxy: URL;
  try {
    proxy = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    throw new ProxyError(`${name} is not a URL`);
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:')
    throw new ProxyError(`${name} must be an http:// or https:// URL`);
  return proxy;
}

/**
 * Whether `NO_PROXY` sends this URL direct. Entries are comma or space
 * separated: `*` (everything), a host (`api.example.com`, which also covers
 * its subdomains), `.example.com` (the domain and its subdomains), an IP
 * address, and any of those with `:port`. Matching ignores case. CIDR ranges
 * are not supported and match nothing.
 */
export function bypassed(url: URL, noProxy: string): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryPort: string | null = null;
    const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
    if (withPort) {
      entry = withPort[1]!;
      entryPort = withPort[2]!;
    }
    entry = entry.replace(/^\[|\]$/g, '');
    if (entryPort !== null && entryPort !== port) continue;
    if (isIP(entry) || isIP(host)) {
      if (entry === host) return true;
      continue;
    }
    const domain = entry.replace(/^\*?\./, '');
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/** The proxy named for messages: host and port, never its credentials. */
function shown(proxy: URL): string {
  return `${proxy.hostname}:${proxy.port || (proxy.protocol === 'https:' ? '443' : '80')}`;
}

/** Opens `CONNECT host:port` through the proxy; resolves with the raw tunnel. */
function tunnel(proxy: URL, host: string, port: string, timeoutMs: number): Promise<Socket> {
  const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const headers: OutgoingHttpHeaders = { host: target };
  if (proxy.username || proxy.password) {
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    headers['proxy-authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: target,
      headers,
      agent: false,
      timeout: timeoutMs,
    });
    request.once('connect', (response, socket, head) => {
      if (response.statusCode === 200) {
        socket.setTimeout(0);
        // Bytes that came with the proxy's 200 belong to the provider: put
        // them back so the TLS (or HTTP) reader sees them first.
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
        return;
      }
      socket.destroy();
      reject(
        new ProxyError(
          `the proxy at ${shown(proxy)} refused the tunnel to ${target} (${response.statusCode ?? 'no status'})`
        )
      );
    });
    request.once('timeout', () =>
      request.destroy(new ProxyError(`the proxy at ${shown(proxy)} did not answer in time`))
    );
    request.once('error', (error) =>
      reject(
        error instanceof ProxyError
          ? error
          : new ProxyError(`could not reach the proxy at ${shown(proxy)}`)
      )
    );
    request.end();
  });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Only https leaves this process; plain http only to this machine (a stand-in
 * provider in tests). A config slip can't send a login or token in clear.
 */
function checkScheme(url: URL): void {
  if (url.protocol === 'https:') return;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol === 'http:' && LOOPBACK.has(host)) return;
  throw new ProxyError(
    `refusing a ${url.protocol} call to ${host}: only https leaves this machine`
  );
}

/**
 * Starts one request to `url`, direct or through the tunnel; resolves once the
 * request can take a body. The caller writes the body and ends it.
 */
async function open(
  url: URL,
  options: { method: string; headers: OutgoingHttpHeaders; timeoutMs: number },
  deps: ProxyTransportDeps
) {
  checkScheme(url);
  const env = (deps.env ?? (() => process.env))();
  const proxy = proxyFor(url, env, (deps.gatewayProxy ?? heldGatewayProxy)());
  const base = {
    method: options.method,
    headers: options.headers,
    timeout: options.timeoutMs,
    ...(deps.tls ?? {}),
  };
  if (proxy === null) {
    return (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, base);
  }
  const port = url.port || '443';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const socket = await tunnel(proxy, host, port, options.timeoutMs);
  const secure =
    deps.secure ??
    ((raw: Socket, servername: string) =>
      tlsConnect({
        socket: raw,
        servername: isIP(servername) ? undefined : servername,
        ALPNProtocols: ['http/1.1'],
        ...(deps.tls ?? {}),
      }));
  // No agent, only `createConnection`: this request, and only it, runs over
  // the tunnel, and nothing is pooled across tunnels. (`agent: false` would
  // make Node ignore `createConnection` and dial the provider directly.)
  return httpRequest(url, {
    ...base,
    protocol: 'http:',
    // The Host header the provider sees: its own name, with no :80 from the
    // plain-http request this rides on.
    port: Number(port),
    defaultPort: 443,
    createConnection: () => secure(socket, host) as Socket,
  });
}

/** The gateway's upstream transport, through the box's proxy when one is set. */
export function proxiedUpstreamSend(deps: ProxyTransportDeps = {}): UpstreamSend {
  return async (url, options) => {
    const request = await open(url, options, deps);
    request.on('timeout', () => request.destroy(new Error('the provider went quiet')));
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', reject);
    });
    return { request, response };
  };
}

/** The gateway's token transport: one form POST, JSON back, through the proxy when set. */
export function proxiedTokenPost(deps: ProxyTransportDeps = {}): TokenPost {
  const timeoutMs = deps.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS;
  return async (url, form) => {
    const body = new URLSearchParams(form).toString();
    const target = new URL(url);
    const work = (async () => {
      const request = await open(
        target,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
            accept: 'application/json',
          },
          timeoutMs,
        },
        deps
      );
      request.on('timeout', () => request.destroy(new Error('the token endpoint went quiet')));
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        request.once('response', resolve);
        request.once('error', reject);
        request.end(body);
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += (chunk as Buffer).length;
        if (size > TOKEN_BODY_MAX) {
          response.destroy();
          throw new Error('the token endpoint sent too much');
        }
        chunks.push(chunk as Buffer);
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        parsed = null;
      }
      return { status: response.statusCode ?? 0, body: parsed };
    })();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the token post timed out')), timeoutMs);
    });
    work.catch(() => undefined); // a late failure after the time limit is not unhandled
    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
    }
  };
}
