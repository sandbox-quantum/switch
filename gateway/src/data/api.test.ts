import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  addBridgeToTeam,
  cancelLinkRequest,
  claimBridgeIdentity,
  createApiKey,
  createUser,
  errorText,
  fetchSession,
  fetchTeamPlacements,
  fetchTeamsAppPackage,
  issueLinkCode,
  logout,
  removeBridgeFromTeam,
  setDefaultTeamsTeam,
  signOutEverywhere,
} from "./api";

describe("errorText", () => {
  it("returns a string detail as is", () => {
    expect(errorText("Cannot demote the last admin", "x")).toBe("Cannot demote the last admin");
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

describe("createUser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("words a rejected password, not [object Object]", async () => {
    respond(422, {
      detail: [
        {
          type: "string_too_short",
          loc: ["body", "password"],
          msg: "String should have at least 8 characters",
        },
      ],
    });
    const err = await createUser("Ada", "ada@example.com", "hello", "user").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("String should have at least 8 characters");
  });
});

describe("fetchTeamPlacements", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the organisation's teams", async () => {
    respond(200, {
      teams: [{ team_id: "t1", name: "Engineering", has_switch: true, is_default: true }],
      default_team_id: "t1",
      in_catalog: true,
      catalog_problem: null,
    });
    const result = await fetchTeamPlacements("b1");
    expect(result.teams).toHaveLength(1);
    expect(result.default_team_id).toBe("t1");
  });

  it("throws the server's own words on a connection that is not running", async () => {
    respond(409, { detail: "The Teams messaging app is not running; try again in a moment." });
    const err = await fetchTeamPlacements("b1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe(
      "The Teams messaging app is not running; try again in a moment.",
    );
  });
});

describe("addBridgeToTeam / removeBridgeFromTeam", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to the team's id and resolves on 204", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await addBridgeToTeam("b1", "t2");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/collaborations/b1/teams/t2");
    expect(init.method).toBe("POST");
  });

  it("throws the catalogue problem when the app cannot be added yet", async () => {
    respond(409, {
      detail: "Switch is not in your organisation's Teams app list yet.",
    });
    const err = await addBridgeToTeam("b1", "t2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(
      "Switch is not in your organisation's Teams app list yet.",
    );
  });

  it("deletes to remove Switch from a team", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await removeBridgeFromTeam("b1", "t1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/collaborations/b1/teams/t1");
    expect(init.method).toBe("DELETE");
  });
});

describe("setDefaultTeamsTeam", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes the connection's config and turns channel creation on", async () => {
    const bridge = {
      bridge_id: "b1",
      bridge_type: "teams",
      display_name: "Acme Corp",
      status: "active",
      agent_greetings_enabled: true,
      channel_creation_supported: true,
      channel_creation_enabled: true,
      room_count: 2,
      created_at: "2026-01-01",
      attention: null,
      team_placement_supported: true,
    };
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(bridge), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await setDefaultTeamsTeam("b1", "t3");

    expect(result).toEqual(bridge);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/collaborations/b1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      connection_config: { team_id: "t3" },
      channel_creation_enabled: true,
    });
  });

  it("throws the server's reason when the team cannot be made the default", async () => {
    respond(422, {
      detail: "Switch is not in that team. Add it to the team first, then make it the default.",
    });
    const err = await setDefaultTeamsTeam("b1", "t3").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).message).toBe(
      "Switch is not in that team. Add it to the team first, then make it the default.",
    );
  });
});

describe("fetchTeamsAppPackage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the filename off Content-Disposition", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Blob(["zip bytes"]), {
            status: 200,
            headers: {
              "Content-Disposition": 'attachment; filename="switch-teams-1.0.0.zip"',
            },
          }),
      ),
    );
    const result = await fetchTeamsAppPackage("b1");
    expect(result.filename).toBe("switch-teams-1.0.0.zip");
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it("throws with the server's detail on failure", async () => {
    respond(404, { detail: "This deployment has no distributed Teams app." });
    await expect(fetchTeamsAppPackage("b1")).rejects.toThrow(
      "This deployment has no distributed Teams app.",
    );
  });
});

describe("signOutEverywhere", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the server to end every session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await signOutEverywhere();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/auth/sessions/revoke");
    expect(init.method).toBe("POST");
  });

  it("throws when the server refuses", async () => {
    respond(401, { detail: "Session ended" });
    await expect(signOutEverywhere()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("logout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the server to clear this browser's session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/auth/logout");
    expect(init.method).toBe("POST");
  });

  it("throws when the session wasn't cleared", async () => {
    respond(403, { detail: "This request didn't come from Switch." });
    await expect(logout()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("createApiKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([[90], [365], ["never" as const]])("sends the chosen lifetime %s", async (lifetime) => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "k", label: "l", key: "s", created_at: "c", expires_at: null }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createApiKey("l", lifetime);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ label: "l", expires_in_days: lifetime });
  });
});

describe("linking a chat account", () => {
  afterEach(() => vi.unstubAllGlobals());

  const capture = (body: unknown) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return () => fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  };

  it("claims expecting to confirm, and asks for a message to tap", async () => {
    const call = capture({ id: "acct-1", claimed_by: [], link_request: null });

    await claimBridgeIdentity("b1", { external_user_id: "U1", username: "ada" });

    const [url, init] = call();
    expect(url).toContain("/collaborations/b1/identities");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      external_user_id: "U1",
      username: "ada",
      expects_confirmation: true,
      wants_prompt: true,
    });
  });

  it("asks for a message to tap with every new code", async () => {
    const call = capture({ code: "ABCD-EFGH" });

    await issueLinkCode("b1", "acct-1");

    const [url, init] = call();
    expect(url).toContain("/collaborations/b1/identities/acct-1/code");
    expect(JSON.parse(String(init.body))).toEqual({ wants_prompt: true });
  });

  it("cancels only the request waiting, never the link", async () => {
    const call = capture({});

    await cancelLinkRequest("b1", "acct-1");

    const [url, init] = call();
    expect(url).toMatch(/\/collaborations\/b1\/identities\/acct-1\/request$/);
    expect(init.method).toBe("DELETE");
  });
});
