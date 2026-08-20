import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { foreignCredentialsOwnerFs } from './write-switch-settings';

/**
 * The Switch deployment that already owns `.switch/agents/<slug>.json` in a
 * working directory, when that is a different deployment from `apiEndpoint` —
 * otherwise null.
 *
 * A create path calls this BEFORE minting an identity. The writer refuses the
 * same collision, but a refusal there comes after registration: the agent exists
 * on the server and its API key, returned once, is already lost. Checking first
 * turns that into a clean "pick another name" (CHOO-1960).
 *
 * Opens the working directory (local disk, or the repo dir over SFTP) for the
 * read alone and closes it again, so nothing is held across the registration
 * call that follows.
 */
export async function foreignCredentialsOwner(
  sshHost: string | null,
  dir: string,
  slug: string,
  apiEndpoint: string
): Promise<string | null> {
  const workspace = await resolveWorkspaceFsFor(sshHost, dir);
  try {
    return await foreignCredentialsOwnerFs(workspace.fs, slug, apiEndpoint);
  } finally {
    workspace.close();
  }
}
