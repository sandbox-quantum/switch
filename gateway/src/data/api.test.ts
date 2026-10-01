import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, errorText, fetchSession } from "./api";

describe("errorText", () => {
  it("returns a string detail as is", () => {
    expect(errorText("Only a workspace owner may grant ownership", "x")).toBe(
      "Only a workspace owner may grant ownership",
    );
  });

  it("joins validation messages", () => {
    expect(
      errorText([{ msg: "field required" }, { msg: "too long" }], "fallback"),
    ).toBe("field required; too long");
  });

  it("reads message, then error, from an object detail", () => {
    expect(errorText({ message: "Workspace limit reached", error: "cap" }, "x")).toBe(
      "Workspace limit reached",
    );
    expect(errorText({ error: "cap" }, "x")).toBe("cap");
  });

  it("falls back rather than printing an object", () => {
    expect(errorText({ code: 7 }, "fallback")).toBe("fallback");
    expect(errorText(null, "fallback")).toBe("fallback");
    expect(errorText([], "fallback")).toBe("fallback");
  });
});

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("fetchSession", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is null when signed out", async () => {
    respond(401, { detail: "Not authenticated" });
    await expect(fetchSession()).resolves.toBeNull();
  });

  it("throws, keeping the status, on any other failure", async () => {
    respond(500, { detail: "boom" });
    const err = await fetchSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe("boom");
  });
});
