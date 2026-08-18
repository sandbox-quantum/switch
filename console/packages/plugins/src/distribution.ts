/**
 * Single source of truth for the Switch plugin-marketplace source — the value
 * passed to `<agent> plugin marketplace add` (a GitHub `owner/repo` or a path)
 * when installing the Switch connector plugin.
 *
 * The repo is public, so `plugin marketplace add` resolves it without a
 * credential. Keep in sync with the Switch Console auto-update target
 * (RELEASE_REPO_* in apps/switch-console-desktop/src/shared/app-identity.ts).
 */
export const SWITCH_MARKETPLACE_SOURCE = 'sandbox-quantum/switch';

/**
 * The published agent-runtime version a session runs, for agents whose Switch
 * connector Switch Console writes itself rather than installing from the
 * marketplace.
 *
 * The two marketplace connectors pin this in their own `.mcp.json`, which is
 * what a Claude Code or Codex session actually reads. An agent with no
 * marketplace has no such file, so the pin lives here instead — and the two
 * must agree, or one host runs a different runtime from the others for no
 * visible reason. `runtime-pin.test.ts` fails when they drift.
 *
 * It must name a version that is *published*: the tag is pushed separately from
 * the merge, so this moves after the tag exists, never ahead of it. That is why
 * it is a literal rather than being derived from the artifact registry the way
 * the runtime's own `RUNTIME_VERSION` is — the registry says where the runtime
 * has got to, which during a release is a version npm does not have yet. A
 * pin has to lag it deliberately, and the lag is the point.
 */
export const SWITCH_AGENT_RUNTIME_PIN = '@sandboxaq/switch-agent-runtime@0.3.1';
