import { describe, expect, it } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { setupChecklist } from './setup-checklist';
import type { YourCloudView } from './your-cloud';

const ready: YourCloudView = {
  resting: false,
  heading: 'Ready',
  room: null,
  awake: null,
  aiCalls: null,
};
const resting: YourCloudView = {
  resting: true,
  heading: 'Resting',
  line: 'x',
  start: 'ensure',
  startLabel: 'Wake',
};
const stopped = (how: 'ensure' | 'lifecycle'): YourCloudView => ({
  resting: true,
  heading: 'Stopped',
  line: 'Start it to use your agents.',
  start: how,
});

function controller(over: Partial<OwnedMachine> = {}): OwnedMachine {
  return {
    id: 'c-box',
    name: 'box',
    providers: [],
    acceptsLogins: true,
    cloud: true,
    workspacesDir: null,
    os: 'linux',
    ...over,
  } as OwnedMachine;
}
const providerReady = (provider: string, isReady: boolean) => ({
  provider,
  ready: isReady,
  problem: isReady ? null : 'Not logged in',
  detail: null,
  loginHelps: true,
});

describe('setupChecklist', () => {
  it('waits, rather than flash "No AI login yet", while the machine list loads', () => {
    expect(setupChecklist({ view: ready, agents: [], controller: undefined })).toBeNull();
  });

  it('folds away once all three are ticked', () => {
    expect(
      setupChecklist({
        view: ready,
        agents: ['a1'],
        controller: controller({ providers: [providerReady('claude', true)] }),
      })
    ).toBeNull();
  });

  it('a resting box counts as ready; a stopped one offers Start, the same way the card would', () => {
    const lines = (view: YourCloudView) =>
      setupChecklist({ view, agents: [], controller: controller() })!;
    expect(lines(resting)[0]).toEqual({
      key: 'cloud',
      done: true,
      text: 'Your cloud is ready',
      action: null,
    });
    expect(lines(stopped('lifecycle'))[0]).toEqual({
      key: 'cloud',
      done: false,
      text: 'Your cloud is stopped',
      action: { kind: 'start', how: 'lifecycle' },
    });
    expect(lines(stopped('ensure'))[0]?.action).toEqual({ kind: 'start', how: 'ensure' });
  });

  it('a paused or starting box shows the card’s own words, with no button', () => {
    const paused: YourCloudView = {
      resting: true,
      heading: 'Paused by Switch',
      line: 'Contact your admin',
    };
    const line = setupChecklist({ view: paused, agents: [], controller: controller() })![0];
    expect(line).toEqual({
      key: 'cloud',
      done: false,
      text: 'Paused by Switch · Contact your admin',
      action: null,
    });
  });

  it('the login is set when any provider on the box is ready; otherwise Give login, for one that isn’t', () => {
    const login = (box: OwnedMachine | null) =>
      setupChecklist({ view: ready, agents: [], controller: box })![1];
    expect(
      login(
        controller({ providers: [providerReady('codex', false), providerReady('claude', true)] })
      )
    ).toEqual({ key: 'login', done: true, text: 'AI login set', action: null });
    expect(login(controller({ providers: [providerReady('codex', false)] }))).toEqual({
      key: 'login',
      done: false,
      text: 'No AI login yet',
      action: { kind: 'give_login', provider: 'codex' },
    });
    expect(login(controller())?.action).toEqual({ kind: 'give_login', provider: 'claude' });
    // No controller row yet, or one that can't take a sealed login: nothing to give it to.
    expect(login(null)?.action).toBeNull();
    expect(login(controller({ acceptsLogins: false }))?.action).toBeNull();
  });

  it('no agent yet offers Add agent; one agent ticks it', () => {
    const agent = (agents: string[]) =>
      setupChecklist({ view: resting, agents, controller: controller() })![2];
    expect(agent([])).toEqual({
      key: 'agent',
      done: false,
      text: 'No agent yet',
      action: { kind: 'add_agent' },
    });
    expect(agent(['a1'])).toEqual({
      key: 'agent',
      done: true,
      text: 'First agent added',
      action: null,
    });
  });
});
