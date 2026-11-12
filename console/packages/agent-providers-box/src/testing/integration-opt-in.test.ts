import { expect, it } from 'vitest';
import { integrationOptedIn } from './conformance';

it('runs the live provider suites only when explicitly asked', () => {
  // A live run reaches the real provider CLI on a real login, so it must be asked for.
  expect(integrationOptedIn({})).toBe(false);
  expect(integrationOptedIn({ SWITCH_RUN_INTEGRATION: '0' })).toBe(false);
  expect(integrationOptedIn({ SWITCH_RUN_INTEGRATION: 'true' })).toBe(false);
  expect(integrationOptedIn({ SWITCH_RUN_INTEGRATION: '1' })).toBe(true);
});
