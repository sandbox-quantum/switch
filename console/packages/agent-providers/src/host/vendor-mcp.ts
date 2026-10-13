import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  serveMcpOverHttp,
  type ToolDefinition,
  type ToolResult,
} from '@sandboxaq/switch-agent-runtime/hosted';
import type { HttpMcpServerSpec } from '../adapter';
import type { Redactions } from './redaction';
import { type ServiceGrant, serviceTokenAnswerSchema } from './service-access';
import { redactServiceToken, type ServiceCredential } from './service-credential';
import type { HostAsk } from './session-channel';

/** How long a vendor has to list its tools before the session goes on without them. */
export const LIST_TIMEOUT_MS = 20_000;
/** How long one tool call at a vendor may take. */
export const CALL_TIMEOUT_MS = 120_000;

export type VendorServers = {
  /** By MCP server name, as the coding tool is given them. */
  specs: Record<string, HttpMcpServerSpec>;
  close: () => Promise<void>;
};

class VendorRefusedToken extends Error {}

type VendorMcpServer = ServiceGrant['mcp_servers'][number];

/**
 * A granted vendor's MCP servers, served to this session's CLI on loopback.
 *
 * One loopback server per vendor server, each behind a bearer minted for this
 * run, so a slow or failing vendor is one failed server and the Switch tools
 * keep working. The vendor's token never reaches the CLI: every list and call
 * asks the agent host for it over the pipe, adds it (and each secret field of
 * a key) to this session's redactions, and calls the vendor from here, over
 * HTTPS, with redirects refused. The server's URL and headers are templates
 * of the token, so the address is known only once a token is: it is rendered
 * on every connection and refused unless HTTPS. A 401 asks again, naming the
 * refused token, and retries once.
 *
 * Tools pass through as the vendor lists them, until they are classified by
 * access level. Only text reaches the CLI: anything else a tool answers is
 * replaced by a line saying what was left out.
 */
export async function startVendorServers(input: {
  grants: ServiceGrant[];
  ask: (ask: HostAsk) => Promise<unknown>;
  redactions: Redactions;
  listTimeoutMs: number;
  callTimeoutMs: number;
  /** How the vendor is reached: `fetch`, but for tests. */
  fetch: typeof fetch;
}): Promise<VendorServers> {
  const specs: Record<string, HttpMcpServerSpec> = {};
  const closers: (() => Promise<void>)[] = [];
  try {
    for (const grant of input.grants) {
      for (const server of grant.mcp_servers) {
        if (new URL(server.url).protocol !== 'https:')
          throw new Error(`${grant.service}'s MCP server ${server.name} is not served over HTTPS.`);
        const vendor = new VendorServer(grant.service, server, input);
        const bearer = randomBytes(32).toString('hex');
        const served = await serveMcpOverHttp(bearer, {
          listTools: () => vendor.listTools(),
          callTool: (name, args) => vendor.callTool(name, args),
        });
        closers.push(served.close);
        specs[server.name] = {
          transport: 'http',
          url: served.url,
          headers: { Authorization: `Bearer ${bearer}` },
        };
      }
    }
  } catch (error) {
    await Promise.all(closers.map((close) => close()));
    throw error;
  }
  return { specs, close: async () => void (await Promise.all(closers.map((close) => close()))) };
}

class VendorServer {
  constructor(
    private readonly service: string,
    private readonly server: VendorMcpServer,
    private readonly deps: {
      ask: (ask: HostAsk) => Promise<unknown>;
      redactions: Redactions;
      listTimeoutMs: number;
      callTimeoutMs: number;
      fetch: typeof fetch;
    }
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    return this.withVendor(this.deps.listTimeoutMs, 'list its tools', async (client) => {
      const tools: ToolDefinition[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        for (const tool of page.tools)
          tools.push({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema as Record<string, unknown>,
          });
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.withVendor(this.deps.callTimeoutMs, `answer ${name}`, async (client) =>
      textResult(this.service, await client.callTool({ name, arguments: args }))
    );
  }

  /** One exchange with the vendor, on a token asked for now, retried once on a 401. */
  private async withVendor<T>(
    timeoutMs: number,
    what: string,
    exchange: (client: Client) => Promise<T>
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    let rejected: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      const credential: ServiceCredential = await withinSignal(
        this.credential(rejected),
        signal,
        `The agent host did not hand out a ${this.service} token within ${timeoutMs / 1000} s.`
      );
      try {
        return await this.connected(credential, signal, exchange);
      } catch (error) {
        if (signal.aborted)
          throw new Error(`${this.service} did not ${what} within ${timeoutMs / 1000} s.`);
        if (!(error instanceof VendorRefusedToken)) throw error;
        if (attempt > 0)
          throw new Error(
            `${this.service} refused this agent's token again after Switch issued a new one.`
          );
        rejected = credential.token;
      }
    }
  }

  private async credential(rejected: string | null): Promise<ServiceCredential> {
    const answer = serviceTokenAnswerSchema.parse(
      await this.deps.ask({ type: 'service-token', service: this.service, rejected })
    );
    if (answer.kind === 'refused') throw new Error(answer.message);
    return redactServiceToken(this.deps.redactions, answer.token);
  }

  private async connected<T>(
    credential: ServiceCredential,
    signal: AbortSignal,
    exchange: (client: Client) => Promise<T>
  ): Promise<T> {
    const url = new URL(credential.render(this.server.url));
    if (url.protocol !== 'https:')
      throw new Error(
        `${this.service}'s MCP server ${this.server.name} is not served over HTTPS once its address is filled in.`
      );
    const headers = Object.fromEntries(
      Object.entries(this.server.headers).map(([name, template]) => [
        name,
        credential.render(template),
      ])
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      fetch: (url, init) =>
        this.deps.fetch(url, {
          ...init,
          redirect: 'error',
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        }),
    });
    const client = new Client({ name: 'switch-session', version: '1.0.0' });
    try {
      await client.connect(transport, { signal });
      return await exchange(client);
    } catch (error) {
      if (error instanceof StreamableHTTPError && error.code === 401)
        throw new VendorRefusedToken(`${this.service} refused the token.`);
      throw error;
    } finally {
      await client.close().catch(() => {});
    }
  }
}

/** `work`, or `message` as an error once `signal` aborts, whichever comes first. */
function withinSignal<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(message));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

type VendorContent = { type: string; text?: unknown; resource?: unknown; uri?: unknown };

/** A vendor's tool answer as text, saying what was left out. */
export function textResult(service: string, result: unknown): ToolResult {
  const answer = result as {
    isError?: boolean;
    content?: VendorContent[];
    structuredContent?: Record<string, unknown>;
  };
  const content = (answer.content ?? []).map((block) => {
    if (block.type === 'text' && typeof block.text === 'string')
      return { type: 'text' as const, text: block.text };
    const resource = block.resource as { text?: unknown; uri?: unknown } | undefined;
    if (block.type === 'resource' && typeof resource?.text === 'string')
      return { type: 'text' as const, text: resource.text };
    if (block.type === 'resource_link' && typeof block.uri === 'string')
      return { type: 'text' as const, text: `[${service} linked ${block.uri}]` };
    return {
      type: 'text' as const,
      text: `[${service} answered with ${block.type} content, which Switch does not pass on yet]`,
    };
  });
  return {
    ...(answer.isError ? { isError: true } : {}),
    content,
    ...(answer.structuredContent ? { structuredContent: answer.structuredContent } : {}),
  };
}
