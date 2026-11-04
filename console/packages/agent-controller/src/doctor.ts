import type { ProviderReadiness } from '@switch-console/agent-providers';
import { ControllerApiError } from './api';
import { errorMessage } from './log';
import { type Mark, type Printer } from './output';
import { PROVIDERS, type Provider } from './schemas';
import { CONTROLLER_CREDENTIAL, type SecretStore } from './secrets';
import type { ServiceState } from './service';
import type { LocatedProvider } from './status';
import type { Identity } from './store';
import { type ControllerRelease, isNewer } from './update';

/**
 * One thing `doctor` looked at. A check that is not `ok` always carries the
 * `fix` that clears it, so a reader never faces a bare failure mark.
 */
export type Check = { name: string; status: Mark; detail: string; fix: string | null };

/** The oldest Node the controller runs on: it needs the built-in `node:sqlite`. */
export const MIN_NODE: readonly [number, number] = [22, 13];

/** Everything `doctor` looks at, so it can be checked without the machine it describes. */
export type DoctorInputs = {
  version: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  dataDir: string;
  identity: Identity | null;
  revokedAt: string | null;
  secrets: SecretStore;
  /** The shared-host bundle's path; throws when there is none. */
  bundle: () => string;
  /** Exchanges the credential for a token: proof the server is reached and accepts it. */
  exchange: (server: string, controllerId: string, credential: string) => Promise<unknown>;
  locate: (provider: Provider) => Promise<LocatedProvider | null>;
  probe: (bundle: string, provider: Provider, binary: string) => Promise<ProviderReadiness>;
  service: () => Promise<ServiceState>;
  latest: () => Promise<ControllerRelease | null>;
  /** The setup that runs every agent as a user of its own, or null when agents run as this user. */
  separateUsers: { agentsDir: string; agentUsers: number; controllerUnit: string } | null;
};

/** How to enroll this machine, named as the reader would type it. */
function enrollFix(server: string | null): string {
  return `switch-agent-controller enroll --server ${server ?? '<url>'} --code <code>, with a code from the gateway's Machines page`;
}

function nodeCheck(nodeVersion: string): Check {
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, '').split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  if (ok) return { name: 'Node', status: 'ok', detail: nodeVersion, fix: null };
  return {
    name: 'Node',
    status: 'fail',
    detail: `${nodeVersion}, older than the ${MIN_NODE.join('.')} the controller needs.`,
    fix: `install Node ${MIN_NODE.join('.')} or later and run the controller with it`,
  };
}

async function serverChecks(inputs: DoctorInputs): Promise<Check[]> {
  if (!inputs.identity)
    return [
      {
        name: 'Enrollment',
        status: 'fail',
        detail: `${inputs.dataDir} is not enrolled.`,
        fix: enrollFix(null),
      },
    ];
  const { identity } = inputs;
  const checks: Check[] = [
    inputs.revokedAt
      ? {
          name: 'Enrollment',
          status: 'fail',
          detail: `Controller ${identity.controllerId} was revoked at ${inputs.revokedAt}.`,
          fix: enrollFix(identity.server),
        }
      : {
          name: 'Enrollment',
          status: 'ok',
          detail: `Controller ${identity.controllerId} ("${identity.name}") on ${identity.server}`,
          fix: null,
        },
  ];
  if (inputs.revokedAt) return checks;
  let credential: string | null;
  try {
    credential = await inputs.secrets.get(CONTROLLER_CREDENTIAL);
  } catch (error) {
    checks.push({
      name: 'Credential',
      status: 'fail',
      detail: `Cannot read it from ${inputs.secrets.description}: ${errorMessage(error)}`,
      fix: 'make the secret store readable (an unlocked keyring, say) and run doctor again',
    });
    return checks;
  }
  if (!credential) {
    checks.push({
      name: 'Credential',
      status: 'fail',
      detail: `Not in ${inputs.secrets.description}.`,
      fix: enrollFix(identity.server),
    });
    return checks;
  }
  checks.push({
    name: 'Credential',
    status: 'ok',
    detail: `In ${inputs.secrets.description}`,
    fix: null,
  });
  try {
    await inputs.exchange(identity.server, identity.controllerId, credential);
    checks.push({
      name: 'Server',
      status: 'ok',
      detail: `${identity.server} accepts this controller`,
      fix: null,
    });
  } catch (error) {
    checks.push({ name: 'Server', status: 'fail', ...serverFailure(identity.server, error) });
  }
  return checks;
}

