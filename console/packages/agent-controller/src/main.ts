import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateSealingKeyPair } from '@switch-console/agent-providers';
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
import { createLogger, errorMessage } from './log';
import { dataLayout, ensureDataDir, resolveDataDir, serverWorkspacesDir } from './paths';
import { definitionProblem } from './reconcile';
import {
  assertSupportedPlatform,
  emptyObservation,
  InProcessRuntime,
  observeOnDisk,
  probeProvider,
} from './runtime';
import { AgentRuntimes } from './runtimes';
import { type ControllerInfoChange, PROTOCOL_VERSION } from './schemas';
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
  assertControllerCanRunSeparateUsers,
  DEFAULT_AGENT_USERS,
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
import { contractPlatform, mapAgentProcess, PathProviderLocator } from './status';
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
      Run the agents assigned to this machine and report their status.
      --agent-runtime separate-user runs every agent as a Linux user of its
      own, as set up by install-service --separate-users.
      --controller-id and --server adopt an identity enrolled elsewhere when
      the data directory holds none, and move the same identity to a new
      server URL when it holds that one. --credential-stdin reads the
      controller credential from stdin and keeps it in memory only.
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
      that may pass. It keeps the PATH of the shell that installed it.
  uninstall-service [--data-dir <dir>]
      Stop the service and remove it. The enrollment and data are kept.
  install-service --separate-users [--user <name>] [--data-dir <dir>]
      [--env-file <path>] [--agents-dir <dir>] [--agent-users <n>] [--no-block]
      As root, once (Linux with systemd and polkit): run every agent as a
      Linux user of its own, seeing only its own directory. Makes <n> agent
      users (default 16), a unit template for them, a polkit rule that lets
      the controller start only those units, and runs the controller as a
      system service of --user (default: the user who ran sudo). Node and the
      controller must be installed system-wide. Run it again to change it.
      --no-block queues the controller's start rather than waiting for it,
      for a service the controller's unit is ordered after.
  uninstall-service --separate-users [--user <name>]
      As root: stop the controller and its agents, and remove what the setup
      made. The agents' directories are kept.
  doctor [--data-dir <dir>] [--shared-host-bundle <path>]
      Check this machine can run agents: Node, enrollment, the credential, the
      server, the provider CLIs and their sign-in, the service, and updates.
  update [--check] [--data-dir <dir>]
      Install the newest release with npm, and restart the service if it runs.
      --check only says whether there is one.

run --env-file and install-service --env-file read NAME=value lines (as for
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
controller, 6 the server knows no controller by this credential.
`;

const EXIT_CODE_FOR: Record<ControllerExit, number> = {
  stopped: EXIT_OK,
  revoked: EXIT_REVOKED,
  taken_over: EXIT_TAKEN_OVER,
  upgrade_required: EXIT_UPGRADE_REQUIRED,
  credential_invalid: EXIT_CREDENTIAL_INVALID,
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
    },
    strict: true,
  });
  assertSupportedPlatform(process.platform);
  const agentRuntime = values['agent-runtime'] ?? 'default';
  if (agentRuntime !== 'default' && agentRuntime !== 'separate-user')
    throw new UsageError('--agent-runtime must be default or separate-user.');
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
  const onSignal = (signal: NodeJS.Signals) => {
    log.info(`Received ${signal}; stopping this controller's agents and exiting.`);
    stop.abort();
  };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  if (Object.keys(fromFile).length)
    log.info("Read the agents' environment from a file", {
      file: values['env-file'],
      names: Object.keys(fromFile),
    });
  // A controller a parent runs is updated with the parent.
  if (credential === null) void announceUpdate(log);
  try {
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
        locator: new PathProviderLocator(process.env.PATH, join(dataDir, 'version-probe')),
        fetch,
        openWebSocket: nodeWebSocket,
        log,
        dataDir,
        // Each agent sees its own directory at the same path: an agent named
        // no directory works in a folder of its own there.
        workspacesFor: separateUsers ? () => unitAgentRoot(separateUsers) : serverWorkspacesDir,
        version: VERSION,
        now: Date.now,
        random: Math.random,
        timing: DEFAULT_TIMING,
      },
      stop.signal
    );
    return EXIT_CODE_FOR[exit];
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal);
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
    const separateUsers = await findSeparateUsersConfig(currentUid(), dataDir);
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
    },
    strict: true,
  });
  assertSupportedPlatform(process.platform);
  if (values['separate-users']) return installSeparateUsersCommand(values);
  for (const flag of ['user', 'agents-dir', 'agent-users', 'no-block'] as const)
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
  const report = await installService(
    {
      node: process.execPath,
      cli: cliPath(),
      dataDir,
      envFile,
      sharedHostBundle,
      path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    },
    runSecretCommand
  );
  process.stdout.write([`Installed and started: ${report.file}`, ...report.notes, ''].join('\n'));
  return EXIT_OK;
}

async function installSeparateUsersCommand(values: {
  'data-dir'?: string;
  'env-file'?: string;
  'shared-host-bundle'?: string;
  user?: string;
  'agents-dir'?: string;
  'agent-users'?: string;
  'no-block'?: boolean;
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
  const removed = await uninstallService(resolveDataDir(values['data-dir']), runSecretCommand);
  process.stdout.write(
    removed ? 'Stopped and removed the service.\n' : 'No service was installed.\n'
  );
  return EXIT_OK;
}

async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { 'data-dir': { type: 'string' }, 'shared-host-bundle': { type: 'string' } },
    strict: true,
  });
  const { dataDir, store, secrets } = await openState(values['data-dir']);
  const locator = new PathProviderLocator(process.env.PATH, join(dataDir, 'version-probe'));
  try {
    const separateUsers = await findSeparateUsersConfig(currentUid(), dataDir);
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
  process.stdout.write(`Installing ${latest.version} from ${latest.packageUrl}\n`);
  const code = await new Promise<number | null>((done, fail) => {
    const prefix = installPrefix(cliPath());
    const npmArgs = [
      'install',
      '--global',
      ...(prefix ? ['--prefix', prefix] : []),
      latest.packageUrl,
    ];
    const child = spawn('npm', npmArgs, { stdio: 'inherit' });
    child.once('error', fail);
    child.once('exit', done);
  });
  if (code !== 0)
    throw new Error(
      `npm install exited with ${code}. If it could not write where the controller is installed, install it again with the installer, which falls back to ~/.local.`
    );
  const dataDir = resolveDataDir(values['data-dir']);
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
