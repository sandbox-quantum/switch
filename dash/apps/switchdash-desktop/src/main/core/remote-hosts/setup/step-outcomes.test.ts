import { describe, expect, it } from 'vitest';
import type { GhAuthStatus } from '../gh-auth';
import {
  condenseCommandOutput,
  describeInstallFailure,
  outcomeForDependency,
  outcomeForGhAuth,
} from './step-outcomes';

function ghStatus(overrides: Partial<GhAuthStatus>): GhAuthStatus {
  return {
    authenticated: true,
    account: 'octocat',
    canReadPackages: true,
    detail: null,
    ...overrides,
  };
}

describe('outcomeForGhAuth', () => {
  it('is satisfied only when the login can also read packages', () => {
    expect(outcomeForGhAuth(ghStatus({}))).toEqual({ outcome: 'satisfied', version: 'octocat' });
  });

  it('does not accept a login that lacks read:packages, and says why', () => {
    const result = outcomeForGhAuth(
      ghStatus({
        canReadPackages: false,
        detail: 'The GitHub token is missing the read:packages scope.',
      })
    );

    expect(result.outcome).toBe('missing');
    expect(result.error).toMatch(/read:packages/);
  });

  it('reports a host with no login at all as missing', () => {
    const result = outcomeForGhAuth(
      ghStatus({
        authenticated: false,
        account: null,
        canReadPackages: false,
        detail: 'Not logged in.',
      })
    );

    expect(result).toEqual({ outcome: 'missing', error: 'Not logged in.' });
  });
});

describe('outcomeForDependency', () => {
  it('reports an available dependency as satisfied with its version', () => {
    expect(outcomeForDependency({ status: 'available', version: '2.44.0' }, false)).toEqual({
      outcome: 'satisfied',
      version: '2.44.0',
    });
  });

  it('reports an absent dependency as missing', () => {
    expect(outcomeForDependency({ status: 'missing', version: null }, false)).toEqual({
      outcome: 'missing',
      version: null,
    });
  });

  it('recovers "too old" from the manager collapsing it into an error', () => {
    expect(
      outcomeForDependency({ status: 'error', version: '16.0.0', error: 'needs >= 20' }, true)
    ).toEqual({ outcome: 'wrong-version', version: '16.0.0', error: 'needs >= 20' });
  });

  it('reports an undetermined probe as unknown rather than guessing missing', () => {
    expect(
      outcomeForDependency({ status: 'error', version: null, error: 'channel closed' }, true)
    ).toEqual({ outcome: 'unknown', version: null, error: 'channel closed' });
  });
});

describe('describeInstallFailure', () => {
  // Trimmed from a real failure on an EC2 Ubuntu host. The lock holder turned
  // out to be an earlier install of ours, stopped on a needrestart dialog — not
  // the automatic updates it was first assumed to be.
  const APT_LOCK_OUTPUT = [
    'Hit:1 http://us-east-2.ec2.archive.ubuntu.com/ubuntu jammy InRelease',
    'Reading package lists... Done',
    'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4030760 (apt-get)',
    'N: Be aware that removing the lock file is not a solution and may break your system.',
    'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?',
  ].join('\n');

  it('names the package-manager lock instead of leaving apt to explain itself', () => {
    const message = describeInstallFailure(
      'Git',
      'Command failed with exit code 100',
      APT_LOCK_OUTPUT
    );

    expect(message).toContain('holds the package manager lock');
    expect(message).toContain('Git');
  });

  it('quotes the pid, so a lock that never clears can be identified', () => {
    // Without it there is no way to tell "the nightly updater, wait a bit" from
    // "the same stuck process every time" — and the advice differs completely.
    expect(
      describeInstallFailure('Git', 'Command failed with exit code 100', APT_LOCK_OUTPUT)
    ).toContain('pid 4030760');
  });

  it('does not promise that retrying will fix it', () => {
    // It said exactly that once. The holder was our own install stopped on a
    // dialog nobody could answer, which would have held the lock until reboot,
    // so "retry in a few minutes" was an infinite loop dressed as advice.
    const message = describeInstallFailure(
      'Git',
      'Command failed with exit code 100',
      APT_LOCK_OUTPUT
    );

    expect(message).toContain('will not clear on its own');
    expect(message).toContain('If retrying keeps failing with the same pid');
  });

  it('recognises the lock from the message alone', () => {
    expect(
      describeInstallFailure('Git', 'E: Could not get lock /var/lib/dpkg/lock-frontend', null)
    ).toContain('package manager');
  });

  it('leaves an error it does not recognise exactly as the installer put it', () => {
    // Guessing at an unfamiliar failure would be worse than quoting it.
    expect(describeInstallFailure('tmux', 'E: Unable to locate package tmux', 'some output')).toBe(
      'E: Unable to locate package tmux'
    );
  });
});

