import { app } from 'electron';

export type MockMode = 'workspace_admin' | 'operator' | 'unreachable';

/**
 * Sample data for building the v3 screens before the server has the
 * endpoints. Only in a development run, and only when asked for with
 * `SWITCH_CONSOLE_V3_MOCK`: `1` (or `operator`) for a Switch operator,
 * `unreachable` for figures the server can't read, and `workspace_admin` for
 * the parked workspace-admin view. A packaged build never shows it: a release
 * build is cut with `import.meta.env.DEV` false, so this is null whatever the
 * environment says, and a packaged dev build is refused too.
 */
export function sharedCloudMock(): MockMode | null {
  if (!import.meta.env.DEV || app.isPackaged) return null;
  const asked = process.env.SWITCH_CONSOLE_V3_MOCK;
  if (asked === '1' || asked === 'operator') return 'operator';
  if (asked === 'workspace_admin' || asked === 'unreachable') return asked;
  return null;
}
