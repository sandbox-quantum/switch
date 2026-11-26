import { describe, expect, it } from 'vitest';
import { loginHint, machineProviderOptions, providerLoginKinds } from './provider-catalogue';

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
        [{ provider: 'claude', ready: false, problem: 'not installed' }]
      )
    ).toEqual([
      { id: 'claude', name: 'Claude Code', ready: false, problem: 'not installed' },
      { id: 'antigravity', name: 'Antigravity', ready: false, problem: 'not checked yet' },
    ]);
  });
});
