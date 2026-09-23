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
 */
export const TELEMETRY_SUMMARY =
  'Switch Console shares anonymous usage data to show which features get used and where the app runs into trouble.';

/**
 * How far the answer reaches, stated because the alternative is a toggle that
 * appears to govern more than it does (CHOO-2890).
 *
 * It governs a Switch server this app runs — the setting is written into that
 * server's configuration at every start — and it does not govern a server
 * reached by URL, which is somebody else's deployment with its own answer. Both
 * halves matter: the first is the promise, the second is the limit of it.
 */
export const TELEMETRY_SCOPE_NOTE =
  'The same answer applies to a Switch server this app runs for you. A server you connect to by URL is not covered — whoever operates it decides.';

export const TELEMETRY_DETAILS_LABEL = 'Read what is collected';

export const TELEMETRY_DETAILS_URL =
  'https://github.com/sandbox-quantum/switch/blob/main/docs/TELEMETRY.md';
