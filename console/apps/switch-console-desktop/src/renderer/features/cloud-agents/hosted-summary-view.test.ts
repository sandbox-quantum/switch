// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';

// The workspace page's Your cloud summary: nothing without hosted_v2 or a box,
// the box's state and hosted-agent count, the same capacity rows as Your
// Agents, and the disk only once it's the workspace disk.

const GiB = 1024 ** 3;
const flags = vi.hoisted(() => ({ hosted_v2: true }));
const machines = vi.hoisted(() => ({ data: null as CloudMachine[] | null }));
const asked = vi.hoisted(() => ({ serverId: undefined as string | null | undefined }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => flags }));
vi.mock('./use-cloud-agents', () => ({
  useCloudMachines: (serverId: string | null) => {
    asked.serverId = serverId;
    return { data: machines.data };
  },
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate }) }));

const { YourCloudSummary } = await import('./hosted-summary-view');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function box(over: Partial<CloudMachine> = {}): CloudMachine {
  return {
    machine_id: 'm-box',
    state: 'ready',
    desired_state: 'running',
    stop_reason: null,
    sleeping: false,
    revision: 1,
    instance_type: null,
    error: null,
    error_code: null,
    retain_until: null,
    heartbeat_at: '2026-11-06T10:00:00Z',
    disk: { total_bytes: 15 * GiB, available_bytes: 11 * GiB, scope: 'workspace' },
    memory: null,
    agents: ['a1', 'a2'],
    controller_id: 'c-box',
    backend: 'box',
    room: { used_bytes: 7 * GiB, total_bytes: 8 * GiB },
    awake: { running: 12, max: 12 },
    ai_calls_today: null,
    ...over,
  };
}

async function show() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(YourCloudSummary, { serverId: 's1' })));
  return { host, done: () => act(() => root.unmount()) };
}

afterEach(() => {
  flags.hosted_v2 = true;
  machines.data = null;
  navigate.mockReset();
  document.body.innerHTML = '';
});

describe('YourCloudSummary', () => {
  it('with hosted_v2 off, shows nothing and asks for no machines', async () => {
    flags.hosted_v2 = false;
    machines.data = [box()];
    const view = await show();
    expect(view.host.innerHTML).toBe('');
    expect(asked.serverId).toBeNull();
    view.done();
  });

  it('with no box (only a v1 machine, or none), shows nothing', async () => {
    machines.data = [box({ backend: 'vm' })];
    let view = await show();
    expect(view.host.innerHTML).toBe('');
    view.done();
    machines.data = [box({ state: 'deleted' })];
    view = await show();
    expect(view.host.innerHTML).toBe('');
    view.done();
  });

  it('shows the state, how many hosted agents, and the capacity rows with their warnings', async () => {
    machines.data = [box()];
    const view = await show();
    const text = view.host.textContent ?? '';
    expect(text).toContain('Your cloud');
    expect(text).toContain('Nearly full · 2 hosted agents');
    expect(text).toContain('Agents awake: 12 of 12');
    expect(text).toContain('Memory: 7.0 GB of 8.0 GB');
    expect(text).toContain('Disk: 4.0 GB of 15.0 GB');
    const step = (name: string) =>
      view.host.querySelector(`[data-capacity="${name}"]`)?.getAttribute('data-step');
    expect(step('awake')).toBe('full');
    expect(step('memory')).toBe('nearly_full');
    expect(step('disk')).toBe('ok');
    // The advice line sits under its bar, and only where it applies.
    expect(text).toContain('Full right now. New work waits until a place frees up.');
    expect(text).toContain('Nearly full. Agents may slow down.');
    expect(view.host.querySelector('[data-capacity="disk"]')?.textContent).not.toContain('Nearly');
    view.done();
  });

  it('says the disk is not available until the box measures the workspace disk', async () => {
    machines.data = [box({ disk: { total_bytes: 2 * GiB, available_bytes: GiB } })];
    const view = await show();
    expect(view.host.textContent).toContain('Disk: not available');
    expect(view.host.textContent).not.toContain('2.0 GB');
    view.done();
  });

  it('a resting box shows its line and no figures', async () => {
    machines.data = [
      box({ sleeping: true, state: 'stopped', desired_state: 'stopped', stop_reason: 'idle' }),
    ];
    const view = await show();
    expect(view.host.textContent).toContain('Resting · 2 hosted agents');
    expect(view.host.textContent).toContain(
      'Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.'
    );
    expect(view.host.querySelector('[data-capacity]')).toBeNull();
    view.done();
  });

  it('Your Agents goes to the agents page', async () => {
    machines.data = [box()];
    const view = await show();
    const button = [...view.host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Your Agents')
    );
    await act(async () => button?.click());
    expect(navigate).toHaveBeenCalledWith('serverAgents', { serverId: 's1' });
    view.done();
  });
});
