import type { CommandContext } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { provider } from './index';

function build(ctx: CommandContext) {
  return provider.behavior.prompt!.buildCommand(ctx);
}

const base: CommandContext = {
  cli: 'codex',
  autoApprove: false,
  isResuming: false,
  sessionId: 'switch-console-session',
  model: '',
};

// Emitted for every session: Codex runs no hook it has no persisted trust
// entry for, and Switch Console's hooks are how it reads the session's status and
// captures the rollout id.
const TRUST_FLAG = '--dangerously-bypass-hook-trust';

// The approval flag, split the way buildStandardCommand splits it on whitespace.
const AUTO_FLAGS = ['-c', 'approval_policy="never"'];

describe('codex buildCommand', () => {
  it('starts a fresh session with auto-approve flags then the positional prompt', () => {
    const cmd = build({ ...base, autoApprove: true, initialPrompt: 'Fix the bug' });

    expect(cmd.command).toBe('codex');
    // sessionIdOnResumeOnly → the Switch Console UUID is never injected on a fresh run.
    // Full structural check: auto-approve flags in order, prompt last.
    expect(cmd.args).toEqual([TRUST_FLAG, ...AUTO_FLAGS, 'Fix the bug']);
  });

  it('omits auto-approve args when autoApprove is false, but keeps hook trust', () => {
    // Hook trust is orthogonal to approvals: gate it on auto-approve and a
    // default agent runs none of Switch Console's hooks, taking the session's status
    // signals and its rollout-id capture with them.
    const cmd = build({ ...base, initialPrompt: 'hello' });
    expect(cmd.args).not.toContain('approval_policy="never"');
    expect(cmd.args).toEqual([TRUST_FLAG, 'hello']);
  });

  it('never overrides the sandbox, whatever the approval setting', () => {
    // Codex runs hooks outside the sandbox — verified against 0.146.0, a
    // SessionStart hook curling 127.0.0.1 succeeds under workspace-write — so
    // Switch Console's loopback hooks are no reason to hand a session full disk and
    // network access it was never asked to have.
    for (const autoApprove of [true, false]) {
      const cmd = build({ ...base, autoApprove, initialPrompt: 'hello' });
      expect(cmd.args.join(' ')).not.toContain('sandbox_mode');
    }
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
