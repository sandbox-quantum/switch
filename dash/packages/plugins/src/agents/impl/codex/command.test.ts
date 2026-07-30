import type { CommandContext } from '@switchdash/core/agents/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provider } from './index';

function build(ctx: CommandContext) {
  return provider.behavior.prompt!.buildCommand(ctx);
}

const base: CommandContext = {
  cli: 'codex',
  autoApprove: false,
  isResuming: false,
  sessionId: 'switchdash-session',
  model: '',
};

// Emitted for every session: Codex runs no hook it has no persisted trust
// entry for, and switchdash's hooks are how it tracks rooms and captures the
// rollout id.
const TRUST_FLAG = '--dangerously-bypass-hook-trust';

// The default (unset) sandbox/approval flag, split the way buildStandardCommand
// splits it on whitespace.
const AUTO_FLAGS = ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'];

describe('codex buildCommand', () => {
  // Neutralize any ambient CODEX_SANDBOX_MODE / CODEX_APPROVAL_POLICY on the dev
  // machine so the auto-approve flag is deterministic (blank → defaults).
  beforeEach(() => {
    vi.stubEnv('CODEX_SANDBOX_MODE', '');
    vi.stubEnv('CODEX_APPROVAL_POLICY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts a fresh session with auto-approve flags then the positional prompt', () => {
    const cmd = build({ ...base, autoApprove: true, initialPrompt: 'Fix the bug' });

    expect(cmd.command).toBe('codex');
    // sessionIdOnResumeOnly → the switchdash UUID is never injected on a fresh run.
    // Full structural check: auto-approve flags in order, prompt last.
    expect(cmd.args).toEqual([TRUST_FLAG, ...AUTO_FLAGS, 'Fix the bug']);
  });

  it('omits auto-approve args when autoApprove is false, but keeps hook trust', () => {
    // Gating hook trust on auto-approve left a default agent running none of
    // switchdash's hooks, so room tracking and rollout-id capture were dead.
    const cmd = build({ ...base, initialPrompt: 'hello' });
    expect(cmd.args).not.toContain('approval_policy="never"');
    expect(cmd.args).toEqual([TRUST_FLAG, 'hello']);
  });

  it('keeps hook trust on resume, where the flag precedes the subcommand', () => {
    const cmd = build({ ...base, isResuming: true, providerSessionId: 'rollout-9' });
    expect(cmd.args.slice(0, 3)).toEqual([TRUST_FLAG, 'resume', 'rollout-9']);
  });

  it('resumes with the captured rollout session id', () => {
    const cmd = build({ ...base, isResuming: true, providerSessionId: 'rollout-9' });
    expect(cmd.args[1]).toBe('resume');
    expect(cmd.args[2]).toBe('rollout-9');
    // No positional prompt is added on resume.
    expect(cmd.args).not.toContain('Fix the bug');
  });

  it('orders resume subcommand + id BEFORE the auto-approve flags on resume', () => {
    const cmd = build({
      ...base,
      isResuming: true,
      providerSessionId: 'rollout-9',
      autoApprove: true,
    });
    // Regression guard on arg order: `resume <id>` must precede the -c flags,
    // and no positional prompt is appended on resume.
    expect(cmd.args).toEqual([TRUST_FLAG, 'resume', 'rollout-9', ...AUTO_FLAGS]);
  });

  it('falls back to `resume --last` as split args when no rollout id was captured', () => {
    const cmd = build({ ...base, isResuming: true });
    // Regression guard: the multi-token fallback must be two argv elements,
    // not a single "resume --last" string.
    expect(cmd.args.slice(1, 3)).toEqual(['resume', '--last']);
  });

  it('rejects an invalid sandbox mode when the session actually auto-approves', () => {
    vi.stubEnv('CODEX_SANDBOX_MODE', 'full');
    expect(() => build({ ...base, autoApprove: true, initialPrompt: 'hi' })).toThrow(
      /Invalid CODEX_SANDBOX_MODE="full"/
    );
  });

  it('does not resolve the sandbox env for a session that never auto-approves', () => {
    // The flag is unused on this path, so a typo in the env must not stop the
    // session from launching at all.
    vi.stubEnv('CODEX_SANDBOX_MODE', 'full');
    expect(build({ ...base, initialPrompt: 'hi' }).args).toEqual([TRUST_FLAG, 'hi']);
  });

  it('deduplicates the bypass-approvals-and-sandbox singleton flag', () => {
    const cmd = build({
      ...base,
      extraArgs: [
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-approvals-and-sandbox',
      ],
    });
    expect(cmd.args.filter((a) => a === '--dangerously-bypass-approvals-and-sandbox')).toHaveLength(
      1
    );
  });
});
