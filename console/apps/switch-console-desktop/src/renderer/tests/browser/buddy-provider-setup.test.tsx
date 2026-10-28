/**
 * The card that sets up an AI provider for switch-buddy: it starts the buddy
 * with a provider already signed in, installs one that is missing, and says
 * what went wrong, one error at a time.
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
  providers: [] as Reported[],
  createBuddy: vi.fn(),
  install: vi.fn(),
  recheck: vi.fn(async () => null),
  onCreated: vi.fn(),
}));

vi.mock('@renderer/features/switch-buddy/create-buddy', () => ({
  createBuddy: state.createBuddy,
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    providers: {
      install: state.install,
      startLogin: vi.fn(),
      cancelLogin: vi.fn(async () => undefined),
    },
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { statusFor: () => ({ user: { name: 'Max Tam', email: null } }) },
}));
vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));
vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { ProviderSetup } from '@renderer/features/switch-buddy/provider-setup';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const ready = (provider: string): Reported => ({
  provider,
  ready: true,
  problem: null,
  detail: null,
});
const missing = (provider: string): Reported => ({
  provider,
  ready: false,
  problem: 'not installed',
  detail: null,
});

beforeEach(() => {
  state.providers = [];
  state.createBuddy.mockReset();
  state.install.mockReset();
  state.onCreated.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <ProviderSetup
        serverId="srv-1"
        workspaceId="ws-1"
        entryPoint="switch_buddy"
        onCreated={state.onCreated}
        thisComputer={{
          state: { kind: 'ready', machine: { id: 'm-1', providers: state.providers } as never },
          recheck: state.recheck,
        }}
      />
    )
  );
}

async function click(label: string) {
  const button = [...container!.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label)
  );
  if (!button) throw new Error(`no button "${label}"`);
  await act(async () => button.click());
}

function alert(): string | null {
  return container!.querySelector('[role="alert"]')?.textContent ?? null;
}

describe('ProviderSetup', () => {
  it('starts the buddy with the provider signed in here', async () => {
    state.providers = [ready('claude'), missing('codex')];
    state.createBuddy.mockResolvedValue({ agentId: 'a-1', name: 'switch-buddy-max-tam' });
    await render();

    await click('Start with Claude Code');

    expect(state.createBuddy).toHaveBeenCalledWith({
      serverId: 'srv-1',
      workspaceId: 'ws-1',
      machineId: 'm-1',
      provider: 'claude',
      person: { name: 'Max Tam', email: null },
      entryPoint: 'switch_buddy',
    });
    expect(state.onCreated).toHaveBeenCalledWith({ agentId: 'a-1', name: 'switch-buddy-max-tam' });
  });

  it('says why the buddy could not be created, and lets the person try again', async () => {
    state.providers = [ready('claude')];
    state.createBuddy.mockRejectedValue(new Error('Your computer went offline.'));
    await render();

    await click('Start with Claude Code');

    expect(alert()).toContain('Your computer went offline.');
    expect(state.onCreated).not.toHaveBeenCalled();
    const start = [...container!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Start with Claude Code')
    )!;
    expect(start.disabled).toBe(false);
  });

  it('installs a provider that is missing, and says when that fails', async () => {
    state.providers = [missing('claude'), missing('codex')];
    state.install.mockResolvedValue({
      success: false,
      error: { type: 'no-install-command' },
    });
    await render();

    // Nothing ready or signed out: the first is picked once the person chooses it.
    await click('Claude Code');
    await click('Install Claude Code');

    expect(state.install).toHaveBeenCalledWith('claude');
    expect(alert()).toContain('can’t install Claude Code on this computer');
  });

  it('clears the last error when the person starts again', async () => {
    state.providers = [ready('claude')];
    state.createBuddy
      .mockRejectedValueOnce(new Error('First try failed.'))
      .mockReturnValueOnce(new Promise(() => {}));
    await render();

    await click('Start with Claude Code');
    expect(alert()).toContain('First try failed.');

    await click('Start with Claude Code');
    expect(alert()).toBeNull();
    expect(container!.textContent).toContain('Creating switch-buddy…');
  });
});
