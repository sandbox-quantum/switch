import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Dismissing the setup checklist has to reach the checklist, not just the disk.
 *
 * The panel renders from the cached `onboarding` setting and nothing broadcasts
 * a settings change back to the renderer, so a dismissal written straight over
 * IPC persisted correctly and changed nothing on screen — the ✕ read as a dead
 * button until the next launch (CHOO-2344).
 */

/** Stands in for the main process: `getWithMeta` reflects what `update` stored. */
const stored = vi.hoisted(() => ({ showChecklist: true }));
const settingsUpdate = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn(() => () => {}), emit: vi.fn() },
  rpc: {
    appSettings: {
      getWithMeta: vi.fn(() =>
        Promise.resolve({
          value: { ...stored },
          defaults: { showChecklist: true },
          overrides: {},
        })
      ),
      update: settingsUpdate.mockImplementation((_key, value) => {
        Object.assign(stored, value);
        return Promise.resolve(undefined);
      }),
      reset: vi.fn(),
      resetField: vi.fn(),
    },
    switchSetup: {
      listAgentTypeAvailability: vi.fn(() => Promise.resolve([])),
      listAgentTypeAvailabilityRemote: vi.fn(() => Promise.resolve([])),
    },
  },
}));
vi.mock('@renderer/lib/telemetry/report', () => ({ report: vi.fn() }));

import { useOnboardingChecklist } from '@renderer/features/onboarding/use-onboarding-checklist';
import { appSettingsMetaQueryKey } from '@renderer/features/settings/app-settings-client';
import { queryClient } from '@renderer/lib/query-client';

const ONBOARDING_KEY = appSettingsMetaQueryKey('onboarding');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  queryClient.clear();
  settingsUpdate.mockClear();
  stored.showChecklist = true;
});

/** Mounts the hook against the app's own query client and hands back `dismiss`. */
async function mountChecklist() {
  queryClient.setQueryData(ONBOARDING_KEY, {
    value: { showChecklist: true },
    defaults: { showChecklist: true },
    overrides: {},
  });

  let dismiss: () => void = () => {};
  function Probe() {
    dismiss = useOnboardingChecklist().dismiss;
    return null;
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    )
  );

  return () => dismiss();
}

describe('dismissing the setup checklist', () => {
  it('hides the checklist for the session, not only on the next launch', async () => {
    const dismiss = await mountChecklist();

    await act(async () => {
      dismiss();
      await vi.waitFor(() =>
        expect(
          queryClient.getQueryData<{ value: { showChecklist: boolean } }>(ONBOARDING_KEY)?.value
            .showChecklist
        ).toBe(false)
      );
    });
  });

  it('persists the dismissal', async () => {
    const dismiss = await mountChecklist();

    await act(async () => {
      dismiss();
      await vi.waitFor(() =>
        expect(settingsUpdate).toHaveBeenCalledWith('onboarding', { showChecklist: false })
      );
    });
  });
});
