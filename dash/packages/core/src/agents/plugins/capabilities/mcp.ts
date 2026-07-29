import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { PluginFs } from '../../runtime/fs';

export type McpTransport = 'stdio' | 'http';

export type IMcpBehavior = {
  readServers(fs: PluginFs): Promise<McpServerRegistration[]>;
  writeServers(fs: PluginFs, servers: McpServerRegistration[]): Promise<void>;
  removeServer(fs: PluginFs, name: string): Promise<void>;
  /**
   * Render a server as launch arguments, for agents that must receive a
   * per-session MCP server on the command line rather than from a config file.
   *
   * Implement this only when the agent cannot resolve a server whose address
   * varies per session any other way. An agent whose connector plugin expands
   * environment variables in its bundled MCP config (Claude Code) leaves this
   * undefined: the config file is already per-session because the values are.
   * Codex performs no such expansion — a plugin-bundled `.mcp.json` reaches the
   * server with `${VAR}` intact — and writing the resolved address into its
   * single global config would make two agents in one location overwrite each
   * other, so its address must ride on argv.
   */
  launchArgsForServer?(server: McpServerRegistration): string[];
};

export type McpServerRegistration = {
  name: string;
  transport?: McpTransport;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /**
   * Name of an environment variable holding the bearer token, for agents that
   * resolve it at request time rather than taking the secret inline. Declared
   * rather than left to the index signature so a typo is a compile error and
   * not a silently unauthenticated server.
   */
  bearer_token_env_var?: string;
  [key: string]: unknown;
};

export const mcpCapability = definePluginCapability<IMcpBehavior>()(
  'mcp',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('supported'),
      scope: z.enum(['global']),
      supportedTransports: z.array(z.enum(['stdio', 'http'])),
    }),
    z.object({
      kind: z.literal('none'),
    }),
  ])
);
