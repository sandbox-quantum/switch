import { describe, expect, it } from "vitest";
import { DEV_MARKERS, devToolsIn } from "../../scripts/dev-tools.mjs";

describe("the build's dev-tools check", () => {
  it("passes a build without them", () => {
    expect(
      devToolsIn([
        ["dist/index.html", "<div id=root></div>"],
        ["dist/assets/index.js", "console.log(1)"],
      ]),
    ).toEqual([]);
  });

  it("finds each marker in whichever file carries it", () => {
    const chunk = `fetch("${DEV_MARKERS[0]}");document.getElementById("${DEV_MARKERS[1]}")`;
    expect(
      devToolsIn([
        ["dist/assets/index.js", "console.log(1)"],
        ["dist/assets/chunk.js", chunk],
      ]),
    ).toEqual(DEV_MARKERS.map((marker) => ["dist/assets/chunk.js", marker]));
  });

  it("refuses to pass a build with nothing in it", () => {
    expect(() => devToolsIn([])).toThrow("no files to check");
  });

  // A marker the code no longer uses would pass every build, switcher or not.
  it("looks for strings the dev tools still use", () => {
    const sources = import.meta.glob<string>(["./*.{ts,tsx}", "!./*.test.*"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const source = Object.values(sources).join("\n");
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    for (const marker of DEV_MARKERS) expect(source).toContain(marker);
  });
});
