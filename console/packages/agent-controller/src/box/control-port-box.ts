import { overControlPort } from '../control-port';

/**
 * Box only: the control-port requests a box's controller and launcher make of
 * an agent host in a process of its own, on top of `overControlPort`.
 */

/**
 * Tell an agent host in a process of its own that the memory guard is about
 * to stop it, so it tells its rooms. Resolves to how many rooms it told.
 */
export async function stopForMemoryOverControlPort(controlFile: string): Promise<number> {
  return overControlPort(controlFile, (client) => client.stopForMemory());
}

/** The control port named in `control.json` isn't the spawned host's own. */
export class WrongPortError extends Error {
  constructor() {
    super('The control port is not the agent host’s own.');
    this.name = 'WrongPortError';
  }
}

/**
 * From the launcher on a split box: hands a host the one-time ticket for its next hub
 * hello, with its HMAC under the launch's push key, over its own control port.
 * `ownsPort` is asked first, with the port the file names: unless the spawned
 * host is listening on it, nothing is sent (`WrongPortError`). Resolves to the
 * host's answer, its confirmation HMAC; a ticket can never be read back.
 */
export async function giveHubTicketOverControlPort(
  controlFile: string,
  ticket: string,
  mac: string,
  ownsPort: (port: number) => Promise<boolean>
): Promise<string> {
  return overControlPort(
    controlFile,
    (client) => client.giveHubTicket(ticket, mac),
    async (port) => {
      if (!(await ownsPort(port))) throw new WrongPortError();
    }
  );
}

/** How long a new host is given to write its own control file and take its ticket. */
export const TICKET_HANDOVER_MS = 10_000;
const TICKET_RETRY_MS = 500;

/**
 * From the launcher on a split box: hands a spawned host its ticket, waiting until
 * `deadlineMs` for the host's own control file. Every attempt asks `ownsPort`
 * first, so the ticket only ever goes to the spawned host's own port: a file
 * naming any other port (a dead host's left on the disk, or another process's)
 * is waited past, never used. Still not the host's port at the deadline:
 * `wrong_port`, and the launcher ends the host. Other
 * failures (no file yet) are retried the same way, then thrown.
 */
export async function pushTicketUntilTaken(input: {
  controlFile: string;
  ticket: string;
  mac: string;
  ownsPort: (port: number) => Promise<boolean>;
  taken: (answer: string) => boolean;
  deadlineMs?: number;
  retryMs?: number;
}): Promise<'taken' | 'wrong_port' | 'not_taken'> {
  const deadline = Date.now() + (input.deadlineMs ?? TICKET_HANDOVER_MS);
  for (;;) {
    try {
      const answer = await giveHubTicketOverControlPort(
        input.controlFile,
        input.ticket,
        input.mac,
        input.ownsPort
      );
      return input.taken(answer) ? 'taken' : 'not_taken';
    } catch (error) {
      if (Date.now() > deadline) {
        if (error instanceof WrongPortError) return 'wrong_port';
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, input.retryMs ?? TICKET_RETRY_MS));
    }
  }
}
