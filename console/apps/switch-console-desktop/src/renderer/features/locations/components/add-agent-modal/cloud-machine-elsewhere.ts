import { RpcError } from '@shared/lib/ipc/rpc-error';

/** What the new-agent form says when the person's cloud machine serves another workspace. */
export type CloudMachineElsewhere = { line: string; helper: string };

/**
 * The notice for a claim refused because the person's cloud box already serves
 * another workspace (`CloudMachineInOtherWorkspaceError` in the main process),
 * or null for any other outcome. The other workspace is named only when the
 * server sent its name; otherwise it is "another workspace".
 */
export function cloudMachineElsewhere(error: unknown): CloudMachineElsewhere | null {
  if (!(error instanceof RpcError) || error.code !== 'CloudMachineInOtherWorkspaceError') {
    return null;
  }
  const name = error.stringField('workspaceName')?.trim();
  return {
    line: `Your cloud box is set up in ${name ? name : 'another workspace'}. For now, each person’s cloud box works in one workspace.`,
    helper: 'To add an agent here, choose This computer or another machine.',
  };
}
