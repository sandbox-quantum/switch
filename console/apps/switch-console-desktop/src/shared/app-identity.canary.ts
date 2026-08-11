// Inlined rather than re-exported from ./app-identity so this module has no relative
// imports. It is loaded under Node (--experimental-strip-types) by
// electron-builder.canary.config.ts, where extensionless ESM specifiers do not resolve.
// The app id stays on `switchdash` (macOS registration and update continuity);
// the display, binary and artifact names moved — see the note in ./app-identity.ts.
export const APP_ID = 'com.switchdash.canary';
export const PRODUCT_NAME = 'Switch Console Canary';
export const APP_NAME_LOWER = 'switch-console-canary';
export const UPDATE_CHANNEL = 'v1-canary';
export const ARTIFACT_PREFIX = 'switch-console-canary';

// Keep in sync with RELEASE_REPO_* in ./app-identity.ts.
export const RELEASE_REPO_OWNER = 'sandbox-quantum';
export const RELEASE_REPO_NAME = 'switch';

// Mirrors COMPATIBLE_SWITCH_VERSION in ./app-identity.ts. Both are checked
// against `switch-console.pins.switch-core` in artifacts.yaml by `just artifacts`,
// so they can no longer drift apart — this used to say "keep in sync" and rely
// on whoever edited one remembering the other (CHOO-1865).
export const COMPATIBLE_SWITCH_VERSION = '0.13.1';
