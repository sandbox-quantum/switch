import { describe, expect, it } from 'vitest';
import { canAttemptMachineProvider, type MachineProvider } from './managed-agents';

const report = (overrides: Partial<MachineProvider>): MachineProvider => ({
  provider: 'deepseek-harness',
  ready: false,
  problem: 'not logged in',
  detail: null,
  loginHelps: true,
  ...overrides,
});

describe('canAttemptMachineProvider', () => {
  it('allows ready or explicitly unverified installed providers, but not missing reports or unavailable providers', () => {
    expect(canAttemptMachineProvider(report({ ready: true }))).toBe(true);
    expect(
      canAttemptMachineProvider(report({ canAttempt: true, problem: 'login could not be checked' }))
    ).toBe(true);
    expect(canAttemptMachineProvider(report({ problem: 'not installed' }))).toBe(false);
    expect(canAttemptMachineProvider(report({ problem: 'not logged in' }))).toBe(false);
    expect(canAttemptMachineProvider(report({ problem: 'login expired' }))).toBe(false);
    expect(canAttemptMachineProvider(undefined)).toBe(false);
  });
});
