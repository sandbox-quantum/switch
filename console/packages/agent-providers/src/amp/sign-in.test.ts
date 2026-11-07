import { describe, expect, it } from 'vitest';
import { parseAmpAccountList } from './sign-in';

describe('parseAmpAccountList', () => {
  it('reads a listed account as signed in', () => {
    expect(parseAmpAccountList('* someone@example.com (user_01ABCDEF)\n', '').status).toBe(
      'authenticated'
    );
    expect(parseAmpAccountList('* someone@example.com (https://ampcode.com)\n', '').status).toBe(
      'authenticated'
    );
    expect(parseAmpAccountList('Accounts:\n  someone@example.com  active\n', '').status).toBe(
      'authenticated'
    );
  });

  it('reads an empty list, or a line saying so, as signed out', () => {
    for (const output of ['', 'No saved accounts.\n', 'Not logged in. Run `amp login`.\n']) {
      const result = parseAmpAccountList(output, '');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('amp login');
    }
    expect(parseAmpAccountList('', 'error: not logged in').status).toBe('unauthenticated');
  });

  it('does not guess from output it does not recognise', () => {
    expect(parseAmpAccountList('Something unexpected\n', '').status).toBe('unknown');
  });
});
