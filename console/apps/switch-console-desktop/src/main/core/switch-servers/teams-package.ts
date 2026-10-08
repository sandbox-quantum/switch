import { writeFile } from 'node:fs/promises';
import { dialog } from 'electron';
import { getMainWindow } from '@main/app/window';
import { fetchTeamsPackage } from '@main/core/switch-servers/gateway-client';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Let the user save the distributed Teams app's install package to disk, for a
 * Teams admin to upload by hand (Teams admin center → Teams apps → Manage apps
 * → Upload new app) when the app is not yet in the organisation's catalogue.
 *
 * The save dialog is shown before the package is fetched, so cancelling costs
 * no round trip. Returns the saved path, or null if the user cancelled.
 */
export async function saveTeamsPackage(
  server: SwitchServer,
  bridgeId: string,
  defaultFileName: string
): Promise<string | null> {
  const win = getMainWindow();
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, {
    title: 'Save Microsoft Teams app package',
    defaultPath: defaultFileName,
    filters: [{ name: 'Teams app package', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const bytes = await fetchTeamsPackage(server, bridgeId);
  await writeFile(result.filePath, Buffer.from(bytes));
  return result.filePath;
}
