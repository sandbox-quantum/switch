import { IS_CANARY } from '@shared/app-identity';

/**
 * Whether this build shows tools meant for the people building Switch: a run
 * from a checkout, or a canary. Never a stable release.
 */
export function showDevTools(): boolean {
  return import.meta.env.DEV || IS_CANARY;
}
