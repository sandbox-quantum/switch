import { NavigationType } from "react-router";
import { describe, expect, it } from "vitest";
import { EMPTY_TRAIL, type Trail, follow, lastWorkspacePage } from "./wayBack";

function at(key: string, pathname: string) {
  return { key, pathname, search: "", hash: "", state: null };
}

function walk(...steps: [NavigationType, string, string][]): Trail {
  return steps.reduce((trail, [type, key, path]) => follow(trail, at(key, path), type), EMPTY_TRAIL);
}

const { Pop, Push, Replace } = NavigationType;

describe("the way back to the workspace", () => {
  it("steps back past every page outside the workspace to the one it was left from", () => {
    const trail = walk(
      [Pop, "a", "/rooms"],
      [Push, "b", "/agents"],
      [Push, "c", "/settings/org/general"],
      [Push, "d", "/settings/org/users"],
    );
    expect(lastWorkspacePage(trail)).toEqual({ href: "/agents", delta: -2 });
  });

  it("has none when the area was opened directly", () => {
    expect(lastWorkspacePage(walk([Pop, "a", "/settings/org/general"]))).toBeNull();
  });

  it("counts a redirect inside the area as the same step", () => {
    const trail = walk(
      [Pop, "a", "/rooms"],
      [Push, "b", "/settings/org"],
      [Replace, "c", "/settings/org/general"],
    );
    expect(lastWorkspacePage(trail)).toEqual({ href: "/rooms", delta: -1 });
  });

  it("follows the browser's own back button, and drops what a new page replaces", () => {
    const trail = walk(
      [Pop, "a", "/rooms"],
      [Push, "b", "/agents"],
      [Push, "c", "/settings/org/general"],
      [Pop, "a", "/rooms"],
      [Push, "d", "/settings/org/users"],
    );
    expect(trail.entries.map((e) => e.key)).toEqual(["a", "d"]);
    expect(lastWorkspacePage(trail)).toEqual({ href: "/rooms", delta: -1 });
  });

  it("starts again at an entry from before the app loaded", () => {
    const trail = walk([Pop, "a", "/rooms"], [Push, "b", "/settings/org/general"], [Pop, "z", "/settings/org/users"]);
    expect(lastWorkspacePage(trail)).toBeNull();
  });

  it("changes nothing when the same location is followed again", () => {
    const trail = walk([Pop, "a", "/rooms"], [Push, "b", "/agents"]);
    expect(follow(trail, at("b", "/agents"), Push)).toBe(trail);
  });
});
