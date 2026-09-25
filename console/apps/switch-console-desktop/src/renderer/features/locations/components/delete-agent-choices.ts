/**
 * Whether removing an agent also removes it from where it runs: the files
 * Console provisioned for it and, on a remote host, what it runs there.
 *
 * On a shared SSH host those files may belong to another install — an agent
 * loaded rather than created — so removing them is the operator's choice,
 * except when the agent is also deleted in Switch: a deleted identity has
 * nothing left to run, so it goes from the host too (CHOO-2893). On this
 * machine Console put the files there and nothing else reads them, so leaving
 * stale credentials behind is not a choice worth offering.
 */
export function removesProvisionedFiles(input: {
  sshHost: string | null;
  dir: string | null;
  chosen: boolean;
  deleteInSwitch: boolean;
}): boolean {
  if (input.dir === null) return false;
  return input.sshHost === null ? true : input.chosen || input.deleteInSwitch;
}
