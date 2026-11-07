import { describe, expect, it } from 'vitest';
import { HistoryCheck, parseHistoryReport } from './history.ts';

describe('history report', () => {
  it('reads the counts and the violations', () => {
    const report = parseHistoryReport(
      '{"rows": 3, "rooms": 1, "events": 2, "agents": 1, "violations": ["bus.room-seq-dense: room r"]}'
    );
    expect(report.events).toBe(2);
    expect(report.violations).toEqual(['bus.room-seq-dense: room r']);
  });

  it('refuses output that is not a report', () => {
    expect(() => parseHistoryReport('Traceback')).toThrow(/not JSON/);
    expect(() => parseHistoryReport('{"rows": 1}')).toThrow(/missing fields/);
  });

  it('is off unless the environment names the command', () => {
    expect(HistoryCheck.fromEnv({})).toBeNull();
    expect(HistoryCheck.fromEnv({ SWITCH_E2E_HISTORY_CHECK: '' })).toBeNull();
    expect(HistoryCheck.fromEnv({ SWITCH_E2E_HISTORY_CHECK: '/bin/true' })).not.toBeNull();
  });

  it('fails when the command cannot run, rather than passing', async () => {
    await expect(new HistoryCheck('/nonexistent/check').verify('e2e-x')).rejects.toThrow(
      /could not run/
    );
  });
});
