/**
 * A Location: where agents' sessions run — a working directory on a host.
 * Local locations live on this machine (`sshHost` null); remote ones on an
 * SSH host identified by its `~/.ssh/config` alias, with auth resolved from
 * the user's SSH config/agent (switchdash stores no credentials). Multiple
 * agents may share one location.
 */
export type Location = {
  id: string;
  name: string;
  /** `~/.ssh/config` Host alias; null when the location is on this machine. */
  sshHost: string | null;
  /** Absolute path to the working directory on the location's host. */
  dir: string;
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
