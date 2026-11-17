import { describe, expect, it } from 'vitest';
import { ownProvenance } from './host-dependency-manager';

const descriptor = {
  installCommands: {
    windows: [
      { method: 'npm' as const, command: 'npm install -g opencode-ai' },
      {
        method: 'powershell' as const,
        command: 'powershell -c "…"',
        installedAt: ['\\.opencode\\bin\\'],
      },
    ],
  },
};
const unknown = { kind: 'unknown' as const, confidence: 'inferred' as const };

describe('ownProvenance', () => {
  it('names the option that installs where the binary is, whatever the case or slashes', () => {
    expect(
      ownProvenance(unknown, descriptor, 'windows', 'C:/Users/Ada/.OpenCode/bin/opencode.exe')
    ).toEqual({ kind: 'powershell', confidence: 'confirmed' });
  });

  it('beats a location guess, but not what a package manager confirmed', () => {
    const guessed = { kind: 'installer-windows' as const, confidence: 'inferred' as const };
    const where = 'C:\\Users\\ada\\.opencode\\bin\\opencode.exe';
    expect(ownProvenance(guessed, descriptor, 'windows', where).kind).toBe('powershell');
    const npm = { kind: 'npm' as const, confidence: 'confirmed' as const };
    expect(ownProvenance(npm, descriptor, 'windows', where)).toBe(npm);
  });

  it('leaves an installation no option claims as detected', () => {
    expect(ownProvenance(unknown, descriptor, 'windows', 'C:\\tools\\opencode.exe')).toBe(unknown);
    expect(ownProvenance(unknown, descriptor, 'macos', '/Users/ada/.opencode/bin/opencode')).toBe(
      unknown
    );
  });
});
