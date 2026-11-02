import { app } from 'electron';

export type MockMode = 'workspace_admin' | 'operator' | 'unreachable';

/**
 * Sample data for building the v3 screens before the server has the
 * endpoints. Only in a development run, and only when asked for with
 * `SWITCH_CONSOLE_V3_MOCK`: `1` (or `operator`) for a Switch operator,
 * `unreachable` for figures the server can't read, and `workspace_admin` for
 * the parked workspace-admin view. A packaged build never shows it.
 */
export function sharedCloudMock(): MockMode | null {
  if (app.isPackaged) return null;
  const asked = process.env.SWITCH_CONSOLE_V3_MOCK;
  if (asked === '1' || asked === 'operator') return 'operator';
  if (asked === 'workspace_admin' || asked === 'unreachable') return asked;
  return null;
}
