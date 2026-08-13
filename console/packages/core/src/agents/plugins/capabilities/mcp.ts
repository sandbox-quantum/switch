import z from 'zod';
import { definePluginCapability } from '../../../lib/plugins/capability';
import type { PluginFs } from '../../runtime/fs';
import type { RepoAgentField } from './repo-agents';

export type McpTransport = 'stdio' | 'http';

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

/**
 * Optional per-agent specialization folded into the launch profile.
 *
 * Every value is a string, and an absent or empty one means "not set" — the
 * provider's own configuration decides. That matters for the on/off settings:
 * omitting `webSearch` leaves the user's base config alone, which is not the
 * same as setting it to `false`.
 *
 * The keys are the field keys the provider declares in
 * {@link IMcpBehavior.launchProfileFields}, so what the form collects and what
 * the profile writer consumes are the same names end to end.
 */
export type SwitchLaunchSpecialization = {
  /** Model id, e.g. a Codex `model` override. */
  model?: string;
  /** Reasoning-effort id, e.g. a Codex `model_reasoning_effort` value. */
  effort?: string;
  /** How much prose the model writes (Codex: `model_verbosity`). */
  verbosity?: string;
  /** How much reasoning is summarised back (Codex: `model_reasoning_summary`). */
  reasoningSummary?: string;
  /** `"true"` / `"false"` / unset — whether the agent may search the web. */
  webSearch?: string;
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
   * Compute the launch config that applies a session's per-agent specialization
   * — model, reasoning effort, instructions — for a provider that can only take
   * them from a config file. Pure: it returns the files to write and the argv to
   * load them, leaving the write to the caller so the same result serves a
   * direct write (local/SSH) and a baked launch spec the sidecar writes.
   *
   * This does NOT register the Switch MCP server. Both connector plugins ship
   * that in their own bundled `.mcp.json`, so it is already present for every
   * session of that host, Switch Console-launched or not.
   *
   * Claude Code leaves this undefined: it takes its specialization on argv.
   * Codex returns a per-agent profile (`~/.codex/<name>.config.toml`) and
   * `--profile <name>`, because free-form instructions cannot ride a command
   * line that the SSH and tmux paths re-render as a shell string.
   *
   * Returns `null` when there is nothing to specialize.
   */
  launchProfile?(
    params: {
      slug: string;
      /** The agent's working directory, mixed into the profile name so two agents
       * that share a name in different directories get distinct profiles. */
      workingDir: string;
    } & SwitchLaunchSpecialization
  ): SwitchLaunchProfile | null;
  /**
   * Home-relative paths the launch profile occupies, so the agent's teardown
   * (delete/rename) can remove them. Pure and identity-shaped — same `(slug,
   * workingDir)` as {@link launchProfile} — so a caller can compute the paths for
   * a name it is about to drop. Undefined for a provider that writes no profile.
   */
  launchProfilePaths?(params: { slug: string; workingDir: string }): string[];
  /**
   * The per-agent fields that feed {@link launchProfile}, declared so the UI can
   * collect them without knowing the provider.
   *
   * This is the launch-profile counterpart of `repoAgents.attributeFields()`:
   * a provider keeps its per-agent settings either in a repo-agent definition or
   * in a launch profile, and whichever it is, the same "advanced configuration"
   * form renders these and the same editor saves them. Declaring them beside the
   * profile builder that consumes them is what stops the field list and the TOML
   * it produces drifting apart.
   *
   * Undefined for a provider that writes no profile.
   */
  launchProfileFields?(): RepoAgentField[];
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
