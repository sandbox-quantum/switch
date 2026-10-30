import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeFetch } from "../../test/routeFetch";
import RegisterMessagingAppDialog from "./RegisterMessagingAppDialog";

const SLACK_TYPE = {
  key: "slack",
  channel_creation_supported: true,
  config_schema: {
    type: "object",
    properties: {
      bot_token: { type: "string" },
      app_token: { type: "string", title: "App-level token" },
      workspace_id: { type: "string" },
    },
    required: ["bot_token", "workspace_id"],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pickSlack() {
  fireEvent.mouseDown(await screen.findByRole("combobox"));
  fireEvent.click(within(await screen.findByRole("listbox")).getByText("slack"));
  fireEvent.change(screen.getByLabelText(/Display Name/), { target: { value: "Our Slack" } });
}

function typeTokens(bot: string, app: string) {
  fireEvent.change(screen.getByLabelText(/Bot Token/), { target: { value: bot } });
  fireEvent.change(screen.getByLabelText(/App-level token/), { target: { value: app } });
}

describe("registering a Slack app of the workspace's own", () => {
  it("walks through the app, checks the tokens and fills in the workspace", async () => {
    const calls = routeFetch({
      "GET /collaborations/types": { body: [SLACK_TYPE] },
      "GET /collaborations/setup/slack": {
        body: { manifest: {}, create_url: "https://api.slack.com/apps?new_app=1" },
      },
      "POST /collaborations/setup/slack/check": {
        body: { workspace_id: "T123", workspace_name: "Acme", bot_name: "switch" },
      },
      "POST /collaborations": { status: 201, body: { id: "b1" } },
    });
    const onSuccess = vi.fn();
    render(<RegisterMessagingAppDialog open onClose={() => {}} onSuccess={onSuccess} />);

    await pickSlack();
    expect(
      (await screen.findByRole("link", { name: /Create the Slack app/ })).getAttribute("href"),
    ).toBe("https://api.slack.com/apps?new_app=1");
    // Read from the tokens, not asked for.
    expect(screen.queryByLabelText(/Workspace Id/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Register" })).toHaveProperty("disabled", true);

    // Pasted with the whitespace a copy often brings; saved as it was checked.
    typeTokens("xoxb-1\n", " xapp-1 ");

    expect(await screen.findByText("Acme", {}, { timeout: 3000 })).toBeTruthy();
    expect(calls.find((c) => c.route === "POST /collaborations/setup/slack/check")?.body).toEqual({
      bot_token: "xoxb-1",
      app_token: "xapp-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const created = calls.find((c) => c.route === "POST /collaborations")?.body as {
      connection_config: Record<string, unknown>;
    };
    expect(created.connection_config).toMatchObject({
      bot_token: "xoxb-1",
      app_token: "xapp-1",
      workspace_id: "T123",
    });
  });

  it("takes back a passed check as soon as a token changes", async () => {
    routeFetch({
      "GET /collaborations/types": { body: [SLACK_TYPE] },
      "GET /collaborations/setup/slack": { body: { manifest: {}, create_url: "https://slack.example" } },
      "POST /collaborations/setup/slack/check": [
        { body: { workspace_id: "T123", workspace_name: "Acme", bot_name: "switch" } },
        { body: { workspace_id: "T456", workspace_name: "Globex", bot_name: "switch" } },
      ],
    });
    render(<RegisterMessagingAppDialog open onClose={() => {}} onSuccess={() => {}} />);

    await pickSlack();
    typeTokens("xoxb-1", "xapp-1");
    expect(await screen.findByText("Acme", {}, { timeout: 3000 })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Bot Token/), { target: { value: "xoxb-2" } });

    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.getByRole("button", { name: "Register" })).toHaveProperty("disabled", true);
    expect(await screen.findByText("Globex", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("shows Slack's refusal and keeps Register off", async () => {
    routeFetch({
      "GET /collaborations/types": { body: [SLACK_TYPE] },
      "GET /collaborations/setup/slack": { body: { manifest: {}, create_url: "https://slack.example" } },
      "POST /collaborations/setup/slack/check": {
        status: 422,
        body: { detail: "The bot token was refused by Slack: invalid_auth." },
      },
    });
    render(<RegisterMessagingAppDialog open onClose={() => {}} onSuccess={() => {}} />);

    await pickSlack();
    typeTokens("xoxb-bad", "xapp-1");

    expect(
      await screen.findByText("The bot token was refused by Slack: invalid_auth.", {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register" })).toHaveProperty("disabled", true);
  });
});
