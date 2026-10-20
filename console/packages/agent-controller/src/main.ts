import { realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  cliToolsBase,
  generateSealingKeyPair,
  isProviderRecheckRequest,
  isStopMessage,
  PROVIDER_RECHECKED_KIND,
  type ProviderRecheckReply,
} from '@switch-console/agent-providers';
import packageJson from '../package.json' with { type: 'json' };
import {
  AccessTokens,
  ControllerApiError,
  ControllerClient,
  enroll,
  exchangeToken,
  normalizeServerUrl,
  nodeWebSocket,
} from './api';
import { type ControllerExit, DEFAULT_TIMING, runController } from './controller';
import { DetachedRuntime } from './detached-runtime';
import { formatChecks, runDoctor } from './doctor';
import { readEnvFile } from './env-file';
import { ConfigurationError, UsageError } from './errors';
import {
  EXIT_CONFIGURATION,
  EXIT_OK,
  EXIT_REVOKED,
  EXIT_TAKEN_OVER,
  EXIT_UPGRADE_REQUIRED,
  EXIT_CREDENTIAL_INVALID,
  EXIT_RESTARTING,
  exitCodeFor,
  isParseArgsError,
} from './exit-codes';
import {
  adoptIdentity,
  CREDENTIAL_STDIN_TIMEOUT_MS,
  readCredential,
  defaultSharedHostBundle,
  resolveSharedHostBundle,
} from './handover';
import { createLogger, errorMessage, type Logger } from './log';
import { loginShellPath, withUserBinDirs } from './login-path';
import { dataLayout, ensureDataDir, resolveDataDir, serverWorkspacesDir } from './paths';
import { ProviderRechecks } from './provider-rechecks';
import { readProviderSeed, writeProviderSeed } from './provider-seed';
import { definitionProblem } from './reconcile';
import { isManagedRelease, readCurrent, throughCurrent } from './releases';
import { emptyObservation, InProcessRuntime, observeOnDisk, probeProvider } from './runtime';
import { AgentRuntimes } from './runtimes';
import { type ControllerInfoChange, PROTOCOL_VERSION, PROVIDERS, type UpdatedBy } from './schemas';
import {
  CONTROLLER_CREDENTIAL,
  defaultSecretStoreKind,
  isSecretStoreKind,
  MemorySecretStore,
  runCommand as runSecretCommand,
  SEALING_KEY,
  SECRET_STORE_KINDS,
  secretStoreFor,
} from './secrets';
import {
  downloadPackage,
  downloadVerified,
  MAX_PACKAGE_BYTES,
  type NpmSetup,
  npmInstall,
  PrefixInstaller,
  type ReleaseInstaller,
  ReleasesDirInstaller,
  runInstallCommand,
  SelfUpdater,
  unavailableInstaller,
} from './self-update';
import {
  assertControllerCanRunSeparateUsers,
  DEFAULT_AGENT_USERS,
  ensureReleases,
  findSeparateUsersConfig,
  installSeparateUsers,
  loadSeparateUsersConfig,
  MAX_AGENT_USERS,
  type SeparateUsersConfig,
  separateUserNames,
  uninstallSeparateUsers,
  unitAgentRoot,
} from './separate-users';
import {
  installService,
  LAUNCHD_FINAL_EXIT_CODES,
  restartService,
  serviceState,
  uninstallService,
} from './service';
import {
  contractPlatform,
  mapAgentProcess,
  PathProviderLocator,
  providerLoginTest,
  ProviderStatuses,
  toolStatuses,
} from './status';
import { ControllerStore } from './store';
import { SystemdRuntime, systemctl } from './systemd-runtime';
import { installPrefix, isNewer, latestRelease, releasesRepository } from './update';

export const VERSION: string = packageJson.version;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const MAX_NAME = 200;
const MAX_DESCRIPTION = 500;

