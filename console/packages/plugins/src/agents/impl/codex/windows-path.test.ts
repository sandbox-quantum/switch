import { expect, it } from 'vitest';
import { withWindowsCodexBinDir } from './windows-path';

const local = 'C:\\Users\\USER\\AppData\\Local';
const codex = `${local}\\Programs\\OpenAI\\Codex\\bin`;

it('adds the official installer’s folder after the PATH an app started with', () => {
  expect(withWindowsCodexBinDir('C:\\Users\\USER\\.local\\bin;C:\\Windows', local)).toBe(
    `C:\\Users\\USER\\.local\\bin;C:\\Windows;${codex}`
  );
  expect(withWindowsCodexBinDir('C:\\Windows', `${local}\\`)).toBe(`C:\\Windows;${codex}`);
});

it('leaves a PATH that already has it, in any case or with a trailing slash', () => {
  for (const path of [`C:\\Windows;${codex}`, `${codex.toUpperCase()}\\;C:\\Windows`]) {
    expect(withWindowsCodexBinDir(path, local)).toBe(path);
  }
});

it('changes nothing without LOCALAPPDATA', () => {
  expect(withWindowsCodexBinDir('C:\\Windows', undefined)).toBe('C:\\Windows');
});
