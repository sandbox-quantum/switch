import { execProvider } from '../provider-process';
import {
  loginWontHelp,
  readiness,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';

/**
 * Pi signs in from its own interface, with `/login` (or a provider's API key
 * in the environment), and has no command that signs in by itself.
 */
export const PI_LOGIN = 'pi';

/** What to do when Pi has no model provider it can use. */
export const PI_SIGN_IN_HINT =
  'Run pi on the execution machine and type /login, or set a model provider’s API key (such as GEMINI_API_KEY) in its environment.';

/**
 * The models `pi --list-models` prints, one row each under a header naming
 * the columns: `provider  model  context  max-out  thinking  images`.
 */
export function parsePiModelList(output: string): Array<{ id: string; name: string }> {
  const rows = output.split('\n').map((line) => line.trim().split(/\s+/));
  const header = rows.findIndex((row) => row[0] === 'provider' && row[1] === 'model');
  if (header === -1) return [];
  return rows
    .slice(header + 1)
    .filter((row) => row.length >= 2 && row[0] && row[1])
    .map(([provider, model]) => ({ id: `${provider}/${model}`, name: `${model} (${provider})` }));
}

/**
 * Pi has no account of its own: it is signed in when some model provider has
 * a credential, saved by `/login` or given in the environment. The models
 * Pi lists are those it has a credential for, and it lists them offline, so
 * the check reads them without a model call and without starting a sign-in.
 */
export async function checkPiSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  let stdout: string;
  try {
    ({ stdout } = await execProvider(input.binaryPath, ['--list-models'], {
      cwd: input.cwd,
      env: { ...input.env, PI_OFFLINE: '1' },
      timeout: 20_000,
    }));
  } catch (error) {
    return loginWontHelp(readiness('unknown', `Could not list Pi's models: ${String(error)}`));
  }
  const models = parsePiModelList(stdout);
  if (models.length > 0)
    return {
      status: 'authenticated',
      message: `Pi can use ${models.length} model${models.length === 1 ? '' : 's'}.`,
      models,
    };
  return stdout.includes('No models available')
    ? readiness('unauthenticated', `No model provider is signed in to Pi. ${PI_SIGN_IN_HINT}`)
    : readiness('unknown', `Pi listed no models and did not say why. ${PI_SIGN_IN_HINT}`);
}