const USAGE = `Usage: switch-agent-controller <command> [options]

Commands:
  enroll --server <agent-bridge-url> --code <code> [--name <name>]
      [--description <text>] [--data-dir <dir>]
      Enroll this machine with a one-time code from Switch. --name defaults to
      the host name; --description says what the machine is for (optional,
      at most 500 characters, editable later in the gateway).
  run [--data-dir <dir>] [--shared-host-bundle <path>]
      [--controller-id <id> --server <agent-bridge-url> [--name <name>]]
      [--credential-stdin] [--agent-runtime default|separate-user]
      [--releases-dir <dir> | --updated-by-console]
      Run the agents assigned to this machine and report their status.
      --agent-runtime separate-user runs every agent as a Linux user of its
      own, as set up by install-service --separate-users.
      --controller-id and --server adopt an identity enrolled elsewhere when
      the data directory holds none, and move the same identity to a new
      server URL when it holds that one. --credential-stdin reads the
      controller credential from stdin and keeps it in memory only.
      --releases-dir, which install-service passes, is where it installs
      the releases Switch names, beside the ones before.
      --updated-by-console, which Switch Console passes to a controller it
      runs on an SSH host, says Console updates it: it follows no release
      Switch names, and tells Switch so. --provider-seed <file> takes the
      provider checks precheck wrote, so the first report carries them.
  precheck --out <file> --probe-dir <dir> [--shared-host-bundle <path>]
      Check every provider's installation and sign-in as run would, with no
      enrollment, writing the results to <file> as each comes back.
  set-info [--name <name>] [--description <text>] [--data-dir <dir>]
      Rename this machine and/or change its description on the server, with
      this controller's own credential. Either or both; --description ""
      clears the description. The same limits as at enrollment.
  status [--data-dir <dir>] [--shared-host-bundle <path>]
      Show this controller's identity and its agents, from local state only.
  install-service [--data-dir <dir>] [--env-file <path>] [--shared-host-bundle <path>]
      Run this controller as a service of this user: a systemd user unit on
      Linux, a launchd agent on macOS. It starts now and again at each login
      (at boot too, on Linux with lingering on), and restarts after an error
      that may pass. It keeps the PATH of the shell that installed it. It
      runs the controller through <data dir>/releases/current, where it
      installs the releases Switch names and keeps the one before.
  uninstall-service [--data-dir <dir>]
      Stop the service and remove it, and the releases it installed. The
      enrollment and data are kept.
  install-service --separate-users [--user <name>] [--data-dir <dir>]
      [--env-file <path>] [--agents-dir <dir>] [--agent-users <n>] [--no-block]
      [--releases-dir <dir>]
      As root, once (Linux with systemd and polkit): run every agent as a
      Linux user of its own, seeing only its own directory. Makes <n> agent
      users (default 16), a unit template for them, a polkit rule that lets
      the controller start only those units, and runs the controller as a
      system service of --user (default: the user who ran sudo). Node and the
      controller must be installed system-wide. Run it again to change it.
      --no-block queues the controller's start rather than waiting for it,
      for a service the controller's unit is ordered after. --releases-dir
      (default /var/lib/switch-agent-controller-<uid>/releases) is where the
      controller installs the releases Switch names; the units run it
      through <dir>/current.
  uninstall-service --separate-users [--user <name>]
      As root: stop the controller and its agents, and remove what the setup
      made. The agents' directories are kept.
  doctor [--data-dir <dir>] [--shared-host-bundle <path>] [--env-file <path>]
      Check this machine can run agents: Node, enrollment, the credential, the
      server, the provider CLIs and their sign-in, the service, and updates.
  update [--check] [--data-dir <dir>]
      Install the newest release with npm, and restart the service if it runs.
      --check only says whether there is one.

When Switch names a release for this controller, run installs it once no
session runs and exits 7 for its service to start it again on it.

run, install-service and doctor --env-file read NAME=value lines (as for
systemd's EnvironmentFile) into the agents' environment: provider API keys, or
Vertex AI and Bedrock settings such as CLAUDE_CODE_USE_VERTEX,
ANTHROPIC_VERTEX_PROJECT_ID and CLOUD_ML_REGION.
enroll --secret-store keychain|secret-service|file says where the controller
credential is kept: the macOS keychain by default on a Mac, owner-only files
by default elsewhere. secret-service (the desktop keyring) needs an unlocked
keyring whenever the controller starts.

The data directory defaults to SWITCH_CONTROLLER_DATA_DIR, then the OS default.
The shared host bundle defaults to SWITCH_CONTROLLER_SHARED_HOST_BUNDLE, then
the one built in the workspace.
Log level: SWITCH_CONTROLLER_LOG_LEVEL (debug, info, warn, error; default info).
Exit codes: 0 stopped, 1 error that may pass, 2 configuration error,
3 revoked, 4 taken over by another instance, 5 the server needs a newer
controller, 6 the server knows no controller by this credential, 7 restarting
into an update (start it again).
`;

const EXIT_CODE_FOR: Record<ControllerExit, number> = {
  stopped: EXIT_OK,
  revoked: EXIT_REVOKED,
  taken_over: EXIT_TAKEN_OVER,
  upgrade_required: EXIT_UPGRADE_REQUIRED,
  credential_invalid: EXIT_CREDENTIAL_INVALID,
  restarting: EXIT_RESTARTING,
};

function bundlePath(flag: string | undefined): string {
  return resolveSharedHostBundle(flag, process.env, defaultSharedHostBundle);
}

async function openState(dataDirFlag: string | undefined) {
  const dataDir = resolveDataDir(dataDirFlag);
  await ensureDataDir(dataDir);
  const layout = dataLayout(dataDir);
  const store = ControllerStore.open(layout.database);
  const recorded = store.secretStoreKind() ?? 'file';
  if (!isSecretStoreKind(recorded)) {
    store.close();
    throw new ConfigurationError(
      `${dataDir} keeps its credential in '${recorded}', which this version does not know. Update switch-agent-controller.`
    );
  }
  return {
    dataDir,
    layout,
    store,
    secrets: secretStoreFor(recorded, { dir: layout.secrets, dataDir }, runSecretCommand),
  };
}

