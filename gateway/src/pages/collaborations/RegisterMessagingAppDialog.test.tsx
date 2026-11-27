import { INSTALL_POLL_INTERVAL_MS } from "@switch-console/chat-ui/components/connect-messaging-app";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RegisterMessagingAppDialog from "./RegisterMessagingAppDialog";

const api = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly detail: unknown,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    createBridge: vi.fn(),
    fetchBridgeTypes: vi.fn(),
    fetchInstallablePlatforms: vi.fn(),
    beginChatClaim: vi.fn(),
    beginAppInstall: vi.fn(),
    fetchBridges: vi.fn(),
    fetchSlackOwnAppSetup: vi.fn(),
    checkSlackTokens: vi.fn(),
  };
});
vi.mock("../../data/api", () => api);
vi.mock("../../data/AuthContext", () => ({
  useAuth: () => ({ session: { tenant: { id: "t-1", name: "Acme" } }, canAdminTenant: true }),
}));
vi.mock("../chats/WebChatHost", () => ({
  useWebBridgeIcons: () => ({ BridgeIcon: () => null, hasBridgeIcon: () => false }),
}));

const TOKEN = { type: "string", format: "password" };

const TYPES = [
  {
    key: "slack",
    config_schema: {
      type: "object",
      properties: {
        bot_token: { ...TOKEN, title: "Bot Token" },
        app_token: { ...TOKEN, title: "App Token" },
        workspace_id: { type: "string", title: "Workspace Id" },
      },
      required: ["workspace_id"],
    },
    channel_creation_supported: true,
    docs_slug: "slack",
    directory_search_supported: true,
  },
  {
    key: "discord",
    config_schema: {
      type: "object",
      properties: {
        bot_token: { type: "string", title: "Bot Token" },
        guild_id: { type: "string", title: "Guild Id" },
      },
      required: ["guild_id"],
    },
    channel_creation_supported: true,
    docs_slug: "discord",
    directory_search_supported: true,
  },
];

const SETUP = {
  create_url: "https://api.slack.com/apps?new_app=1&manifest_json=example",
  manifest: { display_information: { name: "Agent Switch" } },
};

function offered(platforms: string[]) {
  return Object.assign([...platforms], { claimable: [] });
}

