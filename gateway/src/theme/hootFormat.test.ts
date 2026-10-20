import { describe, expect, it } from "vitest";
import { platformLabel } from "./hootFormat";

describe("platformLabel", () => {
  it("names the Teams platform after Microsoft's own app, not a bare title case", () => {
    expect(platformLabel("teams")).toBe("Microsoft Teams");
  });

  it("falls back to title case for a platform with no name of its own to get wrong", () => {
    expect(platformLabel("slack")).toBe("Slack");
    expect(platformLabel("discord")).toBe("Discord");
  });
});
