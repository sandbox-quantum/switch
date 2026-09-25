/**
 * The benchmark's own shared-host entrypoint.
 *
 * It is `shared-daemon.ts` with one substitution: the provider adapter. Every
 * other path — the watcher and its supervisor, the session hosts it parents
 * over IPC, their MCP servers, the room inbox and the activity reports — is
 * the shipped code, imported rather than copied, so what the benchmark
 * measures is the topology the application runs.
 *
 * The substitution cannot be made in the shipped daemon: `adapterFor` maps a
 * provider name onto one of five real adapters and has no seam for a sixth, so
 * a benchmark that went through it would be measuring a coding model's
 * response time. `hostSessionProcess` and the supervisions take what they need
 * as parameters, which is why this file is small.
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
import { AttachmentTransfers } from '../attachment-transfers';
import { type EnsureSession, serveControl } from '../control';
import {
  detachedSupervision,
  ensureSharedProcess,
  inProcessSupervision,
  sharedSessionRoot,
} from '../launch';
import { replaceOwner } from '../ownership-lock';
import { ownProcessGroup } from '../process-fence';
import { SessionLinks } from '../session-channel';
import { sharedConfigSchema } from '../shared-config';
import { hostSessionProcess } from '../shared-host';
import { runSharedWatcher } from '../shared-watcher';
import { superviseSharedHost } from '../supervisor';
import { WatcherControl } from '../watcher-tools';
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
      links: null,
    });
  } else if (mode === '--watch-worker') {
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    // As the shipped sidecar does: its sessions are its children, over IPC.
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
    // A watcher that stops (disabled, stood down after a takeover, or
    // signalled) takes the process with it: the control port and every
    // session host go too, so the supervisor sees a clean exit and does not
    // start it again.
    try {
      await Promise.all([
        runSharedWatcher(root, config, stop.signal, supervision, control, null).finally(() =>
          stop.abort()
        ),
        serveControl(
          resolve(root),
          {
            agentId: config.session.agentId,
            links,
            ensure,
            watcher: control,
            transfers,
          },
          stop.signal
        ),
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
      throw new Error('The benchmark session host is started by its watcher over IPC.');
    const stop = new AbortController();
    process.on('SIGTERM', () => stop.abort());
    process.on('SIGINT', () => stop.abort());
    process.on('disconnect', () => stop.abort());
    try {
      await hostSessionProcess({
        root,
        config,
        adapter: createBenchAdapter(),
        port: process,
        authenticate: null,
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
  if (mode !== '--supervise' && mode !== '--watch-supervise') {
    await mkdir(join(root, 'supervisor'), { recursive: true, mode: 0o700 });
    await replaceOwner(join(root, 'supervisor', 'failure.json'), {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  console.error(error);
  process.exitCode = 1;
}
