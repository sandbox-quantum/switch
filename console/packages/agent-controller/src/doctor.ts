import type { ProviderReadiness } from '@switch-console/agent-providers';
import { ControllerApiError } from './api';
import { errorMessage } from './log';
import { PROVIDERS, type Provider } from './schemas';
import { CONTROLLER_CREDENTIAL, type SecretStore } from './secrets';
import type { ServiceState } from './service';
import type { LocatedProvider } from './status';
import type { Identity } from './store';
import { type ControllerRelease, isNewer } from './update';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type Check = { name: string; status: CheckStatus; detail: string };

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
    detail: ok
      ? nodeVersion
      : `${nodeVersion}; the controller needs ${MIN_NODE.join('.')} or later.`,
  };
}

async function serverChecks(inputs: DoctorInputs): Promise<Check[]> {
  if (!inputs.identity)
    return [
      {
        name: 'Enrollment',
        status: 'fail',
        detail: `${inputs.dataDir} is not enrolled. Run: switch-agent-controller enroll --server <url> --code <code>, with a code from the Machines page.`,
      },
    ];
  const { identity } = inputs;
  const checks: Check[] = [
    {
      name: 'Enrollment',
      status: inputs.revokedAt ? 'fail' : 'ok',
      detail: inputs.revokedAt
        ? `Controller ${identity.controllerId} was revoked at ${inputs.revokedAt}; enroll this machine again.`
        : `Controller ${identity.controllerId} ("${identity.name}") on ${identity.server}`,
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
    });
    return checks;
  }
  if (!credential) {
    checks.push({
      name: 'Credential',
      status: 'fail',
      detail: `Not in ${inputs.secrets.description}; enroll this machine again.`,
    });
    return checks;
  }
  checks.push({ name: 'Credential', status: 'ok', detail: `In ${inputs.secrets.description}` });
  try {
    await inputs.exchange(identity.server, identity.controllerId, credential);
    checks.push({
      name: 'Server',
      status: 'ok',
      detail: `${identity.server} accepts this controller`,
    });
  } catch (error) {
    const detail =
      error instanceof ControllerApiError
        ? error.code === 'invalid_response' || error.code === 'unexpected_response'
          ? `${identity.server} answered, but not as the Switch API (${error.message}). If Switch runs behind a proxy or ingress, it must send /v1 to switch-core.`
          : `${error.code}: ${error.message}`
        : `${identity.server} cannot be reached: ${errorMessage(error)}`;
    checks.push({ name: 'Server', status: 'fail', detail });
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
        detail: `Installed${version}; sign-in not checked without the shared-host bundle.`,
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
      });
    } catch (error) {
      checks.push({
        name: provider,
        status: 'warn',
        detail: `Installed${version}; its sign-in could not be checked: ${errorMessage(error)}`,
      });
    }
  }
  if (ready === 0)
    checks.push({
      name: 'Providers',
      status: 'fail',
      detail:
        'No provider CLI is installed and signed in on PATH for this user, so no agent can run here. Install one (claude, codex, opencode, cursor or antigravity) and sign in, or set its API key in the --env-file the service runs with.',
    });
  return checks;
}

/** Checks this machine can run the agents Switch places on it, and says what to do where it cannot. */
export async function runDoctor(inputs: DoctorInputs): Promise<Check[]> {
  const checks: Check[] = [nodeCheck(inputs.nodeVersion)];
  const supported = inputs.platform === 'darwin' || inputs.platform === 'linux';
  checks.push({
    name: 'Platform',
    status: supported ? 'ok' : 'fail',
    detail: supported
      ? inputs.platform
      : `${inputs.platform} is not supported; use Linux or macOS.`,
  });
  checks.push(...(await serverChecks(inputs)));
  let bundle: string | null = null;
  try {
    bundle = inputs.bundle();
    checks.push({ name: 'Shared host', status: 'ok', detail: bundle });
  } catch (error) {
    checks.push({ name: 'Shared host', status: 'fail', detail: errorMessage(error) });
  }
  if (inputs.separateUsers)
    checks.push({
      name: 'Agent users',
      status: 'ok',
      detail: `Each agent runs as one of ${inputs.separateUsers.agentUsers} users of its own, in ${inputs.separateUsers.agentsDir}; a provider is ready only through what the --env-file gives agents.`,
    });
  checks.push(...(await providerChecks(inputs, bundle)));
  const service = await inputs.service().catch((error: unknown) => errorMessage(error));
  const unit = inputs.separateUsers?.controllerUnit;
  checks.push(
    service === 'running'
      ? { name: 'Service', status: 'ok', detail: 'Installed and running' }
      : service === 'stopped'
        ? {
            name: 'Service',
            status: 'warn',
            detail: unit
              ? `${unit} is not running: sudo systemctl start ${unit}`
              : 'Installed, but not running',
          }
        : service === 'not-installed'
          ? {
              name: 'Service',
              status: 'warn',
              detail:
                'Not installed; run: switch-agent-controller install-service (or keep `run` going yourself)',
            }
          : { name: 'Service', status: 'warn', detail: `Cannot tell: ${service}` }
  );
  try {
    const latest = await inputs.latest();
    checks.push(
      !latest
        ? {
            name: 'Version',
            status: 'ok',
            detail: `${inputs.version}; no release is published yet`,
          }
        : isNewer(latest.version, inputs.version)
          ? {
              name: 'Version',
              status: 'warn',
              detail: `${inputs.version}; ${latest.version} is available: switch-agent-controller update`,
            }
          : { name: 'Version', status: 'ok', detail: `${inputs.version}, the latest` }
    );
  } catch (error) {
    checks.push({
      name: 'Version',
      status: 'warn',
      detail: `${inputs.version}; could not check for a newer one: ${errorMessage(error)}`,
    });
  }
  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  return checks
    .map((check) => `${MARK[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`)
    .join('\n');
}
