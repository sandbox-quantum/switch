import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerSpec } from '../adapter';

/**
 * A stdio MCP server that forwards every message to one Streamable HTTP MCP
 * server, with the headers in a file it is given. Written out and run with
 * Node, so it travels with whatever bundle the adapter is in and needs
 * nothing installed. It holds no state but the server's `Mcp-Session-Id`.
 */
export const MCP_STDIO_RELAY = String.raw`
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [url, headersPath] = process.argv.slice(2);
const headers = JSON.parse(readFileSync(headersPath, 'utf8'));
let session;
let pending = 0;
let closing = false;
// The server gives its session id in the answer to initialize, and refuses
// what comes without it, so nothing else goes out until that answer is in.
let initialized = Promise.resolve();

const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const fail = (message, error) => {
  if (message.id !== undefined && message.method)
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'MCP relay: ' + error } });
  process.stderr.write('MCP relay: ' + error + '\n');
};

let protocol;

async function forward(message) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
      ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
    },
    body: JSON.stringify(message),
  });
  session = response.headers.get('mcp-session-id') ?? session;
  if (!response.ok && response.status !== 202) {
    fail(message, 'the server answered ' + response.status);
    return;
  }
  let answered = false;
  const emit = (text) => {
    const parsed = JSON.parse(text);
    for (const out of Array.isArray(parsed) ? parsed : [parsed]) {
      if (out.id !== undefined && out.id === message.id && !out.method) answered = true;
      if (message.method === 'initialize' && out.result?.protocolVersion)
        protocol = out.result.protocolVersion;
      write(out);
    }
  };
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) {
    let buffer = '';
    const decoder = new TextDecoder();
    const flush = (event) => {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data.trim()) emit(data);
    };
    let carry = '';
    for await (const chunk of response.body) {
      let text = carry + decoder.decode(chunk, { stream: true });
      carry = text.endsWith('\r') ? '\r' : '';
      if (carry) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        flush(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
    flush(buffer);
  } else if (type.includes('application/json')) {
    const body = await response.text();
    if (body.trim()) emit(body);
  }
  if (message.id !== undefined && message.method && !answered)
    fail(message, 'the server ended its answer without a response');
}

function settle() {
  if (closing && pending === 0) {
    if (session)
      fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } })
        .catch(() => {})
        .finally(() => process.exit(0));
    else process.exit(0);
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write('MCP relay: dropped a line that is not JSON\n');
      return;
    }
    pending += 1;
    const sent = initialized.then(() => forward(message));
    if (message.method === 'initialize') initialized = sent.catch(() => {});
    sent
      .catch((error) => fail(message, error instanceof Error ? error.message : String(error)))
      .finally(() => {
        pending -= 1;
        settle();
      });
  })
  .on('close', () => {
    closing = true;
    settle();
  });
`;

/**
 * The session's HTTP MCP servers handed over as stdio relays, for an agent
 * that cannot take them over HTTP. The relay script and each server's
 * headers go in a directory only the owner can read; the agent is given
 * their paths, never the headers. `dir` is null when there was nothing to
 * relay; remove it when the session ends. A host that dies without ending
 * the session leaves it in the temporary directory, readable by its owner
 * alone, until the system clears that.
 */
export async function relayHttpMcpServers(
  servers: Record<string, McpServerSpec>
): Promise<{ servers: Record<string, McpServerSpec>; dir: string | null }> {
  const http = Object.entries(servers).filter(([, spec]) => spec.transport === 'http');
  if (http.length === 0) return { servers, dir: null };
  const dir = await mkdtemp(join(tmpdir(), 'switch-mcp-relay-'));
  try {
    await chmod(dir, 0o700);
    const script = join(dir, 'relay.mjs');
    await writeFile(script, MCP_STDIO_RELAY, { mode: 0o600 });
    const relayed: Record<string, McpServerSpec> = { ...servers };
    for (const [index, [name, spec]] of http.entries()) {
      if (spec.transport !== 'http') continue;
      const headers = join(dir, `headers-${index}.json`);
      await writeFile(headers, JSON.stringify(spec.headers ?? {}), { mode: 0o600 });
      // In Console the session host runs on Electron's binary, which only
      // behaves as Node with this set.
      relayed[name] = {
        transport: 'stdio',
        command: process.execPath,
        args: [script, spec.url, headers],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }
    return { servers: relayed, dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
