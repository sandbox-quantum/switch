import { Emitter } from '@switch-console/shared';

/** A chunk of output from an install command, as the host produces it. */
export type InstallOutputChunk = { sshHost: string; chunk: string };

/**
 * Live output from remote install commands, keyed by host.
 *
 * The install runner is built once per host and cached with its dependency
 * manager, so a caller cannot hand it a callback for one particular install.
 * This is how output reaches whoever is watching at the time — today the host
 * setup service, which knows which step is running and turns it into the line
 * shown beside it.
 */
export const installOutput = new Emitter<InstallOutputChunk>();
