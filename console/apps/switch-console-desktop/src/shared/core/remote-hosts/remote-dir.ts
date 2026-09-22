/**
 * Existence model for a prospective remote working directory (CHOO-1416).
 *
 * A remote agent's working directory is free text, so it is the one input in the
 * add-agent flow nothing else catches: the host is probed for reachability and
 * the server picked from a list, but the directory is only touched at write
 * time — after an identity has been minted on the gateway.
 */

/** What an inspection found at a remote path. */
export type RemoteDirStatus =
  /** Exists and is a directory. */
  | 'directory'
  /** Does not exist, but its parent does, so the first credentials write creates it. */
  | 'creatable'
  /** Exists, but is a regular file. */
  | 'file'
  /**
   * Does not exist and cannot be created: its parent is absent, or is not a
   * directory. A working directory's FS is rooted at the directory itself, and
   * its recursive mkdir will not create anything above that root.
   */
  | 'missing'
  /**
   * Not an absolute path, so there is nothing to inspect: it would resolve
   * against whatever directory the SSH session happens to start in, which is not
   * a directory the user chose.
   */
  | 'relative';

/** The result of inspecting a prospective remote working directory. */
export type RemoteDirInspection = {
  /** The path inspected, normalized. Callers should key off this, not the raw input. */
  dir: string;
  status: RemoteDirStatus;
};

/** Whether `dir` is a path {@link RemoteDirStatus} can describe at all. */
export function isAbsoluteRemoteDir(dir: string): boolean {
  return dir.startsWith('/');
}

/**
 * The one spelling of an absolute remote path: `.`/`..` resolved, repeated and
 * trailing slashes gone. The location row, the gateway's `repo_dir` and the
 * credential-slot lookup are all keyed by this, so two spellings of one
 * directory would give it two locations.
 *
 * Deliberately not `node:path`: this module is shared with the renderer, and a
 * Windows host must still resolve a remote POSIX path as POSIX.
 */
export function normalizeRemoteDir(dir: string): string {
  const segments: string[] = [];
  for (const segment of dir.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** Whether an agent can be created in this directory. */
export function isUsableRemoteDir(inspection: RemoteDirInspection): boolean {
  return inspection.status === 'directory' || inspection.status === 'creatable';
}

/**
 * Why a refusal was a refusal, as a sentence naming the path and the host.
 * Shared so the add-agent modal and the template use view say the same thing.
 *
 * `host` is what the user calls the machine — the onboarded host's display
 * name, falling back to its SSH alias. Not the alias off the result: the picker
 * they chose it from is labelled with the display name, and naming it two ways
 * in one flow reads as two different machines.
 */
export function describeRemoteDirRefusal(inspection: RemoteDirInspection, host: string): string {
  const { dir, status } = inspection;
  switch (status) {
    case 'file':
      return `${dir} is a file on ${host}, not a directory.`;
    case 'relative':
      return `${dir} is not an absolute path. Give the full path on ${host}, starting with “/”.`;
    default:
      return `${dir} cannot be created on ${host}: its parent directory is missing or is not a directory. Create the parent first.`;
  }
}
