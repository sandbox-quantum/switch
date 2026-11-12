/**
 * The first run's server setup, told as a few plain stages instead of the
 * step-by-step messages the main process reports (which name PostgreSQL, uv,
 * versions and downloads — detail that reads as alarming to someone who only
 * wanted to try Switch).
 */
export const SETUP_STAGES = [
  'Getting what’s needed…',
  'Preparing the database…',
  'Starting Switch…',
  'Signing you in…',
] as const;

const STAGE_PATTERNS: readonly RegExp[] = [
  /^(Preparing the server|Looking for PostgreSQL|Downloading|Installing|Unpacking|Building|Checking|Stopping|Moving|Pausing|Taking the Docker server down|Pulling)/,
  /^(Creating the database|Starting PostgreSQL|Exporting|Importing)/,
  /^(Starting switch-core|Waiting for the server)/,
  /^(Signing in|Registering)/,
];

/**
 * The stage a reported step belongs to, or null for a step this list does not
 * know, which leaves the bar where it was rather than guessing.
 */
export function setupStage(message: string | null): number | null {
  if (message === null) return null;
  const stage = STAGE_PATTERNS.findIndex((pattern) => pattern.test(message));
  return stage === -1 ? null : stage;
}

/** How full the bar is at a stage: never full until the server is up. */
export function setupProgress(stage: number): number {
  return Math.round(((stage + 1) / (SETUP_STAGES.length + 1)) * 100);
}
