import { describe, expect, it } from 'vitest';
import { withWindowsGitBashDir } from './windows-git-bash';

const roots = {
  localAppData: 'C:\\Users\\ada\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
};

const files =
  (...present: string[]) =>
  (file: string) =>
    present.some((p) => p.toLowerCase() === file.toLowerCase());

describe('withWindowsGitBashDir', () => {
  it('adds the bin folder beside a Git\\cmd on PATH', () => {
    const path = 'C:\\Windows\\System32;C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\cmd';
    const exists = files(
      'C:\\Windows\\System32\\bash.exe',
      'C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
      'C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
    );
    expect(withWindowsGitBashDir(path, roots, exists)).toBe(
      `${path};C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\bin`
    );
  });

  it('finds Git in its usual install folder when nothing of it is on PATH', () => {
    const exists = files('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(withWindowsGitBashDir('C:\\Windows', roots, exists)).toBe(
      'C:\\Windows;C:\\Program Files\\Git\\bin'
    );
  });

  it('leaves a PATH that already reaches a bash alone', () => {
    const path = 'C:\\msys64\\usr\\bin;C:\\Program Files\\Git\\cmd';
    const exists = files('C:\\msys64\\usr\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe');
    expect(withWindowsGitBashDir(path, roots, exists)).toBe(path);
  });

  it('leaves PATH alone when Git for Windows is not installed', () => {
    expect(withWindowsGitBashDir('C:\\Windows', roots, files())).toBe('C:\\Windows');
  });
});
