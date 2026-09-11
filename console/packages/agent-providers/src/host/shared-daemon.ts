import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LEASE_EXPIRED_EXIT_CODE } from './exit-codes';
import { ensureSharedProcess } from './launch';
import { replaceOwner } from './ownership-lock';
import { ownProcessGroup } from './process-fence';
import { adapterFor } from './server';
import { prepareSharedConfig, sharedConfigSchema } from './shared-config';
import { runSharedHost, SharedHostLeaseExpiredError } from './shared-host';
import { runSharedWatcher } from './shared-watcher';
import { superviseSharedHost } from './supervisor';

const [root, configPath, mode] = process.argv.slice(2);
if (!root || !configPath)
  throw new Error('Shared SDK host requires a state directory and configuration file.');
async function main(): Promise<void> {
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
  if (mode !== '--supervise' && mode !== '--watch-supervise') {
    await mkdir(join(root, 'supervisor'), { recursive: true, mode: 0o700 });
    await replaceOwner(join(root, 'supervisor', 'failure.json'), {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  console.error(error);
  process.exitCode = 1;
}
