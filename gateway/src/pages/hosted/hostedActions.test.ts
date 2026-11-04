import { describe, expect, it } from "vitest";
import { ApiError } from "../../data/api";
import { groupedId, refusal, title } from "./hostedActions";

const MARKER = "zz-marker-7f3a";

describe("hosted action wording (W6)", () => {
  it("shows a keyed id in three groups and leaves anything else as it is", () => {
    expect(groupedId("k1-6d2c91f03ab2")).toBe("k1-6d2c 91f0 3ab2");
    expect(groupedId("k1-6d2c91f03ab29999")).toBe("k1-6d2c 91f0 3ab2");
    expect(groupedId("not a keyed id")).toBe("not a keyed id");
  });

  it("titles each action as a question", () => {
    expect(title("pause", "k1-6d2c91f03ab2", "k1-aaaabbbbcccc")).toBe(
      "Pause user k1-6d2c 91f0 3ab2?",
    );
    expect(title("resume", "k1-6d2c91f03ab2", "k1-aaaabbbbcccc")).toBe(
      "Resume user k1-6d2c 91f0 3ab2?",
    );
    expect(title("restart", "k1-6d2c91f03ab2", "k1-aaaabbbbcccc")).toBe(
      "Restart box k1-aaaa bbbb cccc for k1-6d2c 91f0 3ab2?",
    );
  });

  it("answers every refusal with a fixed line, never the server's text", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
      const line = refusal(new ApiError(status, `${MARKER} detail`, `${MARKER} message`));
      expect(line).not.toContain(MARKER);
      expect(line.length).toBeGreaterThan(0);
    }
    expect(refusal(new ApiError(403, null, ""))).toBe(
      "Only Switch operators can do this.",
    );
    expect(refusal(new ApiError(429, null, ""))).toBe(
      "You've reached the hourly limit for operator actions. Try again later.",
    );
    expect(refusal(new TypeError(`network ${MARKER}`))).toBe(
      "That didn't go through. Reload the list and check the box's state before trying again.",
    );
  });
  it("tells a busy limit lock apart from an unmanaged server, both 503", () => {
    const busy = new ApiError(503, "Operator actions are busy. Try again in a minute.", "x");
    const unmanaged = new ApiError(503, "Hosted agents are not managed here", "x");
    const blank = new ApiError(503, null, "x");
    expect(refusal(busy)).toBe("Switch is busy right now. Try again in a minute.");
    expect(refusal(unmanaged)).toBe("Hosted agents aren't managed on this server.");
    expect(refusal(blank)).toBe("Hosted agents aren't managed on this server.");
  });
});
