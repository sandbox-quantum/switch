import { describe, expect, it } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { repeatsChecklist, setupChecklist } from './setup-checklist';
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
    expect(
      setupChecklist({ view: ready, agents: [], controller: undefined, agentProviders: null })
    ).toBeNull();
  });

  it('folds away once all three are ticked', () => {
    expect(
      setupChecklist({
        view: ready,
        agents: ['a1'],
        controller: controller({ providers: [providerReady('claude', true)] }),
        agentProviders: ['claude'],
      })
    ).toBeNull();
  });

  it('a resting box counts as ready; a stopped one offers Start, the same way the card would', () => {
    const lines = (view: YourCloudView) =>
      setupChecklist({ view, agents: [], controller: controller(), agentProviders: null })!;
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
    const line = setupChecklist({
      view: paused,
      agents: [],
      controller: controller(),
      agentProviders: null,
    })![0];
    expect(line).toEqual({
      key: 'cloud',
      done: false,
      text: 'Paused by Switch · Contact your admin',
      action: null,
    });
  });

  it('the login is set when any provider on the box is ready; otherwise Give login, for one that isn’t', () => {
    const login = (box: OwnedMachine | null) =>
      setupChecklist({ view: ready, agents: [], controller: box, agentProviders: null })![1];
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

  it('with agents, the login ticks only when every provider they use is ready, else Give login for the missing one', () => {
    const login = (agentProviders: readonly string[] | null | undefined, ready: string[]) =>
      setupChecklist({
        view: resting,
        agents: ['a1', 'a2'],
        controller: controller({
          providers: ['claude', 'codex'].map((p) => providerReady(p, ready.includes(p))),
        }),
        agentProviders,
      });
    // A Codex login only, with a Claude agent: not set, and Give login is for Claude.
    expect(login(['claude'], ['codex'])![1]).toEqual({
      key: 'login',
      done: false,
      text: 'No AI login yet',
      action: { kind: 'give_login', provider: 'claude' },
    });
    expect(login(['claude', 'codex'], ['claude'])![1]?.action).toEqual({
      kind: 'give_login',
      provider: 'codex',
    });
    expect(login(['claude', 'codex'], ['claude', 'codex'])).toBeNull();
    // The agent list still loading: wait, rather than show a tick that may be wrong.
    expect(login(undefined, [])).toBeNull();
    expect(login(undefined, ['codex'])).toBeNull();
    // It can't be read: any ready provider counts, as with no agents.
    expect(login(null, ['codex'])).toBeNull();
  });

  it('an agent on a provider the box doesn’t list neither blocks the tick nor gets Give login', () => {
    const login = (agentProviders: string[], ready: string[]) =>
      setupChecklist({
        view: resting,
        agents: ['a1', 'a2'],
        controller: controller({
          providers: ['claude', 'codex'].map((p) => providerReady(p, ready.includes(p))),
        }),
        agentProviders,
      });
    // Claude ready, plus an agent on a provider the box doesn't list: ticked.
    expect(login(['claude', 'mystery'], ['claude'])).toBeNull();
    // The unlisted one first, Codex missing: Give login is for Codex, never the unlisted one.
    expect(login(['mystery', 'codex'], ['claude'])![1]?.action).toEqual({
      kind: 'give_login',
      provider: 'codex',
    });
    // Only unlisted providers: any ready provider counts, as with no agents.
    expect(login(['mystery'], ['codex'])).toBeNull();
    expect(login(['mystery'], [])![1]?.done).toBe(false);
  });

  it('with no agent yet, any ready provider ticks the login, whatever the agent list says', () => {
    const line = setupChecklist({
      view: resting,
      agents: [],
      controller: controller({ providers: [providerReady('codex', true)] }),
      agentProviders: ['claude'],
    })![1];
    expect(line).toEqual({ key: 'login', done: true, text: 'AI login set', action: null });
  });

  it('no agent yet offers Add agent; one agent ticks it', () => {
    const agent = (agents: string[]) =>
      setupChecklist({ view: resting, agents, controller: controller(), agentProviders: null })![2];
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

  it('the card leaves out its status only when the checklist says the very same words', () => {
    const starting: YourCloudView = {
      resting: true,
      heading: 'Starting…',
      line: 'Usually ready in about two minutes.',
    };
    const lines = setupChecklist({
      view: starting,
      agents: [],
      controller: controller(),
      agentProviders: null,
    });
    expect(lines?.[0]?.text).toBe('Starting… · Usually ready in about two minutes.');
    expect(repeatsChecklist(starting, lines)).toBe(true);
    // No checklist showing (not known yet, or folded away): the card says it.
    expect(repeatsChecklist(starting, null)).toBe(false);
    // A stopped box: "Your cloud is stopped" and "Stopped · …" differ, so both stay.
    const stoppedView = stopped('lifecycle');
    expect(
      repeatsChecklist(
        stoppedView,
        setupChecklist({
          view: stoppedView,
          agents: [],
          controller: controller(),
          agentProviders: null,
        })
      )
    ).toBe(false);
    expect(
      repeatsChecklist(
        ready,
        setupChecklist({ view: ready, agents: [], controller: controller(), agentProviders: null })
      )
    ).toBe(false);
  });
});
