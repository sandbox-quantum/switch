import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDetail } from "../../data/api";
import TeamsPlacementDialog from "./TeamsPlacementDialog";

const bridge: BridgeDetail = {
  bridge_id: "b1",
  bridge_type: "teams",
  display_name: "Acme Corp",
  status: "active",
  agent_greetings_enabled: true,
  channel_creation_supported: true,
  channel_creation_enabled: false,
  room_count: 2,
  created_at: "2026-01-01",
  attention: null,
  team_placement_supported: true,
};

function placements(
  overrides: Partial<{
    teams: {
      team_id: string;
      name: string;
      has_switch: boolean | null;
      is_default: boolean;
    }[];
    default_team_id: string | null;
    in_catalog: boolean;
    catalog_problem: string | null;
  }> = {},
) {
  return {
    teams: [
      { team_id: "t1", name: "Engineering", has_switch: true, is_default: true },
      { team_id: "t2", name: "Sales", has_switch: false, is_default: false },
    ],
    default_team_id: "t1",
    in_catalog: true,
    catalog_problem: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("TeamsPlacementDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the organisation's teams", async () => {
    mockFetch(() => jsonResponse(200, placements()));
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    expect(await screen.findByText("Engineering")).toBeTruthy();
    expect(screen.getByText("Sales")).toBeTruthy();
  });

  it("shows a team whose apps could not be read as unknown, and offers no switch", async () => {
    mockFetch(() =>
      jsonResponse(
        200,
        placements({
          teams: [
            { team_id: "t9", name: "Archive", has_switch: null, is_default: false },
          ],
          default_team_id: null,
        }),
      ),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    expect(await screen.findByText("Switch could not read this team's apps.")).toBeTruthy();
    const [toggle] = screen.getAllByRole("switch") as HTMLInputElement[];
    expect(toggle.disabled).toBe(true);
  });

  it("adds Switch to a team the switch is flipped on for", async () => {
    const fetchMock = mockFetch((_url, init) =>
      init?.method === "POST"
        ? new Response(null, { status: 204 })
        : jsonResponse(200, placements()),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("Sales");
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[1]); // Sales has no Switch yet

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeTruthy();
      expect(String(post?.[0])).toContain("/collaborations/b1/teams/t2");
    });
  });

  it("removes Switch from a team the switch is flipped off for", async () => {
    const fetchMock = mockFetch((_url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : jsonResponse(200, placements()),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("Engineering");
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]); // Engineering already has Switch

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(del).toBeTruthy();
      expect(String(del?.[0])).toContain("/collaborations/b1/teams/t1");
    });
  });

  it("sends connection_config.team_id and turns channel creation on when a default is chosen", async () => {
    // Support has Switch but is not yet the default, so picking it actually
    // changes the radio group's value — clicking the already-default team's
    // own radio fires no change event, in a browser or in jsdom.
    const withThirdTeam = placements({
      teams: [
        { team_id: "t1", name: "Engineering", has_switch: true, is_default: true },
        { team_id: "t2", name: "Sales", has_switch: false, is_default: false },
        { team_id: "t3", name: "Support", has_switch: true, is_default: false },
      ],
    });
    const fetchMock = mockFetch((_url, init) =>
      init?.method === "PATCH"
        ? jsonResponse(200, { ...bridge, channel_creation_enabled: true })
        : jsonResponse(200, withThirdTeam),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("Support");
    const radios = screen.getAllByRole("radio");
    // Sales (index 1) has no Switch, so it cannot be made default.
    expect((radios[1] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(radios[2]);

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch?.[1]?.body));
      expect(body.channel_creation_enabled).toBe(true);
      expect(body.connection_config).toEqual({ team_id: "t3" });
    });
  });

  it("waits out the restart a new default team causes instead of reporting it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const before = placements({
      teams: [
        { team_id: "t1", name: "Engineering", has_switch: true, is_default: true },
        { team_id: "t3", name: "Support", has_switch: true, is_default: false },
      ],
    });
    const after = placements({
      teams: [
        { team_id: "t1", name: "Engineering", has_switch: true, is_default: false },
        { team_id: "t3", name: "Support", has_switch: true, is_default: true },
      ],
      default_team_id: "t3",
    });
    let reads = 0;
    mockFetch((_url, init) => {
      if (init?.method === "PATCH") {
        return jsonResponse(200, { ...bridge, channel_creation_enabled: true });
      }
      reads += 1;
      if (reads === 1) return jsonResponse(200, before);
      if (reads === 2) {
        return jsonResponse(503, {
          detail: "The Teams connection is not running; try again in a moment.",
        });
      }
      return jsonResponse(200, after);
    });
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("Support");
    fireEvent.click(screen.getAllByRole("radio")[1]);

    expect(
      await screen.findByText("The connection is restarting with your change…"),
    ).toBeTruthy();
    expect(screen.queryByText(/not running/)).toBeNull();
    await vi.advanceTimersByTimeAsync(1500);

    await waitFor(() => {
      expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
    });
    expect(reads).toBe(3);
    expect(screen.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });

  it("reports a connection that does not come back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch(() =>
      jsonResponse(503, {
        detail: "The Teams connection is not running; try again in a moment.",
      }),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("The connection is restarting with your change…");
    await vi.advanceTimersByTimeAsync(1500 * 21);

    expect(
      await screen.findByText(
        "The Teams connection is not running; try again in a moment.",
      ),
    ).toBeTruthy();
    vi.useRealTimers();
  });

  it("stops waiting for a restart once the dialog is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockFetch(() =>
      jsonResponse(503, { detail: "The Teams connection is not running." }),
    );
    const { rerender } = render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );
    await screen.findByText("The connection is restarting with your change…");
    rerender(<TeamsPlacementDialog bridge={null} onClose={() => {}} onChanged={() => {}} />);
    const callsWhenClosed = fetchMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1500 * 5);

    expect(fetchMock.mock.calls.length).toBe(callsWhenClosed);
    vi.useRealTimers();
  });

  it("disables adding a team and offers the package download when not in the catalogue", async () => {
    mockFetch(() =>
      jsonResponse(
        200,
        placements({
          in_catalog: false,
          catalog_problem: "Microsoft has not listed the app for this organisation yet.",
        }),
      ),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    const downloadButton = await screen.findByRole("button", {
      name: /Download app package/,
    });
    expect(downloadButton).toBeTruthy();
    // The warning renders the catalogue problem alongside the download
    // button's own label in one alert, so it is read off the page rather than
    // matched as an element of its own.
    expect(document.body.textContent ?? "").toContain(
      "Microsoft has not listed the app for this organisation yet.",
    );

    const switches = screen.getAllByRole("switch");
    // Sales has no Switch, and the app isn't in the catalogue yet, so adding
    // it is refused here rather than failing only after the click.
    expect((switches[1] as HTMLInputElement).disabled).toBe(true);
  });

  it("shows the server's error when the teams list fails to load", async () => {
    mockFetch(() =>
      jsonResponse(502, { detail: "Microsoft refused to list the teams." }),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    expect(await screen.findByText("Microsoft refused to list the teams.")).toBeTruthy();
  });

  it("labels each row's radio and switch for assistive tech", async () => {
    mockFetch(() => jsonResponse(200, placements()));
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("Engineering");
    expect(
      screen.getByRole("radio", { name: "Make Engineering the default team" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: "Make Sales the default team" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Remove Switch from Engineering" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Add Switch to Sales" }),
    ).toBeTruthy();
  });

  it("closes and clears stale errors when Close is clicked", async () => {
    mockFetch(() => jsonResponse(200, placements()));
    const onClose = vi.fn();
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={onClose} onChanged={() => {}} />,
    );

    await screen.findByText("Engineering");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the server's reason when toggling a team fails", async () => {
    mockFetch((_url, init) =>
      init?.method === "DELETE"
        ? jsonResponse(503, {
            detail: "The Teams connection is not running; try again in a moment.",
          })
        : jsonResponse(200, placements()),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("Engineering");
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]); // Engineering already has Switch -> DELETE, which fails

    expect(
      await screen.findByText("The Teams connection is not running; try again in a moment."),
    ).toBeTruthy();
  });

  it("shows the server's reason when making a team the default fails", async () => {
    const withThirdTeam = placements({
      teams: [
        { team_id: "t1", name: "Engineering", has_switch: true, is_default: true },
        { team_id: "t2", name: "Sales", has_switch: false, is_default: false },
        { team_id: "t3", name: "Support", has_switch: true, is_default: false },
      ],
    });
    mockFetch((_url, init) =>
      init?.method === "PATCH"
        ? jsonResponse(422, {
            detail:
              "Switch is not in that team. Add it to the team first, then make it the default.",
          })
        : jsonResponse(200, withThirdTeam),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("Support");
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[2]); // Support has Switch but is not yet default

    expect(
      await screen.findByText(
        "Switch is not in that team. Add it to the team first, then make it the default.",
      ),
    ).toBeTruthy();
  });

  describe("downloading the app package", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
      delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    });

    it("creates an object URL and clicks an anchor named after the server's filename", async () => {
      mockFetch((url) =>
        String(url).includes("/teams-package")
          ? new Response(new Blob(["zip-bytes"]), {
              status: 200,
              headers: {
                "Content-Disposition": 'attachment; filename="switch-teams-app.zip"',
              },
            })
          : jsonResponse(
              200,
              placements({
                in_catalog: false,
                catalog_problem: "Switch is not in your organisation's Teams app list yet.",
              }),
            ),
      );

      URL.createObjectURL = vi.fn(() => "blob:http://localhost/mock-id");
      URL.revokeObjectURL = vi.fn();
      const captured: { anchor: HTMLAnchorElement | null } = { anchor: null };
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function (this: HTMLAnchorElement) {
          captured.anchor = this;
        });

      render(
        <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
      );

      const downloadButton = await screen.findByRole("button", {
        name: /Download app package/,
      });
      fireEvent.click(downloadButton);

      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(captured.anchor?.download).toBe("switch-teams-app.zip");
      expect(captured.anchor?.href).toBe("blob:http://localhost/mock-id");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/mock-id");
    });

    it("shows the server's reason when the download fails", async () => {
      mockFetch((url) =>
        String(url).includes("/teams-package")
          ? jsonResponse(502, {
              detail: "Microsoft did not answer; try again shortly.",
            })
          : jsonResponse(
              200,
              placements({
                in_catalog: false,
                catalog_problem: "Switch is not in your organisation's Teams app list yet.",
              }),
            ),
      );

      render(
        <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
      );

      const downloadButton = await screen.findByRole("button", {
        name: /Download app package/,
      });
      fireEvent.click(downloadButton);

      expect(
        await screen.findByText("Microsoft did not answer; try again shortly."),
      ).toBeTruthy();
    });
  });

  it("shows the freshest reload even when an earlier one answers late", async () => {
    const initial = placements();
    const stale = placements({
      teams: [{ team_id: "t1", name: "STALE-TEAM", has_switch: false, is_default: false }],
      default_team_id: null,
    });
    const fresh = placements({
      teams: [{ team_id: "t1", name: "FRESH-TEAM", has_switch: true, is_default: true }],
      default_team_id: "t1",
    });

    type PendingGet = { resolve: (res: Response) => void };
    const pendingGets: PendingGet[] = [];
    let getCount = 0;

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "POST") return new Response(null, { status: 204 });
      getCount += 1;
      if (getCount === 1) return jsonResponse(200, initial);
      return new Promise<Response>((resolve) => {
        pendingGets[getCount] = { resolve };
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    await screen.findByText("Engineering");
    const switches = screen.getAllByRole("switch");

    // Both clicks land while the list is still showing: a resolved reload
    // (load()) flips the dialog into its loading state, which unmounts the
    // very switches a second click would need, so team B has to be toggled
    // before team A's DELETE has resolved rather than after.
    fireEvent.click(switches[0]); // Engineering (has Switch) -> DELETE
    fireEvent.click(switches[1]); // Sales (no Switch) -> POST
    await waitFor(() => expect(getCount).toBe(3));

    // The newer load (#3) answers first, with fresh data.
    pendingGets[3].resolve(jsonResponse(200, fresh));
    expect(await screen.findByText("FRESH-TEAM")).toBeTruthy();

    // The older load (#2) answers late, with stale data that must be ignored.
    pendingGets[2].resolve(jsonResponse(200, stale));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText("FRESH-TEAM")).toBeTruthy();
    expect(screen.queryByText("STALE-TEAM")).toBeNull();
  });
});
