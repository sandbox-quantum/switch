import { execFile, spawn } from 'node:child_process';
import { hostname, release } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import {
  resolveAgentControllerBundlePath,
  resolveSharedHostBundlePath,
} from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { getServer } from '@main/core/switch-servers/servers-store';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { embeddedControllerStateChannel } from '@shared/events/embeddedControllerEvents';
import {
  controllerDataDir,
  EnrollmentFile,
  turnOffWatchers,
  wipeControllerIdentity,
} from './controller-files';
import { DEFAULT_BACKOFF } from './controller-supervisor';
import { EmbeddedControllerService } from './embedded-controller-service';
import { gatewayManagementPort } from './management-port';

const execute = promisify(execFile);

function base(): string {
  return join(app.getPath('userData'), 'agent-controller');
}

/** The embedded controller's data directory for a server, as the controller lays it out. */
export function embeddedControllerDataDir(serverId: string): string {
  return controllerDataDir(base(), serverId);
}

/** The controller's `--version`, run the way it will run: on Electron's binary, as Node. */
async function controllerVersion(bundle: string): Promise<string> {
  const { stdout } = await execute(process.execPath, [bundle, '--version'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000,
  });
  const version = stdout.trim();
  if (!version) throw new Error(`The agents controller at ${bundle} did not report a version.`);
  return version;
}

const controllerLog = log.child({ component: 'embedded-agent-controller' });

export const embeddedControllerService = new EmbeddedControllerService({
  platform: process.platform,
  machine: () => ({
    name: hostname(),
    platform: {
      os:
        process.platform === 'darwin'
          ? 'macos'
          : process.platform === 'win32'
            ? 'windows'
            : process.platform,
      arch: process.arch,
      os_version: release(),
    },
  }),
  records: new EnrollmentFile(() => join(base(), 'state.json')),
  serverApiUrl: async (serverId) => (await getServer(serverId))?.apiUrl ?? null,
  secrets: encryptedAppSecretsStore,
  management: gatewayManagementPort,
  files: {
    dataDir: (serverId) => controllerDataDir(base(), serverId),
    turnOffWatchers,
    wipeIdentity: wipeControllerIdentity,
  },
  bundles: {
    controller: resolveAgentControllerBundlePath,
    sharedHost: resolveSharedHostBundlePath,
  },
  controllerVersion,
  spawn: (command, args, options) => spawn(command, args, options),
  execPath: process.execPath,
  env: () => process.env,
  emit: (event) => events.emit(embeddedControllerStateChannel, event),
  log: {
    info: (message, fields) => log.info(message, { event: 'embedded_controller', ...fields }),
    warn: (message, fields) => log.warn(message, { event: 'embedded_controller', ...fields }),
    error: (message, fields) => log.error(message, { event: 'embedded_controller', ...fields }),
  },
  controllerLine: (serverId, level, line) => controllerLog[level](line, { serverId }),
  now: Date.now,
  backoff: DEFAULT_BACKOFF,
  revokeGraceMs: 20_000,
  stopTimeoutMs: 4_000,
});
