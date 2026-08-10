type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';

export const APP_ID = isCanary ? 'com.switchdash.canary' : 'com.switchdash.stable';
export const PRODUCT_NAME = isCanary ? 'Switchdash Canary' : 'Switchdash';
export const APP_NAME_LOWER = isCanary ? 'switchdash-canary' : 'switchdash';
export const USER_DATA_DIR_NAME = isDev
  ? 'switchdash-dev'
  : isCanary
    ? 'switchdash-canary'
    : 'switchdash';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'switchdash-canary' : 'switchdash';
export const IS_CANARY = isCanary;

// GitHub repo the desktop app publishes releases to / reads auto-updates from.
// CHOO-1260 config-flip point — see RELEASING.md. Mirrored in
// app-identity.canary.ts (keep in sync).
export const RELEASE_REPO_OWNER = 'sandbox-quantum';
export const RELEASE_REPO_NAME = 'switch';

// The switch-core release this app build is compatible with. Local-server mode
// pulls this version's images and bundles this version's standalone compose
// artifact. Bump it in lockstep with the bundled compose
// (src/main/core/managed-switch-server/resources/standalone-docker-compose.pinned.yml)
// so a switchdash release pins a known-good switch-core stack.
//
// Declared in artifacts.yaml under `switchdash.pins.switch-core`, and CHECKED
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
export const COMPATIBLE_SWITCH_VERSION = '0.12.3';
