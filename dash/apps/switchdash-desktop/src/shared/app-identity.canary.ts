// Inlined rather than re-exported from ./app-identity so this module has no relative
// imports. It is loaded under Node (--experimental-strip-types) by
// electron-builder.canary.config.ts, where extensionless ESM specifiers do not resolve.
export const APP_ID = 'com.switchdash.canary';
export const PRODUCT_NAME = 'Switchdash Canary';
export const APP_NAME_LOWER = 'switchdash-canary';
export const UPDATE_CHANNEL = 'v1-canary';
export const ARTIFACT_PREFIX = 'switchdash-canary';

// Keep in sync with RELEASE_REPO_* in ./app-identity.ts (CHOO-1260 flip point).
export const RELEASE_REPO_OWNER = 'sandbox-quantum';
export const RELEASE_REPO_NAME = 'switch';

// Keep in sync with COMPATIBLE_SWITCH_VERSION in ./app-identity.ts.
export const COMPATIBLE_SWITCH_VERSION = '0.3.0';
