/**
 * Guest preload for the embedded Mattermost channel view (CHOO-1674).
 *
 * Runs inside the `<webview>` before any page script. Two jobs, both of which
 * have to happen before first paint:
 *
 *  1. Suppress the "Where would you like to view this?" desktop-vs-browser
 *     interstitial. Mattermost records that choice in localStorage; writing it
 *     up front means the channel loads directly instead of behind a gate the
 *     user would have to dismiss on every navigation.
 *
 *  2. Hide the global header and sidebars, so the pane shows the channel and
 *     nothing else. We inject CSS rather than using Mattermost's `/_popout/`
 *     route because that route requires the desktop app's `window.opener`
 *     token handshake, which an embedded webview cannot supply (verified in
 *     Phase 0 — under an Electron UA the popout bounces to a login page).
 *
 * The sidebars are hidden, not unmounted, so they keep their global keyboard
 * shortcuts. Those would silently navigate a sidebar the user cannot see, so
 * we swallow them.
 */

// Mattermost's landing page records the user's choice under this key and skips
// the interstitial when it is already set.
const LANDING_PAGE_SEEN_KEY = '__landingPageSeen__';

const CHROMELESS_CSS = `
  #global-header,
  .team-sidebar,
  #SidebarContainer,
  .app-bar,
  .announcement-bar,
  .global-classification-banner,
  .sidebar--right--width-holder {
    display: none !important;
  }

  /* The centre column is a named grid track with a min width, and
     .main-wrapper's margin is gated on :has(.team-sidebar) — which still
     matches while the sidebar is merely hidden. Zero it so the channel fills
     the pane instead of sitting behind a phantom gutter. */
  .main-wrapper {
    margin-left: 0 !important;
    border-left: none !important;
  }

  #channel_view {
    min-width: 0 !important;
  }
`;

function suppressLandingInterstitial(): void {
  try {
    window.localStorage.setItem(LANDING_PAGE_SEEN_KEY, 'true');
  } catch {
    // Storage can be unavailable before the origin is committed; the
    // interstitial is a nuisance, not a failure, so carry on either way.
  }
}

function injectChromelessCss(): void {
  const style = document.createElement('style');
  style.setAttribute('data-switchdash', 'chromeless');
  style.textContent = CHROMELESS_CSS;
  // documentElement exists at document-start even though body does not.
  document.documentElement.appendChild(style);
}

/**
 * Mattermost binds these to window at the document level. With the sidebars
 * hidden they would move the user somewhere invisible, so stop them before
 * Mattermost's own listeners see them.
 */
function swallowHiddenSidebarShortcuts(): void {
  window.addEventListener(
    'keydown',
    (event) => {
      const mod = event.ctrlKey || event.metaKey;
      const navigatesHiddenSidebar =
        (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) ||
        (mod && event.shiftKey && ['K', 'k', 'A', 'a'].includes(event.key));
      if (navigatesHiddenSidebar) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    { capture: true }
  );
}

suppressLandingInterstitial();
injectChromelessCss();
swallowHiddenSidebarShortcuts();
