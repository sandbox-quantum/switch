import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeDetail } from "../../data/api";
import * as api from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import * as hooks from "../../data/hooks";
import type { UseQueryResult } from "../../data/hooks";
import CollaborationsPage from "./CollaborationsPage";

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../data/hooks", () => ({
  useBridges: vi.fn(),
  useInstallablePlatforms: vi.fn(),
  useInstalledApps: vi.fn(),
  useBridgeTypes: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return {
    ...actual,
    beginAppInstall: vi.fn(),
  };
});

function authState(canAdminTenant: boolean) {
  return {
    session: null,
    user: null,
    loading: false,
    loadError: null,
    isOperator: false,
    canAdminTenant,
    refresh: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    switchTo: vi.fn(async () => {}),
  };
}

function queryResult<T>(data: T | null): UseQueryResult<T> {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

function bridge(overrides: Partial<BridgeDetail> = {}): BridgeDetail {
  return {
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
    team_placement_supported: false,
    ...overrides,
  };
}

function setup({
  isAdmin = true,
  bridges = [bridge()],
  installablePlatforms = [] as string[],
}: {
  isAdmin?: boolean;
  bridges?: BridgeDetail[];
  installablePlatforms?: string[];
} = {}) {
  vi.mocked(useAuth).mockReturnValue(authState(isAdmin));
  vi.mocked(hooks.useBridges).mockReturnValue(queryResult(bridges));
  vi.mocked(hooks.useInstallablePlatforms).mockReturnValue(
    queryResult(installablePlatforms),
  );
  vi.mocked(hooks.useInstalledApps).mockReturnValue(queryResult([]));
  vi.mocked(hooks.useBridgeTypes).mockReturnValue(queryResult([]));
}

/** A safety net for any request a sub-dialog fires once opened (e.g. the
 *  Teams placement panel's own load) — unmocked requests answer with empty,
 *  valid-enough bodies so an unrelated fetch cannot crash the test. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/teams")) {
        return new Response(
          JSON.stringify({
            teams: [],
            default_team_id: null,
            in_catalog: true,
            catalog_problem: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
}

describe("CollaborationsPage", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    stubFetch();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, href: "" },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it("offers the Teams button only on rows the platform supports, and opens the dialog", async () => {
    setup({
      bridges: [
        bridge({ bridge_id: "b1", display_name: "Supports Teams", team_placement_supported: true }),
        bridge({ bridge_id: "b2", display_name: "No Team Placement", team_placement_supported: false }),
      ],
    });
    render(<CollaborationsPage />);

    const teamsButtons = screen.getAllByRole("button", {
      name: "Choose which teams this app is in",
    });
    expect(teamsButtons).toHaveLength(1);

    fireEvent.click(teamsButtons[0]);
    expect(await screen.findByText("Microsoft Teams: Supports Teams")).toBeTruthy();
  });

  it("shows an attention banner for a row that needs it", () => {
    setup({
      bridges: [
        bridge({
          display_name: "Acme Corp",
          attention: "Microsoft says Switch is no longer approved in this organisation.",
        }),
      ],
    });
    render(<CollaborationsPage />);

    expect(screen.getByText("Acme Corp:")).toBeTruthy();
    expect(
      screen.getByText(
        /Microsoft says Switch is no longer approved in this organisation\./,
      ),
    ).toBeTruthy();
  });

  it("offers Approve again only when admin, team-placement-supported, and installable all hold", () => {
    const attention = "Approval was withdrawn.";
    setup({
      isAdmin: true,
      installablePlatforms: ["teams"],
      bridges: [
        bridge({ team_placement_supported: true, attention }),
      ],
    });
    render(<CollaborationsPage />);

    expect(screen.getByRole("button", { name: "Approve again" })).toBeTruthy();
  });

  it("hides Approve again for a non-admin", () => {
    const attention = "Approval was withdrawn.";
    setup({
      isAdmin: false,
      installablePlatforms: ["teams"],
      bridges: [bridge({ team_placement_supported: true, attention })],
    });
    render(<CollaborationsPage />);

    expect(screen.queryByRole("button", { name: "Approve again" })).toBeNull();
  });

  it("hides Approve again when the bridge doesn't support team placement", () => {
    const attention = "Approval was withdrawn.";
    setup({
      isAdmin: true,
      installablePlatforms: ["teams"],
      bridges: [bridge({ team_placement_supported: false, attention })],
    });
    render(<CollaborationsPage />);

    expect(screen.queryByRole("button", { name: "Approve again" })).toBeNull();
  });

  it("hides Approve again when this deployment has no installable app for the platform", () => {
    const attention = "Approval was withdrawn.";
    setup({
      isAdmin: true,
      installablePlatforms: [],
      bridges: [bridge({ team_placement_supported: true, attention })],
    });
    render(<CollaborationsPage />);

    expect(screen.queryByRole("button", { name: "Approve again" })).toBeNull();
  });

  it("starts the install flow and navigates there on Approve again", async () => {
    setup({
      isAdmin: true,
      installablePlatforms: ["teams"],
      bridges: [
        bridge({
          bridge_type: "teams",
          team_placement_supported: true,
          attention: "Approval was withdrawn.",
        }),
      ],
    });
    vi.mocked(api.beginAppInstall).mockResolvedValue(
      "https://login.microsoftonline.com/authorize?x=1",
    );
    render(<CollaborationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Approve again" }));

    await waitFor(() => expect(api.beginAppInstall).toHaveBeenCalledWith("teams"));
    await waitFor(() =>
      expect(window.location.href).toBe("https://login.microsoftonline.com/authorize?x=1"),
    );
  });

  it("shows a dismissible error when starting the install fails", async () => {
    setup({
      isAdmin: true,
      installablePlatforms: ["teams"],
      bridges: [
        bridge({
          bridge_type: "teams",
          team_placement_supported: true,
          attention: "Approval was withdrawn.",
        }),
      ],
    });
    vi.mocked(api.beginAppInstall).mockRejectedValue(
      new Error("Microsoft did not answer; try again shortly."),
    );
    render(<CollaborationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Approve again" }));

    expect(
      await screen.findByText("Microsoft did not answer; try again shortly."),
    ).toBeTruthy();

    const alert = screen.getByText("Microsoft did not answer; try again shortly.")
      .closest('[role="alert"]') as HTMLElement;
    fireEvent.click(
      alert.querySelector('button[aria-label="Close"]') as HTMLElement,
    );

    await waitFor(() =>
      expect(
        screen.queryByText("Microsoft did not answer; try again shortly."),
      ).toBeNull(),
    );
  });

  it("labels the type column with the platform's own name", () => {
    setup({ bridges: [bridge({ bridge_type: "teams" })] });
    render(<CollaborationsPage />);

    expect(screen.getByText("Microsoft Teams")).toBeTruthy();
  });
});
