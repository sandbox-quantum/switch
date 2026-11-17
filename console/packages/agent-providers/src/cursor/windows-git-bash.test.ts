import { describe, expect, it } from 'vitest';
import { hasWindowsGitBash } from './cursor-adapter';

describe('hasWindowsGitBash', () => {
  const files = new Set([
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe',
  ]);
  const exists = (file: string) => files.has(file);

  it("finds Bash in a Git install's bin or usr\\bin", () => {
    expect(hasWindowsGitBash('C:\\Windows;C:\\Program Files\\Git\\bin\\', exists)).toBe(true);
    expect(
      hasWindowsGitBash('C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\usr\\bin', exists)
    ).toBe(true);
  });

  it("does not take WSL's bash, or Git's cmd folder, for Git Bash", () => {
    expect(hasWindowsGitBash('C:\\Windows\\System32;C:\\Program Files\\Git\\cmd', exists)).toBe(
      false
    );
  });
});
