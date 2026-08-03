import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { PluginFs } from '../../runtime/fs';

export type McpTransport = 'stdio' | 'http';

/**
 * The Switch MCP runtime as a stdio command, handed to {@link
 * IMcpBehavior.launchProfile}. Static and secret-free: the runtime reads its
 * `SWITCH_*` credentials from the session env it inherits, so only the command
 * and args are needed.
 */
export type SwitchMcpLaunchServer = {
  command: string;
  args: string[];
};

/**
 * A per-agent launch config file plus the argv that loads it — the result of
 * {@link IMcpBehavior.launchProfile}. Pure data so it can be written directly
 * (local/SSH runtimes) or baked into a precomputed launch spec and written by
 * the headless VM sidecar, which has no plugin registry.
 */
export type SwitchLaunchProfile = {
  /** File path relative to the agent's home directory. */
  relativePath: string;
  /** Full file content to write at {@link relativePath}. */
  content: string;
  /** Extra argv the launch command needs to load the profile. */
  args: string[];
};

export type IMcpBehavior = {
  readServers(fs: PluginFs): Promise<McpServerRegistration[]>;
  writeServers(fs: PluginFs, servers: McpServerRegistration[]): Promise<void>;
  removeServer(fs: PluginFs, name: string): Promise<void>;
  /**
   * Compute the launch config that registers the Switch MCP server for a
   * session, for agents whose connector plugin cannot resolve a per-session
   * server from a bundled config. Pure: it returns the file to write and the
   * argv to load it, leaving the write to the caller so the same result serves
   * a direct write (local/SSH) and a baked launch spec the sidecar writes.
   *
   * Claude Code leaves this undefined: its plugin expands environment variables
   * in a bundled `.mcp.json`, so the config is already per-session. Codex
   * performs no such expansion and a stdio server cannot ride argv across the
   * `resume` subcommand cleanly, so it returns a per-agent profile
   * (`~/.codex/<slug>.config.toml`) plus `--profile <slug>`. The profile layers
   * over the user's base config, so it never clobbers a `switch` server the user
   * defined themselves.
   *
   * Returns `null` when there is nothing to register (no Switch identity).
   */
  launchProfile?(params: {
    slug: string;
    switchServer: SwitchMcpLaunchServer | null;
  }): SwitchLaunchProfile | null;
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
