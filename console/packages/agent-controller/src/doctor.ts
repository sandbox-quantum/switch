import type { ProviderReadiness } from '@switch-console/agent-providers';
import { ControllerApiError } from './api';
import { heading, mark, type Output, paint, summary } from './format';
import { errorMessage } from './log';
import { PROVIDERS, type Provider } from './schemas';
import { CONTROLLER_CREDENTIAL, type SecretStore } from './secrets';
import type { ServiceState } from './service';
import type { LocatedProvider } from './status';
import type { Identity } from './store';
import { type ControllerRelease, isNewer } from './update';

export type CheckStatus = 'ok' | 'warn' | 'fail';
/**
 * One thing `doctor` looked at. `detail` says what it found; `fix`, for a
 * warning or a failure, says what to do about it, or is null when there is
 * nothing to suggest beyond the detail.
 */
export type Check = { name: string; status: CheckStatus; detail: string; fix: string | null };

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

function nodeCheck(nodeVersion: string): Check {
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, '').split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    name: 'Node',
    status: ok ? 'ok' : 'fail',
    detail: ok ? nodeVersion : `${nodeVersion}, older than ${MIN_NODE.join('.')}`,
    fix: ok ? null : `Install Node ${MIN_NODE.join('.')} or later.`,
  };
}

async function serverChecks(inputs: DoctorInputs): Promise<Check[]> {
  if (!inputs.identity)
    return [
      {
        name: 'Enrollment',
        status: 'fail',
        detail: `${inputs.dataDir} is not enrolled`,
        fix: 'switch-agent-controller enroll --server <url> --code <code>, with a code from the Machines page.',
      },
    ];
  const { identity } = inputs;
  const checks: Check[] = [
    {
      name: 'Enrollment',
      status: inputs.revokedAt ? 'fail' : 'ok',
      detail: inputs.revokedAt
        ? `Controller ${identity.controllerId} was revoked at ${inputs.revokedAt}`
        : `Controller ${identity.controllerId} ("${identity.name}") on ${identity.server}`,
      fix: inputs.revokedAt ? 'Enroll this machine again.' : null,
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
      fix: null,
    });
    return checks;
  }
  if (!credential) {
    checks.push({
      name: 'Credential',
      status: 'fail',
      detail: `Not in ${inputs.secrets.description}`,
      fix: 'Enroll this machine again.',
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
    const notTheApi =
      error instanceof ControllerApiError &&
      (error.code === 'invalid_response' || error.code === 'unexpected_response');
    const detail =
      error instanceof ControllerApiError
        ? notTheApi
          ? `${identity.server} answered, but not as the Switch API (${error.message})`
          : `${error.code}: ${error.message}`
        : `${identity.server} cannot be reached: ${errorMessage(error)}`;
    checks.push({
      name: 'Server',
      status: 'fail',
      detail,
      fix: notTheApi
        ? 'If Switch runs behind a proxy or ingress, it must send /v1 to switch-core.'
        : null,
    });
  }
  return checks;
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
        detail: `Installed${version}; sign-in not checked without the shared-host bundle`,
        fix: null,
      });
      continue;
    }
    try {
      const readiness = await inputs.probe(bundle, provider, located.path);
      if (readiness.status === 'authenticated') ready++;
      checks.push({
        name: provider,
        status: readiness.status === 'authenticated' ? 'ok' : 'warn',
        detail: `Installed${version}, ${readiness.status}${readiness.message ? `: ${readiness.message}` : ''}`,
        fix: null,
      });
    } catch (error) {
      checks.push({
        name: provider,
        status: 'warn',
        detail: `Installed${version}; its sign-in could not be checked: ${errorMessage(error)}`,
        fix: null,
      });
    }
  }
  if (ready === 0)
    checks.push({
      name: 'Providers',
      status: 'fail',
      detail:
        'No provider CLI is installed and signed in on PATH for this user, so no agent can run here',
      fix: 'Install one (claude, codex, opencode, cursor or antigravity) and sign in, or set its API key in the --env-file the service runs with.',
    });
  return checks;
}

