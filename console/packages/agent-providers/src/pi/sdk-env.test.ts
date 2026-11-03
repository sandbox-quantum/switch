import { describe, expect, it } from 'vitest';
import { EXECUTION_INHERIT_ENV } from '../host/agent-env';
import { PI_VERSION } from './pi-version';
import { PI_SDK_ENV, PI_SDK_ENV_REVIEWED_FOR } from './sdk-env';
import { PI_INHERIT_ENV, PI_PROVIDER_ENV } from './sign-in';

const named = (decision: 'pi' | 'shared' | 'excluded') =>
  Object.entries(PI_SDK_ENV)
    .filter(([, entry]) =>
      decision === 'excluded' ? typeof entry.decision === 'object' : entry.decision === decision
    )
    .map(([name]) => name);

describe('the variables the SDKs Pi uses read', () => {
  it('were searched for in the Pi release Switch runs', () => {
    // A new Pi is searched again, and every variable it reads decided on, before this passes.
    expect(PI_SDK_ENV_REVIEWED_FOR).toBe(PI_VERSION);
  });

  it('decided on as Pi’s own are exactly what Pi is given beside its providers’ keys', () => {
    const providerKeys = Object.values(PI_PROVIDER_ENV).flat();
    expect(new Set(PI_INHERIT_ENV)).toEqual(new Set([...providerKeys, ...named('pi')]));
    // The instance metadata service's endpoint and its mode (R4-A), among them.
    for (const name of [
      'AWS_EC2_METADATA_SERVICE_ENDPOINT',
      'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
    ])
      expect(PI_SDK_ENV[name]?.decision, name).toBe('pi');
  });

  it('decided on as shared reach every provider’s sessions already', () => {
    expect(named('shared').length).toBeGreaterThan(0);
    for (const name of named('shared')) expect(EXECUTION_INHERIT_ENV, name).toContain(name);
  });

  it('kept from Pi reach no session of Pi, each for a reason', () => {
    expect(named('excluded').length).toBeGreaterThan(0);
    for (const name of named('excluded')) {
      expect(PI_INHERIT_ENV, name).not.toContain(name);
      expect(EXECUTION_INHERIT_ENV, name).not.toContain(name);
      const { decision } = PI_SDK_ENV[name]!;
      expect(typeof decision === 'object' && decision.excluded.length > 10, name).toBe(true);
    }
  });

  it('each say where the search found them', () => {
    for (const [name, { at }] of Object.entries(PI_SDK_ENV))
      expect(at, name).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9.-]+\/[^\s:]+\.(c|m)?js:\d+$/);
  });
});
