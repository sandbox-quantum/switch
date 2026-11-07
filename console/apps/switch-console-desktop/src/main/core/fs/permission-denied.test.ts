import { describe, expect, it } from 'vitest';
import { isPermissionDenied } from './permission-denied';
import { FileSystemError, FileSystemErrorCodes } from './types';

describe('isPermissionDenied', () => {
  it('recognises a refusal from the local disk or over SFTP', () => {
    expect(isPermissionDenied(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true);
    expect(isPermissionDenied(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true);
    expect(
      isPermissionDenied(new FileSystemError('x', FileSystemErrorCodes.PERMISSION_DENIED))
    ).toBe(true);
  });

  it('does not take a failure that may pass for one', () => {
    expect(isPermissionDenied(new Error('SSH connection is not available'))).toBe(false);
    expect(isPermissionDenied(Object.assign(new Error('x'), { code: 'EIO' }))).toBe(false);
    expect(
      isPermissionDenied(new FileSystemError('x', FileSystemErrorCodes.CONNECTION_ERROR))
    ).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
  });
});
