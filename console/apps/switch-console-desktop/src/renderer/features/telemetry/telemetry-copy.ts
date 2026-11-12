import { RECENTLY_SEEN_DAYS } from '@shared/core/managed-switch-server/managed-switch-server';
import { TELEMETRY_ID_LIFETIME_DAYS } from '@shared/core/telemetry/identifier';

/**
 * The disclosure shown to the user, in one place so the first-run notice and
 * the Settings row cannot drift into promising different things.
 *
 * This is a promise, and what is sent is held to it by the payload rule in
 * `console/AGENTS.md` and by the closed event catalogue in
 * `src/main/core/telemetry/events.ts`. Widening what is sent is a consent
 * decision, not a copy edit.
 *
 * The detail lives in `docs/TELEMETRY.md`, behind the link, rather than in the
 * dialog: anyone who wants the specifics wants all of them — every event, every
 * field — which no dialog can hold, and a wall of bullet points in front of the
 * toggle gets skimmed rather than read.
 *
 * It does not say "anonymous": every event carries a random identifier that
 * links one installation's events for up to {@link TELEMETRY_ID_LIFETIME_DAYS}
 * days (`src/main/core/telemetry/install-id.ts`), which makes the data
 * pseudonymous. "No IP address" is a promise about what the app puts in the
 * data; the connection itself still reaches the relay from the user's address,
 * and what the relay does with it is stated in `docs/TELEMETRY.md` §7.
 */
export const TELEMETRY_SUMMARY = `Switch Console shares usage data to show which features get used and where the app runs into trouble. It is tagged with a random identifier that changes every ${TELEMETRY_ID_LIFETIME_DAYS} days, and never includes your account, email address, content or IP address. Turning sharing off stops it at once and deletes the identifier.`;

/** The same, in one line, for the places with room for no more. */
export const TELEMETRY_SHORT_SUMMARY = `Switch Console shares usage data, tagged with a random identifier that changes every ${TELEMETRY_ID_LIFETIME_DAYS} days, to improve the app.`;

/**
 * How far the answer reaches, stated because the alternative is a toggle that
 * appears to govern more than it does (CHOO-2890).
 *
 * It governs a Switch server this app runs — the setting is written into that
 * server's configuration at every start — and it does not govern a server
 * reached by URL, which is somebody else's deployment with its own answer. On a
 * server other Consoles use too, a "no" applies to everyone at the next start
 * from here, while a "yes" leaves the server as it is — sharing already on stays
 * on — unless nobody else has been seen on it lately (`shareUsageData` in the
 * managed-server pipeline). The first is the promise; the other two are its
 * limits.
 *
 * The server reads the answer only when it starts, and Switch Console does not
 * restart it on the user's behalf (a restart ends live agent sessions), so the
 * note says up front that a running server keeps sharing until it restarts —
 * an opt-out must not read as reaching a server it has not reached yet.
 */
export const TELEMETRY_SCOPE_NOTE = `The same answer applies to a Switch server this app runs for you, from its next start: a server already running keeps its earlier setting until it restarts, and its page offers the restart. If other people use that server from their own Switch Console too, a no turns sharing off for everyone when you next start it, and a yes leaves it as it is unless none of them has used the server in the last ${RECENTLY_SEEN_DAYS} days. A server you connect to by URL is not covered — whoever operates it decides.`;

export const TELEMETRY_DETAILS_LABEL = 'Read what is collected';

export const TELEMETRY_DETAILS_URL =
  'https://github.com/sandbox-quantum/switch/blob/main/docs/TELEMETRY.md';
