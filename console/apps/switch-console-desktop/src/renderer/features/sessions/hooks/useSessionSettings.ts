import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';

export interface SessionSettingsModel {
  autoGenerateName: boolean;
  autoTrustWorktrees: boolean;
  createBranchAndWorktree: boolean;
  preserveNameCapitalization: boolean;
  includeIssueContextByDefault: boolean;
  loading: boolean;
  saving: boolean;
  isFieldOverridden: (
    field:
      | 'autoGenerateName'
      | 'autoTrustWorktrees'
      | 'createBranchAndWorktree'
      | 'preserveNameCapitalization'
      | 'includeIssueContextByDefault'
  ) => boolean;
  updateAutoGenerateName: (next: boolean) => void;
  updateAutoTrustWorktrees: (next: boolean) => void;
  updateCreateBranchAndWorktree: (next: boolean) => void;
  updatePreserveNameCapitalization: (next: boolean) => void;
  updateIncludeIssueContextByDefault: (next: boolean) => void;
  resetAutoGenerateName: () => void;
  resetAutoTrustWorktrees: () => void;
  resetCreateBranchAndWorktree: () => void;
  resetPreserveNameCapitalization: () => void;
  resetIncludeIssueContextByDefault: () => void;
}

export function useSessionSettings(): SessionSettingsModel {
  const {
    value: sessions,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    update,
    resetField,
  } = useAppSettingsKey('sessions');

  return {
    autoGenerateName: sessions?.autoGenerateName ?? false,
    autoTrustWorktrees: sessions?.autoTrustWorktrees ?? false,
    createBranchAndWorktree: sessions?.createBranchAndWorktree ?? true,
    preserveNameCapitalization: sessions?.preserveNameCapitalization ?? false,
    includeIssueContextByDefault: sessions?.includeIssueContextByDefault ?? true,
    loading,
    saving,
    isFieldOverridden,
    updateAutoGenerateName: (next) => update({ autoGenerateName: next }),
    updateAutoTrustWorktrees: (next) => update({ autoTrustWorktrees: next }),
    updateCreateBranchAndWorktree: (next) => update({ createBranchAndWorktree: next }),
    updatePreserveNameCapitalization: (next) => update({ preserveNameCapitalization: next }),
    updateIncludeIssueContextByDefault: (next) => update({ includeIssueContextByDefault: next }),
    resetAutoGenerateName: () => resetField('autoGenerateName'),
    resetAutoTrustWorktrees: () => resetField('autoTrustWorktrees'),
    resetCreateBranchAndWorktree: () => resetField('createBranchAndWorktree'),
    resetPreserveNameCapitalization: () => resetField('preserveNameCapitalization'),
    resetIncludeIssueContextByDefault: () => resetField('includeIssueContextByDefault'),
  };
}
