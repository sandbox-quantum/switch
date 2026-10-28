import { describe, expect, it } from 'vitest';
import type { MachineProvider } from '@shared/core/managed-agents/managed-agents';
import {
  installedHere,
  installSourcesDiffer,
  reportedHeadline,
  reportedProvider,
} from './this-computer-status';

function reported(patch: Partial<MachineProvider>): MachineProvider {
  return { provider: 'claude', ready: false, problem: null, detail: null, ...patch };
}

describe('Settings → Agent providers on this computer', () => {
  it('goes by the controller’s report when there is one, whatever Console’s own check found', () => {
    // The QA case: buddy said signed in, Console's own check had not found the CLI.
    const signedIn = reportedProvider(
      { serverId: 's', providers: [reported({ ready: true })] },
      'claude'
    );
    expect(installedHere(signedIn, 'missing')).toBe(true);
    expect(reportedHeadline(signedIn!)).toBe('Signed in');

    const missing = reported({ problem: 'not installed' });
    expect(installedHere(missing, 'available')).toBe(false);
    expect(reportedHeadline(missing)).toBe('CLI not installed');
  });

  it('falls back to Console’s own check without a report on the provider', () => {
    expect(reportedProvider(null, 'claude')).toBeNull();
    expect(reportedProvider({ serverId: 's', providers: [reported({})] }, 'codex')).toBeNull();
    expect(installedHere(null, 'available')).toBe(true);
    expect(installedHere(null, 'missing')).toBe(false);
    expect(installedHere(null, undefined)).toBe(false);
  });

  it('counts an installed provider that is not signed in as installed', () => {
    for (const problem of ['not logged in', 'login expired', 'login could not be checked'])
      expect(installedHere(reported({ problem }), 'missing')).toBe(true);
    expect(reportedHeadline(reported({ problem: 'not logged in' }))).toBe('Not signed in');
    expect(reportedHeadline(reported({ problem: 'login expired' }))).toBe('Sign-in expired');
    expect(reportedHeadline(reported({ problem: 'login not checked yet' }))).toBe(
      'Checking sign-in…'
    );
    expect(reportedHeadline(reported({ problem: 'login could not be checked' }))).toBe(
      'Sign-in could not be checked'
    );
  });

  it('says when the controller and Console disagree on whether it is installed', () => {
    expect(installSourcesDiffer(reported({ ready: true }), 'missing')).toBe(true);
    expect(installSourcesDiffer(reported({ problem: 'not installed' }), 'available')).toBe(true);
    expect(installSourcesDiffer(reported({ ready: true }), 'available')).toBe(false);
    expect(installSourcesDiffer(null, 'missing')).toBe(false);
  });
});
