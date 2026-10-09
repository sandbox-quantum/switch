import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type HttpMcpServer, serveMcpOverHttp } from '@sandboxaq/switch-agent-runtime/hosted';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpMcpServerSpec } from '../adapter';
import { Redactions } from './redaction';
import type { ServiceGrant, ServiceTokenAnswer } from './service-access';
import type { HostAsk } from './session-channel';
import { startVendorServers, textResult, type VendorServers } from './vendor-mcp';

const GOOD = 'synthetic-vendor-token-accepted-by-the-mcp-server';
const STALE = 'synthetic-vendor-token-the-vendor-no-longer-takes';
const VENDOR_URL = 'https://mcp.example.test/v1/mcp';

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function grant(service: string, mcp: { name: string; url: string }[]): ServiceGrant {
  return {
    service,
    access: 'write',
    tool_mode: 'deny',
    tools: [],
    resources: {},
    skill: null,
    mcp_servers: mcp,
    cli_tools: [],
  };
}

/** The vendor's MCP server, taking only `GOOD`, and what it was asked. */
async function vendor(): Promise<{ server: HttpMcpServer; calls: unknown[] }> {
  const calls: unknown[] = [];
  const server = await serveMcpOverHttp(GOOD, {
    listTools: async () => [
      { name: 'search_items', description: 'Search work items.', inputSchema: { type: 'object' } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `found 2 for ${String(args.query)}` }] };
    },
  });
  servers.push(server);
  return { server, calls };
}

/** `fetch`, sending the vendor's https address to `target` on loopback. */
function routedTo(target: string, seen: string[]): typeof fetch {
  return async (url, init) => {
    seen.push(String(url));
    expect(String(url)).toBe(VENDOR_URL);
    return fetch(target, init);
  };
}

function host(answers: ServiceTokenAnswer[]) {
  const asked: HostAsk[] = [];
  return {
    asked,
    ask: async (ask: HostAsk) => {
      asked.push(ask);
      const next = answers.shift();
      if (!next) throw new Error('no answer left');
      return next;
    },
  };
}

async function client(spec: HttpMcpServerSpec): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
    requestInit: { headers: spec.headers },
  });
  const connected = new Client({ name: 'coding-tool', version: '1.0.0' });
  await connected.connect(transport);
  servers.push({ close: () => connected.close() });
  return connected;
}

async function started(
  grants: ServiceGrant[],
  answers: ServiceTokenAnswer[],
  fetchImpl: typeof fetch,
  listTimeoutMs = 5_000
): Promise<VendorServers & { asked: HostAsk[]; redactions: Redactions }> {
  const parent = host(answers);
  const redactions = new Redactions();
  const vendors = await startVendorServers({
    grants,
    ask: parent.ask,
    redactions,
    listTimeoutMs,
    callTimeoutMs: 5_000,
    fetch: fetchImpl,
  });
  servers.push(vendors);
  return { ...vendors, asked: parent.asked, redactions };
}

