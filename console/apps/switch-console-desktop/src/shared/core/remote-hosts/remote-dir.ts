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
  | 'missing';

/** The result of inspecting a prospective remote working directory. */
export type RemoteDirInspection = {
  /** The absolute path inspected, as resolved on the host. */
  dir: string;
  status: RemoteDirStatus;
};

/** Whether an agent can be created in this directory. */
export function isUsableRemoteDir(inspection: RemoteDirInspection): boolean {
  return inspection.status === 'directory' || inspection.status === 'creatable';
}
