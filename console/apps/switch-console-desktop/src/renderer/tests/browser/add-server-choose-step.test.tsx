/**
 * The add-server chooser's Switch Cloud choice: listed last as coming soon,
 * and not choosable, even in a build that knows where the Cloud is.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connectToSwitchCloud = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/features/switch-servers/use-switch-cloud', () => ({
  useSwitchCloud: () => ({ kind: 'open', url: 'https://cloud.example.invalid' }),
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    servers: [],
    connectToSwitchCloud,
  },
}));

import { ChooseStep } from '@renderer/features/switch-servers/AddServerModal';
import { WizardChromeProvider } from '@renderer/lib/ui/wizard-frame';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = () => {};
  await act(async () =>
    root!.render(
      // Drawn as a page, the way first run draws it, so it needs no dialog.
      <WizardChromeProvider chrome="page" exit={null}>
        <ChooseStep onLocal={noop} onRemoteHost={noop} onExternal={noop} onClose={noop} />
      </WizardChromeProvider>
    )
  );
  return container;
}

/** The chooser's cards, in the order they are drawn: every button but Cancel. */
function cards(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.textContent?.trim() !== 'Cancel'
  );
}

describe('the Switch Cloud choice', () => {
  it('is listed last, as coming soon and disabled', async () => {
    const el = await render();

    const all = cards(el);
    expect(all.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Run a server on this computer'),
      expect.stringContaining('Run or join a server on a remote host'),
      expect.stringContaining('Connect to an existing server'),
      expect.stringContaining('Switch Cloud'),
    ]);
    const cloud = all.at(-1)!;
    expect(cloud.textContent).toContain('Coming soon');
    expect(cloud.disabled).toBe(true);
    expect(cloud.getAttribute('aria-disabled')).toBe('true');
  });

  it('cannot be clicked or focused, and never connects', async () => {
    const el = await render();
    const cloud = cards(el).at(-1)!;

    await act(async () => cloud.click());
    cloud.focus();

    expect(document.activeElement).not.toBe(cloud);
    expect(connectToSwitchCloud).not.toHaveBeenCalled();
  });

  it('leaves the other choices choosable', async () => {
    const el = await render();
    for (const card of cards(el).slice(0, -1)) expect(card.disabled).toBe(false);
  });
});
