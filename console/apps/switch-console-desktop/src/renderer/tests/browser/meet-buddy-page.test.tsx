/**
 * Meet switch-buddy's start choices settle once and stay as they first were:
 * the row of providers does not change under the eye as later checks come
 * back. A choice made before this computer is ready starts once it is.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

type Reported = { provider: string; ready: boolean; problem: string | null; detail: null };

const state = vi.hoisted(() => ({
  computer: { kind: 'starting' } as
    | { kind: 'starting' }
    | { kind: 'ready'; machine: { id: string; providers: Reported[] } }
    | { kind: 'failed'; error: string },
  early: null as Reported[] | null,
  agents: [] as { agentId: string; name: string }[],
  createBuddy: vi.fn(),
}));

vi.mock('@renderer/features/switch-buddy/use-this-computer', () => ({
  useThisComputer: () => ({
    state: state.computer,
    recheck: vi.fn(),
    earlyProviders: state.early,
  }),
}));
vi.mock('@renderer/features/switch-buddy/create-buddy', () => ({
  createBuddy: state.createBuddy,
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useManagedAgents: () => ({ data: state.agents }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { statusFor: () => ({ user: { name: 'Max Tam', email: null } }) },
}));
vi.mock('@renderer/features/switch-buddy/meet-buddy-intro', () => ({
  MeetBuddyIntro: () => <p>intro</p>,
}));
vi.mock('@renderer/lib/components/agent-icon', () => ({
  AgentIcon: ({ id }: { id: string }) => <span data-provider-icon={id} />,
}));
vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { MeetBuddyPage } from '@renderer/features/switch-buddy/meet-buddy-page';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const onCreated = vi.fn();
const onSkip = vi.fn();
const onSetupOpened = vi.fn();

const ready = (provider: string): Reported => ({
  provider,
  ready: true,
  problem: null,
  detail: null,
});
const signedOut = (provider: string): Reported => ({
  provider,
  ready: false,
  problem: 'not signed in',
  detail: null,
});

function machine(...providers: Reported[]) {
  return { kind: 'ready' as const, machine: { id: 'm-1', providers } };
}

beforeEach(() => {
  state.computer = { kind: 'starting' };
  state.early = null;
  state.agents = [];
  state.createBuddy.mockReset();
  onCreated.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  // A new callback each time, so the page renders again with what the hooks
  // now say (it is memoised on its props).
  await act(async () =>
    root!.render(
      <MeetBuddyPage
        serverId="srv-1"
        workspaceId="ws-1"
        onCreated={(agent) => onCreated(agent)}
        onSkip={onSkip}
        onSetupOpened={onSetupOpened}
      />
    )
  );
}

function buttons(): string[] {
  return [...container!.querySelectorAll('button')].map((b) => b.textContent ?? '');
}

describe('MeetBuddyPage', () => {
  it('waits while the providers are being checked', async () => {
    await render();
    expect(container!.textContent).toContain('Checking AI providers');
  });

  it('settles on the providers first found ready, and keeps them as later checks come back', async () => {
    // Claude ready and Codex known: decided, without waiting for the others.
    state.computer = machine(ready('claude'), signedOut('codex'));
    await render();
    expect(buttons()).toEqual(['Claude Code', 'Use other AI providers']);

    // Codex signs in afterwards: the row stays as it first was.
    state.computer = machine(ready('claude'), ready('codex'));
    await render();
    expect(buttons()).toEqual(['Claude Code', 'Use other AI providers']);
  });

  it('offers to set one up, or skip, when none is ready', async () => {
    state.computer = machine(
      signedOut('claude'),
      signedOut('codex'),
      signedOut('opencode'),
      signedOut('cursor'),
      signedOut('antigravity')
    );
    await render();
    expect(buttons()).toEqual(['Skip', 'Set up AI provider']);
  });

  it("goes by Console's own early check until this computer reports", async () => {
    state.early = [ready('codex'), signedOut('claude')];
    await render();
    expect(buttons()).toEqual(['Codex', 'Use other AI providers']);
  });

  it('starts a provider chosen before this computer is ready, once it is', async () => {
    state.early = [ready('claude'), signedOut('codex')];
    state.createBuddy.mockResolvedValue({ agentId: 'a-1', name: 'switch-buddy-max-tam' });
    await render();

    await act(async () =>
      [...container!.querySelectorAll('button')]
        .find((b) => b.textContent === 'Claude Code')!
        .click()
    );
    expect(state.createBuddy).not.toHaveBeenCalled();

    state.computer = machine(ready('claude'), signedOut('codex'));
    await render();

    expect(state.createBuddy).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 'm-1', provider: 'claude', entryPoint: 'onboarding' })
    );
    expect(onCreated).toHaveBeenCalledWith({ agentId: 'a-1', name: 'switch-buddy-max-tam' });
  });

  it('tells the page holding it when the person opens the other providers', async () => {
    state.computer = machine(ready('claude'), signedOut('codex'));
    await render();

    await act(async () =>
      [...container!.querySelectorAll('button')]
        .find((b) => b.textContent === 'Use other AI providers')!
        .click()
    );

    expect(onSetupOpened).toHaveBeenCalledTimes(1);
  });

  it('offers to open the buddy someone already has', async () => {
    state.agents = [{ agentId: 'a-1', name: 'switch-buddy-max' }];
    await render();
    expect(buttons()).toEqual(['Open switch-buddy']);
  });
});
