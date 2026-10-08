import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import packageJson from '../package.json' with { type: 'json' };
import {
  ControllerApiError,
  enroll,
  type Fetch,
  normalizeServerUrl,
  withHostIdentity,
} from './api';
import { type ControllerDeps, DEFAULT_TIMING, runController } from './controller';
import { DetachedRuntime } from './detached-runtime';
import { groupId, readCredentialFile, readEc2Config } from './ec2/config';
import { kmsDecrypter } from './ec2/kms';
import { SealedLogins } from './ec2/sealed-logins';
import { ConfigurationError, UsageError } from './errors';
import {
  EXIT_CONFIGURATION,
  EXIT_OK,
  EXIT_REVOKED,
  EXIT_TAKEN_OVER,
  exitCodeFor,
  isParseArgsError,
} from './exit-codes';
import {
  adoptIdentity,
  CREDENTIAL_STDIN_TIMEOUT_MS,
  readCredential,
  resolveSharedHostBundle,
  workspaceSharedHostBundle,
} from './handover';
import { createLogger, errorMessage, type Logger, routeConsoleTo } from './log';
import { dataLayout, ec2Layout, ensureDataDir, resolveDataDir, serverWorkspacesDir } from './paths';
import { definitionProblem } from './reconcile';
import {
  assertSupportedPlatform,
  emptyObservation,
  InProcessRuntime,
  observeOnDisk,
} from './runtime';
import { AgentRuntimes } from './runtimes';
import {
  CONTROLLER_CREDENTIAL,
  FileSecretStore,
  MemorySecretStore,
  type SecretStore,
} from './secrets';
import {
  contractPlatform,
  FixedProviderLocator,
  mapAgentProcess,
  PathProviderLocator,
  type ProviderLocator,
} from './status';
import { ControllerStore } from './store';
import { SystemdRuntime, systemctl } from './systemd-runtime';

export const VERSION: string = packageJson.version;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const EC2_DATA_ROOT = '/data';
const EC2_RUN_ROOT = '/run/switch-controller';
const EC2_AGENT_GROUP = 'switch-agent';

const USAGE = `Usage: switch-agent-controller <command> [options]

Commands:
  enroll --server <agent-bridge-url> --code <code> [--name <name>]
      [--description <text>] [--data-dir <dir>]
      Enroll this machine with a one-time code from Switch. --name defaults to
      the host name; --description says what the machine is for (optional,
      at most 500 characters, editable later in the gateway).
  run [--data-dir <dir>] [--shared-host-bundle <path>]
      [--controller-id <id> --server <agent-bridge-url> [--name <name>]]
      [--credential-stdin]
      Run the agents assigned to this machine and report their status.
      --controller-id and --server adopt an identity enrolled elsewhere when
      the data directory holds none, and move the same identity to a new
      server URL when it holds that one. --credential-stdin reads the
      controller credential from stdin and keeps it in memory only.
  run --ec2 --config <machine.json> (--credential-file <file> | --credential-stdin)
      [--data-dir <dir>]
      Run a cloud machine's agents as systemd units, with the identity, relay
      port, provider executables and sealed-login key its machine
      configuration names. --data-dir defaults to /data/.switch-controller.
  status [--data-dir <dir>] [--shared-host-bundle <path>]
      Show this controller's identity and its agents, from local state only.

The data directory defaults to SWITCH_CONTROLLER_DATA_DIR, then the OS default.
The shared host bundle defaults to SWITCH_CONTROLLER_SHARED_HOST_BUNDLE, then
the one built in the workspace.
Log level: SWITCH_CONTROLLER_LOG_LEVEL (debug, info, warn, error; default info).
Exit codes: 0 stopped, 1 error that may pass, 2 configuration error,
3 revoked, 4 taken over by another instance.
`;

function bundlePath(flag: string | undefined): string {
  return resolveSharedHostBundle(flag, process.env, workspaceSharedHostBundle);
}

