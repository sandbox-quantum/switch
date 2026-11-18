import { describe, expect, it } from 'vitest';
import { installOutputSummary } from './install-output-summary';

describe('installOutputSummary', () => {
  it('skips npm’s log-file footer for the line that says what failed', () => {
    const output = [
      'npm error code ENOTFOUND',
      'npm error syscall getaddrinfo',
      'npm error network request to https://registry.npmjs.org/@openai%2fcodex failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
      'npm error A complete log of this run can be found in: /Users/ada/.npm/_logs/2026-10-20T10_00_00_000Z-debug-0.log',
    ].join('\n');
    expect(installOutputSummary(output)).toBe('npm error code ENOTFOUND');
  });

  it('skips the older two-line npm footer', () => {
    const output = [
      'npm ERR! code EACCES',
      'npm ERR! A complete log of this run can be found in:',
      'npm ERR!     /Users/ada/.npm/_logs/2026-10-20T10_00_00_000Z-debug-0.log',
    ].join('\n');
    expect(installOutputSummary(output)).toBe('npm ERR! code EACCES');
  });

  it('falls back to the last line when nothing reads like an error', () => {
    expect(installOutputSummary('Downloading…\r\nexit status 7\n')).toBe('exit status 7');
  });

  it('returns null for empty output and caps a long line', () => {
    expect(installOutputSummary('  \n')).toBeNull();
    expect(installOutputSummary(`error ${'x'.repeat(300)}`)).toHaveLength(201);
  });
});
