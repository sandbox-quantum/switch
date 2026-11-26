import { describe, expect, it } from 'vitest';
import { installFailure } from './install-failure';

describe('installFailure', () => {
  it('says to open a new terminal when the CLI was installed but is not found', () => {
    expect(installFailure('Codex', { type: 'not-detected-after-install' } as never)).toContain(
      'Codex was installed, but this computer can’t find it yet.'
    );
  });

  it('says to install it by hand when Console cannot', () => {
    for (const type of ['no-install-command', 'unknown-dependency'])
      expect(installFailure('Codex', { type } as never)).toBe(
        'Switch Console can’t install Codex on this computer. Install it yourself, then press Check again.'
      );
  });

  it('quotes the end of the output when the install command failed', () => {
    const said = installFailure('Codex', {
      type: 'command-failed',
      message: 'npm exited with 1.',
      output: 'lots of noise\nEACCES: permission denied',
    } as never);
    expect(said).toMatch(/^Installing Codex failed: npm exited with 1\. Output: /);
    expect(said).toContain('EACCES');
  });

  it('says what is missing and how to get it instead of the shell error', () => {
    const said = installFailure('OpenCode', {
      type: 'command-failed',
      message: 'The install needs npm, which this computer does not have.',
      output: "npm : The term 'npm' is not recognized… Check the spelling of the name",
      missingCommand: 'npm',
    } as never);
    expect(said).toContain('needs Node.js');
    expect(said).not.toContain('Check the spelling');
    expect(
      installFailure('GitHub Copilot', {
        type: 'command-failed',
        message: '',
        output: '',
        missingCommand: 'winget',
      } as never)
    ).toContain('needs winget');
  });

  it('gives the reason for anything else', () => {
    expect(
      installFailure('Codex', { type: 'permission-denied', message: 'Not allowed.' } as never)
    ).toBe('Installing Codex failed: Not allowed.');
  });
});
