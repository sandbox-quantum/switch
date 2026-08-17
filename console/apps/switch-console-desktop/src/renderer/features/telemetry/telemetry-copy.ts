/**
 * The disclosure shown to the user, in one place so the first-run prompt and
 * the Settings row cannot drift into promising different things.
 *
 * These lists are a promise, and what is sent is held to them by the payload
 * rule in `console/AGENTS.md` and by the closed event catalogue in
 * `src/main/core/telemetry/events.ts`. Widening them is a consent decision, not
 * a copy edit.
 */
export const TELEMETRY_SUMMARY =
  'Switch Console can share usage data to show which features get used and where the app runs into trouble.';

export const TELEMETRY_SHARED = [
  'Which features are used, and how often',
  'Whether sessions end normally or fail',
  'App version and operating system',
  'A random id for this install, so one copy of the app can be told from another',
];

export const TELEMETRY_NEVER_SHARED = [
  'Your name, email address, or sign-in',
  'Anything read off your machine — its name, user account, or network address',
  'Your prompts, code, files, or file paths',
  'Agent, room, project, or server names',
];

export const TELEMETRY_REVERSIBLE = 'You can change this at any time in Settings, under General.';
