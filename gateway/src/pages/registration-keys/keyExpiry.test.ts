import { describe, expect, it } from "vitest";
import { formatKeyExpiry } from "./keyExpiry";

const NOW = new Date("2026-11-06T12:00:00Z");

describe("formatKeyExpiry", () => {
  it("says a key without an expiry never expires", () => {
    expect(formatKeyExpiry(null, NOW)).toBe("No expiry");
  });

  it("shows the day a key expires", () => {
    expect(formatKeyExpiry("2027-02-04T12:00:00+00:00", NOW)).toBe("2027-02-04");
  });

  it("marks a key that has already expired", () => {
    expect(formatKeyExpiry("2026-11-01T12:00:00+00:00", NOW)).toBe("Expired 2026-11-01");
  });
});
