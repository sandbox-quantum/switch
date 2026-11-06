import { describe, expect, it } from "vitest";
import { parseOverview } from "./overview";
import { B1, B2, fixture } from "./testing";

type Raw = Record<string, unknown> & { boxes: Record<string, unknown>[] };

function withBoxFields(fields: Record<string, unknown>): Raw {
  const raw = fixture() as Raw;
  raw.boxes[0] = { ...raw.boxes[0], ...fields };
  return raw;
}

describe("each box's capacity and times on the overview", () => {
  it("reads memory total, awake and the three times when Core sends them", () => {
    const parsed = parseOverview(
      withBoxFields({
        memory_total_bytes: 4 * 1024 ** 3,
        awake: { running: 3, max: 12 },
        active_at: "2026-11-06T09:00:00+00:00",
        heartbeat_at: "2026-11-06T09:05:00+00:00",
        running_observed_at: "2026-11-06T08:00:00+00:00",
        retain_until: "2026-11-20T00:00:00+00:00",
      }),
    );
    const box = parsed?.boxes.find((b) => b.box === B1);
    expect(box).toMatchObject({
      memoryTotalBytes: 4 * 1024 ** 3,
      awake: { running: 3, max: 12 },
      activeAt: "2026-11-06T09:00:00+00:00",
      heartbeatAt: "2026-11-06T09:05:00+00:00",
      runningObservedAt: "2026-11-06T08:00:00+00:00",
      retainUntil: "2026-11-20T00:00:00+00:00",
    });
  });

  it("reads them as missing from an older Core, keeping the box", () => {
    const box = parseOverview(fixture())?.boxes.find((b) => b.box === B2);
    expect(box).toMatchObject({
      memoryTotalBytes: null,
      awake: null,
      activeAt: null,
      heartbeatAt: null,
      runningObservedAt: null,
      retainUntil: null,
    });
  });

  it("drops figures that aren't in shape rather than showing them", () => {
    const box = parseOverview(
      withBoxFields({
        memory_total_bytes: -1,
        awake: { running: 2, max: 0 },
        active_at: "not a time",
      }),
    )?.boxes.find((b) => b.box === B1);
    expect(box).toMatchObject({ memoryTotalBytes: null, awake: null, activeAt: null });
  });
});
