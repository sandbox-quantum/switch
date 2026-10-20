import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  addBridgeToTeam,
  errorText,
  fetchSession,
  fetchTeamPlacements,
  fetchTeamsAppPackage,
  removeBridgeFromTeam,
  setDefaultTeamsTeam,
} from "./api";

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
    respond(409, { detail: "The Teams connection is not running; try again in a moment." });
    const err = await fetchTeamPlacements("b1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe(
      "The Teams connection is not running; try again in a moment.",
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
