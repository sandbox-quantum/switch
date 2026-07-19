import { describe, expect, it } from 'vitest';
import { apiUrlFor, gatewayUrlFor, isPorts, pickFreePorts } from './free-port';

describe('pickFreePorts', () => {
  it('returns four distinct, positive host ports', async () => {
    const ports = await pickFreePorts();
    const values = [ports.gateway, ports.api, ports.mattermost, ports.postgres];
    for (const p of values) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(65536);
    }
    expect(new Set(values).size).toBe(4);
  });
});

describe('isPorts', () => {
  it('accepts a complete numeric port set', () => {
    expect(isPorts({ gateway: 1, api: 2, mattermost: 3, postgres: 4 })).toBe(true);
  });

  it('rejects partial or non-numeric shapes', () => {
    expect(isPorts({ gateway: 1, api: 2, mattermost: 3 })).toBe(false);
    expect(isPorts({ gateway: '1', api: 2, mattermost: 3, postgres: 4 })).toBe(false);
    expect(isPorts(null)).toBe(false);
    expect(isPorts('nope')).toBe(false);
  });
});

describe('url helpers', () => {
  it('build loopback URLs from the chosen ports', () => {
    const ports = { gateway: 3300, api: 8000, mattermost: 8065, postgres: 5432 };
    expect(gatewayUrlFor(ports)).toBe('http://localhost:3300');
    expect(apiUrlFor(ports)).toBe('http://localhost:8000');
  });
});
