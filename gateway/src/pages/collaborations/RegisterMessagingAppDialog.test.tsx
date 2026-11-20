import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RegisterMessagingAppDialog from "./RegisterMessagingAppDialog";
import { INSTALL_POLL_INTERVAL_MS } from "./OfficialAppInstall";

const api = vi.hoisted(() => ({
  createBridge: vi.fn(),
  fetchInstallablePlatforms: vi.fn(),
  beginChatClaim: vi.fn(),
  beginAppInstall: vi.fn(),
  fetchBridges: vi.fn(),
}));
vi.mock("../../data/api", () => api);

const types = vi.hoisted(() => ({
  data: [{ key: "slack", config_schema: { properties: {}, required: [] } }],
  error: null,
}));
vi.mock("../../data/hooks", () => ({ useBridgeTypes: () => types }));

function offered(platforms: string[], claimable: unknown[] = []) {
  return Object.assign([...platforms], { claimable });
}

function renderDialog(initialType: string) {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  render(
    <RegisterMessagingAppDialog
      open
      initialType={initialType}
      onClose={onClose}
      onSuccess={onSuccess}
    />,
  );
  return { onSuccess, onClose };
}

beforeEach(() => {
  api.fetchInstallablePlatforms.mockResolvedValue(offered(["slack"]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RegisterMessagingAppDialog", () => {
  it("offers Switch's own app in one click first, and your own app behind a link", async () => {
    renderDialog("slack");
    expect(await screen.findByRole("button", { name: "Add to Slack" })).toBeTruthy();
    expect(screen.queryByLabelText(/Display name/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use your own app instead" }));
    expect(await screen.findByLabelText(/Display name/)).toBeTruthy();
  });

  it("goes straight to your own app where Switch has none to add", async () => {
    api.fetchInstallablePlatforms.mockResolvedValue(offered([]));
    renderDialog("slack");
    expect(await screen.findByLabelText(/Display name/)).toBeTruthy();
  });

  it("opens the consent page in a new tab and hands over the connection once it appears", async () => {
    const tab = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    api.fetchBridges
      .mockResolvedValueOnce([{ bridge_id: "old", bridge_type: "slack" }])
      .mockResolvedValue([
        { bridge_id: "old", bridge_type: "slack" },
        { bridge_id: "new", bridge_type: "slack" },
      ]);
    api.beginAppInstall.mockResolvedValue("https://slack.example/authorize");
    const { onSuccess } = renderDialog("slack");
    fireEvent.click(await screen.findByRole("button", { name: "Add to Slack" }));
    expect(await screen.findByText("Waiting for Slack…")).toBeTruthy();
    expect(tab.location.href).toBe("https://slack.example/authorize");
    await waitFor(
      () => expect(onSuccess).toHaveBeenCalledWith({ bridge_id: "new", bridge_type: "slack" }),
      { timeout: INSTALL_POLL_INTERVAL_MS + 2000 },
    );
  });
});
