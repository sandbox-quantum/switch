import type { ControlContext } from './control';
import { HOSTED_STATE_VERSION, readStateVersion } from './cutover-manifest';
import { fetchHostedProvider, materializeHostedProvider } from './hosted-provider';
import { type HostedCredentials, HostedWorker } from './hosted-worker';
import type { SharedHostConfig } from './shared-config';
import { readWorkerCapability } from './worker-capability';

/**
 * The provider credential Switch holds for a hosted worker's owner, applied to
 * this process's environment, which every session host it starts inherits.
 */
function hostedCredentials(config: SharedHostConfig, stateRoot: string): HostedCredentials {
  return {
    fetch: async () => {
      const credential = await fetchHostedProvider(config);
      if (credential.status === 'revoked')
        return { revoked: true, revision: null, apply: async () => {} };
      return {
        revoked: false,
        revision: credential.revision,
        apply: async () => {
          const env = Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined
            )
          );
          await materializeHostedProvider(
            stateRoot,
            env,
            credential,
            config.execution?.binaryPath ?? config.start.provider
          );
          for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
          Object.assign(process.env, env);
        },
      };
    },
  };
}

/** The hosted worker a bootstrapped watcher attaches as; null for any other watcher. */
export async function hostedWorker(
  config: SharedHostConfig,
  stateRoot: string,
  context: ControlContext
): Promise<HostedWorker | null> {
  if (process.env.SWITCH_HOSTED_BOOTSTRAP !== '1') return null;
  const bootId = process.env.SWITCH_HOST_BOOT_ID;
  const instanceId = process.env.SWITCH_HOST_INSTANCE_ID;
  if (!bootId || !instanceId)
    throw new Error(
      'A hosted watcher requires SWITCH_HOST_BOOT_ID and SWITCH_HOST_INSTANCE_ID from its bootstrap.'
    );
  const stateVersion = await readStateVersion(stateRoot);
  if (stateVersion !== HOSTED_STATE_VERSION)
    throw new Error(
      `This volume is at layout version ${stateVersion ?? 'none'}, not ${HOSTED_STATE_VERSION}; the hosted bootstrap's preflight must finish before the watcher starts.`
    );
  const worker = new HostedWorker(
    stateRoot,
    { capability: await readWorkerCapability(stateRoot), bootId, instanceId, stateVersion },
    context,
    hostedCredentials(config, stateRoot)
  );
  await worker.open();
  return worker;
}
