import type { CommandContext } from '@switchdash/core/agents/plugins';
import { describe, expect, it } from 'vitest';
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

describe('codex buildCommand', () => {
  it('starts a fresh session with the prompt positional and no session-id flag', () => {
    const cmd = build({ ...base, autoApprove: true, initialPrompt: 'Fix the bug' });

    expect(cmd.command).toBe('codex');
    // sessionIdOnResumeOnly → the switchdash UUID is never injected on a fresh run.
    expect(cmd.args).not.toContain('switchdash-session');
    // auto-approve applied and hook-trust bypass always present.
    expect(cmd.args).toContain('--dangerously-bypass-hook-trust');
    // The prompt is the final positional argument.
    expect(cmd.args.at(-1)).toBe('Fix the bug');
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
