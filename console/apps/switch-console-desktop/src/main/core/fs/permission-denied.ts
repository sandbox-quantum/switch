import { FileSystemError, FileSystemErrorCodes } from './types';

/**
 * Whether a filesystem failure, on the local disk or over SFTP, is this account
 * being refused: typically a file or directory another account owns, which
 * trying again will not change.
 */
export function isPermissionDenied(error: unknown): boolean {
  if (error instanceof FileSystemError) {
    return error.code === FileSystemErrorCodes.PERMISSION_DENIED;
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}
