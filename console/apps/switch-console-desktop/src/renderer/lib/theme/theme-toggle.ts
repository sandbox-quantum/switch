import { err, ok, type Result } from '@switch-console/shared';
import {
  fetchAppSettingsMeta,
  getAllAppSettingsFromCache,
  getAppSettingsMetaFromCache,
  invalidateAppSettingsKey,
  restoreAppSettingsCache,
  setAppSettingsValueInCache,
  updateAppSettingsRequest,
} from '@renderer/features/settings/app-settings-client';
import { failureText } from '@renderer/lib/errors/describe-failure';
import type { Theme } from '@shared/core/app-settings';
import { getNextTheme } from './theme-toggle-model';

export type ToggleThemeError = { message: string };

function errorMessage(error: unknown): string {
  return failureText(error, 'Could not change the theme.');
}

export async function toggleAppTheme(): Promise<Result<NonNullable<Theme>, ToggleThemeError>> {
  let theme: Theme;
  try {
    theme = (await fetchAppSettingsMeta('theme')).value;
  } catch (error) {
    return err({
      message: errorMessage(error),
    });
  }

  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'emdark'
    : 'emlight';
  const next = getNextTheme(theme, systemTheme);
  const previousMeta = getAppSettingsMetaFromCache('theme');
  const previousAll = getAllAppSettingsFromCache();

  setAppSettingsValueInCache('theme', next);

  try {
    await updateAppSettingsRequest('theme', next);
  } catch (error) {
    restoreAppSettingsCache('theme', previousMeta, previousAll);
    return err({
      message: errorMessage(error),
    });
  } finally {
    invalidateAppSettingsKey('theme');
  }

  return ok(next);
}
