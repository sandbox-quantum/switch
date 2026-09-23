import type { SwitchAgentConfig } from '@shared/switch-agents';

/**
 * A Location: where agents' sessions run — a working directory on a host.
 * Local locations live on this machine (`sshHost` null); remote ones on an
 * SSH host identified by its `~/.ssh/config` alias, with auth resolved from
 * the user's SSH config/agent (Switch Console stores no credentials). Multiple
 * agents may share one location.
 */
export type Location = {
  id: string;
  name: string;
  /** `~/.ssh/config` Host alias; null when the location is on this machine. */
  sshHost: string | null;
  /** Absolute path to the working directory on the location's host. */
  dir: string;
  /**
   * Whether this Console observes the agents here without running them
   * (CHOO-2893). The directory belongs to another account on a shared host:
   * nothing is read from it or run in it from here, and the agents' sessions
   * are read and driven through their Switch server alone.
   */
  observed: boolean;
  /** The account on the host that runs an observed location's agents, when it
   * could be told; null otherwise. */
  observedOwner: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocationKind = 'local' | 'ssh';

export function locationKind(location: Pick<Location, 'sshHost'>): LocationKind {
  return location.sshHost === null ? 'local' : 'ssh';
}

export type LocationPathStatus = {
  isDirectory: boolean;
};

export type InspectLocationPathParams = {
  path: string;
};

export type LocationPathInspection = LocationPathStatus & {
  existingLocation?: Location;
  /**
   * The Switch agent configured in this directory, if any (read from the dir's
   * `.claude/settings.local.json`). Switch Console only allows onboarding
   * directories that resolve a Switch agent.
   */
  switchAgent?: SwitchAgentConfig | null;
};

export type OpenLocationError =
  | { type: 'path-not-found'; path: string }
  | { type: 'error'; message: string };

export type UpdateLocationSettingsError =
  | { type: 'location-not-found' }
  | { type: 'invalid-settings' }
  | { type: 'invalid-worktree-directory' }
  | { type: 'write-config-failed'; message: string }
  | { type: 'error' };

export type LocationRemoteState = {
  hasRemote: boolean;
  selectedRemoteUrl: string | null;
};
