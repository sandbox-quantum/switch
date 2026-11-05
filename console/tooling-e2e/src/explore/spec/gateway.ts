/**
 * The explore lane's Bombadil specification: what every gateway page must keep
 * to, and what the explorer may do, while it drives the UI at random.
 *
 * This runs inside Bombadil, not Node: it may import only Bombadil's own
 * modules and JSON. Every property and action generator exported here is used,
 * so nothing else may be exported.
 *
 * The properties port the browser lane's rules for a page that renders but is
 * broken (`src/browser/gateway-ui.ts`), checked in every state the explorer
 * reaches instead of on a scripted path. A 4xx is not one of them: random input
 * is meant to be refused.
 */
import { always, eventually, next, now } from '@antithesishq/bombadil';
import { isAction } from '@antithesishq/bombadil/actions';
import {
  actions,
  extract,
  registerCustomAction,
  weighted,
  type ActionTemplate,
} from '@antithesishq/bombadil/browser';
import {
  clicks,
  inputs,
  navigation,
  scroll,
} from '@antithesishq/bombadil/browser/defaults/actions';
// The admin's credentials, written by the lane beside a copy of this file for
// the run; the copy in the repository is an empty placeholder.
import credentials from './credentials.json';

export {
  noConsoleErrors,
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
} from '@antithesishq/bombadil/browser/defaults/properties';

/** The pages in the navigation rail, and the form for a new room. */
const ROUTES = [
  '/rooms',
  '/rooms/new',
  '/agents',
  '/resources',
  '/collaborations',
  '/registration-keys',
  '/workspace',
  '/usage',
  '/ecosystem',
];

/**
 * Signing out ends the session the explorer is testing, and signing back in
 * proves nothing the browser lane does not. Change password is the entry next
 * to it, and the menu shifts while it settles, so a click aimed there can land
 * on Sign out: the explorer clicks neither.
 */
const SESSION_ENDING = ['Sign out', 'Change password'];

const path = extract((state) => state.window.location.pathname);

/**
 * Whether the login form is shown. Not the path: going back to `/login` while
 * signed in shows that path for a moment, until the app redirects to `/`.
 */
const onLoginPage = extract(
  (state) =>
    state.document.querySelector('form input[type="password"]') !== null &&
    state.document.querySelector('nav[aria-label="Main"]') === null
);

/** Whether the app's navigation rail is shown: only to someone signed in. */
const signedIn = extract(
  (state) => state.document.querySelector('nav[aria-label="Main"]') !== null
);

/**
 * Whether the last action opened a page: a link, back, forward, reload or a
 * jump, but not back or forward to a page restored as it was left. No action
 * at all is the first state, the page the run starts on. Read loosely because
 * Bombadil hands the action over in its trace shape (snake case, empty fields
 * left out), not the one its types declare; the tag is lowercase there, as
 * `getFingerprint` writes it.
 */
const openedPage = extract((state) => {
  // A listener installed with the first read of each page load marks a
  // restore from the back/forward cache, and every read takes the mark, so it
  // holds in the one state the restore landed in.
  const page = state.window as Window & { switchExploreRestored?: boolean };
  if (page.switchExploreRestored === undefined) {
    page.addEventListener('pageshow', (event) => {
      if (event.persisted) page.switchExploreRestored = true;
    });
  }
  const restored = page.switchExploreRestored === true;
  page.switchExploreRestored = false;
  const action = state.lastAction as unknown;
  if (action === 'Back' || action === 'Forward') return !restored;
  if (action === null || typeof action === 'string') return action !== 'Wait';
  const { Click, Custom } = action as {
    Click?: { fingerprint: { tag: string; href?: string } };
    Custom?: { name: string };
  };
  if (Click !== undefined) {
    return Click.fingerprint.tag === 'a' && Click.fingerprint.href !== undefined;
  }
  return Custom !== undefined && (Custom.name === 'goTo' || Custom.name === 'signIn');
});

/**
 * Whether the account menu, which holds Sign out, is open. Bombadil clicks a
 * point, and picks it from elements the open menu can cover: a click meant for
 * the page beneath can land on a menu item instead.
 */
const accountMenuOpen = extract((state) =>
  Array.from(state.document.querySelectorAll('[role="menu"] [role="menuitem"]')).some(
    (item) => (item.textContent ?? '').trim() === 'Sign out' && item.getClientRects().length > 0
  )
);

/**
 * Whether the account menu opened with the last action. It grows into place,
 * and a click while it does lands on whichever entry has moved under the
 * point: Sign out, below the one aimed at.
 */
const accountMenuOpening = extract((state) => {
  const action = state.lastAction as {
    Click?: { fingerprint: { accessible_name?: string } };
  } | null;
  return action?.Click?.fingerprint.accessible_name === 'Account menu';
});

