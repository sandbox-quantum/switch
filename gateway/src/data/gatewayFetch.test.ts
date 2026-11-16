import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_TIMEOUT_MS,
  type SessionSignal,
  WORKSPACE_HEADER,
  gatewayFetch,
  onSessionSignal,
  setShownWorkspace,
} from "./gatewayFetch";

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof respond>): Headers {
  return new Headers(fetchMock.mock.calls[0][1]?.headers);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setShownWorkspace(null);
});

describe("the workspace a write names", () => {
  it("names the workspace the page shows on a write", async () => {
    setShownWorkspace("ws-default");
    const fetchMock = respond(200, {});
    await gatewayFetch("/gateway/api-keys", { method: "POST" });
    expect(sentHeaders(fetchMock).get(WORKSPACE_HEADER)).toBe("ws-default");
  });

  it.each(["PATCH", "PUT", "DELETE"])("names it on a %s", async (method) => {
    setShownWorkspace("ws-default");
    const fetchMock = respond(200, {});
    await gatewayFetch("/gateway/rooms/r", { method });
    expect(sentHeaders(fetchMock).get(WORKSPACE_HEADER)).toBe("ws-default");
  });

  it("names none on a read", async () => {
    setShownWorkspace("ws-default");
    const fetchMock = respond(200, {});
    await gatewayFetch("/gateway/rooms");
    expect(sentHeaders(fetchMock).has(WORKSPACE_HEADER)).toBe(false);
  });

  it("names none while the page shows no workspace", async () => {
    const fetchMock = respond(200, {});
    await gatewayFetch("/gateway/organizations", { method: "POST" });
    expect(sentHeaders(fetchMock).has(WORKSPACE_HEADER)).toBe(false);
  });

  it("keeps the caller's own headers", async () => {
    setShownWorkspace("ws-default");
    const fetchMock = respond(200, {});
    await gatewayFetch("/gateway/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(sentHeaders(fetchMock).get("Content-Type")).toBe("application/json");
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("include");
  });
});

describe("what the server's answers say about the session", () => {
  let heard: SessionSignal[];
  let stop: () => void;
  beforeEach(() => {
    heard = [];
    stop = onSessionSignal((signal) => heard.push(signal));
  });
  afterEach(() => stop());

  it("says the session ended on a 401", async () => {
    respond(401, { detail: "Session ended" });
    await gatewayFetch("/gateway/rooms");
    expect(heard).toEqual([{ kind: "ended" }]);
  });

  it("says something was refused on a 403", async () => {
    respond(403, { detail: "Workspace admin access required" });
    await gatewayFetch("/gateway/tenants/t/invitations", { method: "POST" });
    expect(heard).toEqual([{ kind: "refused" }]);
  });

  it("says the tab shows another workspace, in the server's words, on that 409", async () => {
    respond(409, {
      detail: {
        error: "workspace_mismatch",
        message: "This tab is showing another workspace. Reload to continue.",
      },
    });
    const res = await gatewayFetch("/gateway/api-keys", { method: "POST" });
    expect(heard).toEqual([
      {
        kind: "workspace_mismatch",
        message: "This tab is showing another workspace. Reload to continue.",
      },
    ]);
    // The caller still reads the answer itself.
    expect((await res.json()).detail.error).toBe("workspace_mismatch");
  });

  it("says nothing on any other 409, or on success", async () => {
    respond(409, { detail: "A room with that name exists" });
    await gatewayFetch("/gateway/rooms", { method: "POST" });
    respond(200, {});
    await gatewayFetch("/gateway/rooms");
    expect(heard).toEqual([]);
  });

  it("stops telling a listener that stopped listening", async () => {
    stop();
    respond(401, { detail: "Session ended" });
    await gatewayFetch("/gateway/rooms");
    expect(heard).toEqual([]);
  });
});

describe("a server that doesn't answer", () => {
  it("gives up, saying so, rather than waiting for good", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const pending = gatewayFetch("/gateway/rooms");
    const failed = expect(pending).rejects.toThrow("Switch didn't answer within 30 seconds. Try again.");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
  });

  it("waits longer for a request known to take long", async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
            });
            setTimeout(() => resolve(new Response("{}", { status: 200 })), REQUEST_TIMEOUT_MS + 1000);
          }),
      ),
    );
    const pending = gatewayFetch("/gateway/rooms/from-yaml", { method: "POST" }, 120_000);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1000);
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(aborted).toBe(false);
  });
});
