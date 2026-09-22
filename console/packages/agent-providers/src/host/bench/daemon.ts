/**
 * The benchmark's own shared-host entrypoint.
 *
 * It is `shared-daemon.ts` with one substitution: the provider adapter. Every
 * other path — the watcher, the supervisor, the detached process group, the
 * delivery loop, the lease and the room inbox — is the shipped code, imported
 * rather than copied, so what the benchmark measures is the topology the
 * application runs.
 *
 * The substitution cannot be made in the shipped daemon: `adapterFor` maps a
 * provider name onto one of five real adapters and has no seam for a sixth, so
 * a benchmark that went through it would be measuring a coding model's
 * response time. `runSharedHost` and `detachedSupervision` both take what they
 * need as parameters, which is why this file is small.
 *
 * It ships nowhere. It is not an entry in `tsdown.config.ts`, is not exported
 * from the package, and is bundled only by the benchmark that runs it.
 *
 * Naming itself as the supervision build keeps benchmark and application state
 * apart: a supervisor records the entrypoint it runs, and adopts a root only
 * when the recorded build matches its own.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LEASE_EXPIRED_EXIT_CODE } from '../exit-codes';
import { detachedSupervision, ensureSharedProcess } from '../launch';
import { replaceOwner } from '../ownership-lock';
import { ownProcessGroup } from '../process-fence';
import { prepareSharedConfig, sharedConfigSchema } from '../shared-config';
import { runSharedHost, SharedHostLeaseExpiredError } from '../shared-host';
import { runSharedWatcher } from '../shared-watcher';
import { superviseSharedHost } from '../supervisor';
import { createBenchAdapter } from './adapter';

const [root, configPath, mode] = process.argv.slice(2);
if (!root || !configPath)
  throw new Error('The benchmark host requires a state directory and configuration file.');

async function main(): Promise<void> {
  const config = sharedConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  if (mode === '--ensure' || mode === '--ensure-watch') {
    console.log(
      JSON.stringify(
        await ensureSharedProcess({
          root,
          config,
          resuming: false,
          watcher: mode === '--ensure-watch',
          restart: false,
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
        process.argv[1]!,
        root,
        configPath,
        ...(mode === '--watch-supervise' ? ['--watch-worker'] : []),
      ],
      env: process.env,
      signal: stop.signal,
      build: process.argv[1]!,
    });
  } else if (mode === '--watch-worker') {
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    await runSharedWatcher(root, config, stop.signal, detachedSupervision(process.argv[1]!));
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
          grant: config.grant,
        },
        createBenchAdapter(),
        stop.signal
      );
    } catch (error) {
      if (!stop.signal.aborted) {
        if (!(error instanceof SharedHostLeaseExpiredError)) throw error;
        console.warn('Benchmark host lease expired; the supervisor will relaunch it.');
        process.exitCode = LEASE_EXPIRED_EXIT_CODE;
      }
    }
  }
}

try {
  await main();
} catch (error) {
  if (mode !== '--supervise' && mode !== '--watch-supervise') {
    await mkdir(join(root, 'supervisor'), { recursive: true, mode: 0o700 });
    await replaceOwner(join(root, 'supervisor', 'failure.json'), {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  console.error(error);
  process.exitCode = 1;
}
