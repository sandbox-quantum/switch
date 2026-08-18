import { applyHistoryEntry } from '@renderer/lib/components/nav-buttons';
import { events } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { appCommandNavigateChannel } from '@shared/events/appEvents';

/**
 * `MouseEvent.button` for the two side buttons most mice carry. Chromium
 * reports them like any other button; it is only in a browser that they also
 * move through history on their own.
 */
const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;

function goBack(): void {
  appState.history.back(applyHistoryEntry);
}

function goForward(): void {
  appState.history.forward(applyHistoryEntry);
}

/**
 * Make the mouse's back and forward buttons drive the app's own history.
 *
 * Switch Console is one page that never changes URL, so there is no browser
 * history behind these buttons and Chromium's default handling has nothing to
 * do — the buttons appear broken rather than absent. The app keeps its own
 * navigation stack (the same one the arrows in the titlebar and the keyboard
 * shortcuts use), so this points them at that.
 *
 * Two paths, because the platforms deliver these buttons differently: macOS and
 * Linux hand them to the page as ordinary mouse events, while Windows routes
 * them past the page as an `app-command` the main process has to forward.
 *
 * Returns a teardown for symmetry with the app's other wiring; nothing calls it
 * today because this lives as long as the window does.
 */
export function wireMouseNavigation(): () => void {
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== BACK_BUTTON && event.button !== FORWARD_BUTTON) return;
    // A side button means navigate and nothing else. Left unclaimed it can
    // still reach a control underneath as an `auxclick`.
    event.preventDefault();
    if (event.button === BACK_BUTTON) goBack();
    else goForward();
  };

  // Claim the press too: some elements act on `mousedown`, and swallowing only
  // the release would let them fire while the navigation happens under them.
  const swallow = (event: MouseEvent) => {
    if (event.button === BACK_BUTTON || event.button === FORWARD_BUTTON) event.preventDefault();
  };

  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousedown', swallow);
  window.addEventListener('auxclick', swallow);

  const offAppCommand = events.on(appCommandNavigateChannel, ({ direction }) => {
    if (direction === 'back') goBack();
    else goForward();
  });

  return () => {
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousedown', swallow);
    window.removeEventListener('auxclick', swallow);
    offAppCommand();
  };
}