async function enrollCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      'data-dir': { type: 'string' },
      'secret-store': { type: 'string' },
    },
    strict: true,
  });
  if (!values.server) throw new UsageError('enroll needs --server <agent-bridge-url>.');
  const secretStore = values['secret-store'] ?? defaultSecretStoreKind(process.platform);
  if (!isSecretStoreKind(secretStore))
    throw new UsageError(`--secret-store must be one of ${SECRET_STORE_KINDS.join(', ')}.`);
  if (!values.code) throw new UsageError('enroll needs --code <code>.');
  const server = normalizeServerUrl(values.server);
  const name = values.name ?? hostname();
  const description = values.description?.trim() || undefined;
  if (description !== undefined && description.length > MAX_DESCRIPTION)
    throw new UsageError(`--description must be at most ${MAX_DESCRIPTION} characters.`);
  const { dataDir, layout, store } = await openState(values['data-dir']);
  const secrets = secretStoreFor(secretStore, { dir: layout.secrets, dataDir }, runSecretCommand);
  try {
    const existing = store.identity();
    if (existing && !store.revokedAt())
      throw new ConfigurationError(
        `${dataDir} already belongs to controller ${existing.controllerId} on ${existing.server}. Use another --data-dir, or remove that directory to enroll this machine afresh.`
      );
    // Provider logins given to this machine are sealed to this key; only the
    // machine holds the private half.
    const keys = generateSealingKeyPair();
    const enrolled = await enroll(fetch, server, {
      proof: { kind: 'enrollment_code', code: values.code },
      public_key: { alg: 'X25519', key: keys.publicKey },
      controller: {
        kind: 'daemon',
        name,
        ...(description !== undefined ? { description } : {}),
        platform: contractPlatform(),
        version: VERSION,
      },
    });
    await secrets.set(CONTROLLER_CREDENTIAL, enrolled.credential);
    await secrets.set(SEALING_KEY, JSON.stringify(keys));
    store.saveSecretStoreKind(secretStore);
    store.saveIdentity({
      controllerId: enrolled.controller_id,
      server,
      name,
      enrolledAt: new Date().toISOString(),
    });
    process.stdout.write(
      `Enrolled as controller ${enrolled.controller_id} ("${name}") on ${server}.\nData: ${dataDir}\nRun it as a service: switch-agent-controller install-service${values['data-dir'] ? ` --data-dir ${dataDir}` : ''}\nor in this terminal: switch-agent-controller run${values['data-dir'] ? ` --data-dir ${dataDir}` : ''}\n`
    );
    const warning = secrets.startupWarning();
    if (warning) process.stderr.write(`Warning: ${warning}\n`);
    return EXIT_OK;
  } finally {
    store.close();
  }
}

/** The change `set-info` asks for, checked as the server checks it. */
export function infoChange(values: { name?: string; description?: string }): ControllerInfoChange {
  if (values.name === undefined && values.description === undefined)
    throw new UsageError('set-info needs --name, --description, or both.');
  const change: ControllerInfoChange = {};
  if (values.name !== undefined) {
    const name = values.name.trim();
    if (!name) throw new UsageError('--name must not be blank.');
    if (name.length > MAX_NAME)
      throw new UsageError(`--name must be at most ${MAX_NAME} characters.`);
    change.name = name;
  }
  if (values.description !== undefined) {
    const description = values.description.trim();
    if (description.length > MAX_DESCRIPTION)
      throw new UsageError(`--description must be at most ${MAX_DESCRIPTION} characters.`);
    change.description = description || null;
  }
  return change;
}

async function setInfoCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      'data-dir': { type: 'string' },
    },
    strict: true,
  });
  const change = infoChange(values);
  const { dataDir, store, secrets } = await openState(values['data-dir']);
  try {
    const identity = store.identity();
    if (!identity)
      throw new ConfigurationError(`${dataDir} holds no enrolled controller. Enroll it first.`);
    if (store.revokedAt())
      throw new ConfigurationError(
        `Controller ${identity.controllerId} was revoked; it has to be enrolled again.`
      );
    const credential = await secrets.get(CONTROLLER_CREDENTIAL);
    if (!credential)
      throw new ConfigurationError(
        `${dataDir} holds no controller credential (it is handed over at run time, or was removed). Change the name and description in the gateway's Machines page instead.`
      );
    const log = createLogger({
      level: process.env.SWITCH_CONTROLLER_LOG_LEVEL,
      write: (line) => process.stderr.write(line),
    });
    const client = new ControllerClient({
      fetch,
      server: identity.server,
      controllerId: identity.controllerId,
      version: VERSION,
      tokens: new AccessTokens({
        fetch,
        server: identity.server,
        controllerId: identity.controllerId,
        credential: async () => credential,
        now: Date.now,
        log,
      }),
      openWebSocket: nodeWebSocket,
    });
    const updated = await client.updateInfo(change);
    store.saveName(updated.name);
    process.stdout.write(
      `Controller ${updated.id} is now "${updated.name}"${updated.description ? `: ${updated.description}` : ', with no description'}.\n`
    );
    return EXIT_OK;
  } finally {
    store.close();
  }
}

/**
 * Puts the login shell's PATH, and the user's own bin folders, on this
 * process's: a controller started by a service or an app has neither, and
 * would not find the provider CLIs a person installed.
 */
function pathRefresher(log: Logger): () => Promise<void> {
  return async () => {
    if (process.platform === 'win32') return;
    const shell = process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const path = await loginShellPath(shell, process.env.PATH ?? '');
    if (path === null)
      log.warn(
        "Could not read the login shell's PATH; provider CLIs, git and gh are looked for on this process's own",
        { shell, path: process.env.PATH }
      );
    process.env.PATH = withUserBinDirs(path ?? process.env.PATH ?? '', homedir());
  };
}

/**
 * Checks every provider as `run` would, before there is any enrollment, and
 * writes what it finds to `--out` as each check comes back, for a `run`
 * started later to take (`--provider-seed`).
 */
async function precheckCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      'probe-dir': { type: 'string' },
      'shared-host-bundle': { type: 'string' },
    },
    strict: true,
  });
  if (!values.out || !values['probe-dir'])
    throw new UsageError('precheck needs --out <file> and --probe-dir <dir>.');
  const out = resolve(values.out);
  const probeDir = resolve(values['probe-dir']);
  await mkdir(probeDir, { recursive: true, mode: 0o700 });
  const log = createLogger({
    level: process.env.SWITCH_CONTROLLER_LOG_LEVEL,
    write: (line) => process.stderr.write(line),
  });
  await pathRefresher(log)();
  const sharedHostBundle = bundlePath(values['shared-host-bundle']);
  const providers = new ProviderStatuses({
    locator: new PathProviderLocator(() => process.env.PATH, join(probeDir, 'version-probe')),
    runtime: {
      probe: (provider, binaryPath, cwd) =>
        probeProvider(sharedHostBundle, provider, binaryPath, cwd, process.env),
    },
    sealed: null,
    probeCwd: probeDir,
    verify: providerLoginTest(probeDir),
    now: Date.now,
    log,
    onChange: () => {},
  });
  // One write at a time, each with every result so far.
  let writing = Promise.resolve();
  const write = () => {
    writing = writing.then(() => writeProviderSeed(out, providers.results()));
    return writing;
  };
  // Setting up is when a login that is there but does not work must show.
  await Promise.all(
    PROVIDERS.map((provider) => providers.check(provider, { verify: true }).then(write))
  );
  await writing;
  return EXIT_OK;
}

