import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, connect, createServer as createNetServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetGatewayProxy, GATEWAY_PROXY_ENV, takeGatewayProxy } from './gateway-proxy';
import {
  bypassed,
  ProxyError,
  proxiedTokenPost,
  proxiedUpstreamSend,
  proxyFor,
} from './proxy-transport';

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  forgetGatewayProxy();
});

async function listen<T extends Server | ReturnType<typeof createNetServer>>(server: T) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push({
    close: () => {
      (server as Server).closeAllConnections?.();
      server.close();
    },
  });
  return (server.address() as AddressInfo).port;
}

/** The provider: a plain HTTP server (the tunnel's TLS is swapped out in these tests). */
async function provider() {
  const seen: {
    method: string;
    url: string;
    host: string;
    body: string;
    headers: IncomingMessage['headers'];
  }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({
      method: req.method!,
      url: req.url!,
      host: req.headers.host!,
      body,
      headers: req.headers,
    });
    if (req.url === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'stand-in', expires_in: 3599 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    res.end('data: two\n\n');
  });
  return { port: await listen(server), seen };
}

/** A stand-in CONNECT proxy: records each tunnel asked for, and joins it to `to`. */
async function connectProxy(to: number, refuse = false) {
  const tunnels: { target: string; auth: string | undefined }[] = [];
  const server = createServer();
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    tunnels.push({ target: req.url!, auth: req.headers['proxy-authorization'] });
    if (refuse) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(to, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return { port: await listen(server), tunnels };
}

/** Plain bytes inside the tunnel, so the stand-in provider can be plain HTTP. */
const plain = { secure: (socket: Socket) => socket };

async function read(response: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of response) text += chunk;
  return text;
}

