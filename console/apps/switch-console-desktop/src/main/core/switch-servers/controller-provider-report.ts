/** A provider as a controller reports it: installed, and whether its login works. */
export type ControllerProviderReport = {
  /** The Switch definition provider id (`claude`, `codex`, …). */
  provider: string;
  installed: boolean;
  auth: 'ok' | 'expired' | 'missing' | 'unknown';
  /** Why its login does not work, in the controller's words; null when it said nothing. */
  problem: string | null;
  /** False when signing in with the provider's login command would not fix `problem`. */
  loginHelps: boolean;
};

const PROVIDER_AUTH_STATES: readonly ControllerProviderReport['auth'][] = [
  'ok',
  'expired',
  'missing',
  'unknown',
];

/** One provider status as a controller reports it, or null when it does not say which, or whether it is installed. */
export function providerReport(entry: unknown): ControllerProviderReport | null {
  if (!entry || typeof entry !== 'object') return null;
  const { provider, installed, auth, auth_problem, login_helps } = entry as Record<string, unknown>;
  if (typeof provider !== 'string' || typeof installed !== 'boolean') return null;
  const known = PROVIDER_AUTH_STATES.find((state) => state === auth);
  return {
    provider,
    installed,
    auth: known ?? 'unknown',
    problem: typeof auth_problem === 'string' && auth_problem ? auth_problem : null,
    // A controller that does not send the field leaves the login command on offer.
    loginHelps: login_helps !== false,
  };
}
