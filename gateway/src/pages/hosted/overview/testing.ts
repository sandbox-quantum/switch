import { MARKER } from "../w5shared/testing";

export const U1 = "k1-a83e91f0c2d4b5a6";
export const U2 = "k1-12bd77aa0b1c2d3e";
export const U3 = "k1-f019c27d0b51aa00";
export const U4 = "k1-30f7000011112222"; // paused, with no box
export const U5 = "k1-6d2cab12cd34ef56"; // not in people: paused read from the box's state
export const W1 = "k1-7c10ab12cd34ef56";
export const W2 = "k1-2a44ab12cd34ef56";
export const B1 = "k1-4f2a91aa0b1c2d3e";
export const B2 = "k1-91c0d3aa0b1c2d3e";
export const B3 = "k1-0e77b5aa0b1c2d3e";
export const B4 = "k1-c4d812aa0b1c2d3e";
export const B5 = "k1-7aa031aa0b1c2d3e"; // retired

const agents = (working: number, idle = 0, resting = 0, unavailable = 0) => ({
  working,
  idle,
  resting,
  unavailable,
});

/** A V4-shaped overview (Core's `Overview`), with the marker planted in every
 *  field W4 never shows: none of it may reach the page. */
export function fixture(): Record<string, unknown> {
  return {
    viewer: "operator",
    people: [
      { user_id: U1, name: MARKER, agents: agents(2, 1), memory_bytes: 1, cost_month_usd: 12, kept_apart: "pass", paused: false },
      { user_id: U2, name: MARKER, agents: agents(0, 0, 3), memory_bytes: 1, cost_month_usd: 12, kept_apart: "pass", paused: false },
      { user_id: U3, name: MARKER, agents: agents(0, 0, 0, 2), memory_bytes: 1, cost_month_usd: 12, kept_apart: "pass", paused: true },
      { user_id: U4, name: MARKER, agents: agents(0), memory_bytes: null, cost_month_usd: null, kept_apart: "unknown", paused: true },
    ],
    room: "plenty",
    cost: { per_person_month_usd: 14, target_low_usd: 12, target_high_usd: 20, estimate: true },
    isolation: {
      result: "pass",
      blocked: 16,
      total: 16,
      checked_at: "2026-10-30T06:24:00+00:00",
      // 8 attempts × 2 directions, all blocked, plus one out of shape (dropped).
      attempts: [
        ...Array.from({ length: 8 }, (_, i) => ({
          label: `Attempt ${i + 1}`,
          results: [
            { direction: "A to B", result: "pass" },
            { direction: "B to A", result: "pass" },
          ],
        })),
        { what: MARKER },
      ],
    },
    alerts: [
      {
        id: "ev-1",
        severity: "critical",
        title: "Machine `shared-3` is above 85% memory",
        detail: MARKER,
        raised_at: "2026-10-30T10:48:00+00:00",
        cleared_at: null,
      },
      {
        id: "ev-2",
        severity: "warning",
        title: "Machine `shared-4` has been in its safety check for 10 minutes",
        detail: MARKER,
        raised_at: "2026-10-30T10:46:00+00:00",
        cleared_at: null,
      },
      {
        id: "ev-3",
        severity: "critical",
        title: "Cleared one",
        detail: MARKER,
        raised_at: "2026-10-30T08:00:00+00:00",
        cleared_at: "2026-10-30T08:05:00+00:00",
      },
    ],
    nodes: {
      machines: [
        machineRow("shared-1", "zone-a", 62, 84, "passed", null, 12, 0),
        machineRow("shared-2", "zone-b", 48, 63, "passed", null, 9, 3),
        machineRow("shared-3", "zone-c", 87, 84, "passed", null, 12, 0),
        machineRow("shared-4", "zone-a", 0, 0, "held", 3, 0, 12),
        machineRow("shared-5", "zone-b", null, null, "failed", null, 0, null),
      ],
      services: [{ name: "egress proxy", ready: 2, wanted: 2 }],
      report_at: "2026-10-30T10:50:00+00:00",
      report_stale: false,
    },
    boxes: [
      boxRow(B1, U1, [W1], "running", "shared-1", 1.9 * 1024 ** 3, 0),
      boxRow(B2, U2, [W1], "resting", "shared-1", 0.1 * 1024 ** 3, 0),
      boxRow(B3, U3, [W2], "paused", null, null, 0),
      boxRow(B4, U5, [W2, W1], "starting", "shared-2", 0.4 * 1024 ** 3, 3),
      boxRow(B5, "k1-0000111122223333", [W2], "retired", null, null, null),
    ],
  };
}

/** A made-up keyed id for a node, from its name. */
export function machineId(name: string): string {
  const hex = Array.from(name, (c) => c.charCodeAt(0).toString(16)).join("");
  return `k1-${hex.padEnd(16, "0").slice(0, 16)}`;
}

export function machineRow(
  name: string,
  zone: string,
  used: number | null,
  booked: number | null,
  gate: string,
  held: number | null,
  boxes: number,
  room: number | null,
) {
  return {
    name,
    // The node's keyed id: the Boxes and Machines lists link to its page.
    machine: machineId(name),
    instance_type: MARKER,
    kind: "shared",
    zone,
    memory_used_pct: used,
    memory_booked_pct: booked,
    gate,
    held_minutes: held,
    boxes,
    memory_total_bytes: 16 * 1024 ** 3,
    memory_working_bytes: null,
    memory_resting_bytes: null,
    memory_system_bytes: null,
    people: boxes,
    room_for_people: room,
  };
}

export function boxRow(
  box: string,
  user: string,
  workspaces: string[],
  state: string,
  node: string | null,
  memory: number | null,
  restarts: number | null,
) {
  return {
    box,
    user,
    workspaces,
    state,
    node,
    memory_used_bytes: memory,
    restarts_today: restarts,
  };
}
