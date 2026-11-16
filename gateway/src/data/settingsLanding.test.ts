import { afterEach, describe, expect, it } from "vitest";
import { landingAfterSwitch, landingCarriedAcross } from "./settingsLanding";

afterEach(() => window.sessionStorage.clear());

describe("landingAfterSwitch", () => {
  it.each(["/agents", "/rooms", "/templates", "/resources", "/connectors"])(
    "stays on the %s list",
    (path) => {
      expect(landingAfterSwitch(path)).toBe(path);
      expect(landingCarriedAcross()).toBeNull();
    },
  );

  it.each(["/agents/a1", "/rooms/r1", "/rooms/groups", "/templates/t1", "/connectors/github"])(
    "leaves %s for the landing page, as it showed the old workspace's",
    (path) => {
      expect(landingAfterSwitch(path)).toBe("/");
    },
  );

  it("carries a settings page across through the area", () => {
    expect(landingAfterSwitch("/settings/api-keys")).toBe("/settings");
    expect(landingCarriedAcross()).toBe("/settings/api-keys");
  });
});