function renderDialog(initialType: string) {
  const onSuccess = vi.fn();
  const onClose = vi.fn();
  render(<RegisterMessagingAppDialog open initialType={initialType} onClose={onClose} onSuccess={onSuccess} />);
  return { onSuccess, onClose };
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  api.fetchBridgeTypes.mockResolvedValue(TYPES);
  api.fetchInstallablePlatforms.mockResolvedValue(offered(["slack"]));
  api.fetchSlackOwnAppSetup.mockResolvedValue(SETUP);
  api.fetchBridges.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("RegisterMessagingAppDialog", () => {
  it("offers Switch's own app in one click first, and your own app behind a link", async () => {
    renderDialog("slack");
    expect(await screen.findByRole("button", { name: "Add to Slack" })).toBeTruthy();
    expect(screen.getByText(/Adds Switch’s own Slack app to your Slack workspace/)).toBeTruthy();
    expect(screen.queryByText("Slack app setup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use your own app instead" }));
    expect(await screen.findByText("Slack app setup")).toBeTruthy();
  });

  it("opens the consent page in a tab opened at the click, and hands over the connection once it appears", async () => {
    const tab = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    api.fetchBridges
      .mockResolvedValueOnce([{ bridge_id: "old", bridge_type: "slack", display_name: "Old" }])
      .mockResolvedValue([
        { bridge_id: "old", bridge_type: "slack", display_name: "Old" },
        { bridge_id: "new", bridge_type: "slack", display_name: "Slack" },
      ]);
    api.beginAppInstall.mockResolvedValue("https://slack.example/authorize");
    const { onSuccess } = renderDialog("slack");
    fireEvent.click(await screen.findByRole("button", { name: "Add to Slack" }));
    expect(await screen.findByText("Waiting for Slack…")).toBeTruthy();
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(tab.location.href).toBe("https://slack.example/authorize");
    await waitFor(
      () =>
        expect(onSuccess).toHaveBeenCalledWith({
          bridgeId: "new",
          displayName: "Slack",
          directorySearchSupported: true,
        }),
      { timeout: INSTALL_POLL_INTERVAL_MS + 2000 },
    );
  });

  it("walks Slack's own-app setup: the app comes filled in, and the workspace is read from the pasted tokens", async () => {
    api.fetchInstallablePlatforms.mockResolvedValue(offered([]));
    api.checkSlackTokens.mockResolvedValue({ workspace_id: "T123", workspace_name: "Acme", bot_name: "switch" });
    api.createBridge.mockResolvedValue({
      bridge_id: "b-1",
      display_name: "Slack",
      receives_webhooks: false,
      webhook_url: null,
    });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { onSuccess } = renderDialog("slack");

    expect(await screen.findByLabelText("Name")).toHaveProperty("value", "Slack");
    expect(screen.queryByLabelText(/Workspace Id/)).toBeNull();
    const create = await screen.findByRole("button", { name: /Create the Slack app/ });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    expect(open).toHaveBeenCalledWith(SETUP.create_url, "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByRole("button", { name: /Copy the manifest/ }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(SETUP.manifest, null, 2));
    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();

    expect(screen.getByText("Bot Token, App Token are required to connect.")).toBeTruthy();
    type("Bot Token", "xoxb-not-real");
    type("App Token", "xapp-not-real");
    expect(await screen.findByText(/Both tokens work, for the/, {}, { timeout: 3000 })).toBeTruthy();
    expect(api.checkSlackTokens).toHaveBeenCalledWith("xoxb-not-real", "xapp-not-real");

    const connect = screen.getByRole("button", { name: "Connect" });
    await waitFor(() => expect(connect).toHaveProperty("disabled", false));
    await act(async () => fireEvent.click(connect));
    expect(api.createBridge).toHaveBeenCalledWith(
      "slack",
      "Slack",
      { bot_token: "xoxb-not-real", app_token: "xapp-not-real", workspace_id: "T123" },
      true,
      false,
    );
    expect(onSuccess).toHaveBeenCalledWith({ bridgeId: "b-1", displayName: "Slack", directorySearchSupported: true });
  });

  it("names Discord's fields in plain words, asks for its bot token, and links its setup guide", async () => {
    api.fetchInstallablePlatforms.mockResolvedValue(offered([]));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderDialog("discord");

    expect(await screen.findByLabelText("Name")).toHaveProperty("value", "Discord");
    expect(screen.getByLabelText("Bot token")).toBeTruthy();
    expect(screen.getByLabelText("Server ID")).toBeTruthy();
    expect(screen.queryByText(/Guild Id/)).toBeNull();
    expect(screen.getByText("Bot token, Server ID are required to connect.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /How to set up Discord/ }));
    expect(open).toHaveBeenCalledWith(
      "https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/discord",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("hands over the address a webhook platform delivers to, with a copy button", async () => {
    api.fetchInstallablePlatforms.mockResolvedValue(offered([]));
    api.createBridge.mockResolvedValue({
      bridge_id: "b-2",
      display_name: "Discord",
      receives_webhooks: true,
      webhook_url: "https://switch.example.com/hooks/b-2",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { onSuccess } = renderDialog("discord");

    await screen.findByLabelText("Bot token");
    type("Bot token", "not-a-real-token");
    type("Server ID", "123");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect" })));
    expect(await screen.findByDisplayValue("https://switch.example.com/hooks/b-2")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith("https://switch.example.com/hooks/b-2");
    expect(onSuccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onSuccess).toHaveBeenCalledWith({ bridgeId: "b-2", displayName: "Discord", directorySearchSupported: true });
  });
});
