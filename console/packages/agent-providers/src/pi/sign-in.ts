import { execProvider } from '../provider-process';
import {
  commandOutput,
  readiness,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';

/**
 * Pi has no account of its own: it signs in to a model provider, with `/login`
 * in its terminal UI (saved in its `auth.json`) or a provider's API key in the
 * environment.
 */
export const PI_LOGIN = 'pi, then /login';

/** The rows of `pi --list-models`: one per model Pi has a credential for. */
export function parsePiModelList(output: string): Array<{ provider: string; model: string }> {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  const header = lines.findIndex((line) => /^provider\s+model\s/.test(line));
  if (header < 0) return [];
  return lines.slice(header + 1).flatMap((line) => {
    const [provider, model] = line.trim().split(/\s+/);
    return provider && model ? [{ provider, model }] : [];
  });
}

/**
 * Asks Pi which models it can use, without signing anything in and without
 * the network: `--list-models` lists only models whose provider has a
 * credential, and `--offline` keeps it from refreshing catalogues.
 */
export async function checkPiSignIn({
  binaryPath,
  cwd,
  env,
}: SignInCheckInput): Promise<ProviderReadiness> {
  let output: string;
  try {
    output = (
      await execProvider(binaryPath, ['--list-models', '--offline'], {
        cwd,
        env,
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    output = commandOutput(error);
    if (!output) throw error;
  }
  if (/no models available/i.test(output))
    return readiness('unauthenticated', signInWith(PI_LOGIN));
  const models = parsePiModelList(output);
  if (!models.length)
    return readiness(
      'unknown',
      `Could not tell whether Pi is signed in from its model list. If its sessions fail, sign in on the execution machine with ${PI_LOGIN}.`
    );
  const providers = [...new Set(models.map((entry) => entry.provider))];
  return {
    ...readiness('authenticated', `Signed in to ${providers.join(', ')}.`),
    models: models.map(({ provider, model }) => ({
      id: `${provider}/${model}`,
      name: `${model} (${provider})`,
    })),
  };
}
