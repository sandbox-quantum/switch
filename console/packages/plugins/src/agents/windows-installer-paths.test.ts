import { expect, it } from 'vitest';
import { withWindowsInstallerBinDirs } from './windows-installer-paths';

const local = 'C:\\Users\\USER\\AppData\\Local';
const cursor = `${local}\\cursor-agent`;
const kiro = `${local}\\Kiro-Cli`;

it('adds the Cursor and Kiro installer folders after the PATH an app started with', () => {
  expect(withWindowsInstallerBinDirs('C:\\Users\\USER\\.local\\bin;C:\\Windows', local)).toBe(
    `C:\\Users\\USER\\.local\\bin;C:\\Windows;${cursor};${kiro}`
  );
  expect(withWindowsInstallerBinDirs('C:\\Windows', `${local}\\`)).toBe(
    `C:\\Windows;${cursor};${kiro}`
  );
});

it('adds only what is missing, matching any case or a trailing slash', () => {
  expect(withWindowsInstallerBinDirs(`${kiro.toUpperCase()}\\;C:\\Windows`, local)).toBe(
    `${kiro.toUpperCase()}\\;C:\\Windows;${cursor}`
  );
  const both = `C:\\Windows;${cursor};${kiro}`;
  expect(withWindowsInstallerBinDirs(both, local)).toBe(both);
});

it('changes nothing without LOCALAPPDATA', () => {
  expect(withWindowsInstallerBinDirs('C:\\Windows', undefined)).toBe('C:\\Windows');
});
