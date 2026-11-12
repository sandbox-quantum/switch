import { describe, expect, it } from "vitest";
import { linkedWorkspace, withoutLinkedWorkspace } from "./workspaceLink";

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
