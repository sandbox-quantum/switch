import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ManagementApiError,
  createManagedAgent,
  enrollCommand,
  fetchManagementAvailable,
  managementError,
} from "./management";

function respond(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("managementError", () => {
  it("reads the code and message from the error envelope", async () => {
    const error = await managementError(
      new Response(
        JSON.stringify({
          error: {
            code: "provider_login_expired",
            message: "Codex is not logged in on laptop.",
            retryable: false,
          },
        }),
        { status: 409 },
      ),
    );
    expect(error).toBeInstanceOf(ManagementApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("provider_login_expired");
    expect(error.message).toBe("Codex is not logged in on laptop.");
  });

  it("falls back to the status line for a body that is not the envelope", async () => {
    const error = await managementError(
      new Response(JSON.stringify({ detail: "Not Found" }), {
        status: 404,
        statusText: "Not Found",
      }),
    );
    expect(error.code).toBe("http_error");
    expect(error.message).toBe("404 Not Found");
  });
});

describe("fetchManagementAvailable", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true when the controllers list answers", async () => {
    respond(200, []);
    await expect(fetchManagementAvailable()).resolves.toBe(true);
  });

  it("is false when the routes are not mounted", async () => {
    respond(404, { detail: "Not Found" });
    await expect(fetchManagementAvailable()).resolves.toBe(false);
  });

  it("throws on any other failure rather than hiding the page", async () => {
    respond(500, { detail: "boom" });
    await expect(fetchManagementAvailable()).rejects.toBeInstanceOf(ManagementApiError);
  });
});

describe("createManagedAgent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the definition and surfaces a placement refusal", async () => {
    const fetch = respond(409, {
      error: {
        code: "controller_offline",
        message: "The machine laptop has not reported recently.",
        retryable: true,
      },
    });
    await expect(
      createManagedAgent({
        name: "pm-agent",
        description: "Writes PRDs",
        display_name: null,
        controller_id: "c1",
        desired_state: "running",
        definition: {
          provider: "claude",
          model: null,
          instructions: "",
          auto_approve: false,
          directory: null,
          isolation: "shared",
        },
      }),
    ).rejects.toMatchObject({ code: "controller_offline" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/gateway/management/agents");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: "pm-agent",
      controller_id: "c1",
      definition: { provider: "claude" },
    });
  });
});

describe("enrollCommand", () => {
  it("names the server and the code", () => {
    expect(enrollCommand("https://switch.example.com", "swce_example")).toBe(
      "switch-agent-controller enroll --server https://switch.example.com --code swce_example",
    );
  });
});
