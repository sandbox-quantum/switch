import { toast } from 'sonner';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';

/** What the main process reports back from an attempt to open something. */
type OpenAttempt = { success: boolean; error?: string };

/** Tell the user an open did not happen, for a caller that never got as far as trying. */
export function reportOpenFailure(failureTitle: string, failureDetail: string): void {
  toast.error(failureTitle, { description: failureDetail });
}

/**
 * Report an attempt to open something outside Switch Console, saying so when it did
 * not work.
 *
 * The main process has always reported whether the hand-off succeeded, and
 * every call site dropped that answer — so a link the OS could not open looked
 * exactly like one that opened fine, and a dead action was indistinguishable
 * from a working one. Route opens through here so the failure reaches whoever
 * clicked.
 *
 * Returns whether it opened, for callers with more to do than tell the user.
 */
export async function reportOpenAttempt(
  attempt: Promise<OpenAttempt>,
  failureTitle: string,
  failureDetail: string
): Promise<boolean> {
  try {
    const result = await attempt;
    if (result.success) return true;
    toast.error(failureTitle, { description: result.error ?? failureDetail });
  } catch (cause) {
    const { detail } = describeFailure(cause, failureTitle);
    toast.error(failureTitle, { description: detail ?? failureDetail });
  }
  return false;
}

/** Open a URL outside Switch Console, reporting a failure rather than swallowing it. */
export function openExternalUrl(url: string, failureTitle: string): Promise<boolean> {
  return reportOpenAttempt(rpc.app.openExternal(url), failureTitle, url);
}
