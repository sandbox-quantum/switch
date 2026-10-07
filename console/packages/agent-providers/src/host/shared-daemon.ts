import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { openSwitchStream, runAgentHost } from './agent-host';
import { AttachmentTransfers } from './attachment-transfers';
import { type ControlContext, ensureSessions, ensureThroughWatcher, serveControl } from './control';
import { OBSOLETE_BUNDLE_EXIT_CODE } from './exit-codes';
import { dirMode } from './host-permissions';
import { hostedUnitGitHubEnvironment, prepareHostedAgent } from './hosted-bootstrap';
import { ensureHostedRepository } from './hosted-github';
import { detachedSupervision, ensureSharedProcess, inProcessSupervision } from './launch';
import { replaceOwner } from './ownership-lock';
import { ownProcessGroup } from './process-fence';
import { checkProviderReadiness } from './provider-readiness';
import { adapterFor } from './server';
import { HOST_EXIT_GRACE_MS, SessionLinks } from './session-channel';
import {
  CODEX_AUTH_ENV,
  type SharedHostConfig,
  sessionProviderEnvironment,
  sharedConfigSchema,
} from './shared-config';
import { hostSessionProcess } from './shared-host';
import { superviseSharedHost } from './supervisor';
import { readTakenOver } from './taken-over';
import { recordWatcherHealth } from './watcher-health-file';
import { WatcherControl } from './watcher-tools';

const [root, configPath, mode] = process.argv.slice(2);
if (!root || !configPath)
  throw new Error('Shared SDK host requires a state directory and configuration file.');

/**
 * Runs the room watcher for the state root `root` in this process, with the
 * session hosts it starts as its children. `asUnit` is true for an agents
 * controller's unit, which reaches Switch through the controller and builds
 * the sessions it is asked to start from its own configuration.
 */
async function watch(root: string, config: SharedHostConfig, asUnit: boolean): Promise<void> {
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  process.on('SIGINT', () => stop.abort());
  // The sidecar is the parent of the sessions it runs: it talks to each over
  // IPC, and Console reaches them through its control port.
  const links = new SessionLinks();
  const supervision = inProcessSupervision(process.argv[1]!, links);
  // Console's "Reconnect to room" reaches the watcher through the control port.
  const control = new WatcherControl();
  const ensure = asUnit ? ensureThroughWatcher(control) : ensureSessions(supervision);
  const transfers = new AttachmentTransfers(resolve(root));
  await transfers.clear();
  const context: ControlContext = {
    agentId: config.session.agentId,
    links,
    ensure,
    watcher: control,
    transfers,
  };
  // Console reads the watcher's connection state from this file, with the
  // rest of the host's watcher state, rather than from the control port.
  const stopRecording = recordWatcherHealth(resolve(root), control, links);
  // A watcher that stops (disabled, stood down after a takeover, or
  // signalled) takes the process with it: the control port and every
  // session host go too, so the supervisor sees a clean exit and does not
  // start it again.
  try {
    await Promise.all([
      runAgentHost(root, config, stop.signal, supervision, control, openSwitchStream).finally(() =>
        stop.abort()
      ),
      serveControl(resolve(root), context, stop.signal),
    ]);
  } finally {
    stopRecording();
    await supervision.close();
  }
}

/**
 * The watcher as a systemd unit of an agents controller (`--unit
 * <watcherRoot>`). systemd is its supervisor: it is this unit's only process
 * for the root, so owner records an earlier run left are stale and go. A
 * watcher that stood down after a takeover exits `OBSOLETE_BUNDLE_EXIT_CODE`,
 * which the unit does not restart.
 */
async function runUnit(watcherRoot: string): Promise<void> {
  process.env[CODEX_AUTH_ENV] = 'shared';
  const unitRoot = resolve(watcherRoot);
  const config = sharedConfigSchema.parse(
    JSON.parse(await readFile(join(unitRoot, 'config.json'), 'utf8'))
  );
  Object.assign(process.env, await hostedUnitGitHubEnvironment(dirname(unitRoot), config));
  await rm(join(unitRoot, 'shared-owner.lock'), { force: true });
  await rm(join(unitRoot, 'supervisor', 'owner.json'), { force: true });
  await rm(join(unitRoot, 'ownership'), { recursive: true, force: true });
  await watch(unitRoot, config, true);
  if (await readTakenOver(unitRoot)) process.exitCode = OBSOLETE_BUNDLE_EXIT_CODE;
}

/** Where a failure of this invocation is recorded for whoever runs it, or null for none. */
function failureRoot(): string | null {
  if (root === '--unit') return configPath!;
  if (root === '--prepare') return join(configPath!, 'watcher');
  if (root === '--probe' || root === '--models') return null;
  if (mode === '--supervise' || mode === '--watch-supervise') return null;
  return root!;
}

async function main(): Promise<void> {
  if (root === '--unit') {
    await runUnit(configPath!);
    return;
  }
  if (root === '--prepare') {
    const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
    if (!credentialsDirectory)
      throw new Error(
        'An agent unit is prepared with its systemd credentials; CREDENTIALS_DIRECTORY is not set.'
      );
    await rm(join(configPath!, 'watcher', 'supervisor', 'failure.json'), { force: true });
    await prepareHostedAgent(
      { agentRoot: configPath!, credentialsDirectory },
      { ensureRepository: ensureHostedRepository }
    );
    return;
  }
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
            env: await sessionProviderEnvironment(mode),
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
          env: await sessionProviderEnvironment(mode),
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
          startSource: null,
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
      logRedactions: [],
    });
  } else if (mode === '--watch-worker') {
    await watch(root, config, false);
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
      // Something the host started can outlive it too, and keep this process
      // alive holding the session's lock with no pipe to its parent. Exit
      // regardless: the supervisor then clears what is left of the group.
      setTimeout(() => {
        console.warn(
          `The session host finished but was still running ${HOST_EXIT_GRACE_MS / 1000} s later; exiting so its supervisor can stop what it left behind.`
        );
        process.exit();
      }, HOST_EXIT_GRACE_MS).unref();
    }
  }
}
try {
  await main();
} catch (error) {
  const recorded = failureRoot();
  if (recorded !== null) {
    await mkdir(join(recorded, 'supervisor'), { recursive: true, mode: dirMode() });
    await replaceOwner(join(recorded, 'supervisor', 'failure.json'), {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  console.error(error);
  process.exitCode = 1;
}
