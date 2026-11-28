import { Switch } from '@switch-console/chat-ui/primitives/switch';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { SettingRow } from './SettingRow';

export function ProviderUsageSetting() {
  const settings = useAppSettingsKey('interface');
  return (
    <SettingRow
      title="Show provider usage bar"
      description="Show local subscription usage for supported AI providers along the bottom of Switch Console. The official provider CLIs run on this computer and may refresh stored sign-in tokens as needed."
      control={
        <Switch
          aria-label="Show provider usage bar"
          checked={settings.value?.showProviderUsageBar === true}
          disabled={settings.isLoading || settings.isSaving}
          onCheckedChange={(showProviderUsageBar) => settings.update({ showProviderUsageBar })}
        />
      }
    />
  );
}