/** Checks this machine can run the agents Switch places on it, and says what to do where it cannot. */
export async function runDoctor(inputs: DoctorInputs): Promise<Check[]> {
  const checks: Check[] = [nodeCheck(inputs.nodeVersion)];
  const supported = ['darwin', 'linux', 'win32'].includes(inputs.platform);
  checks.push({
    name: 'Platform',
    status: supported ? 'ok' : 'fail',
    detail: supported ? inputs.platform : `${inputs.platform} is not supported`,
    fix: supported ? null : 'Use Linux, macOS or Windows.',
  });
  checks.push(...(await serverChecks(inputs)));
  let bundle: string | null = null;
  try {
    bundle = inputs.bundle();
    checks.push({ name: 'Shared host', status: 'ok', detail: bundle, fix: null });
  } catch (error) {
    checks.push({ name: 'Shared host', status: 'fail', detail: errorMessage(error), fix: null });
  }
  if (inputs.separateUsers)
    checks.push({
      name: 'Agent users',
      status: 'ok',
      detail: `Each agent runs as one of ${inputs.separateUsers.agentUsers} users of its own, in ${inputs.separateUsers.agentsDir}; a provider is ready only through what the --env-file gives agents.`,
      fix: null,
    });
  checks.push(...(await providerChecks(inputs, bundle)));
  const unit = inputs.separateUsers?.controllerUnit;
  const service =
    inputs.platform === 'win32'
      ? 'console'
      : await inputs.service().catch((error: unknown) => errorMessage(error));
  checks.push(
    service === 'console'
      ? {
          name: 'Service',
          status: 'ok',
          detail:
            'Not a service on Windows: Switch Console starts and stops this controller (or keep `run` going yourself)',
          fix: null,
        }
      : service === 'running'
        ? { name: 'Service', status: 'ok', detail: 'Installed and running', fix: null }
        : service === 'stopped'
          ? {
              name: 'Service',
              status: 'warn',
              detail: unit ? `${unit} is not running` : 'Installed, but not running',
              fix: unit ? `sudo systemctl start ${unit}` : null,
            }
          : service === 'not-installed'
            ? {
                name: 'Service',
                status: 'warn',
                detail: 'Not installed',
                fix: 'switch-agent-controller install-service (or keep `run` going yourself)',
              }
            : { name: 'Service', status: 'warn', detail: `Cannot tell: ${service}`, fix: null }
  );
  try {
    const latest = await inputs.latest();
    checks.push(
      !latest
        ? {
            name: 'Version',
            status: 'ok',
            detail: `${inputs.version}; no release is published yet`,
            fix: null,
          }
        : isNewer(latest.version, inputs.version)
          ? {
              name: 'Version',
              status: 'warn',
              detail: `${inputs.version}; ${latest.version} is available`,
              fix: 'switch-agent-controller update',
            }
          : { name: 'Version', status: 'ok', detail: `${inputs.version}, the latest`, fix: null }
    );
  } catch (error) {
    checks.push({
      name: 'Version',
      status: 'warn',
      detail: `${inputs.version}; could not check for a newer one: ${errorMessage(error)}`,
      fix: null,
    });
  }
  return checks;
}

const SERVER_CHECKS = new Set(['Enrollment', 'Credential', 'Server']);
const PROVIDER_CHECKS = new Set<string>([...PROVIDERS, 'Providers']);

/** The section a check is printed under. */
export function checkGroup(name: string): 'Machine' | 'Server' | 'Providers' {
  if (SERVER_CHECKS.has(name)) return 'Server';
  if (PROVIDER_CHECKS.has(name)) return 'Providers';
  return 'Machine';
}

const GROUPS = ['Machine', 'Server', 'Providers'] as const;

/**
 * The checks under Machine, Server and Providers, each with its mark, a fix
 * under any that has one, and a closing count.
 */
export function formatChecks(out: Output, checks: Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  const lines: string[] = [];
  for (const group of GROUPS) {
    const inGroup = checks.filter((check) => checkGroup(check.name) === group);
    if (!inGroup.length) continue;
    if (lines.length) lines.push('');
    lines.push(heading(out, group));
    for (const check of inGroup) {
      lines.push(`  ${mark(out, check.status)}  ${check.name.padEnd(width)}  ${check.detail}`);
      if (check.fix) lines.push(`        ${paint(out, 'dim', `Fix: ${check.fix}`)}`);
    }
  }
  lines.push(
    '',
    summary(
      out,
      checks.map((check) => check.status)
    )
  );
  return lines.join('\n');
}

/** `doctor --json`: every check, and whether any failed, for scripts. */
export function doctorJson(checks: Check[]): string {
  return JSON.stringify({ ok: checks.every((check) => check.status !== 'fail'), checks }, null, 2);
}
