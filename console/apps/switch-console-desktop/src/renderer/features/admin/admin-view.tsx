import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { settingsForAdminSection } from './admin-sections';

type AdminParams = { serverId?: string; section?: string; app?: string };

/**
 * Where the Admin page was. Its pages are in Settings now, so anything still
 * opening it (a persisted snapshot, an older link) lands on the Settings tab
 * its section became.
 */
export const adminView = {
  WrapView: ({ children }: { children: React.ReactNode } & AdminParams) => <>{children}</>,
  MainPanel: () => null,
  canActivate: (params: unknown): GuardResult => {
    const { section, app } =
      typeof params === 'object' && params !== null ? (params as AdminParams) : {};
    return {
      ok: false,
      redirect: 'settings',
      params: settingsForAdminSection(section, app),
      discardParams: true,
    };
  },
} satisfies ViewDefinition<AdminParams>;
