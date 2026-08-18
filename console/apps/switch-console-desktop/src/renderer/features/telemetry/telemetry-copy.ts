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
  'Which coding agents you use, and whether they run here or on a remote host',
  'Whether sessions end normally or fail',
  'App version and operating system',
  'A random id for this install, so one copy of the app can be told from another',
];

// The location line says what this app does — it sends no address and no
// location — rather than what the services at the far end can work out.
//
// Today they can work out nothing: events go to our own relay, which calls the
// analytics services itself, so they see its address and never the user's. That
// is a property of the relay's configuration, in another repository, and its
// own documentation describes the change that would undo it (forwarding the
// original client IP so geography becomes usable again). A promise phrased
// about their end would quietly become false the day that lands, without a line
// changing here. Phrased about ours, it stays true and stays ours to keep.
export const TELEMETRY_NEVER_SHARED = [
  'Your name, email address, or sign-in',
  'Your machine or its user account',
  'Your IP address or location — the app sends neither',
  'Your prompts, code, files, or file paths',
  'Agent, room, project, or server names',
];

export const TELEMETRY_REVERSIBLE = 'You can change this at any time in Settings, under General.';
