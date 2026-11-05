// The AI logins on the person's box (hosted agents v2, Switch web): give one,
// sealed in this page to the box's own controller key, or take one back.
// Switch stores and relays only the sealed blob; the box opens it.
//
//   GET    /management/controllers/{id}/provider-logins             which, never what
//   PUT    /management/controllers/{id}/provider-logins/{provider}  {sealed}
//   DELETE /management/controllers/{id}/provider-logins/{provider}
//   GET    /management/operations?controller_id={id}                how the box took it

import { fetchCloudMachine } from "./hostedCloud";
import { type Controller, fetchControllers, type Operation } from "./management";
import { type ProviderLogin, type SealedLogin, SealRefused, sealLogin } from "./sealLogin";

const BASE = "/gateway/management";

/** A login the box holds, as its owner sees it: which provider and revision, never what it holds. */
export interface CloudLogin {
  provider: string;
  revision: number;
  key_id: string;
  updated_at: string;
}

export class CloudLoginError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CloudLoginError";
  }
}

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { error?: { message?: unknown } };
      if (typeof payload.error?.message === "string") message = payload.error.message;
    } catch {
      // No envelope: the status says it.
    }
    throw new CloudLoginError(res.status, message);
  }
  return (await res.json()) as T;
}

/**
 * The controller a login may be sealed to: **only** the one the person's v2 box
 * enrolled as (hosted-machines' current `controller_id`), never one picked
 * from their machines by kind, which also holds their own computers. It must
 * be theirs, not revoked, and hold an X25519 key. `sealLogin` then checks the
 * key against its id. Anything else refuses, and nothing is sealed or sent.
 */
export async function boxController(): Promise<Controller & { public_key: { alg: string; key: string; key_id: string } }> {
  const box = await fetchCloudMachine();
  if (!box || box.controller_id === null) throw new SealRefused("key_mismatch");
  const controller = (await fetchControllers()).find((c) => c.id === box.controller_id);
  if (!controller || controller.revoked_at !== null || controller.public_key?.alg !== "X25519")
    throw new SealRefused("key_mismatch");
  return controller as Controller & { public_key: { alg: string; key: string; key_id: string } };
}

export async function listCloudLogins(controllerId: string): Promise<CloudLogin[]> {
  return call<CloudLogin[]>(`/controllers/${encodeURIComponent(controllerId)}/provider-logins`, "GET");
}

/**
 * Seals `login` here to the box's controller and gives it the sealed blob.
 * The `provider.login` operation says whether the provider signs in with it.
 */
export async function giveCloudLogin(
  provider: string,
  login: ProviderLogin,
): Promise<{ controllerId: string; operation: Pick<Operation, "id" | "state"> }> {
  const controller = await boxController();
  const sealed: SealedLogin = await sealLogin({
    publicKey: controller.public_key.key,
    keyId: controller.public_key.key_id,
    controllerId: controller.id,
    provider,
    login,
  });
  const answer = await call<{ operation: Pick<Operation, "id" | "state"> }>(
    `/controllers/${encodeURIComponent(controller.id)}/provider-logins/${encodeURIComponent(provider)}`,
    "PUT",
    { sealed },
  );
  return { controllerId: controller.id, operation: answer.operation };
}

/** Takes the login back; the box checks the provider again (`provider.recheck`) and stops using it. */
export async function withdrawCloudLogin(provider: string): Promise<{ controllerId: string }> {
  const box = await fetchCloudMachine();
  if (!box || box.controller_id === null) throw new SealRefused("key_mismatch");
  await call<{ ok: boolean }>(
    `/controllers/${encodeURIComponent(box.controller_id)}/provider-logins/${encodeURIComponent(provider)}`,
    "DELETE",
  );
  return { controllerId: box.controller_id };
}

export const OPERATION_POLL_MS = 3000;
export const OPERATION_WAIT_MS = 3 * 60_000;
const DONE = new Set(["succeeded", "failed", "cancelled", "expired"]);

/**
 * How the box took a login or a recheck: the operation `id`'s end state, or
 * the latest `kind` operation for `provider` made after `since`, polled until
 * it ends or the wait runs out (`null`).
 */
export async function waitForOperation(
  controllerId: string,
  match: { id: string } | { kind: string; provider: string; since: number },
  options: { pollMs?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Operation["state"] | null> {
  const pollMs = options.pollMs ?? OPERATION_POLL_MS;
  const deadline = Date.now() + (options.waitMs ?? OPERATION_WAIT_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const operations = await call<Operation[]>(
      `/operations?controller_id=${encodeURIComponent(controllerId)}`,
      "GET",
    );
    const found =
      "id" in match
        ? operations.find((op) => op.id === match.id)
        : operations
            .filter(
              (op) =>
                op.kind === match.kind &&
                op.params?.provider === match.provider &&
                Date.parse(op.created_at) >= match.since - 5000,
            )
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (found && DONE.has(found.state)) return found.state;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}
