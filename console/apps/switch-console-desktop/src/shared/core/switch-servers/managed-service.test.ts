import { describe, expect, it } from 'vitest';
import { managedServiceOrigin } from './managed-service';

describe('managed service configuration', () => {
  it('normalizes a configured HTTPS origin', () => {
    expect(managedServiceOrigin(' https://SWITCH.example.com:443/ ')).toBe(
      'https://switch.example.com'
    );
  });
  it.each([undefined, '', '  '])('fails visibly when missing: %s', (value) => {
    expect(() => managedServiceOrigin(value)).toThrow('not configured');
  });
  it.each([
    'http://switch.example.com',
    'https://user:password@switch.example.com',
    'https://switch.example.com/path',
    'https://switch.example.com?token=example',
    'https://switch.example.com#fragment',
    'not-a-url',
  ])('rejects unsafe or ambiguous destinations: %s', (value) => {
    expect(() => managedServiceOrigin(value)).toThrow();
  });
});
