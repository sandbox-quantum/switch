import type { CommandContext } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { provider } from './index';

function build(ctx: CommandContext) {
  return provider.behavior.prompt!.buildCommand(ctx);
}

const base: CommandContext = {
  cli: 'codex',
  autoApprove: false,
  autoMode: false,
  isResuming: false,
  sessionId: 'switch-console-session',
  model: '',
};

// The approval flag, split the way buildStandardCommand splits it on whitespace.
const AUTO_FLAGS = ['-c', 'approval_policy="never"'];
const AUTO_MODE_FLAGS = [
  '-c',
  'approval_policy="on-request"',
  '-c',
  'approvals_reviewer="auto_review"',
];

describe('codex buildCommand', () => {
  it('starts a fresh session with auto-approve flags then the positional prompt', () => {
    const cmd = build({ ...base, autoApprove: true, initialPrompt: 'Fix the bug' });

    expect(cmd.command).toBe('codex');
    // sessionIdOnResumeOnly → the Switch Console UUID is never injected on a fresh run.
    // Full structural check: auto-approve flags in order, prompt last.
    expect(cmd.args).toEqual([...AUTO_FLAGS, 'Fix the bug']);
  });

  it('omits auto-approve args when autoApprove is false', () => {
    const cmd = build({ ...base, initialPrompt: 'hello' });
    expect(cmd.args).not.toContain('approval_policy="never"');
    expect(cmd.args).toEqual(['hello']);
  });

  it('never overrides the sandbox, whatever the approval setting', () => {
    for (const [autoApprove, autoMode] of [
      [true, false],
      [false, true],
      [false, false],
    ]) {
      const cmd = build({ ...base, autoApprove, autoMode, initialPrompt: 'hello' });
      expect(cmd.args.join(' ')).not.toContain('sandbox_mode');
    }
  });

  it("hands approvals to Codex's automatic reviewer in auto mode", () => {
    const cmd = build({ ...base, autoMode: true, initialPrompt: 'hello' });
    expect(cmd.args).toEqual([...AUTO_MODE_FLAGS, 'hello']);
  });

  it('passes only the bypass flags when bypass and auto mode are both on', () => {
    const cmd = build({ ...base, autoApprove: true, autoMode: true, initialPrompt: 'hello' });
    expect(cmd.args).toEqual([...AUTO_FLAGS, 'hello']);
  });

  it('keeps auto mode on resume, after the resume subcommand', () => {
    const cmd = build({
      ...base,
      isResuming: true,
      providerSessionId: 'rollout-9',
      autoMode: true,
    });
    expect(cmd.args).toEqual(['resume', 'rollout-9', ...AUTO_MODE_FLAGS]);
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