describe('the proxy transport', () => {
  it('tunnels an https call through HTTPS_PROXY and streams the answer back', async () => {
    const target = await provider();
    const proxy = await connectProxy(target.port);
    const send = proxiedUpstreamSend({
      env: () => ({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }),
      ...plain,
    });
    const { request, response } = await send(new URL('https://api.provider.test/v1/messages'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'never-the-proxys-business' },
      timeoutMs: 5_000,
    });
    request.end('{"hello":1}');
    const answer = await response;
    expect(answer.statusCode).toBe(200);
    expect(await read(answer)).toBe('data: one\n\ndata: two\n\n');
    expect(proxy.tunnels).toEqual([{ target: 'api.provider.test:443', auth: undefined }]);
    expect(target.seen).toHaveLength(1);
    expect(target.seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/messages',
      host: 'api.provider.test',
      body: '{"hello":1}',
    });
    // The provider's own headers travel inside the tunnel, not to the proxy.
    expect(target.seen[0]!.headers['x-api-key']).toBe('never-the-proxys-business');
  });

  it('sends the proxy credentials only as Proxy-Authorization, and never names them in an error', async () => {
    const target = await provider();
    const proxy = await connectProxy(target.port, true);
    const send = proxiedUpstreamSend({
      env: () => ({ HTTPS_PROXY: `http://box%2Duser:s3cr%40t@127.0.0.1:${proxy.port}` }),
      ...plain,
    });
    const failure = await send(new URL('https://api.provider.test/v1/messages'), {
      method: 'POST',
      headers: {},
      timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    expect(proxy.tunnels).toEqual([
      {
        target: 'api.provider.test:443',
        auth: `Basic ${Buffer.from('box-user:s3cr@t').toString('base64')}`,
      },
    ]);
    expect(failure).toBeInstanceOf(ProxyError);
    const message = String((failure as Error).message);
    expect(message).toContain('refused the tunnel to api.provider.test:443 (403)');
    expect(message).not.toMatch(/box|s3cr|%40|user/);
  });

  it('names an unreachable proxy by host and port only', async () => {
    const closed = await listen(createNetServer());
    servers.pop()!.close();
    const send = proxiedUpstreamSend({
      env: () => ({ HTTPS_PROXY: `http://someone:hunter2@127.0.0.1:${closed}` }),
      ...plain,
    });
    const failure = (await send(new URL('https://api.provider.test/'), {
      method: 'GET',
      headers: {},
      timeoutMs: 2_000,
    }).catch((error: unknown) => error)) as Error;
    expect(failure).toBeInstanceOf(ProxyError);
    expect(failure.message).toBe(`could not reach the proxy at 127.0.0.1:${closed}`);
  });

  it('goes direct, not through the proxy, for a NO_PROXY host', async () => {
    const target = await provider();
    const proxy = await connectProxy(target.port);
    const closed = await listen(createNetServer());
    servers.pop()!.close();
    const send = proxiedUpstreamSend({
      env: () => ({
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: 'localhost,127.0.0.1',
      }),
    });
    const { request, response } = await send(new URL(`https://127.0.0.1:${closed}/v1/models`), {
      method: 'GET',
      headers: {},
      timeoutMs: 2_000,
    });
    request.end();
    const failure = (await response.catch((error: unknown) => error)) as NodeJS.ErrnoException;
    expect(failure.code).toBe('ECONNREFUSED'); // tried the host itself
    expect(proxy.tunnels).toEqual([]);
  });

  it('speaks TLS inside the tunnel by default, so a provider that does not is refused', async () => {
    const target = await provider();
    const proxy = await connectProxy(target.port);
    const send = proxiedUpstreamSend({
      env: () => ({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }),
    });
    const { request, response } = await send(new URL('https://api.provider.test/v1/messages'), {
      method: 'POST',
      headers: {},
      timeoutMs: 5_000,
    });
    request.end('{}');
    const failure = (await response.catch((error: unknown) => error)) as NodeJS.ErrnoException;
    expect(failure).toBeInstanceOf(Error);
    // It failed inside the tunnel, not by looking the provider up itself.
    expect(failure.code).not.toBe('ENOTFOUND');
    expect(failure.message).not.toMatch(/getaddrinfo/);
    expect(proxy.tunnels).toEqual([{ target: 'api.provider.test:443', auth: undefined }]);
    expect(target.seen).toEqual([]); // no plain HTTP request ever reached it
  });

  it('posts a token form through the proxy and reads the JSON back', async () => {
    const target = await provider();
    const proxy = await connectProxy(target.port);
    const post = proxiedTokenPost({
      env: () => ({ https_proxy: `127.0.0.1:${proxy.port}` }), // lower case, no scheme: both accepted
      ...plain,
    });
    const answer = await post('https://oauth2.provider.test/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: 'a.b.c',
    });
    expect(answer).toEqual({ status: 200, body: { access_token: 'stand-in', expires_in: 3599 } });
    expect(proxy.tunnels).toEqual([{ target: 'oauth2.provider.test:443', auth: undefined }]);
    expect(new URLSearchParams(target.seen[0]!.body).get('assertion')).toBe('a.b.c');
    expect(target.seen[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('gives up on a token post that takes too long', async () => {
    const quiet = createNetServer((socket) => socket.on('data', () => {})); // accepts, never answers
    const port = await listen(quiet);
    const post = proxiedTokenPost({ env: () => ({}), tokenTimeoutMs: 200 });
    await expect(post(`https://127.0.0.1:${port}/token`, {})).rejects.toThrow(
      /timed out|went quiet/
    );
  });
});

describe("the gateway's own proxy", () => {
  it('carries the gateway through the proxy user taken at start, not HTTPS_PROXY', async () => {
    const target = await provider();
    const ownProxy = await connectProxy(target.port);
    const agentsProxy = await connectProxy(target.port, true);
    takeGatewayProxy({
      [GATEWAY_PROXY_ENV]: `http://swgw-livebox:pw-test-only@127.0.0.1:${ownProxy.port}`,
    });
    const send = proxiedUpstreamSend({
      env: () => ({ HTTPS_PROXY: `http://127.0.0.1:${agentsProxy.port}` }),
      ...plain,
    });
    const { request, response } = await send(new URL('https://api.provider.test/v1/messages'), {
      method: 'POST',
      headers: {},
      timeoutMs: 5_000,
    });
    request.end('{}');
    expect((await response).statusCode).toBe(200);
    expect(ownProxy.tunnels).toEqual([
      {
        target: 'api.provider.test:443',
        auth: `Basic ${Buffer.from('swgw-livebox:pw-test-only').toString('base64')}`,
      },
    ]);
    expect(agentsProxy.tunnels).toEqual([]);
  });

  it('still honours NO_PROXY, and is named by its variable when refused', () => {
    const url = new URL('https://a.test/');
    expect(proxyFor(url, { HTTPS_PROXY: 'http://p:3128' }, 'http://u:x@g:3128')?.host).toBe(
      'g:3128'
    );
    expect(proxyFor(url, { NO_PROXY: 'a.test' }, 'http://u:x@g:3128')).toBeNull();
    expect(() => proxyFor(url, {}, 'socks5://u:x@g:1080')).toThrow(
      `${GATEWAY_PROXY_ENV} must be an http:// or https:// URL`
    );
  });
});

describe("bytes sent with the proxy's 200", () => {
  it('are kept for the provider connection, not dropped', async () => {
    // A proxy that sends its 200 and the provider's first bytes in one write.
    const answer = 'HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nearly';
    const server = createNetServer((client) => {
      client.once('data', () =>
        client.write(`HTTP/1.1 200 Connection Established\r\n\r\n${answer}`)
      );
      client.on('error', () => {});
    });
    const port = await listen(server);
    const send = proxiedUpstreamSend({
      env: () => ({ HTTPS_PROXY: `http://127.0.0.1:${port}` }),
      ...plain,
    });
    const { request, response } = await send(new URL('https://api.provider.test/v1/models'), {
      method: 'GET',
      headers: {},
      timeoutMs: 2_000,
    });
    request.end();
    const got = await response;
    expect(got.statusCode).toBe(200);
    expect(await read(got)).toBe('early');
  });
});

describe('only https leaves the machine', () => {
  it('refuses plain http to anywhere but this machine, before any connection', async () => {
    const target = await provider();
    const proxy = await connectProxy(target.port);
    const send = proxiedUpstreamSend({
      env: () => ({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }),
    });
    const post = proxiedTokenPost({ env: () => ({}) });
    const options = { method: 'POST', headers: {}, timeoutMs: 2_000 };
    await expect(send(new URL('http://api.provider.test/v1/messages'), options)).rejects.toThrow(
      'refusing a http: call to api.provider.test: only https leaves this machine'
    );
    await expect(post('http://oauth2.provider.test/token', { a: 'b' })).rejects.toThrow(ProxyError);
    await expect(send(new URL('ftp://api.provider.test/'), options)).rejects.toThrow(ProxyError);
    expect(proxy.tunnels).toEqual([]);
    expect(target.seen).toEqual([]);
  });

  it('still allows plain http to this machine (a stand-in provider)', async () => {
    const target = await provider();
    const post = proxiedTokenPost({ env: () => ({}) });
    const answer = await post(`http://127.0.0.1:${target.port}/token`, { a: 'b' });
    expect(answer.status).toBe(200);
  });
});

describe('choosing the proxy', () => {
  const url = (text: string) => new URL(text);

  it('uses HTTPS_PROXY for https only, and refuses a proxy that is not an http(s) URL', () => {
    expect(proxyFor(url('https://a.test/'), { HTTPS_PROXY: 'http://p:3128' })?.host).toBe('p:3128');
    expect(proxyFor(url('http://a.test/'), { HTTPS_PROXY: 'http://p:3128' })).toBeNull();
    expect(proxyFor(url('https://a.test/'), {})).toBeNull();
    expect(proxyFor(url('https://a.test/'), { HTTPS_PROXY: '  ' })).toBeNull();
    expect(() => proxyFor(url('https://a.test/'), { HTTPS_PROXY: 'socks5://p:1080' })).toThrow(
      ProxyError
    );
    expect(() => proxyFor(url('https://a.test/'), { HTTPS_PROXY: 'http://[bad' })).toThrow(
      ProxyError
    );
  });

  it.each([
    ['*', 'https://api.a.test/', true],
    ['a.test', 'https://a.test/', true],
    ['a.test', 'https://api.a.test/', true],
    ['.a.test', 'https://api.a.test/', true],
    ['*.a.test', 'https://api.a.test/', true],
    ['A.TEST', 'https://api.a.test/', true],
    ['a.test', 'https://nota.test/', false],
    ['a.test', 'https://a.test.evil/', false],
    ['a.test:443', 'https://a.test/', true],
    ['a.test:8443', 'https://a.test/', false],
    ['10.0.0.1', 'https://10.0.0.1/', true],
    ['10.0.0.1', 'https://10.0.0.10/', false],
    ['[::1]', 'https://[::1]/', true],
    ['10.0.0.0/8', 'https://10.0.0.1/', false], // CIDR isn't supported
    ['  b.test , a.test ', 'https://a.test/', true],
    ['', 'https://a.test/', false],
  ])('NO_PROXY %j for %s: direct is %s', (noProxy, target, expected) => {
    expect(bypassed(url(target), noProxy)).toBe(expected);
  });
});
