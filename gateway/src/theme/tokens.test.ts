import { describe, expect, it } from "vitest";
import { currentTokens } from "../../scripts/gen-tokens.mjs";

describe("tokens.ts", () => {
  it("is what tokens.css generates, so an edit to one cannot leave the other behind", () => {
    const { generated, checkedIn } = currentTokens();
    expect(generated).toBe(checkedIn);
  });
});
