/**
 * The pop-up that introduces switch-buddy to someone who set Switch up
 * before it existed: shown on a server that offers the buddy, in a workspace
 * where the person has none and has not answered it, and not on the buddy's
 * own page or after Skip in this launch.
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

const state = vi.hoisted(() => ({
  flags: { switch_buddy: true, agent_management: true },
  agents: [] as { name: string }[] | undefined,
  viewId: 'home',
  workspaceId: 'ws-1' as string | null,
  serverId: 'srv-1' as string | null,
  answered: new Set<string>(),
  skipped: false,
  navigate: vi.fn(),
  report: vi.fn(),
}));

vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => state.flags }));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useManagedAgents: () => ({ data: state.agents }),
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useCurrentViewId: () => state.viewId,
  useNavigate: () => ({ navigate: state.navigate }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get activeServerId() {
      return state.serverId;
    },
    statusFor: () => ({ user: { name: 'Max Tam' } }),
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => state.workspaceId },
}));
vi.mock('@renderer/features/switch-buddy/buddy-intro-store', () => ({
  buddyIntroStore: {
    get skippedThisSession() {
      return state.skipped;
    },
    isAnswered: (workspaceId: string) => state.answered.has(workspaceId),
    answered: (workspaceId: string) => state.answered.add(workspaceId),
  },
}));
vi.mock('@renderer/lib/telemetry/report', () => ({ report: state.report }));

import { BuddyIntroDialog } from '@renderer/features/switch-buddy/buddy-intro-dialog';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  state.flags = { switch_buddy: true, agent_management: true };
  state.agents = [];
  state.viewId = 'home';
  state.workspaceId = 'ws-1';
  state.serverId = 'srv-1';
  state.answered = new Set();
  state.skipped = false;
  state.navigate.mockClear();
  state.report.mockClear();
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
  await act(async () => root!.render(<BuddyIntroDialog />));
}

function shown(): boolean {
  return document.body.textContent?.includes('Your first AI assistant in Switch') ?? false;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('BuddyIntroDialog', () => {
  it('introduces the buddy to someone who has none', async () => {
    await render();
    expect(shown()).toBe(true);
    expect(document.body.textContent).toContain('Max');
  });

  it.each([
    ['the server does not offer switch-buddy', () => (state.flags.switch_buddy = false)],
    ['the server does not manage agents', () => (state.flags.agent_management = false)],
    ['the person already has a buddy', () => (state.agents = [{ name: 'switch-buddy-max' }])],
    ['their agents are not known yet', () => (state.agents = undefined)],
    ['it is on the buddy page already', () => (state.viewId = 'switchBuddy')],
    ['they skipped the buddy in this launch', () => (state.skipped = true)],
    ['they answered it in this workspace', () => state.answered.add('ws-1')],
    ['no workspace is open', () => (state.workspaceId = null)],
    ['no server is open', () => (state.serverId = null)],
  ])('stays away when %s', async (_, arrange) => {
    arrange();
    await render();
    expect(shown()).toBe(false);
  });

  it('Meet switch-buddy opens its page and is the answer for the workspace', async () => {
    await render();
    await act(async () => button('Meet switch-buddy').click());

    expect(state.navigate).toHaveBeenCalledWith('switchBuddy', { serverId: 'srv-1' });
    expect(state.answered.has('ws-1')).toBe(true);
    expect(state.report).toHaveBeenCalledWith('buddy_step', {
      action: 'intro_opened',
      provider: 'none',
    });
  });

  it('Not now is the answer too, and opens nothing', async () => {
    await render();
    await act(async () => button('Not now').click());

    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.answered.has('ws-1')).toBe(true);
    expect(state.report).toHaveBeenCalledWith('buddy_step', {
      action: 'intro_dismissed',
      provider: 'none',
    });
  });
});
