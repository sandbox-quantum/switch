import { describe, expect, it } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { type BuddyProvider, buddyProviders, startButtons } from './buddy-providers';

const PROVIDERS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'antigravity', name: 'Antigravity' },
];

function machine(providers: OwnedMachine['providers']): OwnedMachine {
  return {
    id: 'm1',
    name: 'laptop',
    kind: 'console',
    state: 'online',
    providers,
    acceptsLogins: false,
    cloud: false,
    workspacesDir: null,
    os: 'linux',
    local: { kind: 'this-computer' },
  };
}

describe('buddyProviders', () => {
  it('reads each provider from what the controller reported', () => {
    const states = buddyProviders(
      PROVIDERS,
      machine([
        { provider: 'claude', ready: true, problem: null },
        { provider: 'codex', ready: false, problem: 'not logged in' },
        { provider: 'opencode', ready: false, problem: 'not installed' },
        { provider: 'cursor', ready: false, problem: 'login not checked yet' },
      ])
    );
    expect(states.map((p) => [p.id, p.state])).toEqual([
      ['claude', 'ready'],
      ['codex', 'sign-in'],
      ['opencode', 'install'],
      ['cursor', 'checking'],
      ['antigravity', 'checking'],
    ]);
  });

  it('is still checking everything before this computer reports', () => {
    expect(buddyProviders(PROVIDERS, null).every((p) => p.state === 'checking')).toBe(true);
  });
});

describe('startButtons', () => {
  const states = (entries: Record<string, BuddyProvider['state']>): BuddyProvider[] =>
    PROVIDERS.map((provider) => ({ ...provider, state: entries[provider.id] ?? 'checking' }));
  const ids = (buttons: BuddyProvider[] | null) => buttons?.map((provider) => provider.id) ?? null;

  it('decides as soon as Claude Code and Codex are known and one is ready', () => {
    expect(ids(startButtons(states({ claude: 'ready', codex: 'ready' }), false))).toEqual([
      'claude',
      'codex',
    ]);
    expect(ids(startButtons(states({ claude: 'ready', codex: 'sign-in' }), false))).toEqual([
      'claude',
    ]);
  });

  it('waits while one of them is still being checked', () => {
    expect(startButtons(states({ claude: 'ready' }), false)).toBeNull();
    expect(startButtons(states({ codex: 'ready' }), false)).toBeNull();
  });

  it('waits for the rest when neither is ready, then offers what is', () => {
    expect(startButtons(states({ claude: 'install', codex: 'sign-in' }), false)).toBeNull();
    expect(
      ids(
        startButtons(
          states({
            claude: 'install',
            codex: 'sign-in',
            opencode: 'ready',
            cursor: 'install',
            antigravity: 'install',
          }),
          false
        )
      )
    ).toEqual(['opencode']);
  });

  it('offers what is ready once out of patience', () => {
    expect(ids(startButtons(states({ codex: 'ready' }), true))).toEqual(['codex']);
    expect(ids(startButtons(states({}), true))).toEqual([]);
  });
});
