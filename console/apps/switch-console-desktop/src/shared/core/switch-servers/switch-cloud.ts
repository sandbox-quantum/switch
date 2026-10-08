import type { SwitchServer } from './switch-servers';

/** The name a Switch Cloud connection is registered under. */
export const SWITCH_CLOUD_NAME = 'Switch Cloud';

/**
 * Where Switch Cloud is, as far as this build or run has been told.
 *
 * One URL, not the gateway/API pair an arbitrary server is registered with: a
 * hosted deployment serves the management API under `/gateway` and the agent
 * API at the root of the same origin, so both are that origin.
 */
export type SwitchCloudEndpoint = {
  url: string;
};

/**
 * The server an invite link points at: one this install can already sign in
 * to, and how it was reached — or one it has never heard of, named by the web
 * address the link carries and nothing more.
 */
export type InviteServer =
  | { kind: 'known'; server: SwitchServer; via: 'external' | 'cloud' }
  | { kind: 'unknown'; origin: string };
