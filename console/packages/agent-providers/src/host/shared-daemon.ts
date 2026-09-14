import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LEASE_EXPIRED_EXIT_CODE } from './exit-codes';
import { ensureSharedProcess } from './launch';
import { replaceOwner } from './ownership-lock';
import { ownProcessGroup } from './process-fence';
import { checkProviderReadiness } from './provider-readiness';
import { adapterFor } from './server';
import { prepareSharedConfig, sharedConfigSchema } from './shared-config';
import { runSharedHost, SharedHostLeaseExpiredError } from './shared-host';
import { runSharedWatcher } from './shared-watcher';
import { superviseSharedHost } from './supervisor';

const [root, configPath, mode] = process.argv.slice(2);
if (!root || !configPath)
  throw new Error('Shared SDK host requires a state directory and configuration file.');
async function main(): Promise<void> {
  if (root === '--models') {
    const provider = sharedConfigSchema.shape.start.shape.provider.parse(configPath);
    const adapter = adapterFor(provider, process.argv[5]);
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
          entrypoint: process.argv[1],
          config,
          resuming: process.argv[5] === 'true',
          watcher: mode === '--ensure-watch',
          restart: mode === '--restart',
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
    });
  } else if (mode === '--watch-worker') {
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    await runSharedWatcher(root, process.argv[1], config, stop.signal);
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
    const { agentApiUrl, token, input } = await prepareSharedConfig(root, config);
    const readiness = await checkProviderReadiness({
      provider: config.start.provider,
      binaryPath:
        config.execution?.binaryPath ??
        (config.start.provider === 'cursor' ? 'agent' : config.start.provider),
      cwd: input.cwd,
      env: input.env,
    });
    if (readiness.status === 'unauthenticated') throw new Error(readiness.message);
    if (readiness.status === 'unknown') console.warn(readiness.message);
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    try {
      await runSharedHost(
        {
          root: resolve(root),
          agentApiUrl,
          token,
          session: config.session,
          resumeOperationId: config.resumeOperationId,
          input,
          roomConnection: config.roomConnection,
        },
        adapterFor(config.start.provider, config.execution?.binaryPath),
        stop.signal
      );
    } catch (error) {
      if (!stop.signal.aborted) {
        if (!(error instanceof SharedHostLeaseExpiredError)) throw error;
        console.warn(
          'Shared host lease expired. Execution stopped; reconnecting with saved state.'
        );
        process.exitCode = LEASE_EXPIRED_EXIT_CODE;
      }
    }
  }
}
try {
  await main();
} catch (error) {
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
