import { describe, expect, it } from 'vitest';
import { generateSessionName } from './generateSessionName';

describe('generateSessionName', () => {
  describe('heuristic generation (with title)', () => {
    it('generates a branch-style name from a title', () => {
      const result = generateSessionName({ title: 'Fix the login page crash on mobile' });
      expect(result).toBeTruthy();
      expect(result).not.toContain('/');
      expect(result).toMatch(/^[a-z0-9-]+$/);
    });

    it('generates from title and description', () => {
      const result = generateSessionName({
        title: 'Add OAuth2 support',
        description: 'We need SSO integration for enterprise customers',
      });
      expect(result).toBeTruthy();
      expect(result).toMatch(/^[a-z0-9-]+$/);
    });

    it('respects max session name length of 64', () => {
      const result = generateSessionName({
        title:
          'Implement a comprehensive authentication and authorization system with OAuth2 PKCE flow and SAML support',
      });
      expect(result.length).toBeLessThanOrEqual(64);
    });

    it('handles issue identifiers in title', () => {
      const result = generateSessionName({ title: 'Fix login bug #891' });
      expect(result).toBeTruthy();
      expect(result).toMatch(/^[a-z0-9-]+$/);
    });
  });

  describe('random generation (no title)', () => {
    it('generates a random friendly name when no input provided', () => {
      const result = generateSessionName({});
      expect(result).toBeTruthy();
      expect(result).toMatch(/^[a-z0-9-]+$/);
    });

    it('generates different names on subsequent calls', () => {
      const results = new Set<string>();
      for (let i = 0; i < 5; i++) {
        results.add(generateSessionName({}));
      }
      expect(results.size).toBeGreaterThanOrEqual(2);
    });
  });
});
