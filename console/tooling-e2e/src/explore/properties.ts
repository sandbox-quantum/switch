/**
 * The properties `spec/gateway.ts` exports, by export name, which is the name
 * Bombadil reports a violation under. The lane reports one case per property,
 * and vitest needs the cases before the run that finds the violations, so the
 * list is written out here; a unit test holds it to the spec's exports.
 */
export const PROPERTIES = [
  'noConsoleErrors',
  'noUncaughtExceptions',
  'noUnhandledPromiseRejections',
  'signsIn',
  'staysSignedIn',
  'noErrorBanner',
  'noServerErrors',
  'listMatchesApi',
  'listChecked',
] as const;

/** The spec's other exports: its action generators. */
export const ACTION_GENERATORS = ['signingIn', 'settling', 'exploring', 'waiting'] as const;
