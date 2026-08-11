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

const stores = vi.hoisted(() => ({
  reachability: new Map<string, unknown>(),
  plans: new Map<string, unknown>(),
}));

vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: {
    get: (sshHost: string) =>
      stores.reachability.get(sshHost) ?? {
        sshHost,
        status: 'reachable',
        lastError: null,
        lastCheckedAt: null,
        lastReachableAt: null,
        consecutiveFailures: 0,
        nextProbeAt: null,
        probing: false,
      },
  },
}));

vi.mock('@renderer/features/remote-hosts/host-setup-store', () => ({
  hostSetupStore: {
    hydrate: () => Promise.resolve(),
    get: (sshHost: string | null) => (sshHost ? (stores.plans.get(sshHost) ?? null) : null),
  },
}));

/**
 * An out-of-date connector on the agent's own row (CHOO-1809).
 *
 * Asked for so a stale Switch connector is visible without opening every host
 * page. It is strictly lower priority than the trouble icons: an old connector
 * still works, so it must never take the place of the reason an agent is stuck.
 */
import { HostTroubleIndicator } from '@renderer/features/remote-hosts/host-trouble-indicator';
import { TooltipProvider } from '@renderer/lib/ui/tooltip';
import type { HostSetupPlan, HostSetupStep } from '@shared/core/remote-hosts/setup';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  stores.reachability.clear();
  stores.plans.clear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function step(patch: Partial<HostSetupStep>): HostSetupStep {
  return {
    id: 'git',
    kind: 'core-dependency',
    name: 'Git',
    state: 'satisfied',
    outcome: 'satisfied',
    version: '2.43.0',
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional: false,
    dependsOn: [],
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...patch,
  };
}

function plan(steps: HostSetupStep[]): HostSetupPlan {
  return {
    sshHost: 'dev-vm',
    status: 'idle',
    steps,
    currentStepId: null,
    createdAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
  };
}

/** A healthy host running Claude Code, with the connector optionally behind. */
function healthyPlan(pluginPatch: Partial<HostSetupStep> = {}): HostSetupPlan {
  return plan([
    step({}),
    step({ id: 'claude', kind: 'agent-cli', name: 'Claude Code', version: '2.1.0' }),
    step({
      id: 'claude:plugin',
      kind: 'agent-plugin',
      name: 'Switch connector',
      version: '0.7.7',
      dependsOn: ['claude'],
      ...pluginPatch,
    }),
  ]);
}

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // The indicator's only output is a tooltip, which needs its provider.
  await act(async () => root!.render(<TooltipProvider>{node}</TooltipProvider>));
  return container;
}

const indicator = () => <HostTroubleIndicator sshHost="dev-vm" agentId="claude" />;
const icons = (el: HTMLElement) => [...el.querySelectorAll('svg')].length;
/** Tooltip *content* only renders on hover, so assert on the trigger's label. */
const shows = (el: HTMLElement, label: string) =>
  el.querySelector(`[aria-label="${label}"]`) !== null;

describe('the update indicator', () => {
  it('appears when this agent’s connector is behind', async () => {
    stores.plans.set('dev-vm', healthyPlan({ latestVersion: '0.8.0', updateAvailable: true }));

    expect(shows(await render(indicator()), 'Update available')).toBe(true);
  });

  it('stays away when everything is current', async () => {
    // A tick on every healthy row is noise that trains people to stop reading.
    stores.plans.set('dev-vm', healthyPlan());

    expect(icons(await render(indicator()))).toBe(0);
  });

  it('stays away when the newer version is not actually known', async () => {
    stores.plans.set('dev-vm', healthyPlan({ latestVersion: null, updateAvailable: true }));

    expect(icons(await render(indicator()))).toBe(0);
  });

  it('ignores another agent type being out of date', async () => {
    // Codex being stale is not this Claude Code agent's problem, exactly as a
    // missing Codex is not.
    stores.plans.set(
      'dev-vm',
      plan([
        step({}),
        step({ id: 'claude', kind: 'agent-cli', name: 'Claude Code' }),
        step({
          id: 'codex',
          kind: 'agent-cli',
          name: 'Codex',
          version: '0.146.0',
          latestVersion: '0.147.0',
          updateAvailable: true,
        }),
      ])
    );

    expect(icons(await render(indicator()))).toBe(0);
  });

  it('says nothing for a local agent, which has no host', async () => {
    stores.plans.set('dev-vm', healthyPlan({ latestVersion: '0.8.0', updateAvailable: true }));

    const el = await render(<HostTroubleIndicator sshHost={null} agentId="claude" />);

    expect(icons(el)).toBe(0);
  });
});

/**
 * Priority. An available update is information; unreachable and setup-required
 * are reasons the agent cannot work, and they win.
 */
describe('what the indicator shows first', () => {
  it('reports the host being down rather than an available update', async () => {
    stores.reachability.set('dev-vm', {
      sshHost: 'dev-vm',
      status: 'unreachable',
      lastError: 'connection refused',
      lastCheckedAt: null,
      lastReachableAt: null,
      consecutiveFailures: 3,
      nextProbeAt: null,
      probing: false,
    });
    stores.plans.set('dev-vm', healthyPlan({ latestVersion: '0.8.0', updateAvailable: true }));

    const el = await render(indicator());

    expect(shows(el, 'Host unavailable')).toBe(true);
    expect(shows(el, 'Update available')).toBe(false);
  });

  it('reports missing setup rather than an available update', async () => {
    stores.plans.set(
      'dev-vm',
      plan([
        step({ id: 'node', name: 'Node.js', state: 'pending', outcome: 'missing' }),
        step({ id: 'claude', kind: 'agent-cli', name: 'Claude Code' }),
        step({
          id: 'claude:plugin',
          kind: 'agent-plugin',
          name: 'Switch connector',
          latestVersion: '0.8.0',
          updateAvailable: true,
          dependsOn: ['claude'],
        }),
      ])
    );

    const el = await render(indicator());

    expect(shows(el, 'Setup required')).toBe(true);
    expect(shows(el, 'Update available')).toBe(false);
  });
});