async function runCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string' },
      'shared-host-bundle': { type: 'string' },
      'controller-id': { type: 'string' },
      server: { type: 'string' },
      name: { type: 'string' },
      'credential-stdin': { type: 'boolean' },
      'env-file': { type: 'string' },
      launchd: { type: 'boolean' },
      'agent-runtime': { type: 'string' },
      'releases-dir': { type: 'string' },
      'updated-by-console': { type: 'boolean' },
      'provider-seed': { type: 'string' },
    },
    strict: true,
  });
  const agentRuntime = values['agent-runtime'] ?? 'default';
  if (agentRuntime !== 'default' && agentRuntime !== 'separate-user')
    throw new UsageError('--agent-runtime must be default or separate-user.');
  if (agentRuntime === 'separate-user' && values['releases-dir'] !== undefined)
    throw new UsageError(
      '--releases-dir is for a service of your user; agents as users of their own read it from their setup.'
    );
  const releasesDir = values['releases-dir'] ? resolve(values['releases-dir']) : null;
  if (values['updated-by-console'] && releasesDir !== null)
    throw new UsageError(
      '--updated-by-console and --releases-dir disagree: a controller Switch Console updates installs no releases of its own.'
    );
  // Before anything reads the environment: the agents inherit it.
  const fromFile = values['env-file'] ? await readEnvFile(resolve(values['env-file'])) : {};
  Object.assign(process.env, fromFile);
  const controllerId = values['controller-id'];
  if ((controllerId === undefined) !== (values.server === undefined))
    throw new UsageError('--controller-id and --server adopt an identity together; pass both.');
  if (values.name !== undefined && controllerId === undefined)
    throw new UsageError('--name names an identity adopted with --controller-id and --server.');
  const log = createLogger({
    level: process.env.SWITCH_CONTROLLER_LOG_LEVEL,
    write: (line) => process.stderr.write(line),
  });
  // Read again on every provider recheck, so a CLI installed since start is found.
  const refreshPath = pathRefresher(log);
  await refreshPath();
  const providerSeed = values['provider-seed']
    ? await readProviderSeed(resolve(values['provider-seed']), log)
    : [];
  const credential = values['credential-stdin']
    ? await readCredential(process.stdin, CREDENTIAL_STDIN_TIMEOUT_MS)
    : null;
  const sharedHostBundle = bundlePath(values['shared-host-bundle']);
  const { dataDir, layout, store, secrets: fileSecrets } = await openState(values['data-dir']);
  let separateUsers: SeparateUsersConfig | null = null;
  if (agentRuntime === 'separate-user') {
    try {
      separateUsers = await loadSeparateUsersConfig(currentUid(), dataDir);
      assertControllerCanRunSeparateUsers(separateUsers);
    } catch (error) {
      store.close();
      throw error;
    }
  }
  const secrets =
    credential === null
      ? fileSecrets
      : new MemorySecretStore({ [CONTROLLER_CREDENTIAL]: credential }, 'handed over on stdin');
  const stop = new AbortController();
  const onSignal = (signal: NodeJS.Signals | 'a stop request') => {
    log.info(`Received ${signal}; stopping this controller's agents and exiting.`);
    stop.abort();
  };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  // Windows has no signal a parent can send that is caught here, so Console
  // asks over the IPC channel it starts this controller with.
  const rechecks = new ProviderRechecks();
  const onMessage = (message: unknown) => {
    if (isStopMessage(message)) onSignal('a stop request');
    if (isProviderRecheckRequest(message)) {
      const reply = (error: string | null) => {
        const answer: ProviderRecheckReply = {
          kind: PROVIDER_RECHECKED_KIND,
          id: message.id,
          error,
        };
        process.send?.(answer);
      };
      rechecks.run().then(
        () => reply(null),
        (error: unknown) => {
          log.warn('Could not check the providers again on request', {
            error: errorMessage(error),
          });
          reply(errorMessage(error));
        }
      );
    }
  };
  process.on('message', onMessage);
  process.channel?.unref();
  if (Object.keys(fromFile).length)
    log.info("Read the agents' environment from a file", {
      file: values['env-file'],
      names: Object.keys(fromFile),
    });
  // A controller Switch Console runs (its own, handed its credential on stdin,
  // or one it starts on an SSH host) is updated with Console, not by itself.
  const updatedBy: UpdatedBy =
    credential !== null || values['updated-by-console'] === true ? 'console' : 'self';
  if (updatedBy === 'self') void announceUpdate(log);
  try {
    const selfUpdate =
      updatedBy === 'self'
        ? new SelfUpdater({
            version: VERSION,
            installer: await installerFor(
              separateUsers,
              releasesDir,
              updateNpm(dataDir),
              process.platform
            ),
            download: (release, signal) =>
              downloadVerified({
                fetch,
                release,
                dir: updatesDir(dataDir),
                maxBytes: MAX_PACKAGE_BYTES,
                signal,
              }),
            attempts: {
              last: () => store.updateAttempt(),
              save: (attempt) => store.saveUpdateAttempt(attempt),
            },
            supervised: isSupervised(separateUsers, values.launchd === true, process.env),
            log,
            now: Date.now,
          })
        : null;
    if (controllerId !== undefined && values.server !== undefined) {
      const previousServer = store.identity()?.server;
      const adopted = adoptIdentity(
        store,
        {
          controllerId,
          server: values.server,
          name: values.name ?? hostname(),
          now: new Date(),
        },
        dataDir
      );
      if (adopted === 'adopted')
        log.info('Adopted an identity enrolled elsewhere', { controllerId, dataDir });
      if (adopted === 'server_changed')
        log.warn('The server URL changed; this controller now talks to the new one', {
          controllerId,
          from: previousServer,
          to: store.identity()?.server,
        });
    }
    const exit = await runController(
      {
        store,
        secrets,
        runtime: (openStream, workspaces) =>
          separateUsers
            ? new SystemdRuntime({
                config: separateUsers,
                store,
                systemctl,
                env: process.env,
                log,
                now: Date.now,
              })
            : new AgentRuntimes(
                new InProcessRuntime({
                  layout,
                  workspaces,
                  bundlePath: sharedHostBundle,
                  openStream,
                  log,
                  crashBackoffMs: 2_000,
                }),
                new DetachedRuntime({ layout, bundlePath: sharedHostBundle })
              ),
        locator: new PathProviderLocator(() => process.env.PATH, join(dataDir, 'version-probe')),
        // Agents running as users of their own sign in as those users, which
        // a test prompt from the controller's user would not show.
        verifyLogin: agentRuntime === 'default' ? providerLoginTest(dataDir) : undefined,
        rechecks,
        refreshPath,
        providerSeed,
        tools: () => toolStatuses(process.env.PATH, process.platform, cliToolsBase()),
        fetch,
        openWebSocket: nodeWebSocket,
        log,
        dataDir,
        // Each agent sees its own directory at the same path: an agent named
        // no directory works in a folder of its own there.
        workspacesFor: separateUsers ? () => unitAgentRoot(separateUsers) : serverWorkspacesDir,
        version: VERSION,
        updatedBy,
        selfUpdate,
        now: Date.now,
        random: Math.random,
        timing: DEFAULT_TIMING,
      },
      stop.signal
    );
    return EXIT_CODE_FOR[exit];
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal);
    process.off('message', onMessage);
    store.close();
  }
}

