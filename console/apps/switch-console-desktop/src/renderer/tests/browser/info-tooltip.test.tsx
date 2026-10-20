import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';

describe('InfoTooltip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows its explanation when the button is clicked', async () => {
    await act(async () => {
      root.render(<InfoTooltip label="More info about auto mode" content="Explained here." />);
    });
    const button = container.querySelector<HTMLElement>('[aria-label="More info about auto mode"]');
    expect(button).not.toBeNull();
    expect(button!.querySelector('button')).toBeNull();
    expect(document.body.textContent).not.toContain('Explained here.');

    await act(async () => button!.click());

    expect(document.body.textContent).toContain('Explained here.');
  });
});
