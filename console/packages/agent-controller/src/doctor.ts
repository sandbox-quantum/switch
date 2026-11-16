import type { ProviderReadiness } from '@switch-console/agent-providers';
import { ControllerApiError } from './api';
import { errorMessage } from './log';
import { notice, plain, type OutputStyle } from './output';
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
      : `${nodeVersion}; install Node ${MIN_NODE.join('.')} or later, then run doctor again.`,
  };
}

async function serverChecks(inputs: DoctorInputs): Promise<Check[]> {
  if (!inputs.identity)
    return [
      {
        name: 'Enrollment',
        status: 'fail',
        detail: `${inputs.dataDir} is not enrolled. Run: switch-agent-controller enroll --server <url> --code <code>, with a code from the Devices page.`,
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
      detail: `Cannot read it from ${inputs.secrets.description}: ${errorMessage(error)}. Unlock the secret store and check this user can access it, then run doctor again.`,
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
          : `${error.code}: ${error.message}. Check the controller on the Machines page; if it was revoked or its credential replaced, enroll it again.`
        : `${identity.server} cannot be reached: ${errorMessage(error)}. Check the server URL, network and proxy configuration, then run doctor again.`;
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
        detail: `Installed${version}; sign-in not checked without the shared-host bundle. Reinstall the controller or pass --shared-host-bundle <path>, then run doctor again.`,
      });
      continue;
    }
    try {
      const readiness = await inputs.probe(bundle, provider, located.path);
      if (readiness.status === 'authenticated') ready++;
      checks.push({
        name: provider,
        status: readiness.status === 'authenticated' ? 'ok' : 'warn',
        detail: `Installed${version}, ${readiness.status}${readiness.message ? `: ${readiness.message}` : ''}${readiness.status === 'authenticated' ? '' : '; sign in with this provider as the controller user, or configure its API key in the --env-file the service runs with.'}`,
      });
    } catch (error) {
      checks.push({
        name: provider,
        status: 'warn',
        detail: `Installed${version}; its sign-in could not be checked: ${errorMessage(error)}. Check the provider CLI runs as the controller user, then run doctor again.`,
      });
    }
  }
  if (ready === 0)
    checks.push({
      name: 'Providers',
      status: 'fail',
      detail:
        'No provider CLI is installed and signed in on PATH for this user, so no agent can run here. Install one (claude, codex, opencode, cursor, antigravity, dsh, pi, mistral-vibe or junie) and sign in, or set its API key in the --env-file the service runs with.',
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
    detail: supported
      ? inputs.platform
      : `${inputs.platform} is not supported; use Linux, macOS or Windows.`,
  });
  checks.push(...(await serverChecks(inputs)));
  let bundle: string | null = null;
  try {
    bundle = inputs.bundle();
    checks.push({ name: 'Shared host', status: 'ok', detail: bundle });
  } catch (error) {
    checks.push({
      name: 'Shared host',
      status: 'fail',
      detail: `${errorMessage(error)}\nReinstall the controller or pass --shared-host-bundle <path>.`,
    });
  }
  if (inputs.separateUsers)
    checks.push({
      name: 'Agent users',
      status: 'ok',
      detail: `Each agent runs as one of ${inputs.separateUsers.agentUsers} users of its own, in ${inputs.separateUsers.agentsDir}; a provider is ready only through what the --env-file gives agents.`,
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
        }
      : service === 'running'
        ? { name: 'Service', status: 'ok', detail: 'Installed and running' }
        : service === 'stopped'
          ? {
              name: 'Service',
              status: 'warn',
              detail: unit
                ? `${unit} is not running: sudo systemctl start ${unit}`
                : 'Installed, but not running; start the existing service with your service manager, keeping its configured data directory and environment.',
            }
          : service === 'not-installed'
            ? {
                name: 'Service',
                status: 'warn',
                detail:
                  'Not installed; run: switch-agent-controller install-service (or keep `run` going yourself)',
              }
            : {
                name: 'Service',
                status: 'warn',
                detail: `Cannot tell: ${service}. Check the user service manager and its logs, then run doctor again.`,
              }
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
      detail: `${inputs.version}; could not check for a newer one: ${errorMessage(error)}. Check access to the release repository, then retry switch-agent-controller update --check.`,
    });
  }
  return checks;
}

export function formatChecks(checks: Check[], style: OutputStyle = { color: false }): string {
  const names = checks.map((check) => plain(check.name).replace(/\n/g, ' '));
  const width = Math.max(0, ...names.map((name) => name.length));
  return checks
    .map((check, index) => {
      const markWidth = { ok: 4, warn: 6, fail: 7 }[check.status];
      const padding = ' '.repeat(7 - markWidth);
      const detailIndent = ' '.repeat(padding.length + width + 2);
      const detail = plain(check.detail).replace(/\n/g, `\n${detailIndent}`);
      return notice(check.status, `${padding}${names[index].padEnd(width)}  ${detail}`, style);
    })
    .join('\n');
}
