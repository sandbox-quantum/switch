import { pluginRegistry } from '@switch-console/plugins/agents';
import { describe, expect, it } from 'vitest';
import { getProvider } from '@shared/core/providers/agent-provider-registry';

/** `splitFlag` in standard-command.ts is not exported; this mirrors it. */
function splitFlag(flag: string): string[] {
  return flag.split(/\s+/).filter(Boolean);
}

/** Whether `needle` appears in `haystack` as a contiguous run. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  return haystack.some((_, i) => needle.every((token, offset) => haystack[i + offset] === token));
}

function buildCodexArgs(autoApprove: boolean): string[] {
  return pluginRegistry.get('codex')!.behavior.prompt!.buildCommand({
    cli: 'codex',
    autoApprove,
    model: '',
    isResuming: false,
  }).args;
}

/**
 * The registry's argv fields describe the plugin rather than driving it, so
 * nothing at runtime notices when the two disagree. Codex is the entry worth
 * pinning: its flags suppress approval prompts, so a stale mirror
 * misrepresents how much access a session is launched with.
 */
describe('codex registry metadata matches the argv the plugin builds', () => {
  it('emits the mirrored autoApproveFlag', () => {
    const def = getProvider('codex')!;
    const args = buildCodexArgs(true);

    expect(def.autoApproveFlag).toBeDefined();
    expect(containsSequence(args, splitFlag(def.autoApproveFlag!))).toBe(true);
  });

  it('leaves the sandbox to the user config on both sides of the mirror', () => {
    // Auto-approve means unattended approvals, not unattended filesystem and
    // network access.
    const def = getProvider('codex')!;

    expect(def.autoApproveFlag).not.toContain('sandbox_mode');
    expect(buildCodexArgs(true).join(' ')).not.toContain('sandbox_mode');
  });

  it('adds no approval override on a session that does not auto-approve', () => {
    expect(buildCodexArgs(false)).not.toContain('-c');
  });
});
