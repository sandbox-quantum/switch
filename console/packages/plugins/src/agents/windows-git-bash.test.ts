import { expect, it } from 'vitest';
import { withWindowsGitBashDir, type WindowsGitLocations } from './windows-git-bash';

const perUser = 'C:\\Users\\u\\AppData\\Local\\Programs\\Git';
const machine = 'C:\\Program Files\\Git';

/** A file system with just these files on it, matched without regard to case. */
const filesystem =
  (...files: string[]) =>
  (file: string): boolean =>
    files.some((existing) => existing.toLowerCase() === file.toLowerCase());

const locations: WindowsGitLocations = {
  localAppData: 'C:\\Users\\u\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  programW6432: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
};

it('adds the Git bin folder next to the git on PATH, after the other entries', () => {
  const isFile = filesystem(`${perUser}\\cmd\\git.exe`, `${perUser}\\bin\\bash.exe`);
  expect(withWindowsGitBashDir(`C:\\Windows\\System32;${perUser}\\cmd`, locations, isFile)).toBe(
    `C:\\Windows\\System32;${perUser}\\cmd;${perUser}\\bin`
  );
});

it('finds a per-user install and a machine-wide one when git is not on PATH', () => {
  expect(
    withWindowsGitBashDir('C:\\Windows', locations, filesystem(`${perUser}\\bin\\bash.exe`))
  ).toBe(`C:\\Windows;${perUser}\\bin`);
  expect(
    withWindowsGitBashDir('C:\\Windows', locations, filesystem(`${machine}\\bin\\bash.exe`))
  ).toBe(`C:\\Windows;${machine}\\bin`);
});

it('leaves a PATH that already reaches a bash.exe as it is', () => {
  const isFile = filesystem(`C:\\tools\\bash.exe`, `${perUser}\\bin\\bash.exe`);
  const path = `C:\\Windows\\System32;C:\\tools\\;${perUser}\\cmd`;
  expect(withWindowsGitBashDir(path, locations, isFile)).toBe(path);
  const withGitBin = `${perUser.toUpperCase()}\\BIN;C:\\Windows`;
  expect(withWindowsGitBashDir(withGitBin, locations, isFile)).toBe(withGitBin);
});

it('does not take the WSL launcher in System32 for Git Bash', () => {
  const isFile = filesystem('C:\\Windows\\System32\\bash.exe', `${perUser}\\bin\\bash.exe`);
  expect(withWindowsGitBashDir('C:\\Windows\\System32', locations, isFile)).toBe(
    `C:\\Windows\\System32;${perUser}\\bin`
  );
});

it('adds nothing when there is no Git for Windows to find', () => {
  const path = 'C:\\Windows\\System32;';
  expect(withWindowsGitBashDir(path, locations, filesystem())).toBe(path);
  expect(withWindowsGitBashDir(path, {}, filesystem(`${perUser}\\bin\\bash.exe`))).toBe(path);
});
