import { beforeEach, describe, expect, it, vi } from 'vitest';

const report = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/telemetry/report', () => ({ report }));

const { reportBuddyStep } = await import('./buddy-telemetry');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportBuddyStep', () => {
  it('reports a known provider as itself and anything else as none', () => {
    reportBuddyStep('start', 'codex');
    reportBuddyStep('skip', null);
    reportBuddyStep('start', 'unheard-of');
    expect(report.mock.calls).toEqual([
      ['buddy_step', { action: 'start', provider: 'codex' }],
      ['buddy_step', { action: 'skip', provider: 'none' }],
      ['buddy_step', { action: 'start', provider: 'none' }],
    ]);
  });
});