const errorBanners = extract((state) =>
  Array.from(state.document.querySelectorAll('[role="alert"].MuiAlert-colorError'))
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => (element.textContent ?? '').trim().slice(0, 200))
);

/**
 * Every `/gateway/` response since the page last loaded that the server
 * failed, collected by an observer installed with the first read of each page
 * load. An observer sees every entry, where the resource timing buffer stops
 * recording once full; `buffered` hands it what loaded before it was installed.
 */
const serverErrors = extract((state) => {
  const page = state.window as Window & { switchExploreServerErrors?: string[] };
  if (page.switchExploreServerErrors === undefined) {
    const failed: string[] = [];
    page.switchExploreServerErrors = failed;
    // The extractor runs in the page, so these globals are the page's own.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!(entry instanceof PerformanceResourceTiming) || entry.responseStatus < 500) {
          continue;
        }
        const path = new URL(entry.name).pathname;
        if (path.startsWith('/gateway/')) failed.push(`${entry.responseStatus} ${path}`);
      }
    }).observe({ type: 'resource', buffered: true });
  }
  return [...page.switchExploreServerErrors];
});

/** The explorer signs in from the login page it starts on. */
export const signsIn = eventually(() => signedIn.current).within(30, 'seconds');

/**
 * Once signed in, the explorer stays signed in. It cannot sign out (see
 * `SESSION_ENDING`), so the login page again means the session was lost.
 */
export const staysSignedIn = always(
  now(() => signedIn.current).implies(always(() => !onLoginPage.current))
);

const noBanner = () => errorBanners.current.length === 0;

/**
 * No page opens with an error banner: MUI renders each as an `alert` with error
 * severity. A banner after a click is how the gateway refuses what random input
 * asked for (removing a member who owns agents, say), and one stays up until
 * dismissed, so only a banner that appears as a page opens counts: in the
 * state the page opened in, or the one after, once the explorer has waited for
 * what the page fetches (see `settling`).
 */
export const noErrorBanner = always(
  now(noBanner).implies(
    next(now(() => openedPage.current).implies(now(noBanner).and(next(noBanner))))
  )
);

/** The server answered no `/gateway` request with a 5xx. */
export const noServerErrors = always(() => serverErrors.current.length === 0);

/**
 * Sign in as the gateway admin, from the login page.
 *
 * Over `fetch` rather than the form, and with no arguments, because an action's
 * arguments are written to the trace the lane uploads: typed into the form, the
 * password would be too.
 */
const signIn = registerCustomAction('signIn', async (_document, window) => {
  if (credentials.email === '' || credentials.password === '') {
    throw new Error(
      'credentials.json is the empty placeholder: run this spec through the explore lane.'
    );
  }
  const response = await window.fetch('/gateway/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`Signing in answered ${response.status}.`);
  // Replacing the login page in history, so going back does not restore it.
  window.location.replace('/rooms');
});

const goTo = registerCustomAction('goTo', async (_document, window, route: string) => {
  window.location.assign(route);
});

export const signingIn = actions(() => [signIn()]).when(() => onLoginPage.current);

/**
 * Whether a click is safe: never on `SESSION_ENDING`, and while the account menu is open
 * only on the menu's own entries, so a click cannot land on Sign out by
 * accident.
 */
function safeClick(action: ActionTemplate): boolean {
  if (!isAction(action, 'Click')) return true;
  const { textContent, accessibleName, role } = action.Click.fingerprint;
  if (SESSION_ENDING.some((label) => textContent === label || accessibleName === label)) {
    return false;
  }
  return !accountMenuOpen.current || role === 'menuitem' || role === 'radio';
}

const jumps = actions(() =>
  ROUTES.filter((route) => route !== path.current).map((route) => goTo(route))
);

/**
 * Whether the explorer should wait a step before acting: a page has just opened
 * and may still be fetching what it shows (`noErrorBanner` looks at the state
 * after the wait), or the account menu is still growing into place.
 */
const unsettled = () => openedPage.current || accountMenuOpening.current;

export const settling = actions(() => ['Wait']).when(() => signedIn.current && unsettled());

/**
 * Bombadil's default exploration, without signing out, plus a jump to any page
 * in the rail so a dead end (a dialog with nothing to click, a page scrolled
 * away from its links) does not hold the explorer.
 */
export const exploring = weighted([
  [100, clicks.filter(safeClick)],
  [100, inputs],
  [50, scroll],
  [10, navigation],
  [5, jumps],
]).when(() => signedIn.current && !unsettled());

/**
 * Neither signed in nor on the login form: the app is loading its session, or
 * shows a screen without the rail (a workspace picker, onboarding). Wait it
 * out, or leave.
 */
export const waiting = weighted([
  [10, actions(() => ['Wait'])],
  [1, navigation],
  [1, jumps],
]).when(() => !signedIn.current && !onLoginPage.current);
