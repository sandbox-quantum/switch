/** Every request the dashboard sends its server goes through `gatewayFetch`,
 * which does what each of them needs and none should do on its own:
 *
 * - It gives up after a while, saying the server didn't answer, rather than
 *   leaving a spinner turning for good.
 * - A write names the workspace the page shows (`WORKSPACE_HEADER`). The
 *   session's workspace is a claim in a cookie every tab shares, so a tab left
 *   open after another switched workspace would otherwise write into the new
 *   one while still showing the old; the server refuses such a write with a
 *   409 (`WORKSPACE_MISMATCH`).
 * - It tells the session what the server's answers say about it
 *   (`onSessionSignal`): a 401 means the session has ended, a 403 that the
 *   person's role may have changed, and that 409 that the tab is out of date.
 */

export const WORKSPACE_HEADER = "X-Switch-Workspace";
export const WORKSPACE_MISMATCH = "workspace_mismatch";

/** How long a request waits for the server. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** For a request known to take long, such as provisioning a room. */
export const LONG_REQUEST_TIMEOUT_MS = 120_000;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

let shownWorkspace: string | null = null;

/** The workspace this page shows, named on every write it sends; null while
 * it shows none (signed out, or choosing one). */
export function setShownWorkspace(workspaceId: string | null): void {
  shownWorkspace = workspaceId;
}

export type SessionSignal =
  | { kind: "ended" }
  | { kind: "refused" }
  | { kind: "workspace_mismatch"; message: string };

type Listener = (signal: SessionSignal) => void;

const listeners = new Set<Listener>();

/** Hear what the server's answers say about the session. Returns the way to
 * stop listening. */
export function onSessionSignal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function signal(what: SessionSignal): void {
  for (const listener of listeners) listener(what);
}

/** The server didn't answer in time. */
export class ServerTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`Switch didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Try again.`);
    this.name = "ServerTimeout";
  }
}

async function mismatchMessage(res: Response): Promise<string | null> {
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : null;
  if (!detail || typeof detail !== "object") return null;
  const { error, message } = detail as { error?: unknown; message?: unknown };
  return error === WORKSPACE_MISMATCH && typeof message === "string" ? message : null;
}

export async function gatewayFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!SAFE_METHODS.has(method) && shownWorkspace !== null) headers.set(WORKSPACE_HEADER, shownWorkspace);
  // Aborted with the reason, so a request or the reading of its body that
  // outlasts it fails with that, not a bare "aborted". Left to run once the
  // answer begins: a body that stalls is as stuck as no answer.
  const controller = new AbortController();
  setTimeout(() => controller.abort(new ServerTimeout(timeoutMs)), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, credentials: "include", signal: controller.signal });
  } catch (err) {
    if (controller.signal.reason instanceof ServerTimeout) throw controller.signal.reason;
    throw err;
  }
  if (res.status === 401) signal({ kind: "ended" });
  else if (res.status === 403) signal({ kind: "refused" });
  else if (res.status === 409) {
    const message = await mismatchMessage(res);
    if (message !== null) signal({ kind: "workspace_mismatch", message });
  }
  return res;
}
