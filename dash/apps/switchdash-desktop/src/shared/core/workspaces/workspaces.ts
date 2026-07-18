export type WorkspaceType = 'local' | 'location-ssh' | 'byoi';

export type WorkspaceResolution =
  | { kind: 'ready' }
  | { kind: 'needs_create' }
  | { kind: 'branch_elsewhere'; branchName: string; candidatePath: string; previousPath: string }
  | { kind: 'path_missing'; previousPath: string; branchName: string | null };
