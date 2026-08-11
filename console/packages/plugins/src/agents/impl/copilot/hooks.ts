import type { PluginFs } from '@switch-console/core/agents/plugins';
import type { HookRegistration } from '@switch-console/core/agents/plugins';
import {
  SWITCHDASH_MARKER,
  buildFlatEntry,
  filterUserHooks,
  makeNotificationHookCommand,
  makeStdinHookCommand,
  readJsonConfig,
  writeJsonConfig,
} from '@switch-console/core/agents/plugins/helpers';

export const COPILOT_HOOKS_PATH = '.github/hooks/switchdash.json';

export function buildCopilotHookConfig() {
  const stopCmd = makeStdinHookCommand('stop');
  const sessionCmd = makeStdinHookCommand('session');
  const permCmd = makeNotificationHookCommand('permission_prompt');

  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, COPILOT_HOOKS_PATH);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const installed = ['agentStop', 'sessionStart', 'permissionRequest'].some((k) => {
        const entries = Array.isArray(hooks[k]) ? hooks[k] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
      return installed ? [{ event: 'switchdash', command: SWITCHDASH_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readJsonConfig(fs, COPILOT_HOOKS_PATH);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;

      const stopExisting = Array.isArray(hooks.agentStop) ? hooks.agentStop : [];
      hooks.agentStop = [
        ...filterUserHooks(stopExisting as Record<string, unknown>[]),
        buildFlatEntry(stopCmd),
      ];
      const sessionExisting = Array.isArray(hooks.sessionStart) ? hooks.sessionStart : [];
      hooks.sessionStart = [
        ...filterUserHooks(sessionExisting as Record<string, unknown>[]),
        buildFlatEntry(sessionCmd),
      ];
      const permExisting = Array.isArray(hooks.permissionRequest) ? hooks.permissionRequest : [];
      hooks.permissionRequest = [
        ...filterUserHooks(permExisting as Record<string, unknown>[]),
        buildFlatEntry(permCmd),
      ];
      if (Array.isArray(hooks.notification)) {
        hooks.notification = filterUserHooks(hooks.notification as Record<string, unknown>[]);
      }

      await writeJsonConfig(fs, COPILOT_HOOKS_PATH, { ...config, version: 1, hooks });
      return [COPILOT_HOOKS_PATH];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readJsonConfig(fs, COPILOT_HOOKS_PATH);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      for (const key of Object.keys(hooks)) {
        hooks[key] = filterUserHooks(hooks[key] as Record<string, unknown>[]);
      }
      await writeJsonConfig(fs, COPILOT_HOOKS_PATH, { ...config, hooks });
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, COPILOT_HOOKS_PATH);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return ['agentStop', 'sessionStart', 'permissionRequest'].some((k) => {
        const entries = Array.isArray(hooks[k]) ? hooks[k] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
    },
  };
}
