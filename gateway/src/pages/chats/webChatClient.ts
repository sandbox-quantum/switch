import { ChatsClient, type ChatsRequest } from "@switch-console/chat-ui/client/chats-client";
import { chatErrorBodySchema } from "@switch-console/chat-ui/contracts/chats";
import type { ChatFailure, FailureReader } from "@switch-console/chat-ui/model/failures";

const BASE = "/gateway";

/** A `/chats` call that failed: Switch could not be reached, refused it, or answered with an error. */
export class ChatRequestError extends Error {
  constructor(
    readonly kind: "network" | "unauthorized" | "http",
    message: string,
    /** 0 when Switch did not answer. */
    readonly status: number,
    /** The code of a refusal `/chats` explained, such as `NOT_A_MEMBER`; null for any other. */
    readonly apiCode: string | null,
  ) {
    super(message);
    this.name = "ChatRequestError";
  }
}

async function refusal(response: Response): Promise<ChatRequestError> {
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: a proxy's page, say. The status says what happened.
  }
  const coded = chatErrorBodySchema.safeParse(parsed);
  if (coded.success)
    return new ChatRequestError(
      "http",
      coded.data.detail.message,
      response.status,
      coded.data.detail.code,
    );
  const detail = (parsed as { detail?: unknown } | null)?.detail;
  const message =
    typeof detail === "string" && detail ? detail : `Switch answered ${response.status}.`;
  return new ChatRequestError(
    response.status === 401 ? "unauthorized" : "http",
    message,
    response.status,
    null,
  );
}

/** Calls a gateway route with the browser's sign-in, raising a {@link ChatRequestError} for any failure. */
export async function callGateway(
  path: string,
  request: ChatsRequest & { signal?: AbortSignal },
): Promise<Response> {
  const json = request.body !== undefined;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: request.method ?? "GET",
      credentials: "include",
      headers: json ? { "Content-Type": "application/json" } : undefined,
      body: request.formData ?? (json ? JSON.stringify(request.body) : undefined),
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new ChatRequestError(
      "network",
      error instanceof Error ? error.message : String(error),
      0,
      null,
    );
  }
  if (!response.ok) throw await refusal(response);
  return response;
}

export function warn(message: string, context: Record<string, unknown>): void {
  console.warn(message, context);
}

export const webChatsClient = new ChatsClient({ call: callGateway, warn });

/** Reads as a finished sentence rather than a status line or a stack-ish blob. */
function isSentence(text: string): boolean {
  return (
    text.length >= 12 &&
    text.length <= 300 &&
    !text.includes("\n") &&
    /^[A-Z]/.test(text) &&
    /[.!?]$/.test(text)
  );
}

const API_CODES: Record<string, ChatFailure["kind"]> = {
  NOT_A_MEMBER: "not-a-member",
  REQUEST_REUSED: "request-reused",
  MESSAGE_REFUSED: "refused",
  NOT_A_MANAGER: "not-a-manager",
  AGENT_OWNER: "agent-owner",
};

/** How the chat UI reads the dashboard's failures. */
export const webFailures: FailureReader = {
  describe: (error, fallback) => {
    if (error instanceof ChatRequestError) {
      if (error.kind === "unauthorized")
        return { headline: "Your session expired. Sign in again, then retry.", detail: null };
      if (error.kind === "network")
        return { headline: "Could not reach Switch. Check that you are online.", detail: error.message };
      if (error.apiCode !== null || isSentence(error.message))
        return { headline: error.message, detail: null };
      return { headline: fallback, detail: `HTTP ${error.status}: ${error.message}` };
    }
    const raw = (error instanceof Error ? error.message : String(error)).trim();
    return { headline: fallback, detail: raw || null };
  },
  chatFailure: (error) => {
    if (error instanceof ChatRequestError) {
      if (error.apiCode !== null)
        return { kind: API_CODES[error.apiCode] ?? "other", message: error.message, uncertain: false };
      // No answer, or a server error: the request may have landed.
      const uncertain = error.kind === "network" || error.status >= 500;
      return { kind: "other", message: webFailures.describe(error, "Switch did not answer.").headline, uncertain };
    }
    // An answer that did not match the contract arrived after the server acted.
    return {
      kind: "other",
      message: webFailures.describe(error, "The request failed.").headline,
      uncertain: true,
    };
  },
  serverTooOld: (error) =>
    error instanceof ChatRequestError && error.status === 404 && error.apiCode === null,
  warn,
};
