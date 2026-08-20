import React from 'react';
import { useSessionSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Switch } from '@renderer/lib/ui/switch';
import { InfoTooltip } from './InfoTooltip';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

export const AutoGenerateSessionNamesRow: React.FC = () => {
  const sessionSettings = useSessionSettings();

  return (
    <SettingRow
      title="Auto-generate session names"
      description="Automatically suggests a session name when creating a new session."
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('autoGenerateName')}
            defaultLabel="on"
            onReset={sessionSettings.resetAutoGenerateName}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.autoGenerateName}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updateAutoGenerateName}
          />
        </>
      }
    />
  );
};

export const AutoTrustWorktreesRow: React.FC = () => {
  const sessionSettings = useSessionSettings();

  return (
    <SettingRow
      title={
        <div className="flex items-center gap-1.5">
          Auto-trust worktree directories
          <InfoTooltip
            label="More info about auto-trust worktrees"
            content="Applies to Claude Code, Codex, Cursor and GitHub Copilot. Writes trust entries before launching."
          />
        </div>
      }
      description="Skip the folder trust prompt in supported CLIs for new sessions."
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('autoTrustWorktrees')}
            defaultLabel="on"
            onReset={sessionSettings.resetAutoTrustWorktrees}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.autoTrustWorktrees}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updateAutoTrustWorktrees}
          />
        </>
      }
    />
  );
};

export const PreserveSessionNameCapitalizationRow: React.FC = () => {
  const sessionSettings = useSessionSettings();

  return (
    <SettingRow
      title="Preserve session name capitalization"
      description="Keep uppercase letters in generated and manually entered session names. Defaults to lowercase."
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('preserveNameCapitalization')}
            defaultLabel="off"
            onReset={sessionSettings.resetPreserveNameCapitalization}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.preserveNameCapitalization}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updatePreserveNameCapitalization}
          />
        </>
      }
    />
  );
};

export const EnableTmuxRow: React.FC = () => {
  const {
    value: locations,
    update,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('location');

  const tmuxByDefault = locations?.tmuxByDefault ?? false;

  return (
    <SettingRow
      title="Enable tmux"
      description="Run agent sessions and terminals in tmux sessions by default."
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('tmuxByDefault')}
            defaultLabel="off"
            onReset={() => resetField('tmuxByDefault')}
            disabled={loading || saving}
          />
          <Switch
            checked={tmuxByDefault}
            disabled={loading || saving}
            onCheckedChange={(checked) => update({ tmuxByDefault: checked })}
          />
        </>
      }
    />
  );
};
