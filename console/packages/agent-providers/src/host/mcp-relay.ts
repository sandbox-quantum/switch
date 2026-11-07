import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ErrorCode,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_RELAY_HEADERS_ENV, MCP_RELAY_RENAMED_ENV, MCP_RELAY_URL_ENV } from '../acp/mcp';

interface ListedTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

/**
 * Offers each `renamed` argument of the tools in a `tools/list` result under
 * its name with underscores added until it is free, noting in `offered` the
 * name each tool's offered arguments really have.
 */
function offerRenamed(
  result: Record<string, unknown>,
  renamed: ReadonlySet<string>,
  offered: Map<string, Map<string, string>>
): void {
  if (!Array.isArray(result.tools)) return;
  for (const tool of result.tools as ListedTool[]) {
    const schema = tool.inputSchema;
    const properties = schema?.properties ?? {};
    const aliases = new Map<string, string>();
    for (const name of Object.keys(properties).filter((key) => renamed.has(key))) {
      let alias = `${name}_`;
      while (alias in properties) alias += '_';
      aliases.set(name, alias);
    }
    if (!schema || aliases.size === 0) continue;
    schema.properties = Object.fromEntries(
      Object.entries(properties).map(([name, spec]) => [aliases.get(name) ?? name, spec])
    );
    if (schema.required) schema.required = schema.required.map((name) => aliases.get(name) ?? name);
    offered.set(tool.name, new Map([...aliases].map(([name, alias]) => [alias, name])));
  }
}

/**
 * One of a session's HTTP MCP servers, served on stdio to an agent that takes
 * MCP over stdio only (`relayHttpMcp`). Messages pass through unchanged until
 * `stdin` ends, but for the tool arguments the agent cannot take, which it is
 * offered under other names and which reach the server under their own. A
 * request the server cannot be reached for is answered with an error, so one
 * failed call does not take the server's tools from the agent.
 */
export async function relayMcpOverStdio({
  stdin,
  stdout,
  env,
}: {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const url = env[MCP_RELAY_URL_ENV];
  if (!url) throw new Error(`${MCP_RELAY_URL_ENV} names no MCP server to relay to.`);
  const http = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: JSON.parse(env[MCP_RELAY_HEADERS_ENV] ?? '{}') as Record<string, string>,
    },
  });
  const stdio = new StdioServerTransport(stdin, stdout);
  const renamed = new Set(JSON.parse(env[MCP_RELAY_RENAMED_ENV] ?? '[]') as string[]);
  const offered = new Map<string, Map<string, string>>();
  const listings = new Set<string | number>();
  http.onmessage = (message) => {
    if (isJSONRPCResultResponse(message) && listings.delete(message.id))
      offerRenamed(message.result, renamed, offered);
    void stdio.send(message);
  };
  http.onerror = (error) => process.stderr.write(`switch: MCP relay: ${error.message}\n`);
  stdio.onmessage = (message) => {
    if (renamed.size > 0 && isJSONRPCRequest(message)) {
      if (message.method === 'tools/list') listings.add(message.id);
      const call = message.params as { name?: string; arguments?: Record<string, unknown> };
      const names = message.method === 'tools/call' ? offered.get(call.name ?? '') : undefined;
      if (names && call.arguments)
        call.arguments = Object.fromEntries(
          Object.entries(call.arguments).map(([name, value]) => [names.get(name) ?? name, value])
        );
    }
    void http.send(message).catch((error: unknown) => {
      if (isJSONRPCRequest(message))
        void stdio.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: ErrorCode.InternalError,
            message: `Switch could not relay the request to the MCP server: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
    });
  };
  await http.start();
  await stdio.start();
  await once(stdin, 'end');
  await stdio.close();
  await http.close();
}
