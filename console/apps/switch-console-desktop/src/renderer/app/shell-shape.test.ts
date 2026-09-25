import { describe, expect, it } from 'vitest';
import { shellShape } from './shell-shape';

/**
 * The window has two shapes and what the install holds picks between them. Both
 * wrong answers are bad in a way a layout bug is not: onboarding shown to
 * someone who has an install hides it behind a first-run page, and the
 * workspace shown on a fresh install is a sidebar listing nothing.
 */

/**
 * A loaded, empty, undisturbed install — the fresh-install case. Each test
 * below names only what it changes about it.
 */
function shape(differences: Partial<Parameters<typeof shellShape>[0]>) {
  return shellShape({
    loaded: true,
    listError: null,
    installIsEmpty: true,
    viewWorksWithoutServer: false,
    ...differences,
  });
}

describe('what fills the window', () => {
  it('waits rather than guessing before anything has been read', () => {
    // The trap: an install with five servers looks exactly like a fresh one
    // until the read comes back, because neither has answered yet.
    expect(shape({ loaded: false, installIsEmpty: false })).toBe('loading');
  });

  it('onboards only once the install is known to be empty', () => {
    expect(shape({})).toBe('onboarding');
  });

  /**
   * "Something to show" is not "a server". Removing one says in as many words
   * that its agents are kept and can be re-linked elsewhere, so an install left
   * with agents and no server still has a window's worth of content — and the
   * sessions in those agents are still running behind it.
   */
  it('shows the workspace as soon as there is anything to show', () => {
    expect(shape({ installIsEmpty: false })).toBe('workspace');
  });

  it('lets a view that needs no server out of the onboarding page', () => {
    // Settings and the remote hosts are views, so only the workspace can draw
    // them, and the onboarding page carries no chrome of its own. Holding the
    // window on it would leave ⌘, and the Preferences menu item doing nothing.
    expect(shape({ viewWorksWithoutServer: true })).toBe('workspace');
  });

  /**
   * Settings is where the logs and the database are, so a failed first read is
   * precisely when it has to be reachable — and it needs nothing from the read
   * to draw. Ordering this after the load gate would leave ⌘, and Preferences
   * doing nothing in the one state that calls for them.
   */
  it('draws such a view even when nothing could be read', () => {
    expect(shape({ loaded: false, viewWorksWithoutServer: true })).toBe('workspace');
    expect(
      shape({ loaded: false, listError: 'Could not load', viewWorksWithoutServer: true })
    ).toBe('workspace');
  });

  it('says a first read failed instead of staying blank', () => {
    // Otherwise the failure is indistinguishable from the blank first frame and
    // the window just never fills.
    expect(shape({ loaded: false, listError: 'Could not load' })).toBe('failed');
  });

  it('keeps the workspace when a later read fails', () => {
    // The list in hand is still the list; a failed refresh is not a reason to
    // take the app away from someone using it.
    expect(shape({ listError: 'Could not load', installIsEmpty: false })).toBe('workspace');
  });
});
