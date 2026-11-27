import { describe, expect, it } from 'vitest';
import {
  browserCodePrompt,
  browserSignInKind,
  loginHint,
  machineProviderOptions,
  providerLoginKinds,
  providerReportSettled,
} from './provider-catalogue';

describe('providerLoginKinds', () => {
  it('offers a browser what can be pasted or picked, a sign-in file among them', () => {
    const browser = (provider: string) =>
      providerLoginKinds(provider, false).map((kind) => kind.value);
    expect(browser('claude')).toEqual(['setup-token', 'api-key', 'vertex']);
    expect(browser('codex')).toEqual(['api-key', 'auth-json']);
    expect(browser('cursor')).toEqual(['api-key']);
    expect(browser('opencode')).toEqual(['auth-json']);
    expect(browser('antigravity')).toEqual(['auth-json', 'vertex']);
    expect(browser('pi')).toEqual([]);
  });

  it("offers Console this computer's sign-in where a browser picks the file", () => {
    expect(providerLoginKinds('codex', true)).toEqual([
      { value: 'api-key', label: 'API key' },
      { value: 'this-computer', label: "This computer's sign-in" },
    ]);
    expect(providerLoginKinds('opencode', true).map((kind) => kind.value)).toEqual([
      'this-computer',
    ]);
  });
});

describe('loginHint', () => {
  it("names each provider's own sign-in file", () => {
    expect(loginHint('codex', 'Codex', 'auth-json', 'key')).toContain('~/.codex/auth.json');
    expect(loginHint('opencode', 'OpenCode', 'auth-json', 'key')).toContain(
      '~/.local/share/opencode/auth.json'
    );
    expect(loginHint('antigravity', 'Antigravity', 'auth-json', 'key')).toContain('acp_token.json');
  });
});

describe('machineProviderOptions', () => {
  it('lists every provider offered, saying which the machine has not reported', () => {
    expect(
      machineProviderOptions(
        [
          { id: 'claude', name: 'Claude Code' },
          { id: 'antigravity', name: 'Antigravity' },
        ],
        [{ provider: 'claude', ready: false, problem: 'not installed' }],
        false
      )
    ).toEqual([
      { id: 'claude', name: 'Claude Code', ready: false, problem: 'not installed' },
      { id: 'antigravity', name: 'Antigravity', ready: false, problem: 'not checked yet' },
    ]);
  });

  it('says a provider the machine left out of a settled report is not available there', () => {
    expect(
      machineProviderOptions(
        [
          { id: 'claude', name: 'Claude Code' },
          { id: 'opencode', name: 'OpenCode' },
        ],
        [{ provider: 'claude', ready: false, problem: 'not signed in' }],
        true
      )
    ).toEqual([
      { id: 'claude', name: 'Claude Code', ready: false, problem: 'not signed in' },
      { id: 'opencode', name: 'OpenCode', ready: false, problem: 'not available' },
    ]);
  });
});

describe('providerReportSettled', () => {
  const connected = '2026-11-26T10:00:00Z';

  it('waits a minute after the machine connects for the checks it starts with', () => {
    expect(providerReportSettled(connected, '2026-11-26T10:00:30Z')).toBe(false);
    expect(providerReportSettled(connected, '2026-11-26T10:01:00Z')).toBe(true);
  });

  it('is not settled while either time is unknown', () => {
    expect(providerReportSettled(null, '2026-11-26T10:05:00Z')).toBe(false);
    expect(providerReportSettled(connected, null)).toBe(false);
  });
});

describe('browserSignInKind', () => {
  it('signs each provider in on a machine of your own, and only Claude Code and Codex on a cloud device', () => {
    expect(browserSignInKind('claude', false)).toEqual({
      value: 'browser',
      label: 'Sign in with browser',
    });
    for (const provider of ['claude', 'codex', 'cursor', 'antigravity', 'opencode'])
      expect(browserSignInKind(provider, false)?.value).toBe('browser');
    for (const provider of ['claude', 'codex'])
      expect(browserSignInKind(provider, true)?.value).toBe('browser');
    for (const provider of ['cursor', 'antigravity', 'opencode', 'pi'])
      expect(browserSignInKind(provider, true)).toBeNull();
    expect(browserSignInKind('pi', false)).toBeNull();
  });

  it('says what each browser sign-in asks, and what to paste back', () => {
    expect(loginHint('opencode', 'OpenCode', 'browser', 'key')).toContain('ChatGPT');
    expect(loginHint('cursor', 'Cursor', 'browser', 'key')).toContain('notices by itself');
    expect(loginHint('antigravity', 'Antigravity', 'browser', 'key')).toContain('Google');
    expect(browserCodePrompt('antigravity')).toContain('full address');
    expect(browserCodePrompt('claude')).not.toContain('address');
  });
});