async function openState(dataDirFlag: string | undefined) {
  const dataDir = resolveDataDir(dataDirFlag);
  await ensureDataDir(dataDir);
  const layout = dataLayout(dataDir);
  return {
    dataDir,
    layout,
    store: ControllerStore.open(layout.database),
    secrets: new FileSecretStore(layout.secrets),
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
    },
    strict: true,
  });
  if (!values.server) throw new UsageError('enroll needs --server <agent-bridge-url>.');
  if (!values.code) throw new UsageError('enroll needs --code <code>.');
  const server = normalizeServerUrl(values.server);
  const name = values.name ?? hostname();
  const description = values.description?.trim() || undefined;
  if (description !== undefined && description.length > 500)
    throw new UsageError('--description must be at most 500 characters.');
  const { dataDir, store, secrets } = await openState(values['data-dir']);
  try {
    const existing = store.identity();
    if (existing && !store.revokedAt())
      throw new ConfigurationError(
        `${dataDir} already belongs to controller ${existing.controllerId} on ${existing.server}. Use another --data-dir, or remove that directory to enroll this machine afresh.`
      );
    const enrolled = await enroll(fetch, server, {
      proof: { kind: 'enrollment_code', code: values.code },
      controller: {
        kind: 'daemon',
        name,
        ...(description !== undefined ? { description } : {}),
        platform: contractPlatform(),
        version: VERSION,
      },
    });
    await secrets.set(CONTROLLER_CREDENTIAL, enrolled.credential);
    store.saveIdentity({
      controllerId: enrolled.controller_id,
      server,
      name,
      enrolledAt: new Date().toISOString(),
    });
    process.stdout.write(
      `Enrolled as controller ${enrolled.controller_id} ("${name}") on ${server}.\nData: ${dataDir}\nStart it with: switch-agent-controller run${values['data-dir'] ? ` --data-dir ${dataDir}` : ''}\n`
    );
    process.stderr.write(`Warning: ${secrets.startupWarning()}\n`);
    return EXIT_OK;
  } finally {
    store.close();
  }
}

type RunSetup = {
  dataDir: string;
  store: ControllerStore;
  secrets: SecretStore;
  identity: { controllerId: string; server: string; name: string } | null;
  runtime: ControllerDeps['runtime'];
  sealedLoginChanged: ControllerDeps['sealedLoginChanged'];
  pinnedRelayPort: ControllerDeps['pinnedRelayPort'];
  locator: ProviderLocator;
  fetch: Fetch;
  workspacesFor: (server: string) => string;
  close: () => Promise<void>;
};

async function localRun(
  values: {
    'data-dir'?: string;
    'shared-host-bundle'?: string;
    'controller-id'?: string;
    server?: string;
    name?: string;
  },
  credential: string | null,
  log: Logger
): Promise<RunSetup> {
  const controllerId = values['controller-id'];
  if ((controllerId === undefined) !== (values.server === undefined))
    throw new UsageError('--controller-id and --server adopt an identity together; pass both.');
  if (values.name !== undefined && controllerId === undefined)
    throw new UsageError('--name names an identity adopted with --controller-id and --server.');
  const sharedHostBundle = bundlePath(values['shared-host-bundle']);
  const { dataDir, layout, store, secrets: fileSecrets } = await openState(values['data-dir']);
  return {
    dataDir,
    store,
    secrets:
      credential === null
        ? fileSecrets
        : new MemorySecretStore({ [CONTROLLER_CREDENTIAL]: credential }, 'handed over on stdin'),
    identity:
      controllerId !== undefined && values.server !== undefined
        ? { controllerId, server: values.server, name: values.name ?? hostname() }
        : null,
    runtime: (openStream, workspaces, control) =>
      new AgentRuntimes(
        new InProcessRuntime({
          layout,
          workspaces,
          bundlePath: sharedHostBundle,
          openStream,
          log,
          crashBackoffMs: 2_000,
          control,
        }),
        new DetachedRuntime({ layout, bundlePath: sharedHostBundle })
      ),
    locator: new PathProviderLocator(process.env.PATH),
    fetch,
    sealedLoginChanged: null,
    pinnedRelayPort: null,
    workspacesFor: serverWorkspacesDir,
    close: async () => {},
  };
}

/**
 * A cloud machine: identity, relay port and provider executables from the
 * machine configuration, agents as systemd units, provider logins sealed by
 * Switch for this machine.
 */