async function statusCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { 'data-dir': { type: 'string' }, 'shared-host-bundle': { type: 'string' } },
    strict: true,
  });
  const { dataDir, layout, store, secrets } = await openState(values['data-dir']);
  try {
    const separateUsers = await separateUsersConfigHere(dataDir);
    const separateRuntime = separateUsers
      ? new SystemdRuntime({
          config: separateUsers,
          store,
          systemctl,
          env: process.env,
          log: createLogger({ level: 'error', write: (line) => process.stderr.write(line) }),
          now: Date.now,
        })
      : null;
    const out: string[] = [`Data directory: ${dataDir}`];
    if (separateUsers)
      out.push(
        `Agents:         each as a user of its own, in ${separateUsers.agentsDir} (${separateUserNames(separateUsers.uid).controllerUnit})`
      );
    const identity = store.identity();
    if (!identity) {
      out.push('Not enrolled.');
      process.stdout.write(`${out.join('\n')}\n`);
      return 1;
    }
    out.push(
      `Controller:     ${identity.controllerId} ("${identity.name}")`,
      `Server:         ${identity.server}`,
      `Enrolled at:    ${identity.enrolledAt}`,
      `Secret store:   ${secrets.description}`
    );
    const relayPort = store.relayPort();
    out.push(
      `Relay:          ${relayPort === null ? 'never started' : `http://127.0.0.1:${relayPort} (where agents were last pointed)`}`
    );
    const revokedAt = store.revokedAt();
    if (revokedAt) out.push(`Revoked at:     ${revokedAt}`);
    else if (!(await secrets.get(CONTROLLER_CREDENTIAL)))
      out.push('Credential:     not in this data directory (missing, or handed over at run time)');
    const cached = store.cachedAssignment();
    if (cached.kind === 'none') {
      out.push('Assignment:     not pulled yet');
      process.stdout.write(`${out.join('\n')}\n`);
      return 0;
    }
    if (cached.kind === 'unreadable') {
      out.push(
        `Assignment:     saved by an earlier version and not readable by this one (${cached.detail}); pulled again when the controller next runs`
      );
      process.stdout.write(`${out.join('\n')}\n`);
      return 0;
    }
    out.push(
      `Assignment:     revision ${cached.assignment.revision}, ${cached.assignment.agents.length} agent(s)`
    );
    for (const entry of cached.assignment.agents) {
      const row = store.agent(entry.agent_id);
      let observation = emptyObservation();
      let unreadable: string | null = null;
      if (!definitionProblem(entry)) {
        if (separateRuntime)
          observation = await separateRuntime.observe(entry.agent_id).catch((error: unknown) => {
            unreadable = errorMessage(error);
            return emptyObservation();
          });
        else observation = await observeOnDisk(layout, entry.agent_id);
      }
      // Whether events flow is the running controller's to know; this reads only disk.
      const mapped = mapAgentProcess({
        assignment: entry,
        row,
        observation,
        relayAttached: false,
        nowMs: Date.now(),
      });
      out.push(
        '',
        `  ${entry.definition.name} (${entry.agent_id})`,
        `    provider ${entry.definition.provider}, desired ${entry.desired_state}, revision ${entry.revision}, applied ${row?.appliedRevision ?? 'never'}`,
        unreadable && separateUsers
          ? `    ${await unitSummary(separateUsers, store.agentUser(entry.agent_id))}; the rest needs the agents' group (${unreadable})`
          : `    ${mapped.process}${mapped.reason ? ` [${mapped.reason}]` : ''}${mapped.detail ? `: ${mapped.detail}` : ''}`
      );
    }
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } finally {
    store.close();
  }
}

