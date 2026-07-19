import { describe, expect, it } from 'vitest';
import { generateSecrets } from './secret-values';

describe('generateSecrets', () => {
  it('populates every field with a non-empty value', () => {
    const s = generateSecrets();
    for (const [key, value] of Object.entries(s)) {
      expect(value, `empty ${key}`).toBeTruthy();
      expect(value.length, `short ${key}`).toBeGreaterThanOrEqual(16);
    }
  });

  it('generates distinct values across fields and across calls', () => {
    const a = generateSecrets();
    const b = generateSecrets();
    expect(new Set(Object.values(a)).size).toBe(Object.keys(a).length);
    expect(a.jwtSecretKey).not.toBe(b.jwtSecretKey);
    expect(a.dbPassword).not.toBe(b.dbPassword);
  });
});
