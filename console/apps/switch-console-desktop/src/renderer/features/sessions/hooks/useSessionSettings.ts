import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';

export interface SessionSettingsModel {
  autoGenerateName: boolean;
  autoTrustWorktrees: boolean;
  preserveNameCapitalization: boolean;
  loading: boolean;
  saving: boolean;
  isFieldOverridden: (
    field: 'autoGenerateName' | 'autoTrustWorktrees' | 'preserveNameCapitalization'
  ) => boolean;
  updateAutoGenerateName: (next: boolean) => void;
  updateAutoTrustWorktrees: (next: boolean) => void;
  updatePreserveNameCapitalization: (next: boolean) => void;
  resetAutoGenerateName: () => void;
  resetAutoTrustWorktrees: () => void;
  resetPreserveNameCapitalization: () => void;
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
    preserveNameCapitalization: sessions?.preserveNameCapitalization ?? false,
    loading,
    saving,
    isFieldOverridden,
    updateAutoGenerateName: (next) => update({ autoGenerateName: next }),
    updateAutoTrustWorktrees: (next) => update({ autoTrustWorktrees: next }),
    updatePreserveNameCapitalization: (next) => update({ preserveNameCapitalization: next }),
    resetAutoGenerateName: () => resetField('autoGenerateName'),
    resetAutoTrustWorktrees: () => resetField('autoTrustWorktrees'),
    resetPreserveNameCapitalization: () => resetField('preserveNameCapitalization'),
  };
}
