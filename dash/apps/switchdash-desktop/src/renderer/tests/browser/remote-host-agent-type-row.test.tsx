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

/**
 * An agent type is two things, and the page has to admit it (CHOO-1809).
 *
 * The CLI and its Switch connector were one row with one badge and one button.
 * That hid which half needed work, and left the connector with no controls of
 * its own — there was no way to update it, and "Switch setup required" named no
 * action you could take.
 */
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

function agentRow(
  cli: Partial<HostSetupStep>,
  plugin: Partial<HostSetupStep> | null
): AgentTypeRow {
  return {
    agentId: 'claude',
    name: 'Claude Code',
    cli: step(cli),
    plugin: plugin
      ? step({
          id: 'claude:plugin',
          kind: 'agent-plugin',
          name: 'Claude Code · Switch connector',
          dependsOn: ['claude'],
          ...plugin,
        })
      : null,
  };
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

describe('the connector as its own row', () => {
  it('shows the connector beneath the CLI', async () => {
    const el = await render(view(agentRow({ state: 'satisfied' }, { state: 'satisfied' })));

    expect(text(el)).toContain('Claude Code');
    expect(text(el)).toContain('Switch connector');
  });

  it('gives each half its own re-check', async () => {
    const el = await render(view(agentRow({ state: 'satisfied' }, { state: 'satisfied' })));

    expect(recheckButtons(el)).toHaveLength(2);
  });

  it('re-checks only the step whose button was clicked', async () => {
    const onRecheck = vi.fn();
    const el = await render(
      view(agentRow({ state: 'satisfied' }, { state: 'satisfied' }), { onRecheck })
    );

    await act(async () => recheckButtons(el)[1]!.click());

    expect(onRecheck).toHaveBeenCalledExactlyOnceWith('claude:plugin');
  });

  it('installs the connector, not the CLI, from the connector row', async () => {
    const onInstall = vi.fn();
    const el = await render(
      view(agentRow({ state: 'satisfied' }, { state: 'pending', outcome: 'missing' }), {
        onInstall,
      })
    );

    const install = buttons(el).find((b) => b.textContent?.trim() === 'Install');
    await act(async () => install!.click());

    expect(onInstall).toHaveBeenCalledExactlyOnceWith('claude:plugin');
  });

  it('offers the connector its own update', async () => {
    const onUpdate = vi.fn();
    const el = await render(
      view(
        agentRow(
          { state: 'satisfied', version: '2.1.0' },
          { state: 'satisfied', version: '0.7.6', latestVersion: '0.7.7', updateAvailable: true }
        ),
        { onUpdate }
      )
    );

    const update = buttons(el).find((b) => b.textContent?.trim() === 'Update');
    await act(async () => update!.click());

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith('claude:plugin');
  });

  it('can update one half while the other is current', async () => {
    // Two rows, two verdicts: an out-of-date CLI and an out-of-date connector
    // are different facts and each gets its own button.
    const el = await render(
      view(
        agentRow(
          { state: 'satisfied', version: '2.1.0', latestVersion: '2.2.0', updateAvailable: true },
          { state: 'satisfied', version: '0.7.7' }
        )
      )
    );

    expect(labels(el).filter((l) => l === 'Update')).toHaveLength(1);
  });
});

/**
 * The connector is installed *by* the agent's own CLI, so with the CLI absent
 * there is nothing to install it with. Offering the button anyway produced a
 * failure that named the connector rather than the missing CLI.
 */
describe('the connector depends on the CLI', () => {
  const cliMissing = agentRow(
    { state: 'pending', outcome: 'missing' },
    { state: 'pending', outcome: 'missing' }
  );

  it('offers no install for the connector while the CLI is missing', async () => {
    const el = await render(view(cliMissing));

    // The CLI's own Install is still offered — exactly one, not two.
    expect(labels(el).filter((l) => l === 'Install')).toHaveLength(1);
  });

  it('says what it is waiting for instead', async () => {
    const el = await render(view(cliMissing));

    expect(text(el)).toContain('Needs Claude Code first');
  });

  it('offers the connector its actions once the CLI is there', async () => {
    const el = await render(
      view(agentRow({ state: 'satisfied' }, { state: 'pending', outcome: 'missing' }))
    );

    expect(labels(el).filter((l) => l === 'Install')).toHaveLength(1);
    expect(recheckButtons(el)).toHaveLength(2);
  });
});

describe('a plan with no connector step', () => {
  it('renders the CLI alone rather than an empty sub-row', async () => {
    // Plans persisted before connector steps existed have no plugin half.
    const el = await render(view(agentRow({ state: 'satisfied' }, null)));

    expect(text(el)).not.toContain('Switch connector');
    expect(recheckButtons(el)).toHaveLength(1);
  });
});

describe('actions while the host is working', () => {
  it('withdraws both rows’ actions, keeping only the checks', async () => {
    const el = await render(
      view(agentRow({ state: 'satisfied' }, { state: 'pending', outcome: 'missing' }), {
        hostBusy: true,
      })
    );

    expect(labels(el)).not.toContain('Install');
    expect(recheckButtons(el)).toHaveLength(2);
  });
});
