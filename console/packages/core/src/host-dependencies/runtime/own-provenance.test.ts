import { describe, expect, it } from 'vitest';
import { ownProvenance } from './host-dependency-manager';

const descriptor = {
  installCommands: {
    windows: [
      { method: 'npm' as const, command: 'npm install -g opencode-ai' },
      {
        method: 'powershell' as const,
        command: 'powershell -c "…"',
        installedAt: ['.opencode\\bin\\', '.local\\bin\\claude.exe'],
      },
    ],
  },
};
const home = 'C:\\Users\\ada';
const unknown = { kind: 'unknown' as const, confidence: 'inferred' as const };
const owned = { kind: 'powershell', confidence: 'confirmed' };

describe('ownProvenance', () => {
  it('names the option that installs under the home directory, whatever the case or slashes', () => {
    expect(
      ownProvenance(unknown, descriptor, 'windows', 'c:/users/ADA/.OpenCode/bin/opencode.exe', home)
    ).toEqual(owned);
    expect(
      ownProvenance(unknown, descriptor, 'windows', 'C:\\Users\\ada\\.local\\bin\\claude.exe', home)
    ).toEqual(owned);
  });

  it('takes no copy with the same name elsewhere, or beside the one it installs', () => {
    for (const where of [
      'D:\\tools\\.opencode\\bin\\opencode.exe',
      'C:\\Users\\ada\\work\\.local\\bin\\claude.exe',
      'C:\\Users\\ada\\.local\\bin\\claude.exe.old',
    ])
      expect(ownProvenance(unknown, descriptor, 'windows', where, home)).toBe(unknown);
  });

  it('beats a location guess, but not what a package manager confirmed', () => {
    const guessed = { kind: 'installer-windows' as const, confidence: 'inferred' as const };
    const where = 'C:\\Users\\ada\\.opencode\\bin\\opencode.exe';
    expect(ownProvenance(guessed, descriptor, 'windows', where, home)).toEqual(owned);
    const npm = { kind: 'npm' as const, confidence: 'confirmed' as const };
    expect(ownProvenance(npm, descriptor, 'windows', where, home)).toBe(npm);
  });

  it('matches nothing without a home directory, or on another platform', () => {
    const where = 'C:\\Users\\ada\\.opencode\\bin\\opencode.exe';
    expect(ownProvenance(unknown, descriptor, 'windows', where, undefined)).toBe(unknown);
    expect(
      ownProvenance(unknown, descriptor, 'macos', '/Users/ada/.opencode/bin/opencode', '/Users/ada')
    ).toBe(unknown);
  });
});
