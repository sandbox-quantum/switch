import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { GuardResult } from '@renderer/app/view-registry';
import {
  SettingsPage,
  type SettingsPageTab,
} from '@renderer/features/settings/components/SettingsPage';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { useParams } from '@renderer/lib/layout/navigation-provider';

const SettingsTabContext = createContext<{
  tab: SettingsPageTab;
  onTabChange: (tab: SettingsPageTab) => void;
}>({ tab: 'general', onTabChange: () => {} });

/** Minimal passthrough — exists so the registry can infer WrapParams<'settings'>. */
export function SettingsViewWrapper({
  children,
  tab = 'general',
}: {
  children: ReactNode;
  tab?: SettingsPageTab;
}) {
  const { setParams } = useParams('settings');
  const handleTabChange = useCallback(
    (tab: SettingsPageTab) => {
      setParams({ tab });
    },
    [setParams]
  );
  return (
    <SettingsTabContext.Provider value={{ tab, onTabChange: handleTabChange }}>
      {children}
    </SettingsTabContext.Provider>
  );
}

export function useSettingsTab() {
  if (!useContext(SettingsTabContext)) {
    throw new Error('useSettingsTab must be used within a SettingsViewWrapper');
  }
  return useContext(SettingsTabContext);
}

export function SettingsTitlebar() {
  return (
    <Titlebar
      leftSlot={
        <div className="flex items-center px-2">
          <span className="text-sm text-foreground-muted">Settings</span>
        </div>
      }
    />
  );
}

export function SettingsMainPanel() {
  const { tab, onTabChange } = useSettingsTab();
  return (
    <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden bg-background">
      <SettingsPage tab={tab} onTabChange={onTabChange} />
    </div>
  );
}

export const settingsView = {
  WrapView: SettingsViewWrapper,
  MainPanel: SettingsMainPanel,
  /**
   * Remote hosts moved out of Settings to their own view (CHOO-1809). A
   * persisted snapshot from an older build can still name that tab, which would
   * otherwise render Settings with nothing selected — send it to the new view.
   */
  canActivate: (params: unknown): GuardResult => {
    const tab =
      typeof params === 'object' && params !== null ? (params as { tab?: unknown }).tab : undefined;
    if (tab === 'remote-hosts') return { ok: false, redirect: 'remoteHosts' };
    return { ok: true };
  },
};
