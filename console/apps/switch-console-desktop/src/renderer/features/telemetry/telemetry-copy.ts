/**
 * The disclosure shown to the user, in one place so the first-run notice and
 * the Settings row cannot drift into promising different things.
 *
 * This is a promise, and what is sent is held to it by the payload rule in
 * `console/AGENTS.md` and by the closed event catalogue in
 * `src/main/core/telemetry/events.ts`. Widening what is sent is a consent
 * decision, not a copy edit.
 *
 * The detail lives in `docs/TELEMETRY.md` rather than in the dialog: a wall of
 * bullet points is not read, and anyone who does want the specifics wants all
 * of them — every event, every field — which no dialog can hold.
 */
export const TELEMETRY_SUMMARY =
  'Switch Console shares anonymous usage data to show which features get used and where the app runs into trouble. It is on by default, and you can turn it off here.';

export const TELEMETRY_ANONYMITY =
  'The data is anonymous. It carries a random id for this install and nothing that identifies you — not your name, machine, IP address, prompts, code, file paths, or any agent, room, project or server names.';

export const TELEMETRY_REVERSIBLE = 'You can change this at any time in Settings, under General.';

export const TELEMETRY_DETAILS_LABEL = 'Read what is collected';

export const TELEMETRY_DETAILS_URL =
  'https://github.com/sandbox-quantum/switch/blob/main/docs/TELEMETRY.md';
