import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import '@renderer/index.css';
import { AgentStatusSlot } from '@renderer/features/sidebar/agent-status-slot';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** An indicator with nothing to say, the way each one answers for a healthy agent. */
function Silent() {
  return null;
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

function visible(el: HTMLElement, id: string): boolean {
  const node = el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return !!node && getComputedStyle(node).display !== 'none';
}

describe('AgentStatusSlot', () => {
  it('shows only the first indicator that has something to say', async () => {
    // A dead host used to put three warnings on one row, each a consequence of
    // the outage the first one already named.
    const el = await render(
      <AgentStatusSlot>
        <Silent />
        <span data-testid="host">host</span>
        <span data-testid="connection">connection</span>
        <span data-testid="cli">cli</span>
      </AgentStatusSlot>
    );

    expect(visible(el, 'host')).toBe(true);
    expect(visible(el, 'connection')).toBe(false);
    expect(visible(el, 'cli')).toBe(false);
  });

  it('falls through to the next cause when the first has nothing to report', async () => {
    const el = await render(
      <AgentStatusSlot>
        <Silent />
        <Silent />
        <span data-testid="cli">cli</span>
      </AgentStatusSlot>
    );

    expect(visible(el, 'cli')).toBe(true);
  });
});
