/**
 * Codex's sandbox and approval behavior is configurable through two switchdash
 * environment variables, documented in AGENTS.md:
 *   - CODEX_SANDBOX_MODE     → Codex `-c sandbox_mode=...`
 *   - CODEX_APPROVAL_POLICY  → Codex `-c approval_policy=...`
 *
 * When unset, both fall back to the automation defaults that headless
 * auto-sessions require (full access, no approval prompts). An explicit but
 * unrecognized value is a hard error rather than a silent fallback: a typo in
 * CODEX_SANDBOX_MODE must never quietly widen the sandbox back to full access.
 */

export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

const DEFAULT_SANDBOX_MODE: CodexSandboxMode = 'danger-full-access';
const DEFAULT_APPROVAL_POLICY: CodexApprovalPolicy = 'never';

function resolveEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  envVar: string
): T {
  const value = raw?.trim();
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${envVar}="${value}". Expected one of: ${allowed.join(', ')}.`);
}

/**
 * Build Codex's auto-approve argument string, honoring the CODEX_SANDBOX_MODE
 * and CODEX_APPROVAL_POLICY overrides.
 *
 * Hook trust is not part of this: it is orthogonal to the sandbox and every
 * session needs it, so it is a default arg rather than an auto-approve one.
 * See {@link CODEX_HOOK_TRUST_FLAG}.
 */
export function buildCodexAutoApproveFlag(env: Record<string, string | undefined>): string {
  const sandboxMode = resolveEnum(
    env.CODEX_SANDBOX_MODE,
    CODEX_SANDBOX_MODES,
    DEFAULT_SANDBOX_MODE,
    'CODEX_SANDBOX_MODE'
  );
  const approvalPolicy = resolveEnum(
    env.CODEX_APPROVAL_POLICY,
    CODEX_APPROVAL_POLICIES,
    DEFAULT_APPROVAL_POLICY,
    'CODEX_APPROVAL_POLICY'
  );
  return `-c approval_policy="${approvalPolicy}" -c sandbox_mode="${sandboxMode}"`;
}

/**
 * Lets Codex run the hooks switchdash installed without a persisted trust entry.
 *
 * Codex keys hook trust per entry in `~/.codex/config.toml`
 * (`[hooks.state."<hooks.json>:<event>:<group>:<index>"] trusted_hash`) and
 * skips any hook it has no entry for. Verified against 0.146.0: in `codex exec`
 * that skip is silent — no dump, no mention of the hook in the transcript — and
 * in the TUI it is a blocking startup review pane that a detached session has
 * nobody to answer. Either way switchdash's own hooks would not run, taking
 * room tracking and rollout-id capture with them, and rewriting a hook command
 * invalidates the entry a user had already granted.
 *
 * switchdash writes those hooks itself, which is the case the flag is documented
 * for ("automation that already vets hook sources"). It is per-invocation and
 * covers every enabled hook, so a hook the user added to `~/.codex/hooks.json`
 * also runs unreviewed in switchdash-launched sessions. Writing per-entry trust
 * instead would be narrower, but the hash input is undocumented and not
 * derivable from the command text, so it would break silently on a Codex change.
 */
export const CODEX_HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';
