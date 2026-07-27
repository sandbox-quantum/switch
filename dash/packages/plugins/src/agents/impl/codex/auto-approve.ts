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
 * `--dangerously-bypass-hook-trust` is always included: it is orthogonal to the
 * sandbox and lets Codex run switchdash's own SessionStart hook (which captures
 * the rollout session id used for resume) without the interactive trust prompt
 * that automated sessions cannot answer.
 */
export function buildCodexAutoApproveFlag(env: Record<string, string | undefined> = {}): string {
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
  return `-c approval_policy="${approvalPolicy}" -c sandbox_mode="${sandboxMode}" --dangerously-bypass-hook-trust`;
}
