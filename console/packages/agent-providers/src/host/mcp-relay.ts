import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { MCP_RELAY_HEADERS_ENV, MCP_RELAY_URL_ENV } from '../acp/mcp';

/**
 * One of a session's HTTP MCP servers, served on stdio to an agent that takes
 * MCP over stdio only (`relayHttpMcp`). Messages pass through unchanged until
 * `stdin` ends. A request the server cannot be reached for is answered with an
 * error, so one failed call does not take the server's tools from the agent.
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
  http.onmessage = (message) => void stdio.send(message);
  http.onerror = (error) => process.stderr.write(`switch: MCP relay: ${error.message}\n`);
  stdio.onmessage = (message) =>
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
  await http.start();
  await stdio.start();
  await once(stdin, 'end');
  await stdio.close();
  await http.close();
}
