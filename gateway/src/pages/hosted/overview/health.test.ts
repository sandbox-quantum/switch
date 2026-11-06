import { describe, expect, it } from "vitest";
import {
  NO_REPORT_MS,
  ceilingLevel,
  ceilingWords,
  healthSummary,
  nearlyFull,
  needsAttention,
  updatedWords,
} from "./health";
import { type Overview, parseOverview } from "./overview";
import { B1, B2, B3, B4, B5, U1, W1, boxRow, fixture } from "./testing";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const GB = 1024 ** 3;
const MIN = 60_000;

/** The fixture with every alert cleared, so only the boxes decide. */
function quiet(): Record<string, unknown> {
  const raw = fixture();
  raw.alerts = [];
  return raw;
}

function parsed(raw: Record<string, unknown>): Overview {
  const overview = parseOverview(raw);
  if (overview === null) throw new Error("fixture out of shape");
  return overview;
}

const withBoxes = (...boxes: Record<string, unknown>[]) => parsed({ ...quiet(), boxes });
const box = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  ...boxRow(id, U1, [W1], state, "shared-1", null, 0),
  ...extra,
});
const rows = (overview: Overview) =>
  needsAttention(overview, NOW).map((r) => [r.box.box, r.words, r.action, r.severity]);

describe("Needs attention, to the lead's rule (operators item 2)", () => {
  it("lists an error box (red, Open) before a paused one (amber, Resume), straight away", () => {
    expect(rows(withBoxes(box(B1, "paused"), box(B2, "error")))).toEqual([
      [B2, "Error · open it to see why", "open", "red"],
      [B1, "Paused by Switch", "resume", "amber"],
    ]);
  });

  it("lists 3 or more restarts today, and not 2", () => {
    expect(
      rows(withBoxes(box(B1, "running", { restarts_today: 2 }), box(B2, "running", { restarts_today: 4 }))),
    ).toEqual([[B2, "Restarted 4 times today", "open", "amber"]]);
  });

  it("lists an awake box with no report for over 10 minutes, saying how long, and only an awake one", () => {
    expect(
      rows(
        withBoxes(
          box(B1, "running", { heartbeat_at: ago(12 * MIN) }),
          box(B2, "running", { heartbeat_at: ago(NO_REPORT_MS - 1000) }),
          box(B3, "resting", { heartbeat_at: ago(60 * MIN) }),
          box(B4, "running"), // no time from Core: the check is skipped
        ),
      ),
    ).toEqual([[B1, "No report for 12 min", "restart", "amber"]]);
  });

  it("lists a box at 95% of a limit as Full, saying which and how much", () => {
    expect(
      rows(
        withBoxes(
          box(B1, "running", { awake: { running: 12, max: 12 } }),
          box(B2, "running", { memory_used_bytes: 4.9 * GB, memory_total_bytes: 5 * GB }),
          box(B3, "resting", { disk: { total_bytes: 15 * GB, available_bytes: 0.5 * GB, scope: "workspace" } }),
        ),
      ),
    ).toEqual([
      [B1, "Full · 12 of 12 awake", "open", "amber"],
      [B2, "Full · memory 4.9 of 5 GB", "open", "amber"],
      [B3, "Full · disk 14.5 of 15 GB", "open", "amber"],
    ]);
  });

  it("gives 80% to 94% no row, and never counts a disk that isn't the workspace's", () => {
    const overview = withBoxes(
      box(B1, "running", { awake: { running: 11, max: 12 } }), // 92%
      box(B2, "resting", { disk: { total_bytes: 100, available_bytes: 1, scope: "unknown" } }),
      box(B3, "resting", { disk: { total_bytes: 100, available_bytes: 1 } }), // an old box: no scope
    );
    expect(rows(overview)).toEqual([]);
    expect(nearlyFull(overview)).toBe(1);
  });

  it("shows only a box's most serious reason, and never a put-away box", () => {
    expect(
      rows(
        withBoxes(
          box(B1, "running", { heartbeat_at: ago(30 * MIN), restarts_today: 5, awake: { running: 12, max: 12 } }),
          box(B5, "retired", { restarts_today: 9, awake: { running: 12, max: 12 } }),
        ),
      ),
    ).toEqual([[B1, "Restarted 5 times today", "open", "amber"]]);
  });
});

