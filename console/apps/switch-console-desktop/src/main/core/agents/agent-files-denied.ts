import { FileSystemError, FileSystemErrorCodes } from '@main/core/fs/types';
import { ObservedLocationError } from '@main/core/locations/store';

/**
 * Whether reading a directory's agent files failed because this account may
 * not read them — the one sign, in a directory it can list, that the agents
 * there are another account's (CHOO-2893). Anything else (a dropped channel, a
 * missing file) says nothing about whose they are.
 *
 * Discovery and the attach both ask this, so an agent offered for following is
 * one the attach accepts.
 */
export function deniedToThisAccount(error: unknown): boolean {
  return (
    (error instanceof FileSystemError && error.code === FileSystemErrorCodes.PERMISSION_DENIED) ||
    error instanceof ObservedLocationError
  );
}