/** What a refused or unreachable server says, and what to do about it. */
function serverFailure(server: string, error: unknown): { detail: string; fix: string } {
  if (!(error instanceof ControllerApiError))
    return {
      detail: `${server} cannot be reached: ${errorMessage(error)}`,
      fix: "check the URL, this machine's network and any proxy in the way",
    };
  if (error.code === 'invalid_response' || error.code === 'unexpected_response')
    return {
      detail: `${server} answered, but not as the Switch API (${error.message}).`,
      fix: 'if Switch runs behind a proxy or ingress, it must send /v1 to switch-core',
    };
  return {
    detail: `${error.code}: ${error.message}`,
    fix: `check ${server} is the Switch agent bridge URL and still knows this controller`,
  };
}

async function providerChecks(inputs: DoctorInputs, bundle: string | null): Promise<Check[]> {
  const checks: Check[] = [];
  let ready = 0;
  for (const provider of PROVIDERS) {
    const located = await inputs.locate(provider);
    if (!located) continue;
    const version = located.version ? ` ${located.version}` : '';
    if (!bundle) {
      checks.push({
        name: provider,
        status: 'warn',
        detail: `Installed${version}; sign-in not checked without the shared-host bundle.`,
        fix: 'clear the Shared host check above, then run doctor again',
      });
      continue;
    }
    try {
      const readiness = await inputs.probe(bundle, provider, located.path);
      if (readiness.status === 'authenticated') ready++;
      const detail = `Installed${version}, ${readiness.status}${readiness.message ? `: ${readiness.message}` : ''}`;
      checks.push({
        name: provider,
        status: readiness.status === 'authenticated' ? 'ok' : 'warn',
        detail,
        fix:
          readiness.status === 'authenticated'
            ? null
            : `sign ${provider} in on this machine, or set its API key in the --env-file the service runs with`,
      });
    } catch (error) {
      checks.push({
        name: provider,
        status: 'warn',
        detail: `Installed${version}; its sign-in could not be checked: ${errorMessage(error)}`,
        fix: `run ${provider} once as this user to see what it reports`,
      });
    }
  }
  if (ready === 0)
    checks.push({
      name: 'Providers',
      status: 'fail',
      detail: 'No provider CLI is installed and signed in on PATH for this user.',
      fix: 'install one of claude, codex, opencode, cursor or antigravity and sign in, or set its API key in the --env-file the service runs with',
    });
  return checks;
}

/** What the service manager says, and what to do when it is not running the controller. */
function serviceCheck(state: ServiceState | 'console' | string, unit: string | undefined): Check {
  if (state === 'console')
    return {
      name: 'Service',
      status: 'ok',
      detail:
        'Not a service on Windows: Switch Console starts and stops this controller (or keep `run` going yourself)',
      fix: null,
    };
  if (state === 'running')
    return { name: 'Service', status: 'ok', detail: 'Installed and running', fix: null };
  if (state === 'stopped')
    return {
      name: 'Service',
      status: 'warn',
      detail: unit ? `${unit} is not running.` : 'Installed, but not running.',
      fix: unit ? `sudo systemctl start ${unit}` : 'switch-agent-controller install-service',
    };
  if (state === 'not-installed')
    return {
      name: 'Service',
      status: 'warn',
      detail: 'Not installed.',
      fix: 'switch-agent-controller install-service (or keep `run` going yourself)',
    };
  return {
    name: 'Service',
    status: 'warn',
    detail: `Cannot tell: ${state}`,
    fix: "check this user's service manager is reachable",
  };
}

