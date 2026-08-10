import { describe, expect, it } from 'vitest';
import { agentSidecarTmuxName } from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { exactTmuxTarget, makeAgentTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { buildKillTmuxScript, resetTmuxTargets } from './reset-remote-agent-tmux';

const REPO = '/home/dev/repo';
const SLUG = 'agent-a';

describe('resetTmuxTargets', () => {
  it('kills every agent session plus this agent’s sidecar', () => {
    const targets = resetTmuxTargets(['s1', 's2'], REPO, SLUG);
    expect(targets).toContain(makeAgentTmuxSessionName('s1'));
    expect(targets).toContain(makeAgentTmuxSessionName('s2'));
    expect(targets).toContain(agentSidecarTmuxName(REPO, SLUG));
    expect(targets).toHaveLength(3);
  });

  it('kills the sidecar even when the agent has no sessions', () => {
    expect(resetTmuxTargets([], REPO, SLUG)).toEqual([agentSidecarTmuxName(REPO, SLUG)]);
  });

  it('targets only this agent’s sidecar, not a co-located agent’s', () => {
    expect(resetTmuxTargets([], REPO, SLUG)).not.toContain(agentSidecarTmuxName(REPO, 'agent-b'));
  });

  it('deduplicates repeated session ids', () => {
    const targets = resetTmuxTargets(['s1', 's1'], REPO, SLUG);
    expect(targets).toEqual([makeAgentTmuxSessionName('s1'), agentSidecarTmuxName(REPO, SLUG)]);
  });
});

describe('buildKillTmuxScript', () => {
  it('returns null when there is nothing to kill', () => {
    expect(buildKillTmuxScript([])).toBeNull();
  });

  it('fails loud (set -e) and guards each kill behind has-session', () => {
    const script = buildKillTmuxScript(['alpha', 'beta']);
    expect(script).not.toBeNull();
    const lines = script!.split('\n');
    expect(lines[0]).toBe('set -e');
    expect(lines).toHaveLength(3);
    for (const name of ['alpha', 'beta']) {
      const line = lines.find((l) => l.includes(name));
      expect(line).toBeDefined();
      // Each target is killed only if it exists, so an already-gone session is a
      // no-op rather than an error.
      expect(line).toContain('tmux has-session -t');
      expect(line).toContain('tmux kill-session -t');
    }
  });

  it('uses exact-match tmux targets so a name never prefix-matches its sidecar', () => {
    const name = makeAgentTmuxSessionName('s1');
    const script = buildKillTmuxScript([name]);
    // exactTmuxTarget prefixes '=', forcing an exact session-name match.
    expect(script).toContain(exactTmuxTarget(name));
    expect(exactTmuxTarget(name).startsWith('=')).toBe(true);
  });
});
