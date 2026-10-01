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
    teams: { team_id: string; name: string; has_switch: boolean; is_default: boolean }[];
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
      jsonResponse(409, {
        detail: "The Teams connection is not running; try again in a moment.",
      }),
    );
    render(
      <TeamsPlacementDialog bridge={bridge} onClose={() => {}} onChanged={() => {}} />,
    );

    expect(
      await screen.findByText("The Teams connection is not running; try again in a moment."),
    ).toBeTruthy();
  });
});
