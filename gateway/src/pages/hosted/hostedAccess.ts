/** The shell's access check, which is also the operator overview W4's tabs
 *  read: one `GET /shared-cloud/overview`, guarded by Core's
 *  `require_operator`. The nav entry's `hosted_operator` flag is only a hint:
 *  this read decides what the page shows. The answer is kept in memory only
 *  and handed to tabs through `useHosted().overview`; it is never shown as
 *  text by the shell. */
export type HostedAccess =
  | { kind: "operator"; overview: unknown }
  | { kind: "signed-out" }
  | { kind: "refused" }
  | { kind: "error" };

export const ACCESS_PATH = "/gateway/shared-cloud/overview";

export async function checkHostedAccess(signal?: AbortSignal): Promise<HostedAccess> {
  try {
    const res = await fetch(ACCESS_PATH, { credentials: "include", signal });
    if (res.status === 401) return { kind: "signed-out" };
    if (res.status === 403) return { kind: "refused" };
    if (!res.ok) return { kind: "error" };
    return { kind: "operator", overview: await res.json() };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { kind: "error" };
  }
}
