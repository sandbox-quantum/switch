// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import type { YourCloudView } from './your-cloud';

// The box card's setup checklist: ticks and next steps from what Console
// already reads, one Start only, Give login for the box, Add agent, and gone
// once all three are ticked.

const owned = vi.hoisted(() => ({ data: undefined as unknown, isError: false }));
const showAddAgent = vi.hoisted(() => vi.fn());
const gave = vi.hoisted(() => ({ provider: null as string | null }));

vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  useOwnedMachines: () => owned,
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => showAddAgent }));
vi.mock('@renderer/features/locations/components/add-agent-modal/give-machine-login', () => ({
  GiveMachineLogin: ({ provider }: { provider: string }) => {
    gave.provider = provider;
    return createElement('div', { 'data-give-login': provider }, `Give ${provider} login`);
  },
}));

const { BoxSetupChecklist } = await import('./setup-checklist-view');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const box = (agents: string[]) => ({ agents, controller_id: 'c-box' }) as unknown as CloudMachine;
const controller = (ready: boolean) => ({
  id: 'c-box',
  acceptsLogins: true,
  providers: [{ provider: 'claude', ready, problem: null, detail: null, loginHelps: true }],
});
const ready: YourCloudView = {
  resting: false,
  heading: 'Ready',
  room: null,
  awake: null,
  aiCalls: null,
};
const stopped: YourCloudView = { resting: true, heading: 'Stopped', line: 'x', start: 'lifecycle' };

async function show(view: YourCloudView, agents: string[], extra: { blocked?: boolean } = {}) {
  const onStart = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(BoxSetupChecklist, {
        machine: box(agents),
        serverId: 's1',
        view,
        pending: false,
        blocked: extra.blocked ?? false,
        onStart,
      })
    )
  );
  return { host, onStart, done: () => act(() => root.unmount()) };
}
const buttons = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].map((b) => b.textContent);
const click = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  await act(async () => button?.click());
};

afterEach(() => {
  owned.data = undefined;
  owned.isError = false;
  showAddAgent.mockReset();
  gave.provider = null;
  document.body.innerHTML = '';
});

describe('BoxSetupChecklist', () => {
  it('shows three lines with ticks or next steps, in the PM’s words', async () => {
    owned.data = [controller(false)];
    const view = await show(ready, []);
    const line = (key: string) => view.host.querySelector(`[data-checklist-line="${key}"]`);
    expect(line('cloud')?.textContent).toContain('Your cloud is ready');
    expect(line('cloud')?.getAttribute('data-done')).toBe('true');
    expect(line('login')?.textContent).toContain('No AI login yet');
    expect(line('agent')?.textContent).toContain('No agent yet');
    expect(buttons(view.host)).toEqual(['Give login', 'Add agent']);
    view.done();
  });

  it('Give login opens the box’s login for a provider that isn’t ready; Add agent opens Add agent', async () => {
    owned.data = [controller(false)];
    const view = await show(ready, []);
    await click(view.host, 'Give login');
    expect(gave.provider).toBe('claude');
    expect(buttons(view.host)).not.toContain('Give login');
    await click(view.host, 'Add agent');
    expect(showAddAgent).toHaveBeenCalledWith({ entryPoint: 'server_page' });
    view.done();
  });

  it('a stopped box’s Start is on the checklist, once, and starts it the card’s way', async () => {
    owned.data = [controller(true)];
    const view = await show(stopped, ['a1']);
    expect(view.host.textContent).toContain('Your cloud is stopped');
    expect(buttons(view.host)).toEqual(['Start']);
    await click(view.host, 'Start');
    expect(view.onStart).toHaveBeenCalledWith('lifecycle');
    view.done();
  });

  it('while the machine list loads, a stopped box still has its plain Start', async () => {
    owned.data = undefined;
    const view = await show(stopped, []);
    expect(view.host.querySelector('[data-setup-checklist]')).toBeNull();
    expect(buttons(view.host)).toEqual(['Start']);
    view.done();
  });

  it('a paused or turned-off box offers no Start, even on the checklist', async () => {
    owned.data = [controller(false)];
    const view = await show(stopped, [], { blocked: true });
    expect(buttons(view.host)).not.toContain('Start');
    view.done();
  });

  it('a failed machine-list read still shows the checklist, with no Give login', async () => {
    owned.isError = true;
    const view = await show(ready, []);
    expect(view.host.textContent).toContain('No AI login yet');
    expect(buttons(view.host)).toEqual(['Add agent']);
    view.done();
  });

  it('folds away once all three are ticked', async () => {
    owned.data = [controller(true)];
    const view = await show(ready, ['a1']);
    expect(view.host.innerHTML).toBe('');
    view.done();
  });
});
