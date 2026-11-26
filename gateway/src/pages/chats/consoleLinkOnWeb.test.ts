import { describe, expect, it } from "vitest";
import { webLinkTarget } from "./consoleLinkOnWeb";

describe("webLinkTarget", () => {
  it("opens a Console page's counterpart in the dashboard", () => {
    expect(webLinkTarget("switchdash://open/messaging-apps/connect")).toEqual({
      kind: "page",
      path: "/settings/messaging-apps",
    });
    expect(webLinkTarget("switchdash://open/agent/a1?tab=chats")).toEqual({
      kind: "page",
      path: "/chats/agents/a1",
    });
    expect(webLinkTarget("switchdash://open/room/r1")).toEqual({
      kind: "page",
      path: "/chats/rooms/r1",
    });
    expect(webLinkTarget("switchdash://open/connections")).toEqual({
      kind: "page",
      path: "/connectors",
    });
  });

  it("says a page with no counterpart here is in Console", () => {
    expect(webLinkTarget("switchdash://open/server")).toEqual({ kind: "console-only" });
    expect(webLinkTarget("switchdash://open/settings?tab=clis-models")).toEqual({
      kind: "console-only",
    });
    expect(webLinkTarget("switchdash://open/agents?server=https%3A%2F%2Fother.example")).toEqual({
      kind: "console-only",
    });
  });

  it("opens web links as they are, and ignores what is not a link it knows", () => {
    expect(webLinkTarget("https://example.com/x")).toEqual({
      kind: "external",
      href: "https://example.com/x",
    });
    expect(webLinkTarget("switchdash://open/nowhere")).toEqual({ kind: "ignored" });
  });
});
