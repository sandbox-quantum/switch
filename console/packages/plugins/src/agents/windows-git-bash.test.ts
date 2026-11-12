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

  it('does not take the WSL launcher in WindowsApps for Git Bash', () => {
    const path =
      'C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Program Files\\Git\\cmd';
    const exists = files(
      'C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    );
    expect(withWindowsGitBashDir(path, roots, exists)).toBe(`${path};C:\\Program Files\\Git\\bin`);
  });

  it('does not take the WSL launcher in System32 for Git Bash', () => {
    const exists = files(
      'C:\\Windows\\System32\\bash.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    );
    expect(withWindowsGitBashDir('C:\\Windows\\System32', roots, exists)).toBe(
      'C:\\Windows\\System32;C:\\Program Files\\Git\\bin'
    );
  });

  it('leaves a PATH that already reaches Git Bash alone, from bin or usr\\bin', () => {
    const exists = files(
      'C:\\Tools\\PortableGit\\cmd\\git.exe',
      'C:\\Tools\\PortableGit\\usr\\bin\\bash.exe',
      'C:\\Tools\\PortableGit\\bin\\bash.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    );
    expect(withWindowsGitBashDir('C:\\Tools\\PortableGit\\usr\\bin', roots, exists)).toBe(
      'C:\\Tools\\PortableGit\\usr\\bin'
    );
    expect(withWindowsGitBashDir('C:\\Tools\\PortableGit\\bin\\', roots, exists)).toBe(
      'C:\\Tools\\PortableGit\\bin\\'
    );
  });

  it('adds Git Bash after another bash, which still comes first', () => {
    const exists = files('C:\\msys64\\usr\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe');
    expect(withWindowsGitBashDir('C:\\msys64\\usr\\bin', roots, exists)).toBe(
      'C:\\msys64\\usr\\bin;C:\\Program Files\\Git\\bin'
    );
  });

  it('adds the folder once, however often it runs', () => {
    const exists = files('C:\\Program Files\\Git\\bin\\bash.exe');
    const once = withWindowsGitBashDir('C:\\Windows', roots, exists);
    expect(withWindowsGitBashDir(once, roots, exists)).toBe(once);
  });

  it('leaves PATH alone when Git for Windows is not installed', () => {
    expect(withWindowsGitBashDir('C:\\Windows', roots, files())).toBe('C:\\Windows');
  });
});
