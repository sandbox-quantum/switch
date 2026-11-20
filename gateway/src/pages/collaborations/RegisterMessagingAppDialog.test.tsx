import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RegisterMessagingAppDialog from "./RegisterMessagingAppDialog";

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

  it("sends the tab to the consent page, to come back here once connected", async () => {
    api.beginAppInstall.mockRejectedValue(new Error("Slack isn't set up here."));
    renderDialog("slack");
    fireEvent.click(await screen.findByRole("button", { name: "Add to Slack" }));
    expect(await screen.findByText("Slack isn't set up here.")).toBeTruthy();
    expect(api.beginAppInstall).toHaveBeenCalledWith("slack");
  });
});
