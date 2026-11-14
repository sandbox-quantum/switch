import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRequestError, callGateway, webFailures } from "./webChatClient";

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

afterEach(() => vi.unstubAllGlobals());

describe("callGateway", () => {
  it("calls the gateway with the browser's sign-in and sends a body as JSON", async () => {
    const fetchMock = vi.fn(async () => answer(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await callGateway("/chats/r1/read", { method: "PUT", body: { seq: 4 } });
    expect(fetchMock).toHaveBeenCalledWith("/gateway/chats/r1/read", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq: 4 }),
      signal: undefined,
    });
  });

  it("raises a coded refusal with its code and the server's sentence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer(403, { detail: { code: "NOT_A_MEMBER", message: "You are not in this chat." } }),
      ),
    );
    const error = await callGateway("/chats/r1/messages", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error).toMatchObject({ kind: "http", status: 403, apiCode: "NOT_A_MEMBER" });
    expect(webFailures.chatFailure(error)).toEqual({
      kind: "not-a-member",
      message: "You are not in this chat.",
      uncertain: false,
    });
  });

  it("tells a signed-out session from other refusals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(401, { detail: "Not authenticated" })));
    const error = await callGateway("/chats", {}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
    expect(webFailures.describe(error, "Could not list your chats.").headline).toBe(
      "Your session expired. Sign in again, then retry.",
    );
  });

  it("counts no answer, or a server error, as a request that may have landed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const offline = await callGateway("/chats/r1/messages", { method: "POST", body: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(webFailures.chatFailure(offline).uncertain).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => answer(502, "<html>Bad Gateway</html>")));
    const failed = await callGateway("/chats/r1/messages", { method: "POST", body: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(failed).toMatchObject({ kind: "http", status: 502, apiCode: null });
    expect(webFailures.chatFailure(failed)).toMatchObject({ kind: "other", uncertain: true });
  });

  it("reads an uncoded 404 as a server from before the route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(404, { detail: "Not Found" })));
    const error = await callGateway("/chats/r1/activity", {}).catch((caught: unknown) => caught);
    expect(webFailures.serverTooOld(error)).toBe(true);
  });
});
