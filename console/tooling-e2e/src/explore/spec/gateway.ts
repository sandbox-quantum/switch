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
import { always, eventually, now } from '@antithesishq/bombadil';
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
 * What would end the session the explorer is testing. Signing out and back in
 * proves nothing the browser lane does not, and a changed password locks the
 * lane out for the rest of the run.
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
 * `SESSION_ENDING`), so the login page again means the session was lost.
 */
export const staysSignedIn = always(
  now(() => !onLoginPage.current).implies(always(() => !onLoginPage.current))
);

/**
 * No page opens with an error banner: MUI renders each as an `alert` with error
 * severity. A banner after a click is how the gateway refuses what random input
 * asked for (removing a member who owns agents, say), so only a banner that
 * comes with opening a page counts.
 */
export const noErrorBanner = always(
  now(() => openedPage.current).implies(() => errorBanners.current.length === 0)
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

function endsSession(action: ActionTemplate): boolean {
  if (!isAction(action, 'Click')) return false;
  const { textContent, accessibleName } = action.Click.fingerprint;
  return SESSION_ENDING.some((label) => textContent === label || accessibleName === label);
}

/**
 * Bombadil's default exploration, without what ends the session, plus a jump to
 * any page in the rail so a dead end (a dialog with nothing to click, a page
 * scrolled away from its links) does not hold the explorer.
 */
export const exploring = weighted([
  [100, clicks.filter((action) => !endsSession(action))],
  [100, inputs],
  [50, scroll],
  [10, navigation],
  [5, actions(() => ROUTES.filter((route) => route !== path.current).map((route) => goTo(route)))],
]).when(() => !onLoginPage.current);