describe("the health summary (operators item 1)", () => {
  it("is green and says All healthy, with the counts, when nothing needs a look", () => {
    const overview = withBoxes(box(B1, "running"), box(B2, "resting"), box(B5, "retired"));
    expect(healthSummary(overview, needsAttention(overview, NOW))).toEqual({
      health: "green",
      // Put-away boxes aren't counted; the fixture has five nodes.
      counts: "2 boxes · 1 awake · 5 nodes",
      verdict: "All healthy",
      attention: 0,
    });
  });

  it("is amber with N need attention, and red once a box has an error", () => {
    let overview = withBoxes(box(B1, "paused"));
    let summary = healthSummary(overview, needsAttention(overview, NOW));
    expect([summary.health, summary.verdict]).toEqual(["amber", "1 needs attention"]);
    overview = withBoxes(box(B1, "paused"), box(B2, "error"));
    summary = healthSummary(overview, needsAttention(overview, NOW));
    expect([summary.health, summary.verdict]).toEqual(["red", "2 need attention"]);
  });

  it("is amber with no row for a box at 80% to 94% of a limit, and says so", () => {
    const overview = withBoxes(box(B1, "running", { awake: { running: 10, max: 12 } }));
    const summary = healthSummary(overview, needsAttention(overview, NOW));
    expect([summary.health, summary.verdict, summary.attention]).toEqual(["amber", "1 box nearly full", 0]);
  });

  it("goes by open alerts when no box needs attention: red for a critical, amber for a warning", () => {
    const raw = fixture(); // two open alerts, one critical
    raw.boxes = [box(B1, "running")];
    let overview = parsed(raw);
    let summary = healthSummary(overview, needsAttention(overview, NOW));
    expect([summary.health, summary.verdict]).toEqual(["red", "2 alerts open"]);
    raw.alerts = (raw.alerts as { severity: string }[]).filter((a) => a.severity === "warning");
    overview = parsed(raw);
    summary = healthSummary(overview, needsAttention(overview, NOW));
    expect([summary.health, summary.verdict]).toEqual(["amber", "1 alert open"]);
  });

  it("counts against the ceiling when Core sends it: amber from 80%, red when full", () => {
    const raw = { ...quiet(), boxes: [box(B1, "running")] };
    let summary = healthSummary(parsed({ ...raw, box_ceiling: { made: 9, ceiling: 20 } }), []);
    expect([summary.health, summary.counts, summary.verdict]).toEqual([
      "green",
      "1 of 20 boxes · 1 awake · 5 nodes",
      "All healthy",
    ]);
    summary = healthSummary(parsed({ ...raw, box_ceiling: { made: 16, ceiling: 20 } }), []);
    expect([summary.health, summary.verdict]).toEqual([
      "amber",
      "16 of 20 boxes, so new testers may be refused soon",
    ]);
    summary = healthSummary(parsed({ ...raw, box_ceiling: { made: 20, ceiling: 20 } }), []);
    expect([summary.health, summary.verdict]).toEqual([
      "red",
      "20 of 20 boxes, so new testers are refused until a box is put away",
    ]);
  });
});

describe("the ceiling bar (operators item 7)", () => {
  it("steps at 80% and at the ceiling", () => {
    expect(ceilingLevel(null)).toBeNull();
    expect(ceilingLevel({ made: 15, ceiling: 20 })).toBe("ok");
    expect(ceilingLevel({ made: 16, ceiling: 20 })).toBe("near");
    expect(ceilingLevel({ made: 20, ceiling: 20 })).toBe("full");
    expect(ceilingWords({ made: 9, ceiling: 20 })).toBe("9 of 20 boxes");
  });

  it("is left out when the answer has no ceiling or one out of shape", () => {
    expect(parsed(quiet()).boxCeiling).toBeNull();
    expect(parsed({ ...quiet(), box_ceiling: { made: -1, ceiling: 20 } }).boxCeiling).toBeNull();
    expect(parsed({ ...quiet(), box_ceiling: { made: 1, ceiling: 0 } }).boxCeiling).toBeNull();
  });
});

describe("Updated N s ago (operators item 6)", () => {
  it("counts seconds, then minutes", () => {
    expect(updatedWords(NOW, NOW + 2_000)).toBe("Updated just now");
    expect(updatedWords(NOW, NOW + 10_000)).toBe("Updated 10 s ago");
    expect(updatedWords(NOW, NOW + 185_000)).toBe("Updated 3 min ago");
    expect(updatedWords(NOW + 5_000, NOW)).toBe("Updated just now"); // a clock a little ahead
  });
});
