import type { EmbeddedControllerOverview } from '@shared/core/embedded-controller/embedded-controller';

/** What setting this computer up needs from Console's main process. */
export type ThisComputerApi = {
  getOverview: (params: {
    serverId: string;
    workspaceId: string;
  }) => Promise<Pick<EmbeddedControllerOverview, 'unsupportedReason' | 'enrollment'>>;
  enable: (params: { serverId: string; workspaceId: string }) => Promise<void>;
};

/**
 * Where this computer stands as a machine of the workspace:
 * `enrolled`, it runs managed agents there already (or does now);
 * `needs-permission`, it does not, and nothing was changed (B38: it is
 * enrolled only once the person has said so).
 */
export type ThisComputerSetup = 'enrolled' | 'needs-permission';

/**
 * Reads whether this computer runs managed agents for the workspace and,
 * only when `allowEnrol` is true, enrols it when it does not. Opening a page
 * passes false, so it only reads; the person's choice passes true. Throws
 * when this computer cannot run managed agents here.
 */
export async function setUpThisComputer(
  api: ThisComputerApi,
  serverId: string,
  workspaceId: string,
  allowEnrol: boolean
): Promise<ThisComputerSetup> {
  const overview = await api.getOverview({ serverId, workspaceId });
  if (overview.unsupportedReason) throw new Error(overview.unsupportedReason);
  if (overview.enrollment !== null) return 'enrolled';
  if (!allowEnrol) return 'needs-permission';
  await api.enable({ serverId, workspaceId });
  return 'enrolled';
}

/**
 * What opening a page does about this computer, by the server's flags:
 * `wait` until they are known (so a v2 server never enrols on a first guess);
 * with hosted agents v2 on, `read` only and ask before enrolling (B38); with it
 * off, `enrol` straight away, exactly as upstream does.
 */
export function openingSetup(flagsKnown: boolean, hostedV2: boolean): 'wait' | 'read' | 'enrol' {
  if (!flagsKnown) return 'wait';
  return hostedV2 ? 'read' : 'enrol';
}
