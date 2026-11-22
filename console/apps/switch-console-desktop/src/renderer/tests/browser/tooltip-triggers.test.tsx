import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResetToDefaultButton } from '@renderer/features/settings/components/ResetToDefaultButton';
import { NavButtons } from '@renderer/lib/components/nav-buttons';

// A tooltip's trigger is a button of its own, so a button handed to it as a
// child is a button inside a button, named by nothing. Given as the trigger's
// `render`, the button is the trigger, with its own label.
describe('buttons with a tooltip', () => {
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

  it('are one labelled button each, never one inside another', async () => {
    await act(async () => {
      root.render(
        <>
          <NavButtons />
          <ResetToDefaultButton onReset={() => {}} />
        </>
      );
    });
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Go back',
      'Go forward',
      'Reset to default',
    ]);
    expect(container.querySelector('button button')).toBeNull();
  });
});
