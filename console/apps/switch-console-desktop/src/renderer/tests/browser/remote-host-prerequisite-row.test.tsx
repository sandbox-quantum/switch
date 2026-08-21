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
 * The action a prerequisite row offers has to be on the row (CHOO-1809).
 *
 * The GitHub login is the case that went wrong: it was the only prerequisite
 * whose fix lived exclusively in the detail sheet, so the row showed "Not
 * installed" and no way to do anything about it — you had to know to click
 * through. Every other row had its Install button in plain sight.
 */
import { PrerequisiteRow } from '@renderer/features/remote-hosts/setup/setup-rows';
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
    id: 'tmux',
    kind: 'core-dependency',
    name: 'tmux',
    state: 'pending',
    outcome: 'missing',
    version: null,
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

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

function row(
  target: HostSetupStep,
  ghState: HostSetupStep['state'] = 'satisfied',
  overrides: {
    hostBusy?: boolean;
    rechecking?: boolean;
    updating?: boolean;
    onRecheck?: () => void;
    onUpdate?: () => void;
  } = {}
) {
  return (
    <PrerequisiteRow
      step={target}
      isCurrent={false}
      installing={false}
      updating={overrides.updating ?? false}
      rechecking={overrides.rechecking ?? false}
      hostBusy={overrides.hostBusy ?? false}
      activity={null}
      onInstall={() => {}}
      onUpdate={overrides.onUpdate ?? (() => {})}
      onRecheck={overrides.onRecheck ?? (() => {})}
      onOpen={() => {}}
    />
  );
}

function buttonLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}

function recheckButton(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector('button[aria-label^="Re-check"]');
}

/**
 * Re-checking one row exists because the whole-host re-check costs an SSH round
 * trip per step, which is a lot to pay to answer "is this one still there?".
 */
describe('the per-row re-check', () => {
  it('is offered on a row that still needs work', async () => {
    const el = await render(row(step({})));

    expect(recheckButton(el)).not.toBeNull();
  });

  it('is offered on a satisfied row too — that is the question it answers', async () => {
    // "Is this still installed?" is fair to ask of something verified at some
    // point in the past, and it is the only way to find out short of re-probing
    // the entire host.
    const el = await render(
      row(step({ state: 'satisfied', outcome: 'satisfied', version: 'not-a-version' }))
    );

    expect(recheckButton(el)).not.toBeNull();
  });

  it('calls back with the row it belongs to', async () => {
    const onRecheck = vi.fn();
    const el = await render(row(step({}), 'satisfied', { onRecheck }));

    await act(async () => recheckButton(el)!.click());

    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('is disabled while the host is already doing something', async () => {
    // One operation per host at a time: a whole-host re-check and a single row
    // would otherwise race for the runner, and the loser reports an error that
    // reads like the dependency's fault.
    const el = await render(row(step({}), 'satisfied', { hostBusy: true }));

    expect(recheckButton(el)!.disabled).toBe(true);
  });

  it('does not fire while the host is busy', async () => {
    const onRecheck = vi.fn();
    const el = await render(row(step({}), 'satisfied', { hostBusy: true, onRecheck }));

    await act(async () => recheckButton(el)!.click());

    expect(onRecheck).not.toHaveBeenCalled();
  });

  it('is disabled while this row is the one being re-checked', async () => {
    const el = await render(row(step({}), 'satisfied', { rechecking: true }));

    expect(recheckButton(el)!.disabled).toBe(true);
  });
});

/**
 * While a check runs, a row offers nothing but the check (CHOO-1809).
 *
 * Install stayed live on every other row even though the runner takes one
 * operation per host and would have refused it — an offer that cannot be
 * honoured reads as this dependency's fault rather than as the button never
 * having been live.
 */
describe('actions while the host is working', () => {
  it('offers no Install while this row is mid-check', async () => {
    const el = await render(row(step({ state: 'checking' })));

    expect(buttonLabels(el)).not.toContain('Install');
  });

  it('withdraws Install from an idle row while the host is busy elsewhere', async () => {
    const el = await render(row(step({}), 'satisfied', { hostBusy: true }));

    expect(buttonLabels(el)).not.toContain('Install');
  });

  it('still shows the check control, so something says work is happening', async () => {
    const el = await render(row(step({}), 'satisfied', { hostBusy: true }));

    expect(recheckButton(el)).not.toBeNull();
  });
});

/** The Update action is the one thing the "Update available" badge was missing. */
describe('the update action', () => {
  const dep = (patch: Partial<HostSetupStep> = {}) =>
    step({
      id: 'git',
      kind: 'core-dependency',
      name: 'Git',
      dependsOn: [],
      state: 'satisfied',
      outcome: 'satisfied',
      version: '2.43.0',
      ...patch,
    });

  it('is offered when a newer version is known to exist', async () => {
    const el = await render(row(dep({ latestVersion: '2.44.0', updateAvailable: true })));

    expect(buttonLabels(el)).toContain('Update');
  });

  it('is not offered when nothing newer is known', async () => {
    const el = await render(row(dep()));

    expect(buttonLabels(el)).not.toContain('Update');
  });

  it('is not offered on a version we simply could not read', async () => {
    // `latestVersion: null` means "we could not tell", which is not grounds to
    // offer an update any more than it is grounds to claim currency.
    const el = await render(row(dep({ latestVersion: null, updateAvailable: false })));

    expect(buttonLabels(el)).not.toContain('Update');
  });

  it('calls back with the row it belongs to', async () => {
    const onUpdate = vi.fn();
    const el = await render(
      row(dep({ latestVersion: '2.44.0', updateAvailable: true }), 'satisfied', { onUpdate })
    );

    const button = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Update'
    );
    await act(async () => button!.click());

    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('is withdrawn while the host is busy with something else', async () => {
    const el = await render(
      row(dep({ latestVersion: '2.44.0', updateAvailable: true }), 'satisfied', { hostBusy: true })
    );

    expect(buttonLabels(el)).not.toContain('Update');
  });
});
