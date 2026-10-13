import { describe, expect, it, vi } from 'vitest';

vi.mock('./local-server-store', () => ({ localServerStore: {} }));
vi.mock('./remote-server-store', () => ({ remoteServerStore: {} }));

const { deriveManagedState } = await import('./managed-server-state');

const base = {
  phase: 'running' as const,
  checked: true,
  busy: false,
  hostBlocked: false,
  upgrade: null,
  drift: null,
  waiting: false,
  dockerUnavailable: false,
  failedTo: null,
};

describe('deriveManagedState', () => {
  it('is green and answering when running', () => {
    expect(deriveManagedState(base)).toMatchObject({
      tone: 'running',
      label: 'Running',
      answering: true,
      known: true,
    });
  });

  it('needs attention, but still answers, when an update waits on someone here', () => {
    const state = deriveManagedState({
      ...base,
      upgrade: { state: 'held', from: '0.29.0', to: '0.30.0' },
    });
    expect(state).toMatchObject({ tone: 'attention', label: 'Update ready', answering: true });
  });

  it('is working, and does not answer, while starting, stopping or updating', () => {
    expect(deriveManagedState({ ...base, phase: 'starting' })).toMatchObject({
      tone: 'working',
      answering: false,
    });
    expect(deriveManagedState({ ...base, phase: 'stopping' }).label).toBe('Stopping');
    expect(
      deriveManagedState({ ...base, upgrade: { state: 'updating', from: '1', to: '2' } }).label
    ).toBe('Updating');
  });

  it('still answers while waiting on another Console holding a running server', () => {
    expect(deriveManagedState({ ...base, waiting: true })).toMatchObject({
      tone: 'working',
      answering: true,
    });
    expect(deriveManagedState({ ...base, phase: 'stopped', waiting: true }).answering).toBe(false);
  });

  it('is not known to be stopped until its state has been read', () => {
    expect(deriveManagedState({ ...base, phase: 'stopped', checked: false })).toMatchObject({
      tone: 'stopped',
      known: false,
    });
    expect(deriveManagedState({ ...base, phase: 'stopped' }).known).toBe(true);
  });

  it('is red when it failed, saying which way', () => {
    expect(deriveManagedState({ ...base, phase: 'error' }).label).toBe('Failed to start');
    expect(deriveManagedState({ ...base, hostBlocked: true }).label).toBe('Host unreachable');
    expect(
      deriveManagedState({
        ...base,
        phase: 'error',
        drift: { deployed: '0.31.0', expected: '0.30.0', direction: 'downgrade' },
      }).label
    ).toBe('Newer than this app');
    expect(
      deriveManagedState({
        ...base,
        upgrade: { state: 'failed', from: '1', to: '2', error: 'x' },
      })
    ).toMatchObject({ tone: 'failed', label: 'Update failed', answering: false });
    expect(deriveManagedState({ ...base, phase: 'error', dockerUnavailable: true }).label).toBe(
      'Docker not running'
    );
  });

  it('says a stop or a reset that broke partway is that, not a failed start', () => {
    expect(deriveManagedState({ ...base, phase: 'error', failedTo: 'stop' })).toMatchObject({
      tone: 'failed',
      reason: 'stop-failed',
      label: "Couldn't stop",
    });
    expect(deriveManagedState({ ...base, phase: 'error', failedTo: 'reset' }).reason).toBe(
      'reset-failed'
    );
  });
});
