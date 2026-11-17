import { describe, expect, it } from 'vitest';
import { hasWindowsGitBash } from './cursor-adapter';

describe('hasWindowsGitBash', () => {
  const files = new Set([
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe',
    'C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
    'D:\\Tools\\PortableGit\\bin\\bash.exe',
    'D:\\Tools\\PortableGit\\cmd\\git.exe',
    'C:\\Users\\ada\\scoop\\apps\\git\\current\\bin\\bash.exe',
    'C:\\Users\\ada\\scoop\\apps\\git\\current\\cmd\\git.exe',
    'C:\\msys64\\usr\\bin\\bash.exe',
  ]);
  const exists = (file: string) => files.has(file);

  it("finds Bash in a Git install's bin or usr\\bin", () => {
    expect(hasWindowsGitBash('C:\\Windows;C:\\Program Files\\Git\\bin\\', exists)).toBe(true);
    expect(
      hasWindowsGitBash('C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\usr\\bin', exists)
    ).toBe(true);
  });

  it('finds Bash in a Git install whose folder is not called Git', () => {
    expect(hasWindowsGitBash('D:\\Tools\\PortableGit\\bin', exists)).toBe(true);
    expect(hasWindowsGitBash('C:\\Users\\ada\\scoop\\apps\\git\\current\\bin', exists)).toBe(true);
  });

  it("does not take WSL's bash, Git's cmd folder, or a Bash outside Git for Git Bash", () => {
    expect(hasWindowsGitBash('C:\\Windows\\System32;C:\\Program Files\\Git\\cmd', exists)).toBe(
      false
    );
    expect(hasWindowsGitBash('C:\\msys64\\usr\\bin', exists)).toBe(false);
  });
});
