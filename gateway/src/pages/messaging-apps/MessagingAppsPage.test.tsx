import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import type { BridgeDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { ALL_OFF } from "../../data/featureFlags";
import * as hooks from "../../data/hooks";
import type { UseQueryResult } from "../../data/hooks";
import { bridgeDetail, linkedIdentity, pendingIdentity } from "../collaborations/testFixtures";
import MessagingAppsPage from "./MessagingAppsPage";

vi.mock("../../components/DataTable", async () => ({
  ...(await import("../../test/FakeDataTable")),
  TableEmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

vi.mock("../../data/hooks", () => ({
  useBridges: vi.fn(),
  useBridgeTypes: vi.fn(),
  useInstallablePlatforms: vi.fn(),
  useInstalledApps: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/api")>()),
  updateBridge: vi.fn(),
  deleteBridge: vi.fn(),
  beginAppInstall: vi.fn(),
  fetchUnconfirmedLinks: vi.fn(),
  requireLinkConfirmation: vi.fn(),
  fetchMyIdentities: vi.fn(),
  fetchMyPendingIdentities: vi.fn(),
}));

function signIn(isAdmin: boolean, standsHere = true) {
  const workspace = {
    id: "t1",
    slug: "acme",
    name: "Acme",
    role: isAdmin ? "admin" : "member",
    organization_role: null,
    organization_id: null,
  };
  vi.mocked(useAuth).mockReturnValue({
    session: {
      user: { id: "u-ada", name: "ada", email: "ada@example.com", is_operator: false },
      tenant: workspace,
      tenants: standsHere ? [workspace] : [],
    },
    user: { id: "u-ada", name: "ada", email: "ada@example.com", is_operator: false },
    capabilities: {
      isOperator: false,
      administersWorkspace: isAdmin,
      administersOrganization: false,
      inOrganization: false,
      canDeleteWorkspace: false,
      canManageDataProtection: false,
      features: ALL_OFF,
    },
  } as unknown as ReturnType<typeof useAuth>);
}

function queryResult<T>(data: T | null, error: string | null = null): UseQueryResult<T> {
  return { data, loading: false, error, refetch: vi.fn() };
}

function setup({
  isAdmin = true,
  standsHere = true,
  bridges = [bridgeDetail()],
}: { isAdmin?: boolean; standsHere?: boolean; bridges?: BridgeDetail[] } = {}) {
  signIn(isAdmin, standsHere);
  vi.mocked(hooks.useBridges).mockReturnValue(
    queryResult(isAdmin ? bridges : bridges.map((b) => ({ ...b, can_manage: false, can_delete: false }))),
  );
  vi.mocked(hooks.useBridgeTypes).mockReturnValue(queryResult([]));
  vi.mocked(hooks.useInstallablePlatforms).mockReturnValue(
    queryResult(Object.assign([] as string[], { claimable: [] })),
  );
  vi.mocked(hooks.useInstalledApps).mockReturnValue(queryResult([]));
}

const openMenu = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));

describe("MessagingAppsPage", () => {
  beforeEach(() => {
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([]);
    vi.mocked(api.fetchUnconfirmedLinks).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("gives an admin the workspace's apps and their own accounts", async () => {
    setup({ bridges: [bridgeDetail({ display_name: "Acme Slack", bridge_type: "slack" })] });
    render(<MessagingAppsPage />);

    expect(screen.getByRole("heading", { name: "Connected to Acme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add messaging app" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your accounts" })).toBeTruthy();
    expect(await screen.findByText("Slack · Acme Slack")).toBeTruthy();
  });

  it("gives a member only their own accounts, with no copy of the workspace's settings", async () => {
    setup({ isAdmin: false, bridges: [bridgeDetail({ display_name: "Acme Slack", bridge_type: "slack" })] });
    render(<MessagingAppsPage />);

    expect(screen.getByText("Who you are in the messaging apps connected to Acme.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connected to Acme" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add messaging app" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(await screen.findByText("Slack · Acme Slack")).toBeTruthy();
    expect(api.fetchUnconfirmedLinks).not.toHaveBeenCalled();
  });

  it("says when a switch is refused", async () => {
    setup({ bridges: [bridgeDetail({ display_name: "Acme Corp" })] });
    vi.mocked(api.updateBridge).mockRejectedValue(new Error("Only an admin may change this."));
    render(<MessagingAppsPage />);

    fireEvent.click(screen.getByRole("switch", { name: "Channel creation for Acme Corp" }));

    expect(await screen.findByText("Only an admin may change this.")).toBeTruthy();
    expect(api.updateBridge).toHaveBeenCalledWith("b1", { channel_creation_enabled: true });
  });

  it("says the apps could not be loaded instead of claiming there are none", () => {
    setup();
    vi.mocked(hooks.useBridges).mockReturnValue(queryResult<BridgeDetail[]>(null, "Failed to fetch data"));
    render(<MessagingAppsPage />);

    expect(screen.getByText(/Could not load the messaging apps/)).toBeTruthy();
    expect(screen.queryByText("No messaging apps yet")).toBeNull();
  });

  it("keeps a row's actions in its menu, each only where it applies", () => {
    setup({
      bridges: [
        bridgeDetail({
          display_name: "Acme Teams",
          team_placement_supported: true,
          install_links: [{ key: "k", label: "Add", description: "", url: "https://example.com" }],
          home_url: "https://teams.example.com",
        }),
      ],
    });
    render(<MessagingAppsPage />);

    openMenu("Acme Teams");
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Manage Microsoft Teams…")).toBeTruthy();
    expect(within(menu).getByText("Add to a chat…")).toBeTruthy();
    expect(within(menu).getByText("Open in Microsoft Teams")).toBeTruthy();
    expect(within(menu).getByText("Delete…")).toBeTruthy();
    expect(within(menu).queryByText("Copy webhook address")).toBeNull();
  });

  it("says why the webhook address can't be copied when Switch has none to give", () => {
    setup({ bridges: [bridgeDetail({ display_name: "Acme Teams", receives_webhooks: true, webhook_url: null })] });
    render(<MessagingAppsPage />);

    openMenu("Acme Teams");
    expect(screen.getByText(/Switch's configuration has none. Set MESSAGING_PUBLIC_URL./)).toBeTruthy();
  });

  it("copies the webhook address", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    setup({
      bridges: [
        bridgeDetail({
          display_name: "Acme Teams",
          receives_webhooks: true,
          webhook_url: "https://switch.example.com/messaging/bridges/b1/events",
        }),
      ],
    });
    render(<MessagingAppsPage />);

    openMenu("Acme Teams");
    await act(async () => fireEvent.click(screen.getByText("Copy webhook address")));

    expect(writeText).toHaveBeenCalledWith("https://switch.example.com/messaging/bridges/b1/events");
    expect(await screen.findByText("Copied the webhook address for Acme Teams.")).toBeTruthy();
  });

  it("requires confirmation for exactly the older links the admin was shown", async () => {
    const older = {
      id: "acct-9",
      external_user_id: "U9",
      external_username: "bob",
      user_id: "u-bob",
      user_name: "Bob",
    };
    vi.mocked(api.fetchUnconfirmedLinks).mockResolvedValue([older]);
    vi.mocked(api.requireLinkConfirmation).mockResolvedValue(1);
    setup({ bridges: [bridgeDetail({ display_name: "Acme Slack" })] });
    render(<MessagingAppsPage />);

    await waitFor(() => expect(api.fetchUnconfirmedLinks).toHaveBeenCalledWith("b1"));
    openMenu("Acme Slack");
    fireEvent.click(await screen.findByText("Require confirmation for older links (1)…"));
    // Read again on opening, so the admin agrees to the list as it is now.
    const dialog = await screen.findByRole("dialog", { name: "Require confirmation for older links?" });
    expect(api.fetchUnconfirmedLinks).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByText("Bob as @bob")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Require confirmation" })));

    expect(api.requireLinkConfirmation).toHaveBeenCalledWith("b1", [older]);
    expect(await screen.findByText("1 link now needs confirming.")).toBeTruthy();
  });

  it("says why older links could not be counted rather than hiding the action", async () => {
    vi.mocked(api.fetchUnconfirmedLinks).mockRejectedValue(new Error("Bridge not found"));
    setup({ bridges: [bridgeDetail({ display_name: "Acme Slack" })] });
    render(<MessagingAppsPage />);

    await waitFor(() => expect(api.fetchUnconfirmedLinks).toHaveBeenCalled());
    openMenu("Acme Slack");
    expect(await screen.findByText("Could not check for older links: Bridge not found")).toBeTruthy();
  });

  it("marks the default app and shows a needs-attention banner", () => {
    setup({
      bridges: [
        bridgeDetail({ display_name: "Acme Teams", is_default: true, attention: "The app was blocked by your admin." }),
      ],
    });
    render(<MessagingAppsPage />);

    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("The app was blocked by your admin.")).toBeTruthy();
  });

  it("lists the admin's own linked account below the table", async () => {
    vi.mocked(api.fetchMyIdentities).mockResolvedValue([linkedIdentity({ bridge_id: "b1", external_username: "ada" })]);
    setup({ bridges: [bridgeDetail({ display_name: "Acme Slack", bridge_type: "slack" })] });
    render(<MessagingAppsPage />);

    expect(await screen.findByText(/@ada · linked/)).toBeTruthy();
  });

  it("deletes an app after asking, and keeps the dialog open with Switch's refusal", async () => {
    vi.mocked(api.deleteBridge)
      .mockRejectedValueOnce(new Error("Disconnect the app instead."))
      .mockResolvedValue({ ok: true });
    setup({ bridges: [bridgeDetail({ display_name: "Acme Slack", bridge_type: "slack" })] });
    render(<MessagingAppsPage />);

    openMenu("Acme Slack");
    fireEvent.click(screen.getByText("Delete…"));
    const dialog = screen.getByRole("dialog", { name: "Delete messaging app" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })));
    expect(within(dialog).getByText("Disconnect the app instead.")).toBeTruthy();

    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete" })));
    expect(api.deleteBridge).toHaveBeenLastCalledWith("b1");
  });

  it("starts approving again from the needs-attention banner", async () => {
    vi.mocked(api.beginAppInstall).mockResolvedValue("https://login.example.com/consent");
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...original, href: "" } });
    setup({
      bridges: [
        bridgeDetail({ display_name: "Acme Teams", team_placement_supported: true, attention: "Approval was withdrawn." }),
      ],
    });
    vi.mocked(hooks.useInstallablePlatforms).mockReturnValue(
      queryResult(Object.assign(["teams"], { claimable: [] })),
    );
    render(<MessagingAppsPage />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve again" })));

    expect(api.beginAppInstall).toHaveBeenCalledWith("teams");
    expect(window.location.href).toBe("https://login.example.com/consent");
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: original });
  });

  it("says why channel creation is off where the platform has none, where a keyboard reaches it", () => {
    setup({ bridges: [bridgeDetail({ display_name: "Our Telegram", bridge_type: "telegram", channel_creation_supported: false })] });
    render(<MessagingAppsPage />);

    expect(screen.getByRole("button", { name: "Why channel creation is off for Our Telegram" })).toBeTruthy();
  });

  it("says when the apps could not be refreshed, rather than looking current", () => {
    setup({ bridges: [bridgeDetail({ display_name: "Acme Slack" })] });
    vi.mocked(hooks.useBridges).mockReturnValue(
      queryResult([bridgeDetail({ display_name: "Acme Slack" })], "Failed to fetch data"),
    );
    render(<MessagingAppsPage />);

    expect(screen.getByText(/Couldn't refresh the messaging apps/)).toBeTruthy();
    expect(screen.getAllByText("Acme Slack").length).toBeGreaterThan(0);
  });

  it("offers the platform operator no linking in a workspace they entered without belonging to it", async () => {
    setup({ standsHere: false, bridges: [bridgeDetail({ display_name: "Acme Slack" })] });
    render(<MessagingAppsPage />);

    expect(await screen.findByText(/You're here as the platform operator/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Link account in/ })).toBeNull();
  });

  it("reads your accounts again now and then while one waits to be confirmed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.fetchMyPendingIdentities).mockResolvedValue([pendingIdentity({ bridge_id: "b1" })]);
    setup({ isAdmin: false, bridges: [bridgeDetail({ display_name: "Acme Slack", bridge_type: "slack" })] });
    render(<MessagingAppsPage />);
    await screen.findByText(/Waiting for confirmation/);
    const before = vi.mocked(api.fetchMyIdentities).mock.calls.length;

    await act(async () => vi.advanceTimersByTime(10_100));

    expect(vi.mocked(api.fetchMyIdentities).mock.calls.length).toBeGreaterThan(before);
    vi.useRealTimers();
  });
});
