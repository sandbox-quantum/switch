import { applyHistoryEntry } from '@renderer/lib/components/nav-buttons';
import { toast } from '@renderer/lib/hooks/use-toast';
import { toggleSettingsView } from '@renderer/lib/layout/settings-toggle';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { toggleAppTheme } from '@renderer/lib/theme/theme-toggle';
import { APP_COMMAND_DEFS, type AppCommandId, type CommandDef } from '@shared/commands';
import { commandRegistry } from './registry';
import type { AppCommand, CommandProvider } from './types';

function appDef(id: AppCommandId): CommandDef {
  return APP_COMMAND_DEFS.find((d) => d.id === id)!;
}

function createAppCommandProvider(): CommandProvider {
  return {
    scopeId: 'app',

    getCommands(): AppCommand[] {
      // Reads MobX observables — reactions automatically invalidate activeCommands
      // when navigation changes.
      const settingsDef = appDef('app.settings');
      const newLocationDef = appDef('app.newLocation');
      const addServerDef = appDef('app.addServer');
      const toggleThemeDef = appDef('app.toggleTheme');
      const navigateBackDef = appDef('app.navigateBack');
      const navigateForwardDef = appDef('app.navigateForward');

      const commands: AppCommand[] = [
        {
          id: settingsDef.id,
          label: settingsDef.label,
          description: settingsDef.description,
          shortcutKey: settingsDef.shortcutKey,
          group: settingsDef.group,
          execute() {
            toggleSettingsView(
              appState.navigation.navigate.bind(appState.navigation),
              appState.navigation.currentViewId,
              appState.navigation.lastNonSettingsView
            );
          },
        },
        {
          id: newLocationDef.id,
          label: newLocationDef.label,
          description: newLocationDef.description,
          shortcutKey: newLocationDef.shortcutKey,
          group: newLocationDef.group,
          execute() {
            showModal('addAgentModal', {});
          },
        },
        {
          id: addServerDef.id,
          label: addServerDef.label,
          description: addServerDef.description,
          shortcutKey: addServerDef.shortcutKey,
          group: addServerDef.group,
          execute() {
            showModal('addServerModal', {});
          },
        },
      ];

      commands.push({
        id: toggleThemeDef.id,
        label: toggleThemeDef.label,
        description: toggleThemeDef.description,
        shortcutKey: toggleThemeDef.shortcutKey,
        group: toggleThemeDef.group,
        execute() {
          void toggleAppTheme().then((result) => {
            if (result.success) return;
            toast({
              title: 'Theme not changed',
              description: result.error.message,
              variant: 'destructive',
            });
          });
        },
      });

      commands.push(
        {
          id: navigateBackDef.id,
          label: navigateBackDef.label,
          description: navigateBackDef.description,
          shortcutKey: navigateBackDef.shortcutKey,
          group: navigateBackDef.group,
          enabled: appState.history.canGoBack,
          hideFromPalette: true,
          execute() {
            appState.history.back(applyHistoryEntry);
          },
        },
        {
          id: navigateForwardDef.id,
          label: navigateForwardDef.label,
          description: navigateForwardDef.description,
          shortcutKey: navigateForwardDef.shortcutKey,
          group: navigateForwardDef.group,
          enabled: appState.history.canGoForward,
          hideFromPalette: true,
          execute() {
            appState.history.forward(applyHistoryEntry);
          },
        }
      );

      return commands;
    },
  };
}

/**
 * Registers the app-scope CommandProvider. Must be called once at startup.
 * The provider is permanent — it reacts to navigation changes via MobX
 * observables inside getCommands().
 */
export function setupAppCommandProvider(): void {
  commandRegistry.register(createAppCommandProvider());
}
