import { beforeEach, describe, expect, it, vi } from 'vitest';

const report = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/telemetry/report', () => ({ report }));

const { reportBuddyMessage, reportBuddyStep } = await import('./buddy-telemetry');

const buddy = { id: 'a-1', name: 'switch-buddy-max' } as never;
const helper = { id: 'a-2', name: 'helper' } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportBuddyMessage', () => {
  it('counts a message to the buddy alone as the how-manyth in its chat', () => {
    reportBuddyMessage([buddy], 0);
    reportBuddyMessage([buddy], 4);
    expect(report.mock.calls).toEqual([
      ['buddy_message_sent', { nth: '1' }],
      ['buddy_message_sent', { nth: '5' }],
    ]);
  });

  it('counts the sixth and every later one together', () => {
    reportBuddyMessage([buddy], 5);
    reportBuddyMessage([buddy], 40);
    expect(report.mock.calls).toEqual([
      ['buddy_message_sent', { nth: '6+' }],
      ['buddy_message_sent', { nth: '6+' }],
    ]);
  });

  it('says nothing of a chat with another agent, or with the buddy and others', () => {
    reportBuddyMessage([helper], 0);
    reportBuddyMessage([buddy, helper], 0);
    reportBuddyMessage([], 0);
    expect(report).not.toHaveBeenCalled();
  });
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