async function ec2Run(
  values: { 'data-dir'?: string; config?: string; 'credential-file'?: string },
  stdinCredential: string | null,
  log: Logger
): Promise<RunSetup> {
  if (!values.config) throw new UsageError('--ec2 needs --config <machine-configuration>.');
  if ((values['credential-file'] === undefined) === (stdinCredential === null))
    throw new UsageError(
      '--ec2 needs exactly one of --credential-file <file> and --credential-stdin.'
    );
  const config = await readEc2Config(values.config);
  const credential =
    stdinCredential ?? (await readCredentialFile(values['credential-file'] as string));
  const agentGroupId = await groupId(EC2_AGENT_GROUP, '/etc/group');
  const { dataDir, store } = await openState(
    values['data-dir'] ?? join(EC2_DATA_ROOT, '.switch-controller')
  );
  const hostFetch = withHostIdentity(fetch, {
    instanceId: config.instanceId,
    bootId: config.bootId,
  });
  const layout = ec2Layout({ dataRoot: EC2_DATA_ROOT, runRoot: EC2_RUN_ROOT });
  let logins: SealedLogins | undefined;
  let systemd: SystemdRuntime | undefined;
  return {
    dataDir,
    store,
    secrets: new MemorySecretStore(
      { [CONTROLLER_CREDENTIAL]: credential },
      values['credential-file'] === undefined
        ? 'handed over on stdin'
        : 'the machine credential file'
    ),
    identity: { controllerId: config.controllerId, server: config.server, name: hostname() },
    runtime: (_openStream, _workspaces, _control, client) => {
      logins = new SealedLogins({
        fetchEnvelope: (provider) => client.providerCredential(provider),
        decrypt: kmsDecrypter({ region: config.kms.region, endpoint: config.kms.endpoint }),
        kms: {
          keyArn: config.kms.keyArn,
          grantTokens: config.kms.grantTokens,
          context: config.kms.context,
        },
        layout,
        log,
      });
      systemd = new SystemdRuntime({
        layout,
        systemctl,
        logins,
        agentGroupId,
        log,
        now: Date.now,
        idleCheckMs: 60_000,
        forceRestartAfterMs: 30 * 60_000,
      });
      return new AgentRuntimes(systemd, systemd);
    },
    sealedLoginChanged: async (provider) => {
      if (!logins) throw new Error('A sealed login changed before the agents runtime was built.');
      await logins.current(provider);
    },
    pinnedRelayPort: config.relayPort,
    locator: new FixedProviderLocator(config.providers),
    fetch: hostFetch,
    workspacesFor: () => layout.worktreesRoot,
    close: async () => {
      await systemd?.close();
    },
  };
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
      ec2: { type: 'boolean' },
      config: { type: 'string' },
      'credential-file': { type: 'string' },
    },
    strict: true,
  });
  assertSupportedPlatform(process.platform);
  if (values.ec2) {
    const local = (['shared-host-bundle', 'controller-id', 'server', 'name'] as const).find(
      (flag) => values[flag] !== undefined
    );
    if (local)
      throw new UsageError(
        `--${local} does not apply with --ec2; the machine configuration says it.`
      );
  } else if (values.config !== undefined || values['credential-file'] !== undefined)
    throw new UsageError('--config and --credential-file run a cloud machine; pass --ec2.');
  const log = createLogger({
    level: process.env.SWITCH_CONTROLLER_LOG_LEVEL,
    write: (line) => process.stderr.write(line),
  });
  routeConsoleTo(log);
  const credential = values['credential-stdin']
    ? await readCredential(process.stdin, CREDENTIAL_STDIN_TIMEOUT_MS)
    : null;
  const setup = values.ec2
    ? await ec2Run(values, credential, log)
    : await localRun(values, credential, log);
  const { dataDir, store } = setup;
  const stop = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    log.info(`Received ${signal}; stopping this controller's agents and exiting.`);
    stop.abort();
  };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  try {
    if (setup.identity !== null) {
      const { controllerId } = setup.identity;
      const previousServer = store.identity()?.server;
      const adopted = adoptIdentity(store, { ...setup.identity, now: new Date() }, dataDir);
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
        secrets: setup.secrets,
        runtime: setup.runtime,
        sealedLoginChanged: setup.sealedLoginChanged,
        pinnedRelayPort: setup.pinnedRelayPort,
        locator: setup.locator,
        fetch: setup.fetch,
        log,
        dataDir,
        workspacesFor: setup.workspacesFor,
        version: VERSION,
        now: Date.now,
        random: Math.random,
        timing: DEFAULT_TIMING,
      },
      stop.signal
    );
    return exit === 'revoked' ? EXIT_REVOKED : exit === 'taken_over' ? EXIT_TAKEN_OVER : EXIT_OK;
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal);
    await setup.close();
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
    const out: string[] = [`Data directory: ${dataDir}`];
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
      const observation = definitionProblem(entry)
        ? emptyObservation()
        : await observeOnDisk(layout, entry.agent_id);
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
        `    ${mapped.process}${mapped.reason ? ` [${mapped.reason}]` : ''}${mapped.detail ? `: ${mapped.detail}` : ''}`
      );
    }
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } finally {
    store.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'enroll':
        return await enrollCommand(rest);
      case 'run':
        return await runCommand(rest);
      case 'status':
        return await statusCommand(rest);
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE);
        return command === undefined ? EXIT_CONFIGURATION : EXIT_OK;
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        return 0;
      default:
        throw new UsageError(`Unknown command '${command}'.`);
    }
  } catch (error) {
    // The last line is the reason: a parent that supervises this process shows it.
    if (error instanceof UsageError || isParseArgsError(error))
      process.stderr.write(`${USAGE}\nswitch-agent-controller: ${errorMessage(error)}\n`);
    else if (error instanceof ControllerApiError)
      process.stderr.write(`switch-agent-controller: ${error.code}: ${error.message}\n`);
    else process.stderr.write(`switch-agent-controller: ${errorMessage(error)}\n`);
    return exitCodeFor(error);
  }
}
