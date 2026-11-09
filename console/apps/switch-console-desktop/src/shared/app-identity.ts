type ImportMetaWithEnv = ImportMeta & {
  env?: { DEV?: boolean; VITE_BUILD?: string; VITE_RELEASE?: string; VITE_BUILD_LABEL?: string };
};

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';
// Stamped by the release workflow on a tagged build, and only there: a
// workflow_dispatch test build, or one packaged on a laptop, is not a release
// however it is otherwise configured.
const isRelease = env?.VITE_RELEASE === '1';

// What a user reads, what the app calls itself to the OS, and where data lives
// are three different names here, and only the first one moved.
//
// USER_DATA_DIR_NAME holds the database, so it stays `switchdash` forever:
// renaming it starts an existing install from an empty database. APP_ID stays
// with it — it is what macOS registration and update continuity key off, and
// nobody reads it.
//
// OS_APP_NAME is frozen for the same reason and is the least obvious of the
// three. `safeStorage` encrypts against a key the OS files under the name the
// app announces at startup (measured on macOS: neither bundle key is consulted,
// only `app.setName`), and that name is bound the first time the app touches
// the keychain, never re-read. Moving it hands a renamed build an empty key
// while the old ciphertext stays in the shared database — every saved sign-in
// and the local server's own credentials become unreadable, with no way back.
//
// PRODUCT_NAME, APP_NAME_LOWER and ARTIFACT_PREFIX did move (CHOO-2008). The
// cost is paid once, at the release that changes them: Linux package managers
// see `switch-console` as a new package rather than an upgrade of
// `switchdash`, so the old one has to be removed by hand.
//
// Canary is a separate install (its own APP_ID and PRODUCT_NAME) that shares
// stable's data on purpose: same database, same agents, same keychain key, same
// managed local server. That is why OS_APP_NAME and USER_DATA_DIR_NAME do not
// branch on the channel — giving canary its own would start it empty and leave
// it unable to decrypt the sign-ins stable saved.
export const APP_ID = isCanary ? 'com.switchdash.canary' : 'com.switchdash.stable';
export const PRODUCT_NAME = isCanary ? 'Switch Console Canary' : 'Switch Console';
export const OS_APP_NAME = 'Switchdash';
export const APP_NAME_LOWER = isCanary ? 'switch-console-canary' : 'switch-console';
// Named on its own for code outside the Vite build (drizzle-kit), where isDev is
// always false and USER_DATA_DIR_NAME is `switchdash`, the installed app's.
export const DEV_USER_DATA_DIR_NAME = 'switchdash-dev';
export const USER_DATA_DIR_NAME = isDev ? DEV_USER_DATA_DIR_NAME : 'switchdash';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'switch-console-canary' : 'switch-console';
export const IS_CANARY = isCanary;
export const IS_DEV = isDev;
export const IS_RELEASE_BUILD = isRelease;

// A test build's label, for example "Hosted Agents v2 · 0.0.6", set at build
// time with VITE_BUILD_LABEL and empty otherwise, so a normal build is
// unchanged. It is shown only: the window title, the About box and the
// download file name. It never touches APP_ID, PRODUCT_NAME, OS_APP_NAME or
// USER_DATA_DIR_NAME above, so a labelled build keeps its sign-ins and data.
// Read from the Vite build's env, or from the process env when electron-builder
// loads this file under bare Node (where import.meta.env is absent).
const processEnvLabel = typeof process === 'undefined' ? undefined : process.env?.VITE_BUILD_LABEL;

/** A label kept to plain characters and a sane length; anything else gives no label at all. */
export function cleanBuildLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const label = raw.trim();
  return label.length <= 40 && /^[A-Za-z0-9 .·()_-]*$/.test(label) ? label : '';
}

/** The label as it appears in a file name: "Hosted Agents v2 · 0.0.6" gives "hosted-agents-v2-0.0.6". */
export function buildLabelSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const BUILD_LABEL = cleanBuildLabel(env?.VITE_BUILD_LABEL ?? processEnvLabel);
/** The window title: "Switch Console — Hosted Agents v2 · 0.0.6", or just the product name. */
export const WINDOW_TITLE = BUILD_LABEL ? `${PRODUCT_NAME} — ${BUILD_LABEL}` : PRODUCT_NAME;
/** The start of the download's file name, before the architecture. */
export const ARTIFACT_NAME_PREFIX = BUILD_LABEL
  ? `${ARTIFACT_PREFIX}-${buildLabelSlug(BUILD_LABEL)}`
  : ARTIFACT_PREFIX;

// GitHub repo the desktop app publishes releases to / reads auto-updates from.
// The repo is public, so the feed is read unauthenticated. Mirrored in
// app-identity.canary.ts (keep in sync).
export const RELEASE_REPO_OWNER = 'sandbox-quantum';
export const RELEASE_REPO_NAME = 'switch';

// The switch-core release this app build is compatible with. Local-server mode
// pulls this version's images and bundles this version's standalone compose
// artifact. Bump it in lockstep with the bundled compose
// (src/main/core/managed-switch-server/resources/standalone-docker-compose.pinned.yml)
// so a Switch Console release pins a known-good switch-core stack.
//
// Declared in artifacts.yaml under `switch-console.pins.switch-core`, and CHECKED
// against it by `just artifacts` (CHOO-1865). A literal rather than an import
// because electron-builder loads this module under bare Node, where
// extensionless ESM specifiers do not resolve — so it cannot import anything.
// The check is what makes the literal safe; the canary pin is also mirrored in
// app-identity.canary.ts, which is checked the same way.
//
// Deliberately NOT switch-core's own version from that file: bumping
// core/pyproject.toml is the first step of cutting a switch-core release, and a
// derived pin would immediately point local-server mode at images that are not
// on the registry yet.
//
// Two pins: a canary build can run a switch-core pre-release while stable
// stays on the last release. `switch-console.pins.switch-core` and
// `switch-console.canary_pins.switch-core` respectively, each checked.
//
// A dev build takes the canary pin: it runs canary's features (the new first
// run among them, which starts the server with feature flags a stable release
// may not know yet), so it needs the server canary runs.
export const STABLE_SWITCH_VERSION = '0.31.0';
export const CANARY_SWITCH_VERSION = '0.31.0';
export const COMPATIBLE_SWITCH_VERSION =
  isCanary || isDev ? CANARY_SWITCH_VERSION : STABLE_SWITCH_VERSION;

// The last switch-core release that can still read a Matrix homeserver.
//
// Room history written before Switch moved to the Postgres message store lives
// only on the homeserver, and only an image up to this version can copy it
// across — the release after it removes the transport, the backfill command
// and Tuwunel itself. Crossing this line without having run the backfill
// strands that history where nothing will ever read it again, so the upgrade
// runs the backfill first and refuses to cross if it fails.
//
// A stack already on a version above this has nothing to migrate.
//
// It must name a release that EXISTS and that CONTAINS the backfill command —
// `switch_core.cli.backfill`, which only entered the image when the command
// moved into the package. 0.23.0 is published and predates that, so it is not
// a valid value here however natural it looks: pointing at it would make every
// crossing fail with ModuleNotFoundError, and the crossing is mandatory.
export const LAST_MATRIX_VERSION = '0.24.1';
