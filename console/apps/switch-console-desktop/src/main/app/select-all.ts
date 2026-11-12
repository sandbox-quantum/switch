import { webContents } from 'electron';
import { getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { menuSelectAllChannel } from '@shared/events/appEvents';

/**
 * Edit > Select All. In the app's own window the renderer decides, so it acts
 * only inside the focused text field rather than selecting the whole window
 * (CHOO-4120). Other web contents (DevTools, the embedded room) keep
 * Chromium's select-all.
 */
export function selectAll(): void {
  const focused = webContents.getFocusedWebContents();
  const win = getMainWindow();
  const mainContents = win && !win.isDestroyed() ? win.webContents : null;
  if (mainContents && (!focused || focused === mainContents)) {
    events.emit(menuSelectAllChannel, undefined);
    return;
  }
  if (focused && !focused.isDestroyed()) focused.selectAll();
}
