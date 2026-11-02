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
 * proves nothing the browser lane does not. (Changing the password needs the
 * current one, which random input does not know, so that dialog stays open to
 * it.)
 */
const SIGN_OUT = 'Sign out';

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
 * jump. Read loosely because Bombadil hands the action over in its trace shape
 * (snake case, empty fields left out), not the one its types declare.
 */
const openedPage = extract((state) => {
  const action = state.lastAction as unknown;
  if (action === null || typeof action === 'string') return action !== 'Wait';
  const { Click, Custom } = action as {
    Click?: { fingerprint: { tag: string; href?: string } };
    Custom?: { name: string };
  };
  if (Click !== undefined) return Click.fingerprint.tag === 'a' && Click.fingerprint.href !== undefined;
  return Custom !== undefined && (Custom.name === 'goTo' || Custom.name === 'signIn');
});

/**
 * Whether the account menu, which holds Sign out, is open. Bombadil clicks a
 * point, and picks it from elements the open menu can cover: a click meant for
 * the page beneath can land on a menu item instead.
 */
const accountMenuOpen = extract((state) =>
  Array.from(state.document.querySelectorAll('[role="menu"] [role="menuitem"]')).some(
    (item) => (item.textContent ?? '').trim() === SIGN_OUT && item.getClientRects().length > 0
  )
);

/**
 * Whether the account menu opened with the last action. It grows into place,
 * and a click while it does lands on whichever entry has moved under the
 * point: Sign out, below the one aimed at.
 */
const accountMenuOpening = extract((state) => {
  const action = state.lastAction as { Click?: { fingerprint: { accessible_name?: string } } } | null;
  return action?.Click?.fingerprint.accessible_name === 'Account menu';
});

const errorBanners = extract((state) =>
  Array.from(state.document.querySelectorAll('[role="alert"].MuiAlert-colorError'))
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => (element.textContent ?? '').trim().slice(0, 200))
);

/**
 * Every `/gateway/` response since the page last loaded that the server
 * failed. Resource timing keeps 250 entries by default, fewer than a long
 * session on one page makes, so the buffer is raised before it is read.
 */
const serverErrors = extract((state) => {
  const performance = state.window.performance;
  performance.setResourceTimingBufferSize(10_000);
  return performance
    .getEntriesByType('resource')
    .filter(
      (entry): entry is PerformanceResourceTiming =>
        entry instanceof PerformanceResourceTiming &&
        new URL(entry.name).pathname.startsWith('/gateway/') &&
        entry.responseStatus >= 500
    )
    .map((entry) => `${entry.responseStatus} ${new URL(entry.name).pathname}`);
});

/** The explorer signs in from the login page it starts on. */
export const signsIn = eventually(() => signedIn.current).within(30, 'seconds');

/**
 * Once signed in, the explorer stays signed in. It cannot sign out (see
 * `SIGN_OUT`), so the login page again means the session was lost.
 */
export const staysSignedIn = always(
  now(() => signedIn.current).implies(always(() => !onLoginPage.current))
);

/**
 * No page opens with an error banner: MUI renders each as an `alert` with error
 * severity. A banner after a click is how the gateway refuses what random input
 * asked for (removing a member who owns agents, say), and one stays up until
 * dismissed, so only a banner that appears as a page opens counts.
 */
export const noErrorBanner = always(
  now(() => errorBanners.current.length === 0).implies(
    next(now(() => openedPage.current).implies(() => errorBanners.current.length === 0))
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
 * Whether a click is safe: never Sign out, none while the account menu is still
 * opening, and while it is open only on the menu's own entries, so a click
 * cannot land on Sign out by accident.
 */
function safeClick(action: ActionTemplate): boolean {
  if (!isAction(action, 'Click')) return true;
  if (accountMenuOpening.current) return false;
  const { textContent, accessibleName, role } = action.Click.fingerprint;
  if (textContent === SIGN_OUT || accessibleName === SIGN_OUT) return false;
  return !accountMenuOpen.current || role === 'menuitem' || role === 'radio';
}

const jumps = actions(() =>
  ROUTES.filter((route) => route !== path.current).map((route) => goTo(route))
);

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
  [100, actions(() => (accountMenuOpening.current ? ['Wait'] : []))],
]).when(() => signedIn.current);

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
