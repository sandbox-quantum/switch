/**
 * Whether removing an agent also deletes the files Console provisioned for it.
 *
 * On a shared SSH host those files may belong to another install — an agent
 * loaded rather than created — so removing them is the operator's choice. On
 * this machine Console put them there and nothing else reads them, so leaving
 * stale credentials behind is not a choice worth offering.
 */
export function removesProvisionedFiles(input: {
  sshHost: string | null;
  dir: string | null;
  chosen: boolean;
}): boolean {
  if (input.dir === null) return false;
  return input.sshHost === null ? true : input.chosen;
}
