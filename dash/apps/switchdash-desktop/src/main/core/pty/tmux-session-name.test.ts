import { describe, expect, it } from 'vitest';
import {
  makeAgentTmuxSessionName as makeSidecarAgentTmuxSessionName,
  parseAgentTmuxSessionName,
} from '../../../sidecar/vm-tmux';
import { buildTmuxShellLine, makeAgentTmuxSessionName } from './tmux-session-name';

describe('buildTmuxShellLine', () => {
  it('enables tmux mouse scrolling and deep history before attach', () => {
    const result = buildTmuxShellLine('agent-session', 'exec /bin/zsh -il');

    expect(result).toMatch(/^\/bin\/sh -c /);
    // Targets use the `=` exact-match prefix so a `<x>` agent session never
    // resolves to its own `<x>-sidecar` session via tmux prefix matching.
    expect(result).toContain('tmux has-session -t \\"=agent-session\\"');
    expect(result).toContain(
      'tmux -u new-session -d -s \\"agent-session\\" \\"exec /bin/zsh -il\\"'
    );
    // set-option needs the trailing colon: it rejects a bare `=name` target
    // ("no such session"), silently disabling mouse scroll on tmux terminals
    // (CHOO-1403). `=name:` keeps the exact match and is accepted.
    expect(result).toContain('tmux set-option -t \\"=agent-session:\\" mouse on');
    expect(result).toContain('tmux set-option -t \\"=agent-session:\\" history-limit 100000');
    expect(result).toContain('tmux set-option -t \\"=agent-session:\\" window-size latest');
    expect(result).toContain('tmux -u attach-session -t \\"=agent-session\\"');
    expect(result.indexOf('mouse on')).toBeLessThan(result.indexOf('attach-session'));
    expect(result.indexOf('history-limit')).toBeLessThan(result.indexOf('attach-session'));
    expect(result.indexOf('window-size latest')).toBeLessThan(result.indexOf('attach-session'));
  });

  it('does not prefix the new-session name with the exact-match marker', () => {
    const result = buildTmuxShellLine('agent-session', 'exec /bin/zsh -il');

    expect(result).not.toContain('new-session -d -s \\"=agent-session\\"');
  });

  it('sets pane env on the new session with -e flags (so it reaches the agent process)', () => {
    const result = buildTmuxShellLine('agent-session', 'claude', {
      SWITCHDASH_HOOK_PORT: '42339',
      SWITCHDASH_HOOK_TOKEN: 'tok-123',
    });

    // tmux applies -e to the new session's panes; without this the agent inherits
    // the tmux server env, not the env the launcher intended.
    expect(result).toContain("-e 'SWITCHDASH_HOOK_PORT=42339'");
    expect(result).toContain("-e 'SWITCHDASH_HOOK_TOKEN=tok-123'");
    // -e flags belong to new-session, before -s.
    expect(result.indexOf('-e ')).toBeLessThan(result.indexOf('-s '));
    expect(result.indexOf('new-session')).toBeLessThan(result.indexOf('-e '));
  });

  it('omits -e flags when no pane env is given', () => {
    const result = buildTmuxShellLine('agent-session', 'claude');

    expect(result).toContain('new-session -d -s \\"agent-session\\"');
    expect(result).not.toContain('-e ');
  });
});

describe('makeAgentTmuxSessionName', () => {
  const sessionId = 'c1fc96ca-d642-4a5e-a392-8205391e2d11';

  it('derives the pane name from the sessionId alone (no projectId)', () => {
    // The core CHOO-1181 guarantee: two switchdash clients with DIFFERENT local
    // projectIds/scopeIds must compute the SAME tmux name for the same shared
    // conversation, so they attach to one pane instead of each spawning a blank
    // one. So the name must be a pure function of the sessionId.
    const name = makeAgentTmuxSessionName(sessionId);
    expect(name).toBe(
      `switchdash-${Buffer.from(`session-${sessionId}`, 'utf8').toString('base64url')}`
    );
  });

  it('matches the sidecar (VM) derivation so a client attaches to the sidecar-spawned pane', () => {
    expect(makeAgentTmuxSessionName(sessionId)).toBe(makeSidecarAgentTmuxSessionName(sessionId));
  });

  it('round-trips through parseAgentTmuxSessionName (lets the sidecar enumerate panes)', () => {
    expect(parseAgentTmuxSessionName(makeAgentTmuxSessionName(sessionId))).toBe(sessionId);
  });

  it('parseAgentTmuxSessionName ignores non-agent tmux sessions', () => {
    expect(parseAgentTmuxSessionName('switchdash-sidecar-320390b87bfaee19')).toBeNull();
    // A terminal / legacy pane whose decoded payload is not `session-<id>`.
    expect(
      parseAgentTmuxSessionName(
        `switchdash-${Buffer.from('proj:scope:leaf').toString('base64url')}`
      )
    ).toBeNull();
    expect(parseAgentTmuxSessionName('some-other-session')).toBeNull();
  });
});
