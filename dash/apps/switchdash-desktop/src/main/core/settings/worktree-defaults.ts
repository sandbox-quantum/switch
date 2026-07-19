import { homedir } from 'node:os';
import path from 'node:path';

export const WORKTREE_POOL_DIR_NAME = 'worktrees';
export const LOCAL_WORKTREE_ROOT_DIR_NAME = 'switchdash';
export const SSH_LOCATION_STATE_DIR_NAME = '.switchdash';

export function getDefaultLocalWorktreeDirectory(homeDirectory: string = homedir()): string {
  return path.join(homeDirectory, LOCAL_WORKTREE_ROOT_DIR_NAME, WORKTREE_POOL_DIR_NAME);
}

export function getDefaultSshWorktreeDirectory(rootPath: string): string {
  return path.posix.join(rootPath, SSH_LOCATION_STATE_DIR_NAME, WORKTREE_POOL_DIR_NAME);
}
