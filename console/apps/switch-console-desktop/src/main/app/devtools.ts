import { IS_DEV } from '@shared/app-identity';

/**
 * Whether Console's windows offer DevTools: only in development. A packaged
 * build ships without them, Canary included: a console there reaches every
 * main-process call the app window can make, one keystroke from anyone
 * talking a user into pasting something, and Canary shares stable's database
 * and keychain key, so it holds the same sign-ins.
 */
export const DEVTOOLS_ENABLED = IS_DEV;