/** Logs that a newer release exists; a check that fails says so at debug and changes nothing. */
async function announceUpdate(log: ReturnType<typeof createLogger>): Promise<void> {
  try {
    const latest = await latestRelease(fetch, releasesRepository(process.env));
    if (latest && isNewer(latest.version, VERSION))
      log.warn(
        `switch-agent-controller ${latest.version} is available (this is ${VERSION}). Install it with: switch-agent-controller update`
      );
  } catch (error) {
    log.debug('Could not check for a newer release', { error: errorMessage(error) });
  }
}

/** Where downloaded releases and npm's cache go: the controller's own data directory. */
function updatesDir(dataDir: string): string {
  return join(dataDir, 'updates');
}

function updateNpm(dataDir: string): NpmSetup {
  return {
    run: runInstallCommand,
    node: process.execPath,
    cacheDir: join(updatesDir(dataDir), 'npm-cache'),
    env: process.env,
  };
}

/**
 * Whether exiting with `EXIT_RESTARTING` starts this controller again: the
 * separate-users runtime only runs as its system service, `--launchd` is the
 * launchd agent, and systemd sets `INVOCATION_ID` for what it runs (whose
 * `Restart=on-failure` restarts a non-zero exit).
 */
export function isSupervised(
  separateUsers: SeparateUsersConfig | null,
  launchd: boolean,
  env: NodeJS.ProcessEnv
): boolean {
  return separateUsers !== null || launchd || Boolean(env.INVOCATION_ID);
}

/** How this controller installs a release for itself, as it was installed. */
export async function installerFor(
  separateUsers: SeparateUsersConfig | null,
  releasesDir: string | null,
  npm: NpmSetup,
  platform: NodeJS.Platform
): Promise<ReleaseInstaller> {
  if (platform === 'win32')
    return unavailableInstaller(
      'This controller updates itself on Linux and macOS only. On Windows, install the release Switch names by hand and start the controller again.'
    );
  if (separateUsers)
    return separateUsers.releasesDir
      ? new ReleasesDirInstaller({ npm, releasesDir: separateUsers.releasesDir })
      : unavailableInstaller(
          'The setup for agents as users of their own predates releases directories; run sudo switch-agent-controller install-service --separate-users again so this controller can update itself.'
        );
  if (releasesDir) {
    const current = await readCurrent(releasesDir);
    return current.kind === 'link'
      ? new ReleasesDirInstaller({ npm, releasesDir })
      : unavailableInstaller(
          `--releases-dir ${releasesDir} has no current link, which install-service makes; run switch-agent-controller install-service again so this controller can update itself.`
        );
  }
  const cli = cliPath();
  const prefix = installPrefix(cli);
  if (!prefix)
    return unavailableInstaller(
      `This controller runs from ${cli}, not an npm install (a checkout?), so it does not update itself.`
    );
  if (await isManagedRelease(prefix))
    return unavailableInstaller(
      `This controller runs from ${prefix}, a releases directory, but without --releases-dir, which the service install-service sets up passes; only that service installs releases there.`
    );
  return new PrefixInstaller({ npm, prefix, cli });
}

/** The CLI file this process runs, through any npm bin link, as a service names it. */
function cliPath(): string {
  const entry = process.argv[1];
  if (!entry) throw new ConfigurationError('Cannot tell which file this CLI runs from.');
  return realpathSync(entry);
}

async function installServiceCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string' },
      'env-file': { type: 'string' },
      'shared-host-bundle': { type: 'string' },
      'separate-users': { type: 'boolean' },
      user: { type: 'string' },
      'agents-dir': { type: 'string' },
      'agent-users': { type: 'string' },
      'no-block': { type: 'boolean' },
      'releases-dir': { type: 'string' },
    },
    strict: true,
  });
  if (values['separate-users']) return installSeparateUsersCommand(values);
  for (const flag of ['user', 'agents-dir', 'agent-users', 'no-block', 'releases-dir'] as const)
    if (values[flag] !== undefined)
      throw new UsageError(`--${flag} is for install-service --separate-users.`);
  const envFile = values['env-file'] ? resolve(values['env-file']) : null;
  // Read now, so a broken file fails here rather than in the service.
  if (envFile) await readEnvFile(envFile);
  const sharedHostBundle = values['shared-host-bundle']
    ? bundlePath(values['shared-host-bundle'])
    : null;
  const { dataDir, store } = await openState(values['data-dir']);
  try {
    if (!store.identity())
      throw new ConfigurationError(
        `${dataDir} is not enrolled. Enroll first: switch-agent-controller enroll --server <url> --code <code>`
      );
  } finally {
    store.close();
  }
  const cli = cliPath();
  const releases = await planServiceReleases(cli, serviceReleasesDir(dataDir));
  const releasesNote = releases
    ? await ensureReleases({
        releasesDir: releases.dir,
        prefix: releases.prefix,
        version: VERSION,
        owner: null,
      })
    : `This controller runs from ${cli}, not an npm install (a checkout?), so it does not update itself.`;
  const report = await installService(
    {
      node: process.execPath,
      cli: releases ? throughCurrent(releases.dir, releases.prefix, cli) : cli,
      dataDir,
      envFile,
      sharedHostBundle:
        releases && sharedHostBundle
          ? throughCurrent(releases.dir, releases.prefix, sharedHostBundle)
          : sharedHostBundle,
      releasesDir: releases?.dir ?? null,
      path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    },
    runSecretCommand
  );
  process.stdout.write(
    [`Installed and started: ${report.file}`, ...report.notes, releasesNote, ''].join('\n')
  );
  return EXIT_OK;
}

