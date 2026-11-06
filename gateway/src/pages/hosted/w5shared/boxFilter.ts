import type { BoxState, OverviewBox } from "../overview/overview";

/** The Hosted lists' state filter: what an operator asks for, grouping
 *  Core's box states (`read_views.box_state`) into the words on the chips. */
export type BoxFilter = "current" | "awake" | "resting" | "stopped" | "putAway" | "all";

/** The chips, in order (the PM's stories). "Current", the default, is every
 *  box that isn't put away; "All" really is everything, put away included. */
export const BOX_FILTERS: readonly { value: BoxFilter; label: string }[] = [
  { value: "current", label: "Current" },
  { value: "awake", label: "Awake" },
  { value: "resting", label: "Resting" },
  { value: "stopped", label: "Stopped" },
  { value: "putAway", label: "Put away" },
  { value: "all", label: "All" },
];

const GROUP: Record<BoxState, Exclude<BoxFilter, "current" | "all">> = {
  running: "awake",
  starting: "awake",
  resting: "resting",
  stopping: "stopped",
  stopped: "stopped",
  paused: "stopped",
  error: "stopped",
  // Core's word for a box put away or on its way out (retained, deleting).
  retired: "putAway",
};

/** Which chip a box falls under. */
export function boxGroup(state: BoxState): Exclude<BoxFilter, "current" | "all"> {
  return GROUP[state];
}

/** Whether a box is current: anything not put away. */
export function isCurrent(box: Pick<OverviewBox, "state">): boolean {
  return boxGroup(box.state) !== "putAway";
}

/**
 * The boxes a filter and a search show. The search matches the start or any
 * part of a box, user or workspace id, or the machine's name, ignoring case
 * and the spaces the id cell groups ids with. Put-away boxes show only under
 * Put away and All, so they never mix into the current list by accident.
 */
export function filterBoxes(
  boxes: readonly OverviewBox[],
  filter: BoxFilter,
  query: string,
): OverviewBox[] {
  const needle = query.replace(/\s+/g, "").toLowerCase();
  return boxes.filter((box) => {
    const group = boxGroup(box.state);
    if (filter === "current" && group === "putAway") return false;
    if (filter !== "current" && filter !== "all" && group !== filter) return false;
    if (!needle) return true;
    return [box.box, box.user, ...box.workspaces, box.node ?? ""].some((value) =>
      value.toLowerCase().includes(needle),
    );
  });
}

/** How many boxes fall under each chip, for the counts beside their labels. */
export function filterCounts(boxes: readonly OverviewBox[]): Record<BoxFilter, number> {
  const counts: Record<BoxFilter, number> = {
    current: 0,
    awake: 0,
    resting: 0,
    stopped: 0,
    putAway: 0,
    all: boxes.length,
  };
  for (const box of boxes) {
    const group = boxGroup(box.state);
    counts[group] += 1;
    if (group !== "putAway") counts.current += 1;
  }
  return counts;
}

/** "Kept until 20 Nov" for a put-away box with a date; null when it has none. */
export function keptUntil(retainUntil: string | null, now: Date = new Date()): string | null {
  if (retainUntil === null) return null;
  const when = new Date(retainUntil);
  if (Number.isNaN(when.getTime())) return null;
  const sameYear = when.getUTCFullYear() === now.getUTCFullYear();
  const words = when.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
  return `Kept until ${words}`;
}
