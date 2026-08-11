import { describe, expect, it } from 'vitest';
import { resolveSessionControl, type SessionControlContext } from './session-control';

const ESC = '\x1b';

const ctx: SessionControlContext = {
  room: 'hub',
  role: 'reviewer',
  threadId: 'msg-1',
  user: 'ada',
};

describe('resolveSessionControl', () => {
  it('reports no support for a provider Switch Console cannot drive', () => {
    const control = resolveSessionControl('gemini');
    expect(control.capabilities).toEqual({ reset: false, compact: false, interrupt: false });
    expect(control.plan('interrupt', ctx)).toBeNull();
  });

  it.each(['claude', 'codex', 'opencode'])('supports all three commands for %s', (providerId) => {
    expect(resolveSessionControl(providerId).capabilities).toEqual({
      reset: true,
      compact: true,
      interrupt: true,
    });
  });

  it.each(['claude', 'codex'])('interrupts %s with a bare ESC and no submit', (providerId) => {
    // Ctrl+C would exit the CLI rather than the turn, so the recipe must stay
    // ESC-only — and `raw` so no Enter is appended.
    expect(resolveSessionControl(providerId).plan('interrupt', ctx)).toEqual([
      { kind: 'raw', data: ESC },
    ]);
  });

  it.each(['claude', 'codex', 'opencode'])('returns null for an unknown command on %s', (providerId) => {
    expect(resolveSessionControl(providerId).plan('explode', ctx)).toBeNull();
  });

  it.each(['claude', 'codex', 'opencode'])(
    'reconnects and re-assumes the role after %s reset',
    (providerId) => {
      const steps = resolveSessionControl(providerId).plan('reset', ctx);
      expect(steps).not.toBeNull();

      // Whatever the provider calls it, reset drops the context — so the
      // follow-up must put the agent back in the room, back in its role, and
      // tell the asker in their thread.
      const announce = steps!.at(-1);
      expect(announce).toMatchObject({ kind: 'prompt' });
      const text = (announce as { text: string }).text;
      expect(text).toContain('connect to switch room "hub"');
      expect(text).toContain('assume the role reviewer');
      expect(text).toContain('send a targeted message to ada');
      expect(text).toContain('as a threaded reply to message msg-1');
      expect(text).toContain('session has been reset');
    }
  );

  // Codex gates both slash commands behind `available_during_task()` and drops
  // them outright mid-turn, so each has to interrupt first — otherwise the
  // command is discarded and the follow-up announces work that never happened.
  it.each([
    ['reset', '/clear'],
    ['compact', '/compact'],
  ])('interrupts before %s on codex, which drops slash commands mid-turn', (command, slash) => {
    expect(resolveSessionControl('codex').plan(command, ctx)?.slice(0, 2)).toEqual([
      { kind: 'raw', data: ESC },
      { kind: 'prompt', text: slash },
    ]);
  });

  // Claude queues a slash command typed mid-turn, so it needs no interrupt.
  it('compacts claude with /compact and no preceding interrupt', () => {
    expect(resolveSessionControl('claude').plan('compact', ctx)?.[0]).toEqual({
      kind: 'prompt',
      text: '/compact',
    });
  });

  it.each(['claude', 'codex', 'opencode'])('announces the compaction back to the room on %s', (providerId) => {
    const steps = resolveSessionControl(providerId).plan('compact', ctx);
    expect(steps).not.toBeNull();
    expect((steps!.at(-1) as { text: string }).text).toContain('context has been compacted');
  });

  // OpenCode needs Escape TWICE, and coalesces `\x1b\x1b` arriving as one write
  // into a single escape sequence that does nothing — so the two must stay
  // separate steps for the executor to space them apart. A regression here is
  // silent: the interrupt is simply ignored and the turn keeps running.
  it('interrupts opencode with two separate ESC writes', () => {
    expect(resolveSessionControl('opencode').plan('interrupt', ctx)).toEqual([
      { kind: 'raw', data: ESC },
      { kind: 'raw', data: ESC },
    ]);
  });

  it('does not interrupt opencode with one doubled ESC write', () => {
    const steps = resolveSessionControl('opencode').plan('interrupt', ctx);
    expect(steps).not.toContainEqual({ kind: 'raw', data: `${ESC}${ESC}` });
  });

  // OpenCode has no /clear; a fresh session is /new.
  it('resets opencode with /new rather than /clear', () => {
    const steps = resolveSessionControl('opencode').plan('reset', ctx);
    expect(steps?.[0]).toEqual({ kind: 'prompt', text: '/new' });
    expect(steps).not.toContainEqual({ kind: 'prompt', text: '/clear' });
  });

  it('compacts opencode with /compact and no preceding interrupt', () => {
    expect(resolveSessionControl('opencode').plan('compact', ctx)?.[0]).toEqual({
      kind: 'prompt',
      text: '/compact',
    });
  });

  it('omits the role and thread clauses when there is neither', () => {
    const steps = resolveSessionControl('codex').plan('reset', {
      room: 'hub',
      role: null,
      threadId: null,
      user: null,
    });
    const text = (steps!.at(-1) as { text: string }).text;
    expect(text).not.toContain('assume the role');
    expect(text).not.toContain('threaded reply');
    expect(text).toContain('post a short message');
  });
});
