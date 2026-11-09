import { describe, expect, it } from "vitest";
import type { CloudAgent } from "../../../data/hostedCloud";
import {
  BOX_STOPPED,
  OWNER_STOPPED,
  cloudPresentation,
  cloudStatusFor,
  replyAgo,
} from "./cloudAgentState";

const now = new Date("2026-11-05T12:00:00Z");

function agent(overrides: Partial<CloudAgent>): CloudAgent {
  return { agent_id: "a1", state: "idle", ...overrides };
}

describe("cloudPresentation", () => {
  it.each<[Partial<CloudAgent>, string, string]>([
    [{ state: "working" }, "Working", "Replying now"],
    [{ state: "working", room_name: "Design" }, "Working", "Replying in Design"],
    [{ state: "idle" }, "Idle", "Replies straight away"],
    [{ state: "waking", box_starting: true }, "Back in a moment", "Starting your cloud"],
    [{ state: "waking", waiting_for_room: true }, "Back in a moment", "Waiting for room"],
    [{ state: "waking" }, "Back in a moment", "Starting up"],
    [{ state: "resting", box_stopped: true }, "Resting", "Starts when messaged"],
    [{ state: "resting" }, "Resting", "Wakes when you message it"],
    [{ state: "unavailable", paused: true }, "Paused by Switch", "Contact your admin"],
    [
      { state: "unavailable", turned_off: true },
      "Turned off by your admin",
      "Ask your admin to turn it on",
    ],
    [
      { state: "unavailable", stop_reason: "daily_cap_reached" },
      "Can't reply right now",
      "Today's AI limit reached",
    ],
    [
      { state: "unavailable", stop_reason: "budget_reached", reset_at: "2026-11-12T00:00:00Z" },
      "Can't reply right now",
      "Budget reached, resets 12 Nov",
    ],
    [
      { state: "unavailable", stop_reason: "budget_reached", reset_at: "not a date" },
      "Can't reply right now",
      "Budget reached",
    ],
    [
      { state: "unavailable", stop_reason: "login_needed" },
      "Can't reply right now",
      "Check your AI login",
    ],
    [
      { state: "unavailable", stop_reason: "cant_reach" },
      "Can't reply right now",
      "Can't reach your cloud",
    ],
    [{ state: "unavailable", needs_restart: true }, "Can't reply right now", "Needs a restart"],
    [
      { state: "unavailable", memory_stopped: true },
      "Can't reply right now",
      "Stopped: used too much memory",
    ],
    [{ state: "unavailable", needs_check: true }, "Can't reply right now", "Open it to see why"],
    [{ state: "unavailable" }, "Can't reply right now", "Try again in a few minutes"],
  ])("%o reads %s · %s", (overrides, label, detail) => {
    const shown = cloudPresentation(agent(overrides), now);
    expect([shown.label, shown.detail]).toEqual([label, detail]);
  });

  it("gives a next step only where the person can act", () => {
    expect(cloudPresentation(agent({ state: "unavailable", stop_reason: "login_needed" }), now).next).toBe(
      "give_login",
    );
    expect(BOX_STOPPED.next).toBeUndefined();
    for (const overrides of [
      { state: "working" },
      { state: "idle" },
      { state: "waking" },
      { state: "resting" },
      { state: "unavailable", paused: true },
      { state: "unavailable", turned_off: true },
      { state: "unavailable", stop_reason: "cant_reach" },
    ] as Partial<CloudAgent>[])
      expect(cloudPresentation(agent(overrides), now).next).toBeUndefined();
    expect(OWNER_STOPPED.next).toBeUndefined();
  });

  it("gives the last reply, except while working", () => {
    const at = "2026-11-05T11:56:00Z";
    expect(cloudPresentation(agent({ last_reply_at: at }), now).when).toBe("last reply 4 min ago");
    expect(cloudPresentation(agent({ state: "working", last_reply_at: at }), now).when).toBeNull();
    expect(cloudPresentation(agent({}), now).when).toBeNull();
  });
});

describe("replyAgo", () => {
  it.each([
    ["2026-11-05T11:59:30Z", "just now"],
    ["2026-11-05T11:15:00Z", "45 min ago"],
    ["2026-11-05T09:00:00Z", "3 h ago"],
    ["2026-11-04T11:00:00Z", "yesterday"],
    ["2026-11-01T11:00:00Z", "4 days ago"],
    ["garbage", "just now"],
  ])("%s is %s", (iso, words) => {
    expect(replyAgo(iso, now)).toBe(words);
  });
});

describe("cloudStatusFor", () => {
  const states = new Map([["a1", agent({ state: "resting", box_stopped: true })]]);

  it("uses Core's state, then Stopped for an agent on the box its owner stopped", () => {
    expect(cloudStatusFor("a1", states, new Set(["a1", "a2"]), now)?.label).toBe("Resting");
    expect(cloudStatusFor("a2", states, new Set(["a1", "a2"]), now)).toBe(OWNER_STOPPED);
  });

  it("says Stopped · Start your cloud for every agent on a box the panel shows as Stopped", () => {
    expect(cloudStatusFor("a1", states, new Set(["a1"]), now, true)).toBe(BOX_STOPPED);
    // Its owner stopped it too, so Core leaves it out: on a stopped box it still
    // says to start the cloud, never just "Stopped".
    expect(cloudStatusFor("a2", states, new Set(["a1", "a2"]), now, true)).toBe(BOX_STOPPED);
    expect(BOX_STOPPED.label + " · " + BOX_STOPPED.detail).toBe("Stopped · Start your cloud to use it");
    expect(cloudStatusFor("a3", states, new Set(["a1"]), now, true)).toBeNull();
    // A failure keeps its own words on a stopped box.
    const paused = new Map([["a1", agent({ state: "unavailable", paused: true })]]);
    expect(cloudStatusFor("a1", paused, new Set(["a1"]), now, true)?.label).toBe(
      "Paused by Switch",
    );
  });

  it("keeps the plain Stopped only for an agent its owner stopped on a running box", () => {
    expect(cloudStatusFor("a2", states, new Set(["a1", "a2"]), now, false)).toBe(OWNER_STOPPED);
    expect(OWNER_STOPPED.detail).toBeNull();
  });

  it("shows nothing for an agent not on the person's cloud", () => {
    expect(cloudStatusFor("a3", states, new Set(["a1"]), now)).toBeNull();
  });
});
