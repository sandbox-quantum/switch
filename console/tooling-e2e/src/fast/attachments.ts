import { expect } from 'vitest';
import { sleep } from '../clients/switch-client.ts';
import { WRITABLE, type FastScenario } from './scenario.ts';

// An em dash and the narrow no-break space a macOS screenshot name carries:
// neither is latin-1, the only charset an HTTP header carries as is.
const FILE_NAME = 'Device profile — SSH host notes.txt';
const HISTORY_DEADLINE_MS = 30_000;

/**
 * An attachment whose name is not latin-1 is posted, listed and downloaded
 * under its own name. Its download put the name straight into
 * `Content-Disposition`, which failed with a 500, so the agent never got the
 * file.
 */
export const attachmentNames: FastScenario = {
  header: {
    id: 'attachment-names',
    covers: [
      'POST /agents/{agent_id}/rooms/{room_id}/media',
      'GET /agents/{agent_id}/rooms/{room_id}/media',
      'read_context',
    ],
    lane: 'fast',
    environments: WRITABLE,
    owner: 'platform',
    requires: [],
  },
  async run({ fixtures, names, switchClient }) {
    const sender = await fixtures.agent('up');
    const reader = await fixtures.agent('down');
    const room = await fixtures.internalRoom('room', [sender, reader]);

    const bytes = new TextEncoder().encode(`${names.marker('file')}\nnaïve café ✓\n`);
    const posted = await switchClient.uploadMedia(sender, room.id, {
      name: FILE_NAME,
      bytes,
      contentType: 'text/plain',
    });

    interface Entry {
      attachments: { filename: string; mxc: string }[];
    }
    let listed: { filename: string; mxc: string } | undefined;
    const until = Date.now() + HISTORY_DEADLINE_MS;
    while (listed === undefined && Date.now() < until) {
      const context = await switchClient.callOperation<{
        threads: { root: Entry; replies: Entry[] }[];
      }>(reader, 'read_context', { room_id: room.id, limit: 20 });
      listed = context.threads
        .flatMap((thread) => [thread.root, ...thread.replies])
        .flatMap((entry) => entry.attachments)
        .find((attachment) => attachment.mxc === posted.mxc);
      if (listed === undefined) await sleep(1_000);
    }
    expect(listed, `the room's history never listed ${posted.mxc}`).toBeDefined();
    expect(listed!.filename).toBe(FILE_NAME);

    const download = await switchClient.downloadMedia(reader, room.id, posted.mxc);
    expect(Buffer.from(download.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(download.contentType).toMatch(/^text\/plain/);
    // RFC 6266: the name itself, percent-encoded as UTF-8, in `filename*`.
    expect(download.contentDisposition).toContain(
      `filename*=UTF-8''${encodeURIComponent(FILE_NAME)}`
    );
  },
};
