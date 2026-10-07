import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import packageJson from '../package.json' with { type: 'json' };
import { ControllerApiError, enroll, normalizeServerUrl, nodeWebSocket } from './api';
import { DEFAULT_TIMING, runController } from './controller';
import { DetachedRuntime } from './detached-runtime';
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
import { createLogger, errorMessage } from './log';
import { dataLayout, ensureDataDir, resolveDataDir, serverWorkspacesDir } from './paths';
import { definitionProblem } from './reconcile';
import {
  assertSupportedPlatform,
  emptyObservation,
  InProcessRuntime,
  observeOnDisk,
} from './runtime';
import { AgentRuntimes } from './runtimes';
import { CONTROLLER_CREDENTIAL, FileSecretStore, MemorySecretStore } from './secrets';
import { contractPlatform, mapAgentProcess, PathProviderLocator } from './status';
import { ControllerStore } from './store';

export const VERSION: string = packageJson.version;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

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
    },
    strict: true,
  });
  assertSupportedPlatform(process.platform);
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
          new AgentRuntimes(
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
        locator: new PathProviderLocator(process.env.PATH),
        fetch,
        openWebSocket: nodeWebSocket,
        log,
        dataDir,
        workspacesFor: serverWorkspacesDir,
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
