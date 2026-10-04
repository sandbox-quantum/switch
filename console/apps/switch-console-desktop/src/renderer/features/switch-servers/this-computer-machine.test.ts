import { describe, expect, it } from 'vitest';
import type {
  EmbeddedControllerOverview,
  EmbeddedControllerPhase,
  EmbeddedControllerRemote,
} from '@shared/core/embedded-controller/embedded-controller';
import {
  agentActual,
  canStartAgain,
  machineStatus,
  toggleBlocker,
  toggleChecked,
} from './this-computer-machine';

const ENROLLMENT = {
  controllerId: 'controller-1',
  name: 'build-box',
  workspaceId: 'workspace-1',
  enrolledAt: '2026-01-01T00:00:00Z',
};

function overview(
  phase: EmbeddedControllerPhase,
  remote: EmbeddedControllerRemote | null,
  enrolled = true
): EmbeddedControllerOverview {
  return {
    serverId: 'server-1',
    unsupportedReason: null,
    enrollment: enrolled ? ENROLLMENT : null,
    phase,
    remote,
  };
}

const ok = (state: 'online' | 'unknown' | 'revoked' | null): EmbeddedControllerRemote => ({
  kind: 'ok',
  controller: state ? { state, lastSeenAt: null } : null,
  agents: [],
});
const running: EmbeddedControllerPhase = { kind: 'running', since: '2026-01-01T00:00:00Z' };
/** Well past the connecting grace for `running`. */
const LATER = Date.parse('2026-01-01T01:00:00Z');

describe('machineStatus', () => {
  it('says running only while the server sees the controller online', () => {
    expect(machineStatus(overview(running, ok('online')), LATER).label).toBe('Running');
    expect(machineStatus(overview(running, ok('unknown')), LATER)).toMatchObject({
      label: 'Disconnected',
      tone: 'warn',
    });
    expect(machineStatus(overview(running, ok('revoked')), LATER).label).toBe('Removed');
    expect(machineStatus(overview(running, { kind: 'unavailable' }), LATER).label).toBe(
      'Disconnected'
    );
    expect(
      machineStatus(overview(running, { kind: 'error', message: 'offline' }), LATER)
    ).toMatchObject({
      label: 'Running',
      tone: 'warn',
    });
  });

  it('says connecting, not disconnected, in the first minute after the controller starts', () => {
    const justStarted = Date.parse(running.since) + 5_000;
    expect(machineStatus(overview(running, ok('unknown')), justStarted)).toMatchObject({
      label: 'Connecting…',
      tone: 'busy',
    });
    expect(machineStatus(overview(running, ok('online')), justStarted).label).toBe('Running');
  });

  it('names every other phase, with the reason where there is one', () => {
    expect(machineStatus(overview({ kind: 'off' }, ok(null), false), LATER).label).toBe('Off');
    expect(machineStatus(overview({ kind: 'enrolling' }, null, false), LATER).tone).toBe('busy');
    expect(
      machineStatus(
        overview(
          {
            kind: 'restarting',
            attempt: 2,
            retryAt: '2026-01-01T00:00:02Z',
            lastExit: 'exit code 1',
          },
          ok('unknown')
        ),
        LATER
      )
    ).toMatchObject({ label: 'Disconnected', detail: expect.stringContaining('exit code 1') });
    expect(machineStatus(overview({ kind: 'removed', at: 'x' }, null, false), LATER)).toMatchObject(
      {
        label: 'Removed',
        detail: expect.stringContaining('This computer was removed from Switch.'),
      }
    );
    expect(machineStatus(overview({ kind: 'taken_over', at: 'x' }, null), LATER).detail).toMatch(
      /took over/
    );
    expect(machineStatus(overview({ kind: 'error', message: 'boom' }, null), LATER)).toEqual({
      label: 'Error',
      tone: 'error',
      detail: 'boom',
    });
  });
});

describe('toggle', () => {
  it('blocks turning on where the controller cannot run or the server cannot place agents', () => {
    const off = { kind: 'off' } as const;
    expect(toggleBlocker(overview(off, ok(null), false))).toBeNull();
    expect(
      toggleBlocker({
        ...overview(off, ok(null), false),
        unsupportedReason: 'Needs macOS or Linux.',
      })
    ).toBe('Needs macOS or Linux.');
    expect(toggleBlocker(overview(off, { kind: 'unavailable' }, false))).toMatch(
      /agent management turned on/
    );
    expect(toggleBlocker(overview(off, null, false))).toMatch(/Open a workspace/);
    expect(toggleBlocker(overview({ kind: 'enrolling' }, null, false))).toBe('Working…');
  });

  it('always lets an enrolled computer be turned off, unless something is in flight', () => {
    expect(toggleBlocker(overview(running, { kind: 'unavailable' }))).toBeNull();
    expect(toggleBlocker(overview({ kind: 'stopping' }, ok('online')))).toBe('Working…');
    expect(toggleChecked(overview(running, ok('online')))).toBe(true);
    expect(toggleChecked(overview({ kind: 'enrolling' }, null, false))).toBe(true);
    expect(toggleChecked(overview({ kind: 'removed', at: 'x' }, null, false))).toBe(false);
  });

  it('offers to start again only after a takeover or an error', () => {
    expect(canStartAgain(overview({ kind: 'taken_over', at: 'x' }, null))).toBe(true);
    expect(canStartAgain(overview({ kind: 'error', message: 'm' }, null))).toBe(true);
    expect(canStartAgain(overview(running, null))).toBe(false);
    expect(canStartAgain(overview({ kind: 'error', message: 'm' }, null, false))).toBe(false);
  });
});

describe('agentActual', () => {
  const base = {
    agentId: 'a',
    name: 'scout',
    displayName: null,
    provider: 'claude',
    desiredState: 'running' as const,
  };

  it('reads the last report: process, attachment and reason', () => {
    expect(agentActual({ ...base, actual: null })).toEqual({
      label: 'Not reported yet',
      tone: 'neutral',
    });
    expect(
      agentActual({
        ...base,
        actual: { process: 'running', attached: true, reason: null, detail: null },
      })
    ).toEqual({ label: 'running', tone: 'ok' });
    expect(
      agentActual({
        ...base,
        actual: { process: 'running', attached: false, reason: null, detail: null },
      })
    ).toEqual({ label: 'running, not attached', tone: 'warn' });
    expect(
      agentActual({
        ...base,
        actual: {
          process: 'failed',
          attached: false,
          reason: 'provider_login_missing',
          detail: 'x',
        },
      })
    ).toEqual({ label: 'failed (provider login missing)', tone: 'error' });
  });
});
