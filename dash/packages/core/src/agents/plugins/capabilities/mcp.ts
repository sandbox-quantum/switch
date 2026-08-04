import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { PluginFs } from '../../runtime/fs';

export type McpTransport = 'stdio' | 'http';

/**
 * The Switch MCP runtime as a stdio command, handed to {@link
 * IMcpBehavior.launchProfile}.
 *
 * Static and secret-free — but not self-sufficient. An agent host spawns an MCP
 * server with an environment of its own choosing, not a copy of its own: Codex
 * passes a fixed allowlist (`HOME`, `PATH`, `SHELL`, `USER`, `TMPDIR`, …) and
 * drops everything else. `envVars` names what the host must route through for
 * the runtime to authenticate and to resolve its package, carrying names only
 * so no credential is written anywhere.
 */
export type SwitchMcpLaunchServer = {
  command: string;
  args: string[];
  /**
   * Environment variable names the host must forward from its own environment.
   * Required rather than optional: a launch server that omits them produces a
   * session whose Switch tools silently never start.
   */
  envVars: string[];
};

/** A single per-agent launch config file, path relative to the agent's home. */
export type SwitchLaunchProfileFile = {
  relativePath: string;
  content: string;
};

/**
 * A per-agent launch config — the files to write plus the argv that loads them —
 * the result of {@link IMcpBehavior.launchProfile}. Pure data so it can be
 * written directly (local/SSH runtimes) or baked into a precomputed launch spec
 * and written by the headless VM sidecar, which has no plugin registry. A list
 * rather than a single file so a host that needs the config split across several
 * is not a change to this type; Codex today returns exactly one.
 */
export type SwitchLaunchProfile = {
  files: SwitchLaunchProfileFile[];
  /** Extra argv the launch command needs to load the profile. */
  args: string[];
};

/** Optional per-agent specialization folded into the launch profile. */
export type SwitchLaunchSpecialization = {
  /** Model id, e.g. a Codex `model` override. */
  model?: string;
  /** Reasoning-effort id, e.g. a Codex `model_reasoning_effort` override. */
  reasoningEffort?: string;
  /** A system-prompt/instructions body, carried in the profile itself (Codex:
   * `developer_instructions`), which adds to the host's own operating
   * instructions rather than replacing them. */
  instructions?: string;
};

export type IMcpBehavior = {
  readServers(fs: PluginFs): Promise<McpServerRegistration[]>;
  writeServers(fs: PluginFs, servers: McpServerRegistration[]): Promise<void>;
  removeServer(fs: PluginFs, name: string): Promise<void>;
  /**
   * Compute the launch config that registers the Switch MCP server for a
   * session (and folds in any per-agent specialization), for agents whose
   * connector plugin cannot resolve a per-session server from a bundled config.
   * Pure: it returns the files to write and the argv to load them, leaving the
   * write to the caller so the same result serves a direct write (local/SSH) and
   * a baked launch spec the sidecar writes.
   *
   * Claude Code leaves this undefined: its plugin expands environment variables
   * in a bundled `.mcp.json`, so the config is already per-session. Codex
   * performs no such expansion and a stdio server cannot ride argv across the
   * `resume` subcommand cleanly, so it returns a per-agent profile
   * (`~/.codex/<name>.config.toml`) and `--profile <name>`. That profile must
   * also name the environment it needs;
   * see {@link SwitchMcpLaunchServer.envVars}.
   *
   * Returns `null` when there is nothing to write (no Switch identity and no
   * specialization).
   */
  launchProfile?(
    params: {
      slug: string;
      /** The agent's working directory, mixed into the profile name so two agents
       * that share a name in different directories get distinct profiles. */
      workingDir: string;
      switchServer: SwitchMcpLaunchServer | null;
    } & SwitchLaunchSpecialization
  ): SwitchLaunchProfile | null;
  /**
   * Home-relative paths the launch profile occupies, so the agent's teardown
   * (delete/rename) can remove them. Pure and identity-shaped — same `(slug,
   * workingDir)` as {@link launchProfile} — so a caller can compute the paths for
   * a name it is about to drop. Undefined for a provider that writes no profile.
   */
  launchProfilePaths?(params: { slug: string; workingDir: string }): string[];
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
