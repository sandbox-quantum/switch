import type { EmbeddedControllerOverview } from '@shared/core/embedded-controller/embedded-controller';
import {
  FLAGS_NOT_READ_YET,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';

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

/**
 * The gateway's refusal of a read made before signing in (gateway-client.ts).
 * A fresh Console reads every server's flags before anyone has signed in, so
 * this is the first answer on every first sign-in.
 */
export const FLAGS_NOT_SIGNED_IN = 'Not signed in to this Switch server.';

/**
 * Whether the server's flags give the buddy an answer to open on: read, or
 * failed while signed in (then they stay off, so v1 is never held up). Not
 * read yet, or refused because nobody had signed in yet, is no answer: on a v2
 * server that would enrol this computer without asking (B38) on a first
 * sign-in. The read after signing in answers.
 */
export function flagsAnswered(state: Pick<ServerFeatureFlags, 'fetchedAt' | 'error'>): boolean {
  if (state.fetchedAt !== null && state.error === null) return true;
  return (
    state.error !== null &&
    state.error !== FLAGS_NOT_READ_YET &&
    state.error !== FLAGS_NOT_SIGNED_IN
  );
}
