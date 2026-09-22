import { describe, expect, it } from 'vitest';
import { shellShape } from './shell-shape';

/**
 * The window has two shapes and the server list picks between them. Both wrong
 * answers are bad in a way a layout bug is not: onboarding shown to someone who
 * has servers hides their install behind a first-run page, and the workspace
 * shown on a fresh install is a sidebar listing nothing.
 */

/**
 * A loaded, empty, undisturbed install — the fresh-install case. Each test
 * below names only what it changes about it.
 */
function shape(differences: Partial<Parameters<typeof shellShape>[0]>) {
  return shellShape({
    loaded: true,
    listError: null,
    serverCount: 0,
    viewWorksWithoutServer: false,
    onboardingInProgress: false,
    ...differences,
  });
}

describe('what fills the window', () => {
  it('waits rather than guessing before the list has been read', () => {
    // The trap: an install with five servers looks exactly like a fresh one
    // until the read comes back, because both have an empty list.
    expect(shape({ loaded: false })).toBe('loading');
  });

  it('onboards only once the list is known to be empty', () => {
    expect(shape({})).toBe('onboarding');
  });

  it('shows the workspace as soon as there is a server to show', () => {
    expect(shape({ serverCount: 1 })).toBe('workspace');
  });

  it('lets a view that needs no server out of the onboarding page', () => {
    // Settings and the remote hosts are views, so only the workspace can draw
    // them, and the onboarding page carries no chrome of its own. Holding the
    // window on it would leave ⌘, and the Preferences menu item doing nothing.
    expect(shape({ viewWorksWithoutServer: true })).toBe('workspace');
  });

  it('stays on the first-run pages once the flow has added the server', () => {
    // The flow adds the server pages before it is done with it — signing in and
    // linking accounts both come after. Going by the count alone would throw
    // the user out of the flow at the moment it half-succeeded.
    expect(shape({ serverCount: 1, onboardingInProgress: true })).toBe('onboarding');
  });

  it('still lets such a view out of a flow in progress', () => {
    expect(shape({ onboardingInProgress: true, viewWorksWithoutServer: true })).toBe('workspace');
  });

  it('says a first read failed instead of staying blank', () => {
    // Otherwise the failure is indistinguishable from the blank first frame and
    // the window just never fills.
    expect(shape({ loaded: false, listError: 'Could not load' })).toBe('failed');
  });

  it('keeps the workspace when a later read fails', () => {
    // The list in hand is still the list; a failed refresh is not a reason to
    // take the app away from someone using it.
    expect(shape({ listError: 'Could not load', serverCount: 2 })).toBe('workspace');
  });
});
