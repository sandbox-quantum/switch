import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type ProviderReadiness,
  type SharedHostConfig,
  WATCHER_HEALTH_FILE,
  watcherHealthFileSchema,
} from '@switch-console/agent-providers';
import { ReasonedError } from './errors';
import { isSafeSegment, type DataLayout } from './paths';
import {
  type AgentObservation,
  type AgentRuntime,
  type HostedDeploymentRequest,
  readOptional,
  readRelayCredentials,
  type RelayCredentials,
  removeOptional,
  writeRelayCredentials,
} from './runtime';
import type { Provider } from './schemas';
import { OBSOLETE_EXIT_CODE } from './status';
import type { Supervisor } from './supervisor-client';

const execute = promisify(execFile);

/** The agent ids the machine supervisor accepts: lowercase UUIDs. */
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs a cloud machine's agents: each in its own `switch-agent@<id>` systemd
 * unit, which the machine's root supervisor installs, starts, stops and
 * removes when this controller asks over its socket. The units keep what the
 * machine had before controllers ran it: a memory limit, OOM handling and a
 * crash-loop limit, in the agents' slice, as the unprivileged agent account.
 *
 * The supervisor builds each agent's deployment from what the controller
 * sends (the assignment's hosted block, plus the relay credentials the
 * agent's worker reaches Switch with), validates it, and derives every path
 * itself; nothing the controller sends is a path. The relay credentials are
 * kept in this controller's data directory, as the shared host runtime keeps
 * them, so a relay that comes back on another port is noticed and the units
 * reinstalled with the new ones.
 *
 * What it observes is the unit, as the supervisor reports it, and the
 * agent's watcher health file in the agent's state directory on the data
 * volume (`<agentsDir>/<id>/`), which says whether the watcher is connected
 * and which sessions it holds.
 */
export class SystemdRuntime implements AgentRuntime {
  readonly kind = 'systemd';

  constructor(
    private readonly deps: {
      layout: DataLayout;
      supervisor: Supervisor;
      /** The agents' state directories on the data volume, `/data/agents`. */
      agentsDir: string;
    }
  ) {}

  credentialsPath(agentId: string): string {
    return this.deps.layout.agentCredentials(agentId);
  }

  async readCredentials(agentId: string): Promise<RelayCredentials | null> {
    return readRelayCredentials(this.credentialsPath(agentId), agentId);
  }

  async writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void> {
    await writeRelayCredentials(
      this.deps.layout.agentDir(agentId),
      this.credentialsPath(agentId),
      agentId,
      credentials
    );
  }

  async deleteCredentials(agentId: string): Promise<void> {
    await removeOptional(this.credentialsPath(agentId));
  }

  async workingDirectory(): Promise<string> {
    throw new ReasonedError(
      'definition_invalid',
      'A cloud machine runs only its cloud agents, whose workspace its supervisor prepares.'
    );
  }

  async launch(_agentId: string, _template: SharedHostConfig): Promise<void> {
    throw new ReasonedError(
      'definition_invalid',
      'A cloud machine runs only its cloud agents; this agent is not one.'
    );
  }

  async launchHosted(
    agentId: string,
    deployment: HostedDeploymentRequest,
    options: { restart: boolean }
  ): Promise<void> {
    if (deployment.agent_id !== agentId)
      throw new Error(`The deployment for ${agentId} names agent ${deployment.agent_id}.`);
    await this.deps.supervisor.request({
      op: 'install',
      agent: deployment,
      restart: options.restart,
    });
  }

  async stop(agentId: string, options: { wait: boolean }): Promise<void> {
    await this.deps.supervisor.request({ op: 'stop', agent_id: agentId, wait: options.wait });
  }

  async remove(agentId: string): Promise<void> {
    await this.deps.supervisor.request({ op: 'remove', agent_id: agentId });
  }

  async prune(keep: string[]): Promise<void> {
    await this.deps.supervisor.request({
      op: 'prune',
      // Only an id the supervisor could have installed: it refuses the whole
      // request for one that is not.
      keep: keep.filter((agentId) => AGENT_ID.test(agentId)),
    });
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const unit = await this.deps.supervisor.request({ op: 'state', agent_id: agentId });
    if (!unit) throw new Error(`The machine supervisor reported no unit for ${agentId}.`);
    const alive = ['starting', 'running', 'restarting', 'stopping'].includes(unit.process_state);
    return {
      alive,
      configured: null,
      flags: null,
      health: alive ? await this.health(agentId) : null,
      failure: failureOf(unit.process_state, unit.exit),
      takenOver: null,
      unit: {
        installed: unit.installed,
        revision: unit.revision,
        processState: unit.process_state,
        restarts: unit.restarts,
        oomKills: unit.oom_kills,
        exit: unit.exit,
      },
    };
  }

  async probe(provider: Provider): Promise<ProviderReadiness> {
    throw new Error(
      `A cloud machine's controller does not check ${provider} logins; each agent's bootstrap does.`
    );
  }

  /** The watcher's health file, when it can be read and its writer is still running. */
  private async health(agentId: string): Promise<AgentObservation['health']> {
    if (!isSafeSegment(agentId)) return null;
    const root = join(this.deps.agentsDir, agentId);
    let text: string | null;
    try {
      text = await readOptional(join(root, WATCHER_HEALTH_FILE));
    } catch {
      return null;
    }
    if (text === null) return null;
    const parsed = watcherHealthFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return { ...parsed.data, current: await runs(parsed.data.pid, root) };
  }
}

/** Why a unit is down and stays down, in the words a status report carries; null while it is not. */
export function failureOf(
  state: string,
  exit: { code: number | null; signal: number | null; result: string | null } | null
): string | null {
  const how = exit
    ? exit.code !== null
      ? ` (exit status ${exit.code}${exit.result ? `, ${exit.result}` : ''})`
      : exit.signal !== null
        ? ` (signal ${exit.signal}${exit.result ? `, ${exit.result}` : ''})`
        : exit.result
          ? ` (${exit.result})`
          : ''
    : '';
  if (exit?.code === OBSOLETE_EXIT_CODE)
    return 'The agent stopped because its cloud launch moved to a new revision; it starts again when this controller is assigned it.';
  if (state === 'crashed')
    return `The agent's unit kept failing and hit its restart limit${how}; it stays down until it is restarted.`;
  if (state === 'failed') return `The agent's unit stopped with an error${how}.`;
  return null;
}

async function runs(pid: number, root: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.includes(root);
  } catch {
    return false;
  }
}