async function versionCheck(inputs: DoctorInputs): Promise<Check> {
  let latest: ControllerRelease | null;
  try {
    latest = await inputs.latest();
  } catch (error) {
    return {
      name: 'Version',
      status: 'warn',
      detail: `${inputs.version}; could not check for a newer one: ${errorMessage(error)}`,
      fix: 'check this machine can reach GitHub, or install the newest release by hand',
    };
  }
  if (!latest)
    return {
      name: 'Version',
      status: 'ok',
      detail: `${inputs.version}; no release is published yet`,
      fix: null,
    };
  if (isNewer(latest.version, inputs.version))
    return {
      name: 'Version',
      status: 'warn',
      detail: `${inputs.version}; ${latest.version} is available.`,
      fix: 'switch-agent-controller update',
    };
  return { name: 'Version', status: 'ok', detail: `${inputs.version}, the latest`, fix: null };
}

/** Checks this machine can run the agents Switch places on it, and says what to do where it cannot. */
export async function runDoctor(inputs: DoctorInputs): Promise<Check[]> {
  const checks: Check[] = [nodeCheck(inputs.nodeVersion)];
  const supported = ['darwin', 'linux', 'win32'].includes(inputs.platform);
  checks.push({
    name: 'Platform',
    status: supported ? 'ok' : 'fail',
    detail: supported ? inputs.platform : `${inputs.platform} is not supported.`,
    fix: supported ? null : 'run the controller on Linux, macOS or Windows',
  });
  checks.push(...(await serverChecks(inputs)));
  let bundle: string | null = null;
  try {
    bundle = inputs.bundle();
    checks.push({ name: 'Shared host', status: 'ok', detail: bundle, fix: null });
  } catch (error) {
    checks.push({
      name: 'Shared host',
      status: 'fail',
      detail: errorMessage(error),
      fix: 'install switch-agent-controller again, or pass --shared-host-bundle <path>',
    });
  }
  if (inputs.separateUsers)
    checks.push({
      name: 'Agent users',
      status: 'ok',
      detail: `Each agent runs as one of ${inputs.separateUsers.agentUsers} users of its own, in ${inputs.separateUsers.agentsDir}; a provider is ready only through what the --env-file gives agents.`,
      fix: null,
    });
  checks.push(...(await providerChecks(inputs, bundle)));
  checks.push(
    serviceCheck(
      inputs.platform === 'win32'
        ? 'console'
        : await inputs.service().catch((error: unknown) => errorMessage(error)),
      inputs.separateUsers?.controllerUnit
    )
  );
  checks.push(await versionCheck(inputs));
  return checks;
}

/**
 * `doctor --json` on stdout, and nothing else on it. The shape is stable:
 * fields are added, never renamed or dropped, so a script may read it across
 * controller versions.
 *
 * - `schema`     — this document's name and version.
 * - `version`    — the controller that ran the checks.
 * - `ok`         — true when no check failed; it matches the exit code (0 / 1).
 * - `checks[]`   — one per check, in the order `doctor` prints them:
 *   - `name`     — what was checked ("Node", "Server", a provider's name).
 *   - `status`   — "ok", "warn" or "fail".
 *   - `detail`   — what was found.
 *   - `fix`      — how to clear it, or null when there is nothing to fix.
 */
export type DoctorDocument = {
  schema: 'switch-agent-controller/doctor@1';
  version: string;
  ok: boolean;
  checks: Check[];
};

export function doctorDocument(version: string, checks: Check[]): DoctorDocument {
  return { schema: 'switch-agent-controller/doctor@1', version, ok: doctorPassed(checks), checks };
}

/** Whether `doctor` ends with 0: a warning is not a failure, and never was. */
export function doctorPassed(checks: Check[]): boolean {
  return !checks.some((check) => check.status === 'fail');
}

export function renderDoctor(printer: Printer, document: DoctorDocument): void {
  printer.title(`switch-agent-controller doctor: ${document.version}`);
  printer.heading('Checks');
  printer.checks(document.checks);
  const failed = document.checks.filter((check) => check.status === 'fail').length;
  const warned = document.checks.filter((check) => check.status === 'warn').length;
  printer.blank();
  if (document.ok && warned === 0) {
    printer.line(printer.paint('This machine can run agents.', 'green'));
    return;
  }
  printer.line(
    `${count(failed, 'problem')}, ${count(warned, 'warning')}; the fix for each is on its line above.`
  );
}

function count(many: number, thing: string): string {
  return `${many} ${thing}${many === 1 ? '' : 's'}`;
}
