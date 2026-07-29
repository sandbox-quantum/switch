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

// The default (unset) sandbox/approval flag, split the way buildStandardCommand
// splits it on whitespace.
const AUTO_FLAGS = [
  '-c',
  'approval_policy="never"',
  '-c',
  'sandbox_mode="danger-full-access"',
  '--dangerously-bypass-hook-trust',
];

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
    expect(cmd.args).toEqual([...AUTO_FLAGS, 'Fix the bug']);
  });

  it('omits auto-approve args when autoApprove is false', () => {
    const cmd = build({ ...base, initialPrompt: 'hello' });
    expect(cmd.args).not.toContain('--dangerously-bypass-hook-trust');
    expect(cmd.args).toEqual(['hello']);
  });

  it('resumes with the captured rollout session id', () => {
    const cmd = build({ ...base, isResuming: true, providerSessionId: 'rollout-9' });
    expect(cmd.args[0]).toBe('resume');
    expect(cmd.args[1]).toBe('rollout-9');
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
    expect(cmd.args).toEqual(['resume', 'rollout-9', ...AUTO_FLAGS]);
  });

  it('falls back to `resume --last` as split args when no rollout id was captured', () => {
    const cmd = build({ ...base, isResuming: true });
    // Regression guard: the multi-token fallback must be two argv elements,
    // not a single "resume --last" string.
    expect(cmd.args.slice(0, 2)).toEqual(['resume', '--last']);
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
