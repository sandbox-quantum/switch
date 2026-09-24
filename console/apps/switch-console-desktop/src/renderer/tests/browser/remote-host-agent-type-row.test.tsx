import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The row's sibling components reach the renderer IPC bridge at import time,
// which only exists inside Electron. Hoisted so it is in place before those
// modules are evaluated. Nothing under test calls through it.
vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/components/agent-icon', () => ({
  AgentIcon: () => null,
}));

import { AgentTypeRowItem } from '@renderer/features/remote-hosts/setup/setup-rows';
import type { AgentTypeRow } from '@renderer/features/remote-hosts/setup/step-presentation';
import type { HostSetupStep } from '@shared/core/remote-hosts/setup';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function step(patch: Partial<HostSetupStep>): HostSetupStep {
  return {
    id: 'claude',
    kind: 'agent-cli',
    name: 'Claude Code',
    state: 'pending',
    outcome: 'missing',
    version: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
    output: null,
    optional: false,
    dependsOn: ['node'],
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...patch,
  };
}

function agentRow(cli: Partial<HostSetupStep>): AgentTypeRow {
  return { agentId: 'claude', name: 'Claude Code', cli: step(cli) };
}

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

type Overrides = {
  hostBusy?: boolean;
  installingStepId?: string | null;
  updatingStepId?: string | null;
  recheckingStepId?: string | null;
  onInstall?: (stepId: string) => void;
  onUpdate?: (stepId: string) => void;
  onRecheck?: (stepId: string) => void;
};

function view(row: AgentTypeRow, overrides: Overrides = {}) {
  return (
    <AgentTypeRowItem
      row={row}
      currentStepId={null}
      installingStepId={overrides.installingStepId ?? null}
      updatingStepId={overrides.updatingStepId ?? null}
      recheckingStepId={overrides.recheckingStepId ?? null}
      hostBusy={overrides.hostBusy ?? false}
      activityFor={() => null}
      onInstall={overrides.onInstall ?? (() => {})}
      onUpdate={overrides.onUpdate ?? (() => {})}
      onRecheck={overrides.onRecheck ?? (() => {})}
      onOpen={() => {}}
    />
  );
}

const text = (el: HTMLElement) => el.textContent ?? '';
const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')];
const labels = (el: HTMLElement) => buttons(el).map((b) => b.textContent?.trim() ?? '');
const recheckButtons = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLButtonElement>('button[aria-label^="Re-check"]'),
];

describe('an agent type row', () => {
  it('shows the CLI with its own re-check', async () => {
    const el = await render(view(agentRow({ state: 'satisfied' })));

    expect(text(el)).toContain('Claude Code');
    expect(recheckButtons(el)).toHaveLength(1);
  });

  it('installs the CLI', async () => {
    const onInstall = vi.fn();
    const el = await render(
      view(agentRow({ state: 'pending', outcome: 'missing' }), { onInstall })
    );

    const install = buttons(el).find((b) => b.textContent?.trim() === 'Install');
    await act(async () => install!.click());

    expect(onInstall).toHaveBeenCalledExactlyOnceWith('claude');
  });

  it('offers an update when a newer CLI exists', async () => {
    const onUpdate = vi.fn();
    const el = await render(
      view(
        agentRow({
          state: 'satisfied',
          version: '2.1.0',
          latestVersion: '2.2.0',
          updateAvailable: true,
        }),
        { onUpdate }
      )
    );

    const update = buttons(el).find((b) => b.textContent?.trim() === 'Update');
    await act(async () => update!.click());

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith('claude');
  });
});

describe('actions while the host is working', () => {
  it('withdraws the install, keeping only the check', async () => {
    const el = await render(
      view(agentRow({ state: 'pending', outcome: 'missing' }), { hostBusy: true })
    );

    expect(labels(el)).not.toContain('Install');
    expect(recheckButtons(el)).toHaveLength(1);
  });
});
