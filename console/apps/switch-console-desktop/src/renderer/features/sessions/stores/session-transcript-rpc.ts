import { rpc } from '@renderer/lib/ipc';
import type { SessionTranscriptRpc } from '@shared/core/sessions/session-transcript';

/** The `sessionTranscript` controller, typed by its shared contract. */
export function transcriptRpc(): SessionTranscriptRpc {
  return rpc.sessionTranscript;
}
