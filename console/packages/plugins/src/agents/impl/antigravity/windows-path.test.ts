import { expect, it } from 'vitest';
import { withWindowsAgyBinDir } from './windows-path';

const local = 'C:\\Users\\u\\AppData\\Local';
const agy = 'C:\\Users\\u\\AppData\\Local\\agy\\bin';

it('adds the folder Google’s agy installer writes to after the PATH, so an agy already on it wins', () => {
  expect(withWindowsAgyBinDir('C:\\scoop\\shims;C:\\Windows\\System32', local)).toBe(
    `C:\\scoop\\shims;C:\\Windows\\System32;${agy}`
  );
  expect(withWindowsAgyBinDir('C:\\Windows', `${local}\\`)).toBe(`C:\\Windows;${agy}`);
});

it('leaves a PATH that has the folder, in any case or with a trailing slash, as it is', () => {
  for (const path of [
    `${agy.toUpperCase()};C:\\Windows\\System32`,
    `C:\\Windows\\System32;;${agy}\\`,
  ])
    expect(withWindowsAgyBinDir(path, local)).toBe(path);
});

it('adds nothing without LOCALAPPDATA', () => {
  expect(withWindowsAgyBinDir('C:\\Windows\\System32;', undefined)).toBe('C:\\Windows\\System32;');
});
