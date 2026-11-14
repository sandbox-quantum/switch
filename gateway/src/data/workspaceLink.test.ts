import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetLinkForSignIn,
  keepLinkForSignIn,
  linkAddress,
  linkedWorkspace,
  onThisDashboard,
  takeLinkAfterSignIn,
  withoutLinkedWorkspace,
} from "./workspaceLink";

describe("a link naming a workspace", () => {
  it("reads the workspace it names", () => {
    expect(linkedWorkspace("?workspace=t2")).toBe("t2");
    expect(linkedWorkspace("?tab=documents&workspace=t%202")).toBe("t 2");
  });

  it("names none without the parameter, or with it empty", () => {
    expect(linkedWorkspace("")).toBeNull();
    expect(linkedWorkspace("?tab=documents")).toBeNull();
    expect(linkedWorkspace("?workspace=")).toBeNull();
  });

  it("drops only the workspace from the address", () => {
    expect(withoutLinkedWorkspace({ pathname: "/rooms", search: "?workspace=t2", hash: "" })).toBe(
      "/rooms",
    );
    expect(
      withoutLinkedWorkspace({
        pathname: "/resources",
        search: "?tab=documents&workspace=t2",
        hash: "#top",
      }),
    ).toBe("/resources?tab=documents#top");
  });
});

describe("the address a link leaves for", () => {
  const origin = window.location.origin;

  it("names the workspace, keeping the page's own query and fragment", () => {
    expect(linkAddress({ path: "/resources?tab=documents#top", workspace: "t 2" })).toBe(
      `${origin}/resources?tab=documents&workspace=t+2#top`,
    );
  });

  it("stays on this dashboard whatever the path holds", () => {
    expect(new URL(linkAddress({ path: "//elsewhere.example/x", workspace: "t2" })).origin).toBe(
      origin,
    );
    expect(new URL(onThisDashboard("//elsewhere.example/x")).origin).toBe(origin);
  });
});

describe("a link kept for after the sign-in", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  it("is given back once", () => {
    keepLinkForSignIn({ path: "/rooms/r1", workspace: "t2" });
    expect(takeLinkAfterSignIn()).toEqual({ path: "/rooms/r1", workspace: "t2" });
    expect(takeLinkAfterSignIn()).toBeNull();
  });

  it("is dropped once it has waited too long", () => {
    vi.useFakeTimers();
    keepLinkForSignIn({ path: "/rooms/r1", workspace: "t2" });
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(takeLinkAfterSignIn()).toBeNull();
  });

  it("is dropped when it is not a path on this dashboard, or not one at all", () => {
    window.sessionStorage.setItem(
      "switch.workspaceLinkAfterSignIn",
      JSON.stringify({ path: "https://elsewhere.example/", workspace: "t2", at: Date.now() }),
    );
    expect(takeLinkAfterSignIn()).toBeNull();
    window.sessionStorage.setItem("switch.workspaceLinkAfterSignIn", "not json");
    expect(takeLinkAfterSignIn()).toBeNull();
  });

  it("can be forgotten", () => {
    keepLinkForSignIn({ path: "/rooms/r1", workspace: "t2" });
    forgetLinkForSignIn();
    expect(takeLinkAfterSignIn()).toBeNull();
  });
});
