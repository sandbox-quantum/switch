import { describe, expect, it } from "vitest";
import { prefilledAccess } from "./connectorProfile";

describe("prefilledAccess", () => {
  it("names each permission the form asks for, then how long it lasts", () => {
    expect(
      prefilledAccess(
        "https://github.com/settings/personal-access-tokens/new?name=Switch&description=x&expires_in=30&contents=write&pull_requests=write&issues=read",
      ),
    ).toEqual(["Code: read and write", "Pull requests: read and write", "Issues: read", "Expires in 30 days"]);
  });

  it("says nothing of an expiry the form leaves open", () => {
    expect(prefilledAccess("https://github.com/settings/personal-access-tokens/new?expires_in=none&some_thing=admin")).toEqual([
      "some thing: admin",
    ]);
  });
});
