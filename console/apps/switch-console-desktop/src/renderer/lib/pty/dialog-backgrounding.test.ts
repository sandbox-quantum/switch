// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isBackgroundedByDialog } from './dialog-backgrounding';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement | null {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>('#term');
}

describe('isBackgroundedByDialog', () => {
  it('does not background a terminal when no dialog is open', () => {
    expect(isBackgroundedByDialog(mount('<div id="term"></div>'))).toBe(false);
  });

  it('backgrounds a terminal that sits behind a dialog', () => {
    const term = mount('<div id="term"></div><div role="dialog"></div>');
    expect(isBackgroundedByDialog(term)).toBe(true);
  });

  // The regression: a terminal rendered by the dialog is what the user is
  // typing into. Refusing its keys left `gh auth` waiting on an Enter that
  // could never arrive.
  it('does not background a terminal rendered inside the dialog', () => {
    const term = mount('<div role="dialog"><div id="term"></div></div>');
    expect(isBackgroundedByDialog(term)).toBe(false);
  });

  it('does not background a deeply nested terminal inside the dialog', () => {
    const term = mount('<div role="dialog"><section><p><div id="term"></div></p></section></div>');
    expect(isBackgroundedByDialog(term)).toBe(false);
  });

  it('checks every open dialog, not just the first', () => {
    const term = mount('<div role="dialog"></div><div role="dialog"><div id="term"></div></div>');
    expect(isBackgroundedByDialog(term)).toBe(false);
  });

  // Without an element there is nothing to compare against; staying blocked
  // preserves the old behaviour rather than letting keys through on a guess.
  it('backgrounds an unmounted terminal while a dialog is open', () => {
    mount('<div role="dialog"></div>');
    expect(isBackgroundedByDialog(null)).toBe(true);
  });
});
