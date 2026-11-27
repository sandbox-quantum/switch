import { resolveWorkdirFsFor } from './agent-workdir-fs';
import { agentSettingsRelativePath } from './switch-settings-paths';
import {
  existingAgentIdInSlot,
  foreignCredentialsOwnerFs,
  prepareAgentCredentialsFile,
  UnignoredAgentCredentialsError,
} from './write-switch-settings';

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
  const workdir = await resolveWorkdirFsFor(sshHost, dir);
  try {
    return await foreignCredentialsOwnerFs(workdir.fs, slug, apiEndpoint);
  } finally {
    workdir.close();
  }
}

/**
 * The `SWITCH_AGENT_ID` of an agent already configured in the credentials slot
 * for `slug`, when the file belongs to the SAME deployment as `apiEndpoint` —
 * otherwise null.
 *
 * The create path calls this after the cross-deployment check
 * ({@link foreignCredentialsOwner}) and before minting a new identity. A
 * same-server file whose agent id is unknown to this install's database is a
 * colleague's agent: minting over it would overwrite their token (CHOO-2560).
 */
export async function sameEndpointAgentId(
  sshHost: string | null,
  dir: string,
  slug: string,
  apiEndpoint: string
): Promise<string | null> {
  const workdir = await resolveWorkdirFsFor(sshHost, dir);
  try {
    const existingRaw = await workdir.fs.read(agentSettingsRelativePath(slug));
    return existingAgentIdInSlot(existingRaw, apiEndpoint);
  } finally {
    workdir.close();
  }
}

/**
 * Why `slug`'s credentials file in a working directory cannot be given a
 * token, or null when it can. Puts Console's `.gitignore` in place and asks
 * git ({@link prepareAgentCredentialsFile}), so a create path calling this
 * before minting turns a file the repository tracks into a refusal with
 * nothing left behind on the server, as {@link foreignCredentialsOwner} does
 * for another deployment's file.
 */
export async function credentialsFileRefusal(
  sshHost: string | null,
  dir: string,
  slug: string
): Promise<string | null> {
  const workdir = await resolveWorkdirFsFor(sshHost, dir);
  try {
    await prepareAgentCredentialsFile(workdir, slug);
    return null;
  } catch (error) {
    if (error instanceof UnignoredAgentCredentialsError) return error.message;
    throw error;
  } finally {
    workdir.close();
  }
}
