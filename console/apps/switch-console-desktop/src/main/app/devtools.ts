import { IS_CANARY, IS_DEV } from '@shared/app-identity';

/**
 * Whether Console's windows offer DevTools. A stable build ships without them:
 * a console there reaches every main-process call the app window can make, one
 * keystroke from anyone talking a user into pasting something. Dev builds and
 * Canary, whose users are there to test it, keep them.
 */
export const DEVTOOLS_ENABLED = IS_DEV || IS_CANARY;
