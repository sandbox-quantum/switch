import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { buildTmuxShellLine, killTmuxSession } from './tmux-session-name';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('killTmuxSession', () => {
  it('does not shell out to tmux on Windows, which never started one', async () => {
    setPlatform('win32');
    const exec = vi.fn();
    await killTmuxSession({ exec } as unknown as IExecutionContext, 'switchdash-abc');
    expect(exec).not.toHaveBeenCalled();
  });

  it('kills the exact session elsewhere', async () => {
    setPlatform('darwin');
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await killTmuxSession({ exec } as unknown as IExecutionContext, 'switchdash-abc');
    expect(exec).toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=switchdash-abc']);
  });
});

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
