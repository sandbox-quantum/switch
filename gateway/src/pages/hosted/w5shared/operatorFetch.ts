import { formatDateTime } from "../../../theme/hootFormat";

/** A read of one of Core's operator routes, for the W5 tabs (Alerts, Audit
 *  log, Operators). Only four outcomes reach the screen: the parsed body; a
 *  401, after which the tab asks the app to check the session again, so a
 *  signed-out person goes to sign-in as on every other page; a 403, shown as
 *  "Operators only"; or an error, shown as one fixed line. The server's own
 *  text is never passed on. */
export type OperatorRead<T> =
  { kind: "ok"; body: T } | { kind: "signedOut" } | { kind: "refused" } | { kind: "error" };

export async function readOperatorRoute<T>(
  path: string,
  parse: (raw: unknown) => T | null,
  signal?: AbortSignal,
): Promise<OperatorRead<T>> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { kind: "error" };
  }
  if (res.status === 401) return { kind: "signedOut" };
  if (res.status === 403) return { kind: "refused" };
  if (!res.ok) return { kind: "error" };
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { kind: "error" };
  }
  const body = parse(raw);
  return body === null ? { kind: "error" } : { kind: "ok", body };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A time for a W5 row, in the app's usual format (`formatDateTime`, e.g.
 *  "2026-10-29 10:51 AM"), never the browser's own locale. An unreadable or
 *  missing time shows as "—". */
export function shortTime(iso: string | null): string {
  return formatDateTime(iso);
}