describe('condenseCommandOutput', () => {
  it('keeps the final state of a redrawn progress line, not every frame', () => {
    const raw = '0% [Working]\r50% [Working]\r100% [Working]\nFetched 6649 B\n';

    expect(condenseCommandOutput(raw)).toBe('100% [Working]\nFetched 6649 B');
  });

  it('drops the blank padding apt uses to erase the previous frame', () => {
    const raw = '0% [Waiting for headers]\r                         \rHit:7 security.ubuntu.com\n';

    expect(condenseCommandOutput(raw)).toBe('Hit:7 security.ubuntu.com');
  });

  it('keeps the error, which is what the user is looking for', () => {
    const raw =
      '0% [Waiting]\r0% [Waiting]\r          \rReading package lists... Done\n' +
      'E: Could not get lock /var/lib/dpkg/lock-frontend\n';

    expect(condenseCommandOutput(raw)).toBe(
      'Reading package lists... Done\nE: Could not get lock /var/lib/dpkg/lock-frontend'
    );
  });

  it('leaves output with no redraws alone', () => {
    expect(condenseCommandOutput('line one\nline two')).toBe('line one\nline two');
  });
});

/**
 * An install that never ran because its own toolchain is absent (CHOO-1809).
 *
 * The report that prompted this: installing Codex on a host printed the host's
 * login banner in ASCII art followed by `npm: command not found`, and that whole
 * blob was the error. Nothing in it says the host is missing npm, and nothing
 * distinguishes it from Codex itself being broken.
 */
describe('describeInstallFailure — the install command could not run', () => {
  const banner = [
    '  ____              _ ',
    ' / ___|  __ _ _ __ | |',
    'alg-bench-debian-12-v260624',
    '/bin/bash: line 1: npm: command not found',
  ].join('\n');

  it('names the missing tool rather than echoing the transcript', () => {
    const message = describeInstallFailure('Codex', 'Install command failed.', banner);

    expect(message).toContain('npm');
    expect(message).toContain('was not found on the host');
  });

  it('says the host was left alone, because it was', () => {
    const message = describeInstallFailure('Codex', 'Install command failed.', banner);

    expect(message).toContain('Nothing was changed');
  });

  it('explains where npm comes from, since a working node implies it', () => {
    // The confusing part of this failure is that Node.js reads "Installed" on
    // the same page. Saying only "npm is missing" invites the reply "but Node
    // is right there".
    const message = describeInstallFailure('Codex', 'Install command failed.', banner);

    expect(message).toContain('Node.js');
  });

  it('handles a tool other than npm without inventing advice for it', () => {
    const message = describeInstallFailure(
      'Something',
      'Install command failed.',
      '/bin/sh: 1: curl: command not found'
    );

    expect(message).toContain('curl');
    expect(message).not.toContain('Node.js');
  });

  it('leaves an ordinary failure message alone', () => {
    expect(describeInstallFailure('Git', 'Disk full.', 'no space left on device')).toBe(
      'Disk full.'
    );
  });

  it('still prefers the lock diagnosis when both could match', () => {
    const message = describeInstallFailure(
      'Git',
      'Install command failed.',
      'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242\nfoo: command not found'
    );

    expect(message).toContain('package manager lock');
  });
});

/**
 * npm refusing to write to a root-owned global prefix (CHOO-1809).
 *
 * npm's own report is a stack trace through arborist ending in advice to "run
 * the command again as root" — addressed to a user who is not the one running
 * it. Passed through, that is what the row shows.
 */
describe('describeInstallFailure — npm cannot write the global prefix', () => {
  // Trimmed from a real transcript, after ANSI stripping and condensing.
  const eacces = [
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error path /usr/lib/node_modules/@openai',
    'npm error errno -13',
    "npm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/@openai'",
    'npm error     at async mkdir (node:internal/fs/promises:858:10)',
    'npm error The operation was rejected by your operating system.',
    'npm error the command again as root/Administrator.',
  ].join('\n');

  it('names the directory that could not be written', () => {
    const message = describeInstallFailure(
      'Codex',
      'User does not have sufficient permissions.',
      eacces
    );

    expect(message).toContain('/usr/lib/node_modules');
  });

  it('does not capture npm’s surrounding quote as part of the path', () => {
    const message = describeInstallFailure('Codex', 'Install command failed.', eacces);

    expect(message).not.toContain("@openai'");
  });

  it('says switchdash will not escalate on its own', () => {
    // The user should know why we did not just sudo it, rather than assuming
    // the install is broken.
    const message = describeInstallFailure('Codex', 'Install command failed.', eacces);

    expect(message).toContain('does not run installs as root');
  });

  it('reports the host as untouched, because the write never happened', () => {
    const message = describeInstallFailure('Codex', 'Install command failed.', eacces);

    expect(message).toContain('Nothing was changed');
  });

  it('leaves an unrelated permission failure to the generic message', () => {
    const message = describeInstallFailure(
      'Git',
      'Permission denied.',
      'cannot open /etc/apt/sources.list'
    );

    expect(message).toBe('Permission denied.');
  });
});
