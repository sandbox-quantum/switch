import { describe, expect, it } from 'vitest';
import { updateCheckUnavailable } from './update-check';

const base = { supported: true, installed: true, latestVersion: '0.2.0' };

describe('updateCheckUnavailable', () => {
  it('is true when there is no advertised version to compare against', () => {
    // Codex on a remote host: its marketplace listing carries no plugin
    // versions, so `updateAvailable: false` means "unknown", not "current".
    expect(updateCheckUnavailable({ ...base, latestVersion: null })).toBe(true);
  });

  it('is false when a version is advertised, update or no update', () => {
    expect(updateCheckUnavailable(base)).toBe(false);
  });

  it('is false before the plugin is installed — nothing to be stale yet', () => {
    expect(updateCheckUnavailable({ ...base, installed: false, latestVersion: null })).toBe(false);
  });

  it('is false for an agent type with no Switch setup at all', () => {
    expect(updateCheckUnavailable({ ...base, supported: false, latestVersion: null })).toBe(false);
  });
});
