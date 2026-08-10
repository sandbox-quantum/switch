import { Info } from 'lucide-react';
import React from 'react';
import { useSessionSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Switch } from '@renderer/lib/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

function InfoTooltip({ label, content }: { label: string; content: React.ReactNode }) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger>
          <button
            type="button"
            className="text-muted-foreground inline-flex h-4 w-4 items-center justify-center hover:text-foreground"
            aria-label={label}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

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
            content="Applies to Claude Code and GitHub Copilot. Writes trust entries before launching."
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

export const CreateBranchAndWorktreeRow: React.FC = () => {
  const sessionSettings = useSessionSettings();

  return (
    <SettingRow
      title="Create branch and worktree by default"
      description="Start new From Branch sessions in a dedicated session branch and worktree unless changed in the session modal."
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('createBranchAndWorktree')}
            defaultLabel="on"
            onReset={sessionSettings.resetCreateBranchAndWorktree}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.createBranchAndWorktree}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updateCreateBranchAndWorktree}
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

export const IncludeIssueContextByDefaultRow: React.FC = () => {
  const sessionSettings = useSessionSettings();

  return (
    <SettingRow
      title="Include issue context by default"
      description="Add the selected issue to the initial agent prompt when creating a session from an issue."
      control={
        <>
          <ResetToDefaultButton
            visible={sessionSettings.isFieldOverridden('includeIssueContextByDefault')}
            defaultLabel="on"
            onReset={sessionSettings.resetIncludeIssueContextByDefault}
            disabled={sessionSettings.loading || sessionSettings.saving}
          />
          <Switch
            checked={sessionSettings.includeIssueContextByDefault}
            disabled={sessionSettings.loading || sessionSettings.saving}
            onCheckedChange={sessionSettings.updateIncludeIssueContextByDefault}
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
