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
export function topLevelLabels(
  workspaces: string,
  agents: readonly LabelledAgent[]
): Map<string, string> {
  const root = resolve(workspaces);
  const owners = new Map<string, string[]>();
  for (const agent of agents) {
    const folder = topLevelFolder(root, agent);
    if (folder === null) continue;
    const label = agent.displayName?.trim() || agent.name;
    owners.set(folder, [...(owners.get(folder) ?? []), label]);
  }
  const labels = new Map<string, string>();
  for (const [folder, names] of owners) if (names.length === 1) labels.set(folder, names[0]!);
  return labels;
}

/** The label for one top-level folder name, given the map `topLevelLabels` made. */
export function labelFor(labels: ReadonlyMap<string, string>, folder: string): string {
  return labels.get(folder) ?? SHARED_LABEL;
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
