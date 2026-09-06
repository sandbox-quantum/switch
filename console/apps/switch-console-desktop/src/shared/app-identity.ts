type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';

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
export const APP_ID = isCanary ? 'com.switchdash.canary' : 'com.switchdash.stable';
export const PRODUCT_NAME = isCanary ? 'Switch Console Canary' : 'Switch Console';
export const OS_APP_NAME = isCanary ? 'Switchdash Canary' : 'Switchdash';
export const APP_NAME_LOWER = isCanary ? 'switch-console-canary' : 'switch-console';
export const USER_DATA_DIR_NAME = isDev
  ? 'switchdash-dev'
  : isCanary
    ? 'switchdash-canary'
    : 'switchdash';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'switch-console-canary' : 'switch-console';
export const IS_CANARY = isCanary;

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
// The check is what makes the literal safe; it is also mirrored in
// app-identity.canary.ts, which is checked the same way.
//
// Deliberately NOT switch-core's own version from that file: bumping
// core/pyproject.toml is the first step of cutting a switch-core release, and a
// derived pin would immediately point local-server mode at images that are not
// on the registry yet.
export const COMPATIBLE_SWITCH_VERSION = '0.24.0';

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