/** Where a service of the user's keeps the releases it installs for itself. */
function serviceReleasesDir(dataDir: string): string {
  return join(dataDir, 'releases');
}

/**
 * The releases directory a service of the user's runs through, for the
 * controller at `cli`, and the npm prefix that controller came from; null
 * when it is not an npm install (a checkout), which cannot have one.
 */
export async function planServiceReleases(
  cli: string,
  dir: string
): Promise<{ dir: string; prefix: string } | null> {
  const prefix = installPrefix(cli);
  if (!prefix) return null;
  if ((await isManagedRelease(prefix)) && resolve(dirname(prefix)) !== resolve(dir))
    throw new ConfigurationError(
      `This controller runs from ${prefix}, the releases directory of another setup. Run install-service with the controller npm installed (switch-agent-controller on your PATH).`
    );
  return { dir, prefix };
}

async function installSeparateUsersCommand(values: {
  'data-dir'?: string;
  'env-file'?: string;
  'shared-host-bundle'?: string;
  user?: string;
  'agents-dir'?: string;
  'agent-users'?: string;
  'no-block'?: boolean;
  'releases-dir'?: string;
}): Promise<number> {
  const user = values.user ?? process.env.SUDO_USER;
  if (!user)
    throw new UsageError(
      'install-service --separate-users needs --user <name>, the user the controller runs as, when not run through sudo.'
    );
  const agentUsers =
    values['agent-users'] === undefined ? DEFAULT_AGENT_USERS : Number(values['agent-users']);
  if (!Number.isInteger(agentUsers) || agentUsers < 1 || agentUsers > MAX_AGENT_USERS)
    throw new UsageError(`--agent-users must be a whole number from 1 to ${MAX_AGENT_USERS}.`);
  const envFile = values['env-file'] ? resolve(values['env-file']) : null;
  if (envFile) await readEnvFile(envFile);
  const report = await installSeparateUsers(
    {
      user,
      dataDir: values['data-dir'] ? resolve(values['data-dir']) : null,
      agentsDir: values['agents-dir'] ? resolve(values['agents-dir']) : null,
      agentUsers,
      node: process.execPath,
      cli: cliPath(),
      bundle: bundlePath(values['shared-host-bundle']),
      version: VERSION,
      releasesDir: values['releases-dir'] ? resolve(values['releases-dir']) : null,
      envFile,
      path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      noBlock: values['no-block'] === true,
    },
    runSecretCommand
  );
  process.stdout.write(['Agents now run as users of their own.', ...report.notes, ''].join('\n'));
  return EXIT_OK;
}

async function uninstallServiceCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string' },
      'separate-users': { type: 'boolean' },
      user: { type: 'string' },
    },
    strict: true,
  });
  if (values['separate-users']) {
    const user = values.user ?? process.env.SUDO_USER;
    if (!user)
      throw new UsageError(
        'uninstall-service --separate-users needs --user <name> when not run through sudo.'
      );
    const report = await uninstallSeparateUsers(user, runSecretCommand);
    process.stdout.write(
      ['Removed the setup for agents as users of their own.', ...report.notes, ''].join('\n')
    );
    return EXIT_OK;
  }
  if (values.user !== undefined)
    throw new UsageError('--user is for uninstall-service --separate-users.');
  const dataDir = resolveDataDir(values['data-dir']);
  const removed = await uninstallService(dataDir, runSecretCommand);
  const releasesDir = serviceReleasesDir(dataDir);
  const current = await readCurrent(releasesDir);
  if (current.kind !== 'missing') await rm(releasesDir, { recursive: true, force: true });
  process.stdout.write(
    [
      removed ? 'Stopped and removed the service.' : 'No service was installed.',
      ...(current.kind !== 'missing'
        ? [`Removed the releases it installed for itself, in ${releasesDir}.`]
        : []),
      '',
    ].join('\n')
  );
  return EXIT_OK;
}

async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string' },
      'shared-host-bundle': { type: 'string' },
      'env-file': { type: 'string' },
    },
    strict: true,
  });
  // The agents' environment, as `run` would have it: a provider signed in by a
  // key or token there reads as signed in here too.
  if (values['env-file'])
    Object.assign(process.env, await readEnvFile(resolve(values['env-file'])));
  const { dataDir, store, secrets } = await openState(values['data-dir']);
  const locator = new PathProviderLocator(() => process.env.PATH, join(dataDir, 'version-probe'));
  try {
    const separateUsers = await separateUsersConfigHere(dataDir);
    const separateRuntime = separateUsers
      ? new SystemdRuntime({
          config: separateUsers,
          store,
          systemctl,
          env: process.env,
          log: createLogger({ level: 'error', write: (line) => process.stderr.write(line) }),
          now: Date.now,
        })
      : null;
    const checks = await runDoctor({
      version: VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      dataDir,
      identity: store.identity(),
      revokedAt: store.revokedAt(),
      secrets,
      bundle: () => bundlePath(values['shared-host-bundle']),
      exchange: (server, controllerId, credential) =>
        exchangeToken(fetch, server, controllerId, credential),
      locate: (provider) => locator.locate(provider),
      probe: (bundle, provider, binary) =>
        separateRuntime
          ? separateRuntime.probe(provider, binary, dataDir, null)
          : probeProvider(bundle, provider, binary, dataDir, process.env),
      service: () =>
        separateUsers
          ? systemServiceState(separateUserNames(separateUsers.uid).controllerUnit)
          : serviceState(dataDir, runSecretCommand),
      separateUsers: separateUsers && {
        agentsDir: separateUsers.agentsDir,
        agentUsers: separateUsers.agentUsers,
        controllerUnit: separateUserNames(separateUsers.uid).controllerUnit,
      },
      latest: () => latestRelease(fetch, releasesRepository(process.env)),
    });
    process.stdout.write(`${formatChecks(checks)}\n`);
    return checks.some((check) => check.status === 'fail') ? 1 : EXIT_OK;
  } finally {
    store.close();
  }
}

