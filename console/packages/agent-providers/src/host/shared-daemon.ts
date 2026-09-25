import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AttachmentTransfers } from './attachment-transfers';
import { type ControlContext, type EnsureSession, serveControl } from './control';
import { OBSOLETE_BUNDLE_EXIT_CODE, WorkerObsoleteError } from './exit-codes';
import { fetchHostedProvider, materializeHostedProvider } from './hosted-provider';
import { type HostedCredentials, HostedWorker } from './hosted-worker';
import {
  detachedSupervision,
  ensureSharedProcess,
  inProcessSupervision,
  sharedSessionRoot,
} from './launch';
import { replaceOwner } from './ownership-lock';
import { ownProcessGroup } from './process-fence';
import { checkProviderReadiness } from './provider-readiness';
import { adapterFor } from './server';
import { SessionLinks } from './session-channel';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';
import { hostSessionProcess } from './shared-host';
import { runSharedWatcher } from './shared-watcher';
import { superviseSharedHost } from './supervisor';
import { WatcherControl } from './watcher-tools';
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
async function hostedWorker(
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
  const worker = new HostedWorker(
    stateRoot,
    { capability: await readWorkerCapability(stateRoot), bootId, instanceId },
    context,
    hostedCredentials(config, stateRoot)
  );
  await worker.open();
  return worker;
}

const [root, configPath, mode] = process.argv.slice(2);
if (!root || !configPath)
  throw new Error('Shared SDK host requires a state directory and configuration file.');
async function main(): Promise<void> {
  if (root === '--models') {
    const provider = sharedConfigSchema.shape.start.shape.provider.parse(configPath);
    const adapter = adapterFor(provider, process.argv[5], '');
    const sessionId = randomUUID();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const models = await Promise.race([
        (async () => {
          await adapter.startSession({
            sessionId,
            cwd: mode,
            runtimeMode: 'approval-required',
            mcpServers: {},
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined
              )
            ),
          });
          return (await adapter.listModels?.(sessionId)) ?? [];
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Model discovery timed out.')), 60000);
        }),
      ]);
      console.log(
        JSON.stringify({
          status: 'unknown',
          message: models.length
            ? 'Models loaded.'
            : 'The provider returned no models. Enter a model ID or leave blank for the provider default.',
          models: models.map((model) => ({ id: model.id, name: model.label })),
        })
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      await adapter.stopAll();
    }
    return;
  }
  if (root === '--probe') {
    console.log(
      JSON.stringify(
        await checkProviderReadiness({
          provider: configPath,
          cwd: mode,
          binaryPath: process.argv[5],
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined
            )
          ),
        })
      )
    );
    return;
  }
  const config = sharedConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  if (mode === '--ensure' || mode === '--ensure-watch' || mode === '--restart') {
    console.log(
      JSON.stringify(
        await ensureSharedProcess({
          root,
          config,
          resuming: process.argv[5] === 'true',
          watcher: mode === '--ensure-watch',
          restart: mode === '--restart',
          supervision: detachedSupervision(process.argv[1]!),
        })
      )
    );
  } else if (mode === '--supervise' || mode === '--watch-supervise') {
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    await superviseSharedHost({
      root: resolve(root),
      executable: process.execPath,
      args: [
        process.argv[1],
        root,
        configPath,
        ...(mode === '--watch-supervise' ? ['--watch-worker'] : []),
      ],
      env: process.env,
      signal: stop.signal,
      build: process.argv[1]!,
      links: null,
    });
  } else if (mode === '--watch-worker') {
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    // The sidecar is the parent of the sessions it runs: it talks to each over
    // IPC, and Console reaches them through its control port.
    const links = new SessionLinks();
    const supervision = inProcessSupervision(process.argv[1]!, links);
    const ensure: EnsureSession = async (input) => {
      const session = sharedConfigSchema.parse(input.config);
      return ensureSharedProcess({
        root: sharedSessionRoot(session.session.sessionId),
        config: session,
        resuming: input.resuming,
        watcher: false,
        restart: input.restart,
        supervision,
      });
    };
    // Console's "Reconnect to room" reaches the watcher through the control port.
    const control = new WatcherControl();
    const transfers = new AttachmentTransfers(resolve(root));
    await transfers.clear();
    const context: ControlContext = {
      agentId: config.session.agentId,
      links,
      ensure,
      watcher: control,
      transfers,
    };
    const hosted = await hostedWorker(config, resolve(root), context);
    // A watcher that stops (disabled, stood down after a takeover, or
    // signalled) takes the process with it: the control port and every
    // session host go too, so the supervisor sees a clean exit and does not
    // start it again.
    try {
      await Promise.all([
        runSharedWatcher(root, config, stop.signal, supervision, control, hosted).finally(() =>
          stop.abort()
        ),
        serveControl(resolve(root), context, stop.signal),
      ]);
    } finally {
      await supervision.close();
    }
  } else if (process.platform !== 'win32' && (await ownProcessGroup()) === null) {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      env: process.env,
    });
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      process.on(signal, () => child.kill(signal));
    child.on('error', (error) => {
      throw error;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  } else {
    if (!process.send)
      throw new Error(
        'A session host is started by Console or the agent sidecar, which answer its Switch tools; run on its own it has nothing to answer them.'
      );
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    // Started by a parent that talks to it: it goes when the parent goes.
    process.on('disconnect', () => stop.abort());
    try {
      await hostSessionProcess({
        root,
        config,
        adapter: adapterFor(
          config.start.provider,
          config.execution?.binaryPath,
          config.execution?.skill ?? ''
        ),
        port: process,
        authenticate:
          config.start.provider === 'claude'
            ? async (input) => {
                const readiness = await checkProviderReadiness({
                  provider: config.start.provider,
                  binaryPath: config.execution?.binaryPath ?? 'claude',
                  cwd: input.cwd,
                  env: input.env,
                });
                if (readiness.status === 'unauthenticated') throw new Error(readiness.message);
                if (readiness.status === 'unknown') console.warn(readiness.message);
              }
            : null,
        signal: stop.signal,
      });
    } catch (error) {
      if (!stop.signal.aborted) throw error;
    } finally {
      // The channel would otherwise keep this process alive after the host is done.
      process.disconnect();
    }
  }
}
try {
  await main();
} catch (error) {
  if (error instanceof WorkerObsoleteError) {
    // Not a failure of this bundle's to record: the worker service waits for a current one.
    console.error(error.message);
    process.exitCode = OBSOLETE_BUNDLE_EXIT_CODE;
  } else {
    if (
      root !== '--probe' &&
      root !== '--models' &&
      mode !== '--supervise' &&
      mode !== '--watch-supervise'
    ) {
      await mkdir(join(root, 'supervisor'), { recursive: true, mode: 0o700 });
      await replaceOwner(join(root, 'supervisor', 'failure.json'), {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    console.error(error);
    process.exitCode = 1;
  }
}
