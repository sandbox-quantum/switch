import { describe, expect, it } from "vitest";
import {
  channelCleanupText,
  channelKeptText,
  channelRetiredText,
  isRetirable,
  retireChannelLabel,
} from "./roomDeleteWording";

// Every platform's outcome, as each bridge declares it: archived on Slack and
// Mattermost, deleted on Discord, left by the bot on Telegram, kept on Teams.

describe("isRetirable", () => {
  it("offers the choice only where retiring does something", () => {
    expect(isRetirable("archived")).toBe(true);
    expect(isRetirable("deleted")).toBe(true);
    expect(isRetirable("left")).toBe(true);
    expect(isRetirable("kept")).toBe(false);
    expect(isRetirable(null)).toBe(false);
  });
});

describe("retireChannelLabel", () => {
  it("names what retiring does on each platform", () => {
    expect(retireChannelLabel("Slack", "archived")).toBe("Also archive the Slack channel");
    expect(retireChannelLabel("Discord", "deleted")).toBe("Also delete the Discord channel");
    expect(retireChannelLabel("Telegram", "left")).toBe("Also have the bot leave the Telegram chat");
  });
});

describe("channelKeptText", () => {
  it("says the channel stays and stops syncing", () => {
    expect(channelKeptText("Slack", "archived")).toBe("The Slack channel stays as it is; Switch stops syncing it.");
    expect(channelKeptText("Discord", "deleted")).toBe(
      "The Discord channel stays as it is; Switch stops syncing it.",
    );
  });

  it("calls a Telegram chat a chat", () => {
    expect(channelKeptText("Telegram", "left")).toBe("The Telegram chat stays as it is; Switch stops syncing it.");
  });

  it("says a Teams channel has to be removed in Teams", () => {
    expect(channelKeptText("Microsoft Teams", "kept")).toBe(
      "Its Microsoft Teams channel stays in Microsoft Teams; remove it there.",
    );
  });
});

describe("channelRetiredText", () => {
  it("says a Slack channel will be archived, not deleted", () => {
    expect(channelRetiredText("Slack", "archived")).toBe("Its Slack channel will be archived.");
  });

  it("says a Discord channel will be deleted", () => {
    expect(channelRetiredText("Discord", "deleted")).toBe("Its Discord channel will be deleted.");
  });

  it("says the bot will leave a Telegram chat, which stays", () => {
    expect(channelRetiredText("Telegram", "left")).toBe(
      "The bot will leave the Telegram chat; the chat itself stays.",
    );
  });
});

describe("channelCleanupText", () => {
  it("asks for each platform's channel to be cleaned up by hand, saying why", () => {
    const failed = { outcome: "failed" as const, reason: "missing scope" };
    expect(channelCleanupText("Slack", "archived", failed)).toBe(
      "The room was deleted, but its Slack channel could not be archived (missing scope). Archive it in Slack by hand.",
    );
    expect(channelCleanupText("Discord", "deleted", failed)).toBe(
      "The room was deleted, but its Discord channel could not be deleted (missing scope). Delete it in Discord by hand.",
    );
    expect(channelCleanupText("Telegram", "left", failed)).toBe(
      "The room was deleted, but the bot could not leave the Telegram chat (missing scope). Remove the bot from the chat in Telegram.",
    );
  });

  it("leaves out the reason when the server gives none", () => {
    expect(channelCleanupText("Slack", "archived", { outcome: "failed", reason: null })).toBe(
      "The room was deleted, but its Slack channel could not be archived. Archive it in Slack by hand.",
    );
  });

  it("has nothing to say when the channel was retired", () => {
    expect(channelCleanupText("Slack", "archived", { outcome: "archived", reason: null })).toBeNull();
    expect(channelCleanupText("Slack", "archived", null)).toBeNull();
  });
});
