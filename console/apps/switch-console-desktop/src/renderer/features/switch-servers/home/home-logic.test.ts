import { describe, expect, it } from 'vitest';
import { type HomeStateInputs, homeState, reachable } from './home-state';

const ready: HomeStateInputs = {
  hostBlocked: false,
  stopped: false,
  unreachable: false,
  signedIn: true,
  aiConnected: true,
  suggestionsReady: true,
};

describe('homeState', () => {
  it('asks switch-buddy when signed in with AI connected', () => {
    expect(homeState(ready)).toBe('askBuddy');
  });

  it('puts an unreachable host, a stopped server and an unreachable gateway first', () => {
    expect(homeState({ ...ready, hostBlocked: true, stopped: true })).toBe('hostUnreachable');
    expect(homeState({ ...ready, stopped: true, unreachable: true })).toBe('stopped');
    expect(homeState({ ...ready, unreachable: true, signedIn: false })).toBe('unreachable');
  });

  it('shows sign-in before anything about AI', () => {
    expect(homeState({ ...ready, signedIn: false, aiConnected: null })).toBe('signedOut');
  });

  it('loads while the status, the AI check or the suggestions are not known', () => {
    expect(homeState({ ...ready, signedIn: null })).toBe('loading');
    expect(homeState({ ...ready, aiConnected: null })).toBe('loading');
    expect(homeState({ ...ready, suggestionsReady: false })).toBe('loading');
  });

  it('offers to connect AI without waiting for suggestions it will not show', () => {
    expect(homeState({ ...ready, aiConnected: false, suggestionsReady: false })).toBe('connectAi');
  });
});

describe('reachable', () => {
  it('needs a machine to be online', () => {
    expect(reachable({ state: 'online', cloud: false })).toBe(true);
    expect(reachable({ state: 'offline', cloud: false })).toBe(false);
    expect(reachable({ state: 'unknown', cloud: false })).toBe(false);
  });

  it('lets a Switch cloud machine be offline, since it is started when needed', () => {
    expect(reachable({ state: 'offline', cloud: true })).toBe(true);
  });

  it('never counts a revoked machine', () => {
    expect(reachable({ state: 'revoked', cloud: true })).toBe(false);
    expect(reachable({ state: 'revoked', cloud: false })).toBe(false);
  });
});