const token = (value: string): ServiceTokenAnswer => ({
  kind: 'token',
  token: value,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

describe('a granted vendor’s MCP servers', () => {
  it('lists and calls the vendor’s tools with a token asked for on each call', async () => {
    const { server, calls } = await vendor();
    const seen: string[] = [];
    const vendors = await started(
      [grant('example', [{ name: 'example', url: VENDOR_URL }])],
      [token(GOOD), token(GOOD)],
      routedTo(server.url, seen)
    );
    const spec = vendors.specs.example!;
    expect(spec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const tool = await client(spec);
    expect((await tool.listTools()).tools.map((t) => t.name)).toEqual(['search_items']);
    const result = await tool.callTool({ name: 'search_items', arguments: { query: 'bugs' } });
    expect(result.content).toEqual([{ type: 'text', text: 'found 2 for bugs' }]);
    expect(calls).toEqual([{ name: 'search_items', args: { query: 'bugs' } }]);
    expect(vendors.asked).toEqual([
      { type: 'service-token', service: 'example', rejected: null },
      { type: 'service-token', service: 'example', rejected: null },
    ]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('never gives the coding tool the vendor’s token, and redacts it', async () => {
    const { server } = await vendor();
    const vendors = await started(
      [grant('example', [{ name: 'example', url: VENDOR_URL }])],
      [token(GOOD)],
      routedTo(server.url, [])
    );
    const spec = vendors.specs.example!;
    expect(JSON.stringify(vendors.specs)).not.toContain(GOOD);
    await (await client(spec)).listTools();
    expect(vendors.redactions.text(`the token was ${GOOD}`)).toBe('the token was [REDACTED]');
  });

  it('asks again once when the vendor refuses the token, naming it', async () => {
    const { server } = await vendor();
    const vendors = await started(
      [grant('example', [{ name: 'example', url: VENDOR_URL }])],
      [token(STALE), token(GOOD)],
      routedTo(server.url, [])
    );
    const tools = await (await client(vendors.specs.example!)).listTools();
    expect(tools.tools).toHaveLength(1);
    expect(vendors.asked).toEqual([
      { type: 'service-token', service: 'example', rejected: null },
      { type: 'service-token', service: 'example', rejected: STALE },
    ]);
  });

  it('gives up after a second refusal, as one failed tool call', async () => {
    const { server } = await vendor();
    const vendors = await started(
      [grant('example', [{ name: 'example', url: VENDOR_URL }])],
      [token(GOOD), token(STALE), token(STALE)],
      routedTo(server.url, [])
    );
    const tool = await client(vendors.specs.example!);
    await tool.listTools();
    const result = await tool.callTool({ name: 'search_items', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('refused this agent');
    expect(vendors.asked).toHaveLength(3);
  });

  it('says why when Switch refuses the token', async () => {
    const { server } = await vendor();
    const vendors = await started(
      [grant('example', [{ name: 'example', url: VENDOR_URL }])],
      [{ kind: 'refused', code: 'grant_missing', message: 'No Example grant.', final: true }],
      routedTo(server.url, [])
    );
    await expect((await client(vendors.specs.example!)).listTools()).rejects.toThrow(
      'No Example grant.'
    );
  });

  it('keeps one vendor’s failure to itself, and gives up on one that does not answer', async () => {
    const { server } = await vendor();
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      );
    const vendors = await started(
      [
        grant('slow', [{ name: 'slow', url: 'https://mcp.slow.example.test/mcp' }]),
        grant('example', [{ name: 'example', url: VENDOR_URL }]),
      ],
      [token(GOOD), token(GOOD)],
      (url, init) => (String(url) === VENDOR_URL ? fetch(server.url, init) : hanging(url, init)),
      300
    );
    const slow = await client(vendors.specs.slow!);
    const started_at = Date.now();
    await expect(slow.listTools()).rejects.toThrow('did not list its tools');
    expect(Date.now() - started_at).toBeLessThan(5_000);
    const tools = await (await client(vendors.specs.example!)).listTools();
    expect(tools.tools).toHaveLength(1);
  });

  it('refuses a vendor server that is not HTTPS', async () => {
    await expect(
      startVendorServers({
        grants: [grant('example', [{ name: 'example', url: 'http://mcp.example.test/mcp' }])],
        ask: async () => null,
        redactions: new Redactions(),
        listTimeoutMs: 1_000,
        callTimeoutMs: 1_000,
        fetch,
      })
    ).rejects.toThrow('not served over HTTPS');
  });

  it('serves nothing for grants without MCP servers', async () => {
    const vendors = await started([grant('github', [])], [], fetch);
    expect(vendors.specs).toEqual({});
  });
});

describe('a vendor’s tool answer', () => {
  it('passes text on and says what else was left out', () => {
    expect(
      textResult('Example', {
        content: [
          { type: 'text', text: 'two items' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'example://1', text: 'item one' } },
          { type: 'resource_link', uri: 'https://example.test/items/1', name: 'item' },
        ],
        isError: true,
        structuredContent: { count: 2 },
      })
    ).toEqual({
      isError: true,
      content: [
        { type: 'text', text: 'two items' },
        {
          type: 'text',
          text: '[Example answered with image content, which Switch does not pass on yet]',
        },
        { type: 'text', text: 'item one' },
        { type: 'text', text: '[Example linked https://example.test/items/1]' },
      ],
      structuredContent: { count: 2 },
    });
  });
});
