import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isSafeSegment } from './paths';

/** One assigned agent, as its definition names it: enough to find its working folder. */
export type LabelledAgent = {
  /** The agent's name, which names its default folder under the workspaces folder. */
  name: string;
  /** What the owner sees; falls back to `name`. */
  displayName?: string | null;
  /** The definition's own working directory, or null for the default one. */
  directory: string | null;
};

/**
 * What Core takes as an agent's name in a listing (`VALID_AGENT_NAME_RE`, at
 * most 255 characters). A name outside it is left out of the entry, never sent:
 * one odd name must not fail a whole listing in Core.
 */
const AGENT_KEY = /^[a-z0-9][a-z0-9._-]*$/;
const AGENT_KEY_MAX = 255;

/** The label for every top-level folder that isn't exactly one agent's working folder. */
export const SHARED_LABEL = 'Shared';

/**
 * The file explorer's labels for the top-level folders of the agents'
 * workspaces (file explorer plan, controller part). A folder that is exactly
 * one assigned agent's working folder (its own `directory`, or the default
 * `<workspaces>/<name>`) is labelled with that agent's name; every other one is
 * "Shared". Labels come only from the controller's own agent definitions, so
 * the launcher, which lists the folders, never learns agent names.
 *
 * A folder two agents both work in is "Shared": no folder carries one agent's
 * name while another agent writes there too. A working folder nested deeper, or
 * outside the workspaces folder, labels nothing.
 */
/** A folder that is exactly one agent's working folder: what people read, and the agent's stable name. */
export type FolderLabel = { label: string; agent: string };

export function topLevelLabels(
  workspaces: string,
  agents: readonly LabelledAgent[]
): Map<string, FolderLabel> {
  const root = resolve(workspaces);
  const owners = new Map<string, FolderLabel[]>();
  for (const agent of agents) {
    const folder = topLevelFolder(root, agent);
    if (folder === null) continue;
    const label = agent.displayName?.trim() || agent.name;
    owners.set(folder, [...(owners.get(folder) ?? []), { label, agent: agent.name }]);
  }
  const labels = new Map<string, FolderLabel>();
  for (const [folder, owned] of owners) if (owned.length === 1) labels.set(folder, owned[0]!);
  return labels;
}

/** The most characters a label carries: Core's limit on an entry's `label`. */
const LABEL_MAX = 255;

/**
 * The label for one top-level folder name, given the map `topLevelLabels` made.
 * Cut to 255 characters (whole code points, never mid-character), so one long
 * display name can't fail a whole listing in Core.
 */
export function labelFor(labels: ReadonlyMap<string, FolderLabel>, folder: string): string {
  const label = labels.get(folder)?.label;
  if (label === undefined) return SHARED_LABEL;
  const points = Array.from(label);
  return points.length <= LABEL_MAX ? label : points.slice(0, LABEL_MAX).join('');
}

/** The agent whose working folder this is, by its stable name, or undefined for a "Shared" one. */
export function agentFor(
  labels: ReadonlyMap<string, FolderLabel>,
  folder: string
): string | undefined {
  const agent = labels.get(folder)?.agent;
  return agent !== undefined && agent.length <= AGENT_KEY_MAX && AGENT_KEY.test(agent)
    ? agent
    : undefined;
}

/** The top-level folder name an agent works in, if its working folder is exactly one level under the root. */
function topLevelFolder(root: string, agent: LabelledAgent): string | null {
  let folder: string;
  if (agent.directory === null) {
    if (!isSafeSegment(agent.name)) return null;
    folder = agent.name;
  } else {
    if (!isAbsolute(agent.directory)) return null;
    const rel = relative(root, resolve(agent.directory));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) return null;
    folder = rel;
  }
  return isSafeSegment(folder) ? folder : null;
}
