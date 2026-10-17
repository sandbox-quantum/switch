import { describe, expect, it } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { buddyProviders } from './buddy-providers';

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
