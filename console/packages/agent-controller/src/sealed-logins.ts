import {
  generateSealingKeyPair,
  type HostedCredential,
  hostedCredentialSchema,
  openProviderLogin,
  type SealingKeyPair,
} from '@switch-console/agent-providers';
import { z } from 'zod';
import { ControllerApiError, type ControllerClient } from './api';
import { errorMessage, type Logger } from './log';
import type { Provider } from './schemas';
import { SEALING_KEY, type SecretStore } from './secrets';

/** A login Switch gave this machine for a provider, opened. */
export type GivenLogin = Extract<HostedCredential, { status: 'connected' }>;

const keyPairSchema = z.strictObject({ publicKey: z.string(), privateKey: z.string() });

/**
 * This machine's sealing keypair, from the secret store, made and kept there
 * when it has none. Null for a store that does not outlive the process (a
 * credential handed over by a parent): a key made there would be lost at the
 * next start, while Switch went on sealing to it.
 */
export async function sealingKeys(secrets: SecretStore): Promise<SealingKeyPair | null> {
  if (!secrets.persistent) return null;
  const saved = await secrets.get(SEALING_KEY);
  if (saved !== null) return keyPairSchema.parse(JSON.parse(saved));
  const keys = generateSealingKeyPair();
  await secrets.set(SEALING_KEY, JSON.stringify(keys));
  return keys;
}

/**
 * Registers the key with Switch, which keeps the first one it is given. Says
 * so and answers false when Switch holds another, or cannot take one: then no
 * login given to this machine could be opened here.
 */
export async function registerSealingKey(
  client: Pick<ControllerClient, 'registerPublicKey'>,
  keys: SealingKeyPair,
  log: Logger
): Promise<boolean> {
  try {
    await client.registerPublicKey(keys.publicKey);
    return true;
  } catch (error) {
    if (error instanceof ControllerApiError && error.status === 409) {
      log.error(
        'Switch holds another key for this machine, so provider logins given to it cannot be opened here. Enroll the machine again to give it this one.',
        { error: error.message }
      );
      return false;
    }
    if (error instanceof ControllerApiError && error.status === 422) {
      log.warn(
        'This Switch server does not take a key for sealed provider logins; only logins on this machine are used.',
        { error: error.message }
      );
      return false;
    }
    log.warn(
      'Could not register the key for sealed provider logins; trying again at the next start',
      {
        error: errorMessage(error),
      }
    );
    return true;
  }
}

/** Why a login given to this machine is not used. */
export type LoginProblem = { code: 'provider_login_missing' | 'internal'; message: string };

/**
 * The provider logins Switch gave this machine, sealed to its key: fetched,
 * opened with the private key, and kept in memory only. Nothing of them is
 * written to disk here; the agent that uses one gets it with its credentials.
 */
export class SealedLogins {
  constructor(
    private readonly deps: {
      client: Pick<ControllerClient, 'sealedLogin'>;
      keys: SealingKeyPair;
      controllerId: string;
    }
  ) {}

  /**
   * The provider's login as Switch has it now: the login, or why there is
   * none to use. A failure to reach Switch throws.
   */
  async fetch(provider: Provider): Promise<{ login: GivenLogin } | { problem: LoginProblem }> {
    const answer = await this.deps.client.sealedLogin(provider);
    if (answer === null)
      return {
        problem: {
          code: 'provider_login_missing',
          message: `No ${provider} login has been given to this machine.`,
        },
      };
    try {
      const opened = openProviderLogin({
        keys: this.deps.keys,
        controllerId: this.deps.controllerId,
        provider,
        sealed: answer.sealed,
      });
      const login = hostedCredentialSchema.safeParse({
        status: 'connected',
        provider,
        revision: String(answer.revision),
        kind: opened.kind,
        credential: opened.credential,
      });
      if (!login.success || login.data.status !== 'connected')
        throw new Error(
          `The ${provider} login given to this machine cannot be used: ${login.error?.issues[0]?.message ?? 'it is not a connected login'}`
        );
      return { login: login.data };
    } catch (error) {
      return { problem: { code: 'internal', message: errorMessage(error) } };
    }
  }
}
