import type {
  ParsedAgentEntry,
  TemplateConnection,
} from '@main/core/agent-templates/template-document';
import type { TemplateRunAgent } from '@main/core/switch-servers/gateway-client';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { hasPlaceholder, interpolate, type Values } from './use-template-model';

/**
 * A template run on a server with agent management: every agent the
 * template creates is a managed agent on one of the deployer's machines, and
 * the whole run (agents, then rooms) goes to the server in one request,
 * which checks it whole and keeps nothing when it fails.
 */

const AGENTS_DIR = '{$agents_dir}';

/**
 * The texts of an entry's runtime fields, for telling whether a param is read
 * by one. The renderer's copy of the main process's: the renderer can import
 * only types from `@main`.
 */
export function runtimeFieldTexts(
  agent: Pick<ParsedAgentEntry, 'provider' | 'location' | 'machine' | 'directory'>
): string[] {
  return [agent.provider ?? '', agent.location ?? '', agent.machine ?? '', agent.directory ?? ''];
}

/**
 * The machine a new agent runs on, among the deployer's machines on the
 * server. `machineText` names one by id or name, from the template's
 * `machine` (or, on a server with agent management, its `location`). A
 * `location` this Console knows (this computer, an SSH host) means nothing to
 * the server, so when it names no machine the first online machine that can
 * run the provider stands in, as `$first`. An explicit `machine` that names
 * none is not replaced: null.
 */
export function machineFor(
  machines: readonly OwnedMachine[],
  machineText: string | null,
  provider: string | null,
  fallBackToFirst: boolean
): OwnedMachine | null {
  if (machineText !== null && machineText !== '') {
    const byId = machines.find((m) => m.id === machineText);
    if (byId) return byId;
    const named = machines.filter((m) => m.name === machineText);
    if (named.length === 1) return named[0]!;
    if (!fallBackToFirst) return null;
  }
  return fallBackToFirst ? firstReady(machines, provider) : null;
}

/** `$first` among the deployer's machines: the first online one, by name, that can run `provider`. */
export function firstReady(
  machines: readonly OwnedMachine[],
  provider: string | null
): OwnedMachine | null {
  return (
    [...machines]
      .sort((a, b) => a.name.localeCompare(b.name))
      .find(
        (m) =>
          m.state === 'online' &&
          (provider === null || m.providers.some((p) => p.provider === provider && p.ready))
      ) ?? null
  );
}

/** Why the machine cannot take an agent of `provider` now, or null when it can. */
export function machineProblem(
  machine: OwnedMachine,
  provider: string | null,
  agentName: string
): string | null {
  if (machine.state !== 'online')
    return `${machine.name} is ${machine.state}. Start its controller, or run ${agentName} elsewhere.`;
  if (provider === null) return null;
  const entry = machine.providers.find((p) => p.provider === provider);
  if (!entry) return `${provider} is not installed on ${machine.name}.`;
  if (!entry.ready)
    return `${provider} on ${machine.name} is not ready${entry.problem ? `: ${entry.problem}` : ''}.`;
  return null;
}

/**
 * The connections an entry grants, as its `connections:` lists them. A
 * `repo` grants nothing: the agent clones it itself, with a connection the
 * template lists or the machine's own credentials.
 */
export function connectionsFor(entry: ParsedAgentEntry, values: Values): TemplateConnection[] {
  return entry.connections.map((c) => ({
    service: interpolate(c.service, values),
    access: c.access,
    repos: c.repos.map((r) => interpolate(r, values)),
  }));
}

/** How a connection the template grants stands for the deployer. */
export type ConnectionState = {
  service: string;
  /** The service's name, or its slug when the server does not list it. */
  name: string;
  repos: string[];
  /** Connected and grantable; otherwise why not. */
  ready: boolean;
  note: string | null;
};

