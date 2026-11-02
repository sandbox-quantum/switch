import { describe, expect, it } from "vitest";
import { budgetMetrics } from "../../data/api";
import { budgetMetricLabel, capLine, dailyCapProblem, hoursLabel, metricLabel } from "./usageFormat";

describe("the daily AI cap (visibility L1b)", () => {
  it("is held to 50 to 5,000 a day, whole numbers only", () => {
    for (const ok of ["50", "300", "5000", " 120 "]) expect(dailyCapProblem(ok)).toBeNull();
    for (const bad of ["49", "5001", "0", "-5", "2.5", "300a", ""])
      expect(dailyCapProblem(bad)).toBe("Choose between 50 and 5,000 a day.");
  });

  it("says why the cap in force differs from the one set", () => {
    expect(capLine({ cap_in_force: null }, 300)).toBeNull();
    expect(capLine({ cap_in_force: 300, cap_source: "workspace" }, 300)).toBe("300 a day");
    expect(capLine({ cap_in_force: 200, cap_source: "local" }, null)).toBe("200 a day");
    expect(capLine({ cap_in_force: 200, cap_source: "local" }, 300)).toBe(
      "200 applied: Switch's own limit is lower",
    );
    expect(capLine({ cap_in_force: 50, cap_source: "workspace" }, 10)).toBe(
      "50 applied: the lowest allowed",
    );
    expect(capLine({ cap_in_force: 5000, cap_source: "workspace" }, 9000)).toBe(
      "5,000 applied: the highest allowed",
    );
  });
});

describe("hosted metrics", () => {
  it("offer awake minutes only while the server's flag is on, and AI calls only as the daily cap", () => {
    expect(budgetMetrics(false, true)).not.toContain("awake_minutes");
    expect(budgetMetrics(true, true)).toContain("awake_minutes");
    expect(budgetMetrics(false, true)).toContain("hosted_ai_calls");
  });

  it("never offer the daily AI cap while hosted agents v2 is off", () => {
    expect(budgetMetrics(false, false)).not.toContain("hosted_ai_calls");
    expect(budgetMetrics(true, false)).not.toContain("hosted_ai_calls");
  });

  it("never offer awake minutes while hosted agents v2 is off, even with its own flag on", () => {
    expect(budgetMetrics(true, false)).not.toContain("awake_minutes");
    expect(budgetMetricLabel("hosted_ai_calls")).toBe("Daily AI calls per person");
    expect(metricLabel("hosted_ai_calls")).toBe("AI calls");
    expect(metricLabel("awake_minutes")).toBe("Awake minutes");
  });

  it("shows awake hours to one decimal", () => {
    expect(hoursLabel(41.46)).toBe("41.5 h");
  });
});
