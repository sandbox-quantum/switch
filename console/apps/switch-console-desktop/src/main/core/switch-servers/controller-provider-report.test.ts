import { describe, expect, it } from 'vitest';
import { providerReport } from './controller-provider-report';

describe('providerReport', () => {
  const entry = { provider: 'codex', installed: true, auth: 'missing' };

  it('reads whether signing in would help, offering it unless the controller says not', () => {
    expect(providerReport({ ...entry, login_helps: false })?.loginHelps).toBe(false);
    expect(providerReport(entry)?.loginHelps).toBe(true);
    expect(providerReport({ ...entry, login_helps: 'no' })?.loginHelps).toBe(true);
  });

  it('keeps what the controller said, and reads a login state it does not know as unknown', () => {
    expect(providerReport({ ...entry, auth: 'later', auth_problem: 'In the keyring.' })).toEqual({
      provider: 'codex',
      installed: true,
      auth: 'unknown',
      problem: 'In the keyring.',
      loginHelps: true,
    });
  });

  it('leaves out an entry that does not say which provider, or whether it is installed', () => {
    expect(providerReport({ installed: true, auth: 'ok' })).toBeNull();
    expect(providerReport({ provider: 'codex', auth: 'ok' })).toBeNull();
    expect(providerReport(null)).toBeNull();
  });
});
