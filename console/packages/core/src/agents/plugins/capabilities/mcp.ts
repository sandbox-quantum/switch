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
 * A per-agent launch config — what to write, what argv loads it, and what
 * environment it needs — the result of {@link IMcpBehavior.launchProfile}. Pure
 * data so it can be written directly (local/SSH runtimes) or baked into a
 * precomputed launch spec and written by the headless VM sidecar, which has no
 * plugin registry. A list rather than a single file so a host that needs the
 * config split across several is not a change to this type; Codex returns one
 * file, OpenCode two.
 */
export type SwitchLaunchProfile = {
  files: SwitchLaunchProfileFile[];
  /** Extra argv the launch command needs to load the profile. */
  args: string[];
  /**
   * Extra environment the launch command needs to load the profile, merged over
   * the provider's own launch env.
   *
   * Not every host can be pointed at a config file from the command line. Codex
   * takes `--profile <name>`; OpenCode has no equivalent flag at all and names
   * its extra config through `OPENCODE_CONFIG`, so for that host the environment
   * is the only way in. Values should stay short — the SSH and tmux paths render
   * the launch as a shell string — so a profile puts its content in a file and
   * uses this to point at it.
   *
   * A value naming one of the profile's own files writes
   * {@link LAUNCH_PROFILE_HOME_PLACEHOLDER} where the home directory belongs;
   * see that constant for why it cannot be resolved here.
   */
  env?: Record<string, string>;
};

/**
 * Token a launch profile writes in place of the agent's home directory, in its
 * env values and in its file content, substituted by whichever launch surface
 * applies the profile.
 *
 * A profile's files are addressed relative to home, but a host that names one
 * absolutely — OpenCode's `OPENCODE_CONFIG`, and the instructions path inside
 * that config — needs the real directory, and the profile builder cannot form
 * one: it is pure, and for a remote auto-session it runs on the desktop, which
 * does not know the VM's home directory — the sidecar resolves that when it
 * writes the files. So the profile says "home" and each surface fills in its own.
 *
 * It shares the launch spec's placeholder prefix, so a substitution missed on the
 * remote path is caught by the spec's leftover-placeholder check rather than
 * reaching the agent as a literal.
 */
export const LAUNCH_PROFILE_HOME_PLACEHOLDER = '__SWITCHDASH_HOME__';

/** Replace {@link LAUNCH_PROFILE_HOME_PLACEHOLDER} in one profile string. */
export function resolveLaunchProfileHome(value: string, homeDir: string): string {
  return value.split(LAUNCH_PROFILE_HOME_PLACEHOLDER).join(homeDir);
}

/** Replace {@link LAUNCH_PROFILE_HOME_PLACEHOLDER} in a profile's env values. */
export function resolveLaunchProfileEnv(
  env: Record<string, string> | undefined,
  homeDir: string
): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, resolveLaunchProfileHome(value, homeDir)])
  );
}

/**
 * Optional per-agent specialization folded into the launch profile: the values
 * collected for the fields the provider declares in
 * {@link IMcpBehavior.launchProfileFields}, keyed by those fields' keys.
 *
 * Deliberately open rather than a fixed set of names. Providers do not agree on
 * what a per-agent setting is — Codex's reasoning-effort enum, verbosity and
 * reasoning summary have no OpenCode equivalent, and OpenCode's model-specific
 * variant, temperature, top-p and step cap have no Codex one — so naming them
 * here would make one provider's vocabulary the type of all of them.
 *
 * Every value is a string, and an absent or empty one means "not set": the
 * provider's own configuration decides. That matters for the on/off settings —
 * omitting a web-search value leaves the user's base config alone, which is not
 * the same as setting it off.
 */
export type SwitchLaunchSpecialization = Record<string, string | undefined>;

/**
 * A model the host offers, and the reasoning variants that model accepts.
 *
 * `id` is written the way the provider's model field is typed (OpenCode:
 * `provider/model`), so a typed value can be compared to the catalogue without
 * either side reformatting.
 *
 * `variants` is empty for a model with no reasoning control — every local model
 * seen so far, which is exactly the case the form needs to know about: an empty
 * list means the variant field has nothing to offer and should say so rather
 * than accept a value that will be ignored.
 */
export type LaunchProfileModel = {
  id: string;
  variants: string[];
};

/**
 * Run a command on the host an agent runs on — the local machine or a remote
 * one — and return its stdout. Passed in rather than imported so a provider's
 * catalogue lookup works the same on both, and so it can be driven directly in a
 * test.
 */
export type LaunchProfileHostExec = (
  command: string,
  args: string[]
) => Promise<{ stdout: string }>;

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
   * line that the SSH and tmux paths re-render as a shell string. OpenCode
   * returns a config file and the environment variable naming it, having no
   * profile flag to load it with.
   *
   * Returns `null` when there is nothing to specialize.
   */
  launchProfile?(params: {
    slug: string;
    /** The agent's working directory, mixed into the profile name so two agents
     * that share a name in different directories get distinct profiles. */
    workingDir: string;
    /** Collected values, keyed by the provider's own field keys. */
    values: SwitchLaunchSpecialization;
  }): SwitchLaunchProfile | null;
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
  /**
   * The models this host offers for {@link launchProfileFields}'s model field,
   * with the reasoning variants each accepts.
   *
   * Optional, and the form works without it: a provider that does not implement
   * this gets a plain text model field, which is where both providers started.
   * Implementing it turns that field into one the app can check what was typed
   * against, and lets a variant field offer the values the *chosen model*
   * actually takes — which for OpenCode is the only correct answer, since the
   * list differs per model and an unrecognised one is ignored in silence.
   *
   * Throwing is meaningful: it means the host could not be asked (the CLI is not
   * installed there, the connection failed). The caller says so and falls back
   * to plain text rather than reporting that the host offers no models, which
   * would flag every valid model as wrong.
   */
  launchProfileModels?(exec: LaunchProfileHostExec): Promise<LaunchProfileModel[]>;
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
