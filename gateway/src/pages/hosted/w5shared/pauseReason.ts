import { isRecord, readOperatorRoute, stringOrNull } from "./operatorFetch";

/** Why a person was paused, for Resume's confirm (security's note): the
 *  operator's reason and when, from the operators' audit log. */
export type PauseReason =
  | { kind: "loading" }
  | { kind: "found"; reason: string; at: string }
  /** Paused, but no operator pause with a reason is in the log (Switch's own
   *  pause, or one older than the log keeps). */
  | { kind: "none" }
  | { kind: "error" };

const PAUSED = "hosted.user_paused";

/** The newest pause of `userKeyedId` with a reason, from Core's audit route
 *  (`action` and `target_id` filters). The reason is an operator's own words:
 *  the dialog shows it as text only. */
export async function readPauseReason(
  userKeyedId: string,
  signal?: AbortSignal,
): Promise<PauseReason> {
  const params = new URLSearchParams({ action: PAUSED, target_id: userKeyedId, limit: "5" });
  const read = await readOperatorRoute(
    `/gateway/shared-cloud/audit-events?${params.toString()}`,
    (raw) => (Array.isArray(raw) ? raw : null),
    signal,
  );
  if (read.kind !== "ok") return { kind: "error" };
  for (const item of read.body) {
    if (!isRecord(item) || item.action !== PAUSED || item.target_id !== userKeyedId) continue;
    const details = isRecord(item.details) ? item.details : {};
    const reason = stringOrNull(details.reason);
    const at = stringOrNull(item.occurred_at);
    if (reason && at) return { kind: "found", reason, at };
  }
  return { kind: "none" };
}
