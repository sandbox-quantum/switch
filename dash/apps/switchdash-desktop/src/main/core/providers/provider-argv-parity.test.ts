import { pluginRegistry } from '@switchdash/plugins/agents';
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
 * pinning: its flags disable the sandbox and bypass hook trust, so a stale
 * mirror misrepresents how much access a session is launched with.
 */
describe('codex registry metadata matches the argv the plugin builds', () => {
  it('emits the mirrored defaultArgs and autoApproveFlag', () => {
    const def = getProvider('codex')!;
    const args = buildCodexArgs(true);

    expect(def.defaultArgs).toBeDefined();
    expect(def.autoApproveFlag).toBeDefined();
    expect(containsSequence(args, def.defaultArgs!)).toBe(true);
    expect(containsSequence(args, splitFlag(def.autoApproveFlag!))).toBe(true);
  });

  it('emits defaultArgs on a session that does not auto-approve', () => {
    // Hook trust belongs in defaultArgs, not autoApproveFlag: Codex silently
    // skips hooks it has no trust entry for, so gating it on auto-approve
    // leaves a default session running none of switchdash's hooks.
    const def = getProvider('codex')!;
    const args = buildCodexArgs(false);

    expect(containsSequence(args, def.defaultArgs!)).toBe(true);
    expect(args).not.toContain('-c');
  });
});
