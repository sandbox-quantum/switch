import React from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Switch } from '@renderer/lib/ui/switch';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

/**
 * The way back after dismissing the setup checklist (CHOO-2022). Dismissal
 * removes the only control that could restore it, so it has to live somewhere
 * else — here.
 */
export const OnboardingChecklistRow: React.FC = () => {
  const {
    value,
    update,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('onboarding');

  const showChecklist = value?.showChecklist ?? true;

  return (
    <SettingRow
      title="Onboarding checklist"
      description="Show the “Setting up Switch” checklist in the sidebar, with the steps left to finish setting up."
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('showChecklist')}
            defaultLabel="on"
            onReset={() => resetField('showChecklist')}
            disabled={loading || saving}
          />
          <Switch
            checked={showChecklist}
            disabled={loading || saving}
            onCheckedChange={(checked) => update({ showChecklist: checked })}
          />
        </>
      }
    />
  );
};