export function connectionStates(
  wanted: readonly TemplateConnection[],
  catalog: readonly ConnectionCatalogEntry[] | null
): ConnectionState[] {
  return wanted.map((c) => {
    const entry = catalog?.find((e) => e.slug === c.service) ?? null;
    const base = { service: c.service, name: entry?.name ?? c.service, repos: c.repos };
    if (catalog === null) return { ...base, ready: false, note: 'Checking your connections…' };
    if (entry === null)
      return { ...base, ready: false, note: 'This server has no such connection.' };
    if (entry.unavailable_reason) return { ...base, ready: false, note: entry.unavailable_reason };
    if (entry.status !== 'connected')
      return {
        ...base,
        ready: false,
        note:
          entry.status === 'needs_reauthorization'
            ? `Reconnect ${entry.name} under Connections.`
            : `Connect ${entry.name} under Connections first.`,
      };
    return { ...base, ready: true, note: null };
  });
}

/** What the server is sent for one new agent. `directory` keeps `{$agents_dir}`, which the server reads as the machine's own folder for agents. */
export function runAgent(params: {
  slot: string;
  name: string;
  entry: ParsedAgentEntry;
  values: Values;
  displayName: string | null;
  provider: string;
  machine: OwnedMachine;
  directoryText: string;
}): TemplateRunAgent {
  const { entry, values, name } = params;
  const filled = (text: string) => interpolate(text, { ...values, agent: name });
  const isolation = entry.isolation ? filled(entry.isolation) : 'shared';
  const autoApprove =
    typeof entry.autoApprove === 'string'
      ? values[entry.autoApprove.replace(/^\{|\}$/g, '')] === true
      : entry.autoApprove === true;
  const repo = entry.repoUrl ? interpolate(entry.repoUrl, values) : null;
  const instructions = repo
    ? `${entry.instructions}\n\nYou work on the repository ${repo}. If your working directory is not a clone of it yet, clone ${repo} into it first.`
    : entry.instructions;
  const directory = params.directoryText.trim();
  return {
    slot: params.slot,
    name,
    description: filled(entry.description) || name,
    displayName: params.displayName,
    instructions,
    provider: params.provider,
    machine: params.machine.id,
    model: entry.model && filled(entry.model) !== '' ? filled(entry.model) : null,
    advancedConfig: fillDeep(entry.advancedConfig, { ...values, agent: name }) as Record<
      string,
      unknown
    >,
    isolation: isolation === 'isolated' ? 'isolated' : 'shared',
    autoApprove,
    directory: directory === `${AGENTS_DIR}/${name}` ? null : directory,
    addressing: entry.addressing ?? 'owner',
    connections: connectionsFor(entry, values),
  };
}

/** The directory text for a managed agent: its field or param with the inputs and `{agent}` filled in, `{$agents_dir}` kept for the server. */
export function managedDirectory(directoryText: string, values: Values, name: string): string {
  const keep = { ...values, agent: name, $agents_dir: AGENTS_DIR };
  return interpolate(interpolate(directoryText, keep), keep);
}

/** Whether the directory is still waiting on an input: a placeholder other than `{$agents_dir}`. */
export function directoryUnresolved(directory: string): boolean {
  return hasPlaceholder(directory.split(AGENTS_DIR).join(''));
}

/** The directory as the deployer reads it, `{$agents_dir}` shown as the machine's folder when it has said where that is. */
export function shownDirectory(directory: string, machine: OwnedMachine | null): string {
  if (!directory.includes(AGENTS_DIR)) return directory;
  return machine?.workspacesDir
    ? directory.split(AGENTS_DIR).join(machine.workspacesDir.replace(/[/\\]+$/, ''))
    : directory.split(AGENTS_DIR).join(`${machine?.name ?? 'its machine'}'s agents folder`);
}

function fillDeep(node: unknown, values: Values): unknown {
  if (typeof node === 'string') {
    const whole = /^\{(\$?\w+)\}$/.exec(node);
    if (whole && values[whole[1]] !== undefined) return values[whole[1]];
    return interpolate(node, values);
  }
  if (Array.isArray(node)) return node.map((item) => fillDeep(item, values));
  if (node !== null && typeof node === 'object')
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillDeep(v, values)]));
  return node;
}
