import { describe, expect, it } from "vitest";
import { accountInitials } from "./NavRail";

describe("accountInitials", () => {
  it.each([
    ["Ada Lovelace", "AL"],
    ["Ada King Lovelace", "AL"],
    ["ada", "A"],
    ["  Grace   Hopper ", "GH"],
    ["Émile Zola", "ÉZ"],
  ])("takes %s's from the first and last words of the name", (name, initials) => {
    expect(accountInitials({ name, email: "someone@example.com" })).toBe(initials);
  });

  it("falls back to the email's first letter when the name gives none", () => {
    expect(accountInitials({ name: "", email: "bo@example.com" })).toBe("B");
    expect(accountInitials({ name: "42", email: "bo@example.com" })).toBe("B");
  });

  it("shows a question mark with nobody signed in", () => {
    expect(accountInitials(null)).toBe("?");
  });
});
