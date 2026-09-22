/**
 * Existence model for a prospective remote working directory (CHOO-1416).
 *
 * A remote agent's working directory is typed as free text, so it is the one
 * input in the add-agent flow that can be wrong in a way nothing else catches:
 * the SSH host is probed for reachability, the server is picked from a list,
 * but the directory was only ever touched at write time — by which point an
 * identity had already been minted on the gateway.
 */

/** What an inspection found at a remote path. */
export type RemoteDirStatus =
  /** Exists and is a directory. */
  | 'directory'
  /**
   * Does not exist, but its parent does, so the first credentials write creates
   * it — which is what already happened before this check existed. Usable.
   */
  | 'creatable'
  /** Exists, but is a regular file. */
  | 'file'
  /**
   * Does not exist and cannot be created: its parent is absent, or is not a
   * directory. This is the failing case: a working directory's FS is rooted at
   * the directory itself, and its recursive mkdir will not create anything
   * above that root.
   */
  | 'missing'
  /**
   * Not an absolute path, so there is nothing to inspect: it would resolve
   * against whatever directory the SSH session happens to start in, which is
   * not a directory the user chose. A refusal rather than a thrown error so it
   * reaches the user as a sentence naming the path, like the others.
   */
  | 'relative';

/** The result of inspecting a prospective remote working directory. */
export type RemoteDirInspection = {
  /**
   * The path inspected, normalized as it resolves on the host. Adopt this
   * downstream rather than the raw input, so the path that was checked is the
   * path the agent is created against.
   */
  dir: string;
  status: RemoteDirStatus;
};

/** Whether `dir` is a path {@link RemoteDirStatus} can describe at all. */
export function isAbsoluteRemoteDir(dir: string): boolean {
  return dir.startsWith('/');
}

/**
 * The one spelling of an absolute remote path: `.`/`..` resolved, repeated and
 * trailing slashes gone. Settle on this before anything keys off the path — the
 * location row, the gateway's `repo_dir` and the credential-slot lookup are all
 * keyed by it, so `/h/x/../repo` and `/h/repo` reaching different ones would
 * give the same directory two locations.
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
 *
 * Shared because two screens render it — the add-agent modal and the template
 * use view — and a refusal explained one way in one and another way in the
 * other is how a user learns to distrust both.
 */
export function describeRemoteDirRefusal(inspection: RemoteDirInspection, sshHost: string): string {
  const { dir, status } = inspection;
  switch (status) {
    case 'file':
      return `${dir} is a file on ${sshHost}, not a directory.`;
    case 'relative':
      return `${dir} is not an absolute path. Give the full path on ${sshHost}, starting with “/”.`;
    default:
      return `${dir} cannot be created on ${sshHost}: its parent directory is missing or is not a directory. Create the parent first.`;
  }
}
