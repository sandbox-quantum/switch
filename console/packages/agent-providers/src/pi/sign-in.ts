import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { PI_LOGIN } from './pi-adapter';

/**
 * Pi has no account of its own: it signs in to model providers, with `/login`
 * or a provider's key in the environment, and lists only the models it holds
 * a credential for. So "signed in" means it lists at least one. The list is
 * asked for offline, so the check neither refreshes a catalog nor signs in.
 */
export async function checkPiSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const { stdout } = await execProvider(input.binaryPath, ['--list-models'], {
    cwd: input.cwd,
    env: { ...input.env, PI_OFFLINE: '1' },
    timeout: 20000,
  });
  // A table under a `provider  model …` header; signed out, a sentence instead.
  const lines = stdout.split('\n').map((line) => line.trim());
  const header = lines.findIndex((line) => /^provider\s+model\b/.test(line));
  const models =
    header < 0 ? [] : lines.slice(header + 1).filter((line) => /^\S+\s+\S+/.test(line));
  return models.length > 0
    ? readiness('authenticated', 'Signed in to a model provider.')
    : readiness('unauthenticated', signInWith(PI_LOGIN));
}
