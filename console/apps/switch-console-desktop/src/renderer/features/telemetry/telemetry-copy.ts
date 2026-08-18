/**
 * The disclosure shown to the user, in one place so the first-run prompt and
 * the Settings row cannot drift into promising different things.
 *
 * These lists are a promise, not a description of a feature that exists: the
 * app sends nothing today. Whatever eventually does the sending is held to them
 * by the payload rule in `console/AGENTS.md`. Widening them is a consent
 * decision, not a copy edit.
 */
export const TELEMETRY_SUMMARY =
  'Switch Console can share anonymous usage data to show which features get used and where the app runs into trouble.';

export const TELEMETRY_SHARED = [
  'Which features are used, and how often',
  'Errors and crashes the app hits',
  'App version and operating system',
];

export const TELEMETRY_NEVER_SHARED = [
  'Anything that identifies you or your machine',
  'Your prompts, code, files, or file paths',
  'Agent, room, project, or server names',
];

export const TELEMETRY_REVERSIBLE = 'You can change this at any time in Settings, under General.';