async function updateCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { check: { type: 'boolean' }, 'data-dir': { type: 'string' } },
    strict: true,
  });
  const latest = await latestRelease(fetch, releasesRepository(process.env));
  if (!latest) {
    process.stdout.write('No switch-agent-controller release is published yet.\n');
    return 1;
  }
  if (!isNewer(latest.version, VERSION)) {
    process.stdout.write(`This is the latest release, ${VERSION}.\n`);
    return EXIT_OK;
  }
  if (values.check) {
    process.stdout.write(
      `${latest.version} is available (this is ${VERSION}). Install it with: switch-agent-controller update\n`
    );
    return EXIT_OK;
  }
  const prefix = installPrefix(cliPath());
  if (prefix && (await isManagedRelease(prefix)))
    throw new ConfigurationError(
      `This controller runs from ${prefix}, a releases directory install-service set up: it installs the release Switch names itself, once no session is mid-turn. To install another by hand, install it with npm and run install-service again.`
    );
  const dataDir = resolveDataDir(values['data-dir']);
  process.stdout.write(`Installing ${latest.version} from ${latest.packageUrl}\n`);
  const { file } = await downloadPackage({
    fetch,
    url: latest.packageUrl,
    dir: updatesDir(dataDir),
    maxBytes: MAX_PACKAGE_BYTES,
    signal: null,
  });
  try {
    await npmInstall(updateNpm(dataDir), prefix, file, null);
  } catch (error) {
    throw new Error(
      `${errorMessage(error)}\nIf npm could not write where the controller is installed, install it again with the installer, which falls back to ~/.local.`
    );
  } finally {
    await rm(file, { force: true });
  }
  const releasesDir = serviceReleasesDir(dataDir);
  if (prefix && (await readCurrent(releasesDir)).kind === 'link')
    process.stdout.write(
      `${await ensureReleases({ releasesDir, prefix, version: latest.version, owner: null })}\n`
    );
  if ((await serviceState(dataDir, runSecretCommand)) === 'running') {
    await restartService(dataDir, runSecretCommand);
    process.stdout.write(`Installed ${latest.version} and restarted the service.\n`);
  } else process.stdout.write(`Installed ${latest.version}.\n`);
  return EXIT_OK;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'enroll':
        return await enrollCommand(rest);
      case 'run': {
        const code = await runCommand(rest).catch((error: unknown) => {
          reportFailure(error);
          return exitCodeFor(error);
        });
        // launchd cannot spare exit codes from a restart; the reason is logged above.
        return rest.includes('--launchd') && LAUNCHD_FINAL_EXIT_CODES.includes(code)
          ? EXIT_OK
          : code;
      }
      case 'set-info':
        return await setInfoCommand(rest);
      case 'status':
        return await statusCommand(rest);
      case 'install-service':
        return await installServiceCommand(rest);
      case 'uninstall-service':
        return await uninstallServiceCommand(rest);
      case 'doctor':
        return await doctorCommand(rest);
      case 'precheck':
        return await precheckCommand(rest);
      case 'update':
        return await updateCommand(rest);
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE);
        return command === undefined ? EXIT_CONFIGURATION : EXIT_OK;
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        return 0;
      case '--protocol':
        process.stdout.write(`${PROTOCOL_VERSION}\n`);
        return 0;
      default:
        throw new UsageError(`Unknown command '${command}'.`);
    }
  } catch (error) {
    reportFailure(error);
    return exitCodeFor(error);
  }
}

/** What systemd says of an agent's unit, for a shell without the agents' group. */
async function unitSummary(config: SeparateUsersConfig, slot: number | null): Promise<string> {
  if (slot === null) return 'no agent user claimed';
  const unit = separateUserNames(config.uid).agentUnit(slot);
  const state = await systemctl(['is-active', unit]).catch(
    (error: { stdout?: string }) => error.stdout ?? 'unknown'
  );
  return `${unit} is ${state.trim()}`;
}

/** The separate-users setup this data directory has, or none: Windows has no Linux users. */
async function separateUsersConfigHere(dataDir: string): Promise<SeparateUsersConfig | null> {
  if (process.platform === 'win32') return null;
  return findSeparateUsersConfig(currentUid(), dataDir);
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ConfigurationError('This platform has no user ids.');
  return uid;
}

/** Whether a system service is running, as a user may ask. */
async function systemServiceState(unit: string): Promise<'running' | 'stopped'> {
  const state = await systemctl(['is-active', unit]).catch(() => 'inactive');
  return state.trim() === 'active' ? 'running' : 'stopped';
}

/** The last line is the reason: a parent that supervises this process shows it. */
function reportFailure(error: unknown): void {
  if (error instanceof UsageError || isParseArgsError(error))
    process.stderr.write(`${USAGE}\nswitch-agent-controller: ${errorMessage(error)}\n`);
  else if (error instanceof ControllerApiError)
    process.stderr.write(`switch-agent-controller: ${error.code}: ${error.message}\n`);
  else process.stderr.write(`switch-agent-controller: ${errorMessage(error)}\n`);
}
