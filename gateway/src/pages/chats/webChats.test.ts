import { describe, expect, it } from "vitest";
import { firstWords } from "./webChats";

describe("firstWords", () => {
  it("names a chat from the first words of its first message, on one line", () => {
    expect(firstWords("  Please run\napp.py and tell me what it prints. ")).toBe(
      "Please run app.py and tell me",
    );
  });

  it("shortens a name too long for the list", () => {
    expect(firstWords("Supercalifragilisticexpialidocious antidisestablishmentarianism")).toBe(
      "Supercalifragilisticexpialidocious antidisestab…",
    );
  });

  it("refuses a message with no words, which leaves the chat its default name", () => {
    expect(() => firstWords("   ")).toThrow();
  });
});
