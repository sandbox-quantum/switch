import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import { relayHttpMcpServers } from './mcp-relay';

interface Seen {
  method: string;
  authorization: string | undefined;
  session: string | undefined;
  body: Record<string, unknown> | null;
}

let server: Server | undefined;
afterEach(() => server?.close());

/** A Streamable HTTP MCP endpoint: JSON for initialize, SSE for a tool call, 202 for a notification. */
async function endpoint(): Promise<{
  url: string;
  seen: Seen[];
  versions: Array<string | undefined>;
}> {
  const seen: Seen[] = [];
  const versions: Array<string | undefined> = [];
  const read = async (request: IncomingMessage) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  };
  server = createServer(async (request, response) => {
    const body = await read(request);
    seen.push({
      method: request.method ?? '',
      authorization: request.headers.authorization,
      session: request.headers['mcp-session-id'] as string | undefined,
      body,
    });
    if (request.method === 'POST' && body?.id !== undefined)
      versions.push(request.headers['mcp-protocol-version'] as string | undefined);
    if (request.headers.authorization !== 'Bearer placeholder-token') {
      response.writeHead(401).end();
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(200).end();
      return;
    }
    if (body?.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } })
      );
      return;
    }
    if (body?.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const name = (body.params as { name?: string } | undefined)?.name;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (name === 'silent') {
      response.end(': nothing to say\n\n');
      return;
    }
    if (name === 'crlf-multiline') {
      // One answer over two data lines, cut between tokens, with a CRLF split
      // across two writes.
      response.write(`event: message\r\ndata: {"jsonrpc":"2.0",\r`);
      response.write(`\ndata: "id":${String(body.id)},"result":{"lines":"a\\nb"}}\r\n\r\n`);
      response.end();
      return;
    }
    response.write(': keep-alive\n\n');
    response.write(
      `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`
    );
    response.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'echoed' }] } })}\n\n`
    );
    response.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/mcp`, seen, versions };
}

async function relay(url: string, headers: Record<string, string>) {
  const { servers, dir } = await relayHttpMcpServers({
    switch: { transport: 'http', url, headers },
  });
  const spec = servers.switch!;
  if (spec.transport !== 'stdio') throw new Error('not relayed');
  const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
    waiters.splice(0).forEach((wake) => wake());
  });
  const next = async (count: number) => {
    while (lines.length < count) await new Promise<void>((resolve) => waiters.push(resolve));
    return lines[count - 1]!;
  };
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const closed = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { spec, dir: dir!, send, next, close: () => child.stdin.end(), closed };
}

it('relays requests, JSON and event-stream answers, and notifications, with the headers and session id', async () => {
  const { url, seen } = await endpoint();
  const { send, next, close, closed } = await relay(url, {
    Authorization: 'Bearer placeholder-token',
  });
  send({ id: 1, method: 'initialize', params: {} });
  expect(await next(1)).toEqual({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18' },
  });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'echo' } });
  expect(await next(2)).toMatchObject({ method: 'notifications/progress' });
  expect(await next(3)).toEqual({
    jsonrpc: '2.0',
    id: 2,
    result: { content: [{ type: 'text', text: 'echoed' }] },
  });
  close();
  expect(await closed).toBe(0);
  expect(seen.map((s) => [s.method, s.body?.method ?? null, s.session ?? null])).toEqual([
    ['POST', 'initialize', null],
    ['POST', 'notifications/initialized', 's-1'],
    ['POST', 'tools/call', 's-1'],
    ['DELETE', null, 's-1'],
  ]);
  expect(seen.every((s) => s.authorization === 'Bearer placeholder-token')).toBe(true);
});

it('reads an event stream with CRLF lines split across chunks and data over several lines', async () => {
  const { url } = await endpoint();
  const { send, next, close } = await relay(url, { Authorization: 'Bearer placeholder-token' });
  send({ id: 1, method: 'initialize', params: {} });
  await next(1);
  send({ id: 2, method: 'tools/call', params: { name: 'crlf-multiline' } });
  expect(await next(2)).toEqual({ jsonrpc: '2.0', id: 2, result: { lines: 'a\nb' } });
  close();
});

it('answers a request whose event stream ends without a response, rather than leave it waiting', async () => {
  const { url } = await endpoint();
  const { send, next, close } = await relay(url, { Authorization: 'Bearer placeholder-token' });
  send({ id: 1, method: 'initialize', params: {} });
  await next(1);
  send({ id: 2, method: 'tools/call', params: { name: 'silent' } });
  expect(await next(2)).toMatchObject({
    id: 2,
    error: { message: 'MCP relay: the server ended its answer without a response' },
  });
  close();
});

it('sends the protocol version initialize agreed on what follows', async () => {
  const { url, versions } = await endpoint();
  const { send, next, close } = await relay(url, { Authorization: 'Bearer placeholder-token' });
  send({ id: 1, method: 'initialize', params: {} });
  await next(1);
  send({ id: 2, method: 'tools/call', params: { name: 'echo' } });
  await next(3);
  expect(versions).toEqual([undefined, '2025-06-18']);
  close();
});

it('holds what follows initialize until its answer brings the session id', async () => {
  const { url, seen } = await endpoint();
  const { send, next, close } = await relay(url, { Authorization: 'Bearer placeholder-token' });
  send({ id: 1, method: 'initialize', params: {} });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  await next(2);
  expect(seen.slice(1).map((s) => s.session)).toEqual(['s-1', 's-1']);
  close();
});

it('answers a request the server refuses with a JSON-RPC error, so the agent is not left waiting', async () => {
  const { url } = await endpoint();
  const { send, next, close } = await relay(url, { Authorization: 'Bearer wrong' });
  send({ id: 7, method: 'tools/list' });
  expect(await next(1)).toMatchObject({
    id: 7,
    error: { code: -32603, message: 'MCP relay: the server answered 401' },
  });
  close();
});

it('keeps the headers out of the command line, in files only the owner can read', async () => {
  const { url } = await endpoint();
  const { spec, dir, close } = await relay(url, { Authorization: 'Bearer placeholder-token' });
  expect(spec.args.join(' ')).not.toContain('placeholder-token');
  expect(dirname(spec.args[0]!)).toBe(dir);
  if (process.platform !== 'win32') {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of [spec.args[0]!, spec.args[2]!])
      expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  close();
});

it('leaves stdio servers alone and writes nothing when there is no HTTP server', async () => {
  const stdio = { echo: { transport: 'stdio' as const, command: 'node', args: ['echo.js'] } };
  const { servers, dir } = await relayHttpMcpServers(stdio);
  expect(servers).toBe(stdio);
  expect(dir).toBeNull();
  expect(existsSync('relay.mjs')).toBe(false);
});
