/**
 * Your cloud's capacity bars take their colour from the step, as on Switch
 * web: the usual colour below 80%, amber from 80%, red from 95%.
 */
import '@renderer/index.css';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { HostedCapacityRows } from '@renderer/features/cloud-agents/hosted-summary-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GB = 1024 ** 3;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** The indicator's painted colour for one row, and the colour a token resolves to. */
function barColour(name: string): string {
  const indicator = host!.querySelector(
    `[data-capacity="${name}"] [data-slot="progress-indicator"]`
  );
  return getComputedStyle(indicator!).backgroundColor;
}
function tokenColour(className: string): string {
  const probe = document.createElement('div');
  probe.className = className;
  host!.append(probe);
  const colour = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return colour;
}

it('colours each bar by its step: usual, amber at 80%, red at 95%', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <HostedCapacityRows
        machine={{
          agents: ['a1'],
          awake: { running: 1, max: 5 }, // 20%
          room: { used_bytes: 3.2 * GB, total_bytes: 4 * GB }, // 80%
          disk: { total_bytes: 20 * GB, available_bytes: 1 * GB, scope: 'workspace' }, // 95%
        }}
      />
    )
  );
  expect(host.querySelector('[data-capacity="memory"]')?.getAttribute('data-step')).toBe(
    'nearly_full'
  );
  expect(host.querySelector('[data-capacity="disk"]')?.getAttribute('data-step')).toBe('full');
  const usual = tokenColour('bg-foreground-info');
  const amber = tokenColour('bg-foreground-warning');
  const red = tokenColour('bg-destructive');
  expect(new Set([usual, amber, red]).size).toBe(3);
  expect(barColour('awake')).toBe(usual);
  expect(barColour('memory')).toBe(amber);
  expect(barColour('disk')).toBe(red);
});
