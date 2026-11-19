import { mkdir, readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CONTROL_FILE,
  ensureSharedProcess,
  macEquals,
  requestMemoryStop,
  sharedConfigSchema,
  takenMac,
  ticketMac,
} from '@switch-console/agent-providers-box';
import {
  pushTicketUntilTaken,
  stopForMemoryOverControlPort,
  warmOverControlPort,
} from './control-port';
import { DetachedRuntime } from './detached-runtime';
import { Launcher, MEASURE_INTERVAL_MS } from './launcher';
import { type LauncherAddress, netOptions, parseLoopback } from './launcher-address';
import { portIsHosts, spawnedSupervision } from './launcher-spawn';
import { dataLayout } from './paths';
import { probeProvider } from './runtime';
import type { Provider } from './schemas';

/**
 * `switch-agent-controller launcher`: the agents container's pid 1, behind
 * tini, on boxes where the controller runs as its own user. It
 * connects to the controller's socket, acts on its orders, measures every
 * 2 s, and exits when the socket closes, so the container restarts and every
 * host and tool goes with it. At start it waits up to 30 s for the controller
 * to listen, so a launcher that starts first doesn't loop through restarts.
 *
 *   switch-agent-controller launcher --data-dir /data/agents --controller-address 127.0.0.1:<port> \
 *     --shared-host-bundle <path> --workspaces /data/agents/workspaces
 *
 * It never reads the controller's data: that disk isn't mounted here.
 */

export const DEFAULT_LAUNCHER_SOCKET = '/run/switch/launcher.sock';
/** How long the launcher waits at start for the controller's socket, then exits as before. */
export const CONTROLLER_WAIT_MS = 30_000;
const CONTROLLER_RETRY_MS = 500;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** One log line: a fixed event and ids or numbers, never text from the other side. */
function log(event: string, fields: Record<string, string | number>): void {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

/** One attempt to connect: the open socket, or null if nothing is listening there yet. */
function tryConnect(address: LauncherAddress): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(netOptions(address));
    const failed = () => {
      socket.destroy();
      resolve(null);
    };
    socket.once('error', failed);
    socket.once('connect', () => {
      socket.off('error', failed);
      resolve(socket);
    });
  });
}

/**
 * The controller's socket, once it listens, or null after `waitMs`. Any
 * failure to connect counts as "not yet": the socket file missing, refused,
 * or not a socket. One log line when the wait starts, and one if it runs out.
 */
export async function connectWhenReady(
  address: LauncherAddress,
  waitMs: number,
  retryMs = CONTROLLER_RETRY_MS
): Promise<Socket | null> {
  const deadline = Date.now() + waitMs;
  let first = true;
  for (;;) {
    const socket = await tryConnect(address);
    if (socket) return socket;
    if (first) {
      log('waiting_for_controller', { waitMs });
      first = false;
    }
    if (Date.now() >= deadline) {
      log('controller_not_listening', { waitMs });
      return null;
    }
    await delay(Math.min(retryMs, Math.max(0, deadline - Date.now())));
  }
}

export async function runLauncher(
  argv: string[],
  defaults: { bundle: string; version: string; controllerWaitMs?: number }
): Promise<number> {
  const dataDir = flag(argv, '--data-dir');
  if (!dataDir) {
    process.stderr.write('launcher: --data-dir (the agents data folder) is required.\n');
    return 2;
  }
  // Loopback inside the pod on a gVisor box (`--controller-address`), or a socket path.
  const loopback = flag(argv, '--controller-address');
  const socketFlag = flag(argv, '--socket');
  if (loopback !== undefined && socketFlag !== undefined) {
    process.stderr.write('launcher: give --controller-address or --socket, not both.\n');
    return 2;
  }
  let address: LauncherAddress = { kind: 'path', path: socketFlag ?? DEFAULT_LAUNCHER_SOCKET };
  if (loopback !== undefined) {
    const parsed = parseLoopback(loopback);
    if (!parsed) {
      process.stderr.write('launcher: --controller-address must be 127.0.0.1:<port>.\n');
      return 2;
    }
    address = parsed;
  }
  const bundlePath = flag(argv, '--shared-host-bundle') ?? defaults.bundle;
  const layout = dataLayout(dataDir);
  const socket = await connectWhenReady(address, defaults.controllerWaitMs ?? CONTROLLER_WAIT_MS);
  // Exiting lets the container restart, as before the wait.
  if (!socket) return 1;
  let timer: NodeJS.Timeout | null = null;
  return await new Promise<number>((resolve) => {
    const launcher = new Launcher({
      send: (line) => void socket.write(line),
      runner: (markers, spawned) =>
        new DetachedRuntime({
          layout,
          bundlePath,
          // Started here, so each host is this launcher's child with a known pid,
          // its launch's marker and push key, and told its hellos need a ticket.
          start: async (agentId, root, templatePath) => {
            const config = sharedConfigSchema.parse(
              JSON.parse(await readFile(templatePath, 'utf8'))
            );
            await ensureSharedProcess({
              root,
              config,
              resuming: false,
              watcher: true,
              restart: false,
              supervision: spawnedSupervision({
                agentId,
                bundlePath,
                env: { ...markers.environmentFor(agentId), SWITCH_HUB_TICKETS: '1' },
                spawned,
              }),
              startSource: null,
            });
          },
        }),
      // The ticket goes only to the spawned host's own port: a control file a
      // dead host left behind is waited past until the new host writes its
      // own, and still wrong at the deadline ends the host (`wrong_port`).
      pushTicket: (agentId, ticket, host) =>
        pushTicketUntilTaken({
          controlFile: join(layout.watcherRoot(agentId), CONTROL_FILE),
          ticket,
          mac: ticketMac(host.key, ticket),
          ownsPort: (port) => portIsHosts('/proc', host.pid, port),
          taken: (answer) => macEquals(answer, takenMac(host.key, ticket)),
        }),
      probe: (provider, binaryPath, env) =>
        mkdir(join(dataDir, 'probe'), { recursive: true, mode: 0o700 }).then(() =>
          probeProvider(bundlePath, provider as Provider, binaryPath, join(dataDir, 'probe'), {
            ...process.env,
            ...env,
          })
        ),
      warm: (agentId, roomId) =>
        warmOverControlPort(join(layout.watcherRoot(agentId), CONTROL_FILE), roomId),
      memoryNotice: async (agentId) => {
        // The request file first, as the controller writes it where hosts run as its own.
        await requestMemoryStop(layout.watcherRoot(agentId));
        return stopForMemoryOverControlPort(join(layout.watcherRoot(agentId), CONTROL_FILE));
      },
      workspacesRoot: flag(argv, '--workspaces'),
      dataRoot: dataDir,
      credentialsPath: (agentId) => layout.agentCredentials(agentId),
      signal: (pid, name) => process.kill(pid, name),
      version: defaults.version,
      // The file name only: a path isn't safe to log on the other side.
      bundle: basename(bundlePath),
      now: Date.now,
      log,
      onClosed: () => {
        if (timer) clearInterval(timer);
        log('controller_socket_closed', {});
        // Exiting ends the container: no host or tool runs on unsupervised.
        resolve(1);
      },
    });
    socket.on('data', (chunk: Buffer) => launcher.feed(chunk));
    socket.on('error', () => launcher.close());
    socket.on('close', () => launcher.close());
    log('connected', { bootId: launcher.bootId });
    launcher.start();
    let busy = false;
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void launcher
        .measure()
        .then(() => launcher.checkHosts())
        .catch(() => log('measure_failed', {}))
        .finally(() => {
          busy = false;
        });
    }, MEASURE_INTERVAL_MS);
  });
}
