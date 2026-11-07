import { describe, expect, it } from "vitest";
import { currentTokens } from "../../scripts/gen-hoot-tokens.mjs";

describe("hoot-tokens.ts", () => {
  it("is what hoot.css generates, so an edit to one cannot leave the other behind", () => {
    const { generated, checkedIn } = currentTokens();
    expect(generated).toBe(checkedIn);
  });
});
