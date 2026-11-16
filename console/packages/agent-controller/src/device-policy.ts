import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  DEVICE_POLICY_FILE,
  type DeviceConsentNeed,
  type DevicePolicy,
  emptyDevicePolicy,
  policyAllowsBypass,
  policyAllowsDirectory,
  readDevicePolicy,
  withinDirectory,
} from '@switch-console/agent-providers';
import { errorMessage, type Logger } from './log';
import { expandHome } from './paths';
import type { AgentAssignment, AgentDefinition } from './schemas';

/**
 * The device policy (`DEVICE_POLICY_FILE` in the data directory) as this
 * controller last read it. Read again whenever the file changes, which
 * `refresh` notices; a file that cannot be read allows nothing, and says so
 * in the log, rather than keeping what an earlier one allowed.
 */
export class DevicePolicySource {
  private policy: DevicePolicy = emptyDevicePolicy();
  private stamp: string | null = null;
  private failure: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly dataDir: string,
    private readonly log: Logger
  ) {}

  current(): DevicePolicy {
    return this.policy;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads the file again if it changed, and tells listeners when what it allows did. */
  async refresh(): Promise<void> {
    const path = join(this.dataDir, DEVICE_POLICY_FILE);
    const stamp = await stat(path).then(
      (info) => `${info.mtimeMs}:${info.size}:${info.ino}`,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 'none';
        throw error;
      }
    );
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    let next: DevicePolicy;
    try {
      next = await readDevicePolicy(this.dataDir);
      this.failure = null;
    } catch (error) {
      const message = errorMessage(error);
      if (message !== this.failure)
        this.log.error(
          'Could not read what this device allows its agents; until it can be read, it allows nothing',
          { file: path, error: message }
        );
      this.failure = message;
      next = emptyDevicePolicy();
    }
    if (JSON.stringify(next) === JSON.stringify(this.policy)) return;
    this.policy = next;
    for (const listener of this.listeners) listener();
  }
}

/**
 * What an assigned agent's definition is checked against on this machine:
 * the data directory no agent may work in, the folder agents work in by
 * default, and the device policy. `policy` is null where agents do not run as
 * the controller's user (each a Linux user of its own, contained by its unit),
 * and the device policy does not apply.
 */
export type DefinitionContext = {
  dataDir: string;
  workspaces: string;
  policy: DevicePolicy | null;
};

/** The definition's directory as this machine reads it: absolute and resolved, or null. */
function namedDirectory(definition: Pick<AgentDefinition, 'directory'>): string | null {
  if (definition.directory === null) return null;
  const expanded = expandHome(definition.directory);
  return isAbsolute(expanded) ? resolve(expanded) : null;
}

/**
 * A directory outside the workspaces folder that the device has not allowed
 * the agent, or null. The data directory's own `workspaces` folder counts as
 * the workspaces folder: agents defined before the default moved were given
 * directories there by the server.
 */
export function unallowedDirectory(
  entry: AgentAssignment,
  context: DefinitionContext
): string | null {
  if (context.policy === null) return null;
  const directory = namedDirectory(entry.definition);
  if (directory === null) return null;
  if (withinDirectory(context.workspaces, directory)) return null;
  if (withinDirectory(join(context.dataDir, 'workspaces'), directory)) return null;
  if (policyAllowsDirectory(context.policy, entry.agent_id, directory)) return null;
  return directory;
}

/**
 * Advanced settings, by provider, with the values that run an agent without
 * asking a person, as `auto_approve` does. Claude Code lets the definition an
 * agent runs as override the session's permission mode: `bypassPermissions`
 * runs every tool, and `dontAsk` settles every call without asking (what the
 * settings allow runs, the rest is refused). No other provider's settings can
 * do as much: Codex's profile names no sandbox or approval policy, OpenCode's
 * one permission setting (web search) is asked about by the session's own
 * rules whatever it says, and the rest take no advanced settings.
 */
const BYPASS_SETTINGS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  claude: { permissionMode: ['bypassPermissions', 'dontAsk'] },
};

/** The definition's advanced settings that would run it without asking, with their values. */
export function bypassSettings(
  definition: Pick<AgentDefinition, 'provider' | 'advanced_config'>
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [key, values] of Object.entries(BYPASS_SETTINGS[definition.provider] ?? {})) {
    const value = definition.advanced_config[key];
    if (typeof value === 'string' && values.includes(value.trim())) found[key] = value.trim();
  }
  return found;
}

/** What in the definition asks to run without approvals, in words; empty for nothing. */
function bypassRequests(definition: AgentDefinition): string[] {
  return [
    ...(definition.auto_approve ? ['auto_approve'] : []),
    ...Object.entries(bypassSettings(definition)).map(
      ([key, value]) => `${key} ${value} in its advanced configuration`
    ),
  ];
}

/** Whether the definition asks to bypass approvals and the device has not allowed it. */
export function bypassWithheld(entry: AgentAssignment, context: DefinitionContext): boolean {
  return (
    context.policy !== null &&
    bypassRequests(entry.definition).length > 0 &&
    !policyAllowsBypass(context.policy, entry.agent_id)
  );
}

/**
 * The definition as this device runs it: without bypass unless the device
 * allowed it. A setting that would bypass approvals is left out, so the
 * runtime mode decides, as it does for a definition that never set it.
 */
export function effectiveDefinition(
  entry: AgentAssignment,
  context: DefinitionContext
): AgentDefinition {
  if (!bypassWithheld(entry, context)) return entry.definition;
  const withheld = bypassSettings(entry.definition);
  return {
    ...entry.definition,
    auto_approve: false,
    advanced_config: Object.fromEntries(
      Object.entries(entry.definition.advanced_config).filter(([key]) => !(key in withheld))
    ),
  };
}

/** What a status report says of a bypass this device withholds, or null when it withholds none. */
export function bypassWithheldDetail(
  entry: AgentAssignment,
  context: DefinitionContext
): string | null {
  if (!bypassWithheld(entry, context)) return null;
  return `Switch asks for this agent to run without asking for approval (${bypassRequests(entry.definition).join('; ')}), and this device has not allowed that, so it asks. ${howToAllow(entry.agent_id, 'bypass')}`;
}

/** Every assigned agent asking for something the device has not allowed. */
export function consentNeeds(
  agents: AgentAssignment[],
  context: DefinitionContext
): DeviceConsentNeed[] {
  const needs: DeviceConsentNeed[] = [];
  for (const entry of agents) {
    const bypass = bypassWithheld(entry, context);
    const directory = unallowedDirectory(entry, context);
    if (!bypass && directory === null) continue;
    needs.push({
      agentId: entry.agent_id,
      name: entry.definition.name,
      displayName: entry.definition.display_name ?? null,
      bypass,
      directory,
    });
  }
  return needs;
}

/** How a person allows `what` for the agent on this device, for messages that say it is not. */
export function howToAllow(agentId: string, what: { directory: string } | 'bypass'): string {
  const flag =
    what === 'bypass' ? '--bypass' : `--directory '${what.directory.replaceAll("'", "'\\''")}'`;
  return `Allow it on this device: Switch Console asks, or run \`switch-agent-controller allow ${agentId} ${flag}\`.`;
}
