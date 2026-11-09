import type { BoxCeiling, Overview, OverviewBox } from "./overview";

/**
 * Overview's health summary and "Needs attention" list (UX proposal,
 * operators items 1, 2 and 7), to the lead's rule and the PM's strings table.
 * One written rule for each, so QA can test pass or fail, and the summary,
 * the list and the ceiling bar never disagree. Counts, states and ids only:
 * never a name.
 *
 * The overview has no time a box entered its state, so paused and error boxes
 * are listed straight away, without "for N min", and "stuck stopping" is left
 * out until Core serves that time.
 */

/** An awake box with no report for longer than this is listed. */
export const NO_REPORT_MS = 10 * 60_000;
/** Restarts today from which a box is listed. */
export const MANY_RESTARTS = 3;
/** Capacity from which a box is listed ("Full · …"). */
export const FULL = 0.95;
/** Capacity from which the summary turns amber, with no row. */
export const NEARLY_FULL = 0.8;

export type AttentionReason = "error" | "paused" | "restarts" | "no_report" | "full";
export type AttentionAction = "open" | "resume" | "restart";

/** Most serious first: a row shows its most serious reason, and that one's action. */
const ORDER: readonly AttentionReason[] = ["error", "paused", "restarts", "no_report", "full"];

const ACTION: Record<AttentionReason, AttentionAction> = {
  error: "open",
  paused: "resume",
  restarts: "open",
  no_report: "restart",
  full: "open",
};

export interface AttentionRow {
  box: OverviewBox;
  reason: AttentionReason;
  /** The PM's words for it, with this box's figures. */
  words: string;
  action: AttentionAction;
  /** Red for an error, amber for the rest. */
  severity: "red" | "amber";
}

/** "4.9 of 5 GB": one decimal, dropping a trailing ".0". */
function gbPair(used: number, total: number): string {
  const one = (bytes: number) => (bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "");
  return `${one(used)} of ${one(total)} GB`;
}

type Fill = { share: number; words: string };

/** The box's capacity readings, each as a share of its limit and its "Full · …" words. */
function fills(box: OverviewBox): Fill[] {
  const out: Fill[] = [];
  if (box.awake) {
    out.push({
      share: box.awake.running / box.awake.max,
      words: `Full · ${box.awake.running} of ${box.awake.max} awake`,
    });
  }
  if (box.memoryUsedBytes !== null && box.memoryTotalBytes !== null && box.memoryTotalBytes > 0) {
    out.push({
      share: box.memoryUsedBytes / box.memoryTotalBytes,
      words: `Full · memory ${gbPair(box.memoryUsedBytes, box.memoryTotalBytes)}`,
    });
  }
  const disk = box.workspaceDisk ?? null;
  if (disk) {
    const used = disk.totalBytes - disk.availableBytes;
    out.push({ share: used / disk.totalBytes, words: `Full · disk ${gbPair(used, disk.totalBytes)}` });
  }
  return out;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

function rowFor(box: OverviewBox, now: number): AttentionRow | null {
  if (box.state === "retired") return null;
  const found: Partial<Record<AttentionReason, string>> = {};
  if (box.state === "error") found.error = "Error · open it to see why";
  if (box.state === "paused") found.paused = "Paused by Switch";
  if (box.restartsToday !== null && box.restartsToday >= MANY_RESTARTS)
    found.restarts = `Restarted ${box.restartsToday} times today`;
  if (box.state === "running" && box.heartbeatAt !== null) {
    const silent = now - Date.parse(box.heartbeatAt);
    if (silent > NO_REPORT_MS) found.no_report = `No report for ${minutes(silent)} min`;
  }
  const full = fills(box).find((f) => f.share >= FULL);
  if (full) found.full = full.words;
  const reason = ORDER.find((r) => found[r] !== undefined);
  if (reason === undefined) return null;
  return {
    box,
    reason,
    words: found[reason]!,
    action: ACTION[reason],
    severity: reason === "error" ? "red" : "amber",
  };
}

/** Boxes that need an operator, most serious first. Put-away boxes never do. */
export function needsAttention(overview: Overview, now: number): AttentionRow[] {
  const rows = overview.boxes.flatMap((box) => {
    const row = rowFor(box, now);
    return row ? [row] : [];
  });
  return rows.sort((a, b) => ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason));
}

/** Current boxes at 80% or more of a limit (but not listed): amber in the summary only. */
export function nearlyFull(overview: Overview): number {
  return overview.boxes.filter(
    (box) => box.state !== "retired" && fills(box).some((f) => f.share >= NEARLY_FULL),
  ).length;
}

export type Health = "green" | "amber" | "red";

export const HEALTH_WORDS: Record<Health, string> = {
  green: "Healthy",
  amber: "Needs a look",
  red: "Something's wrong",
};

export interface HealthSummary {
  health: Health;
  /** "9 of 20 boxes · 3 awake · 2 nodes", or "9 boxes · …" without a ceiling. */
  counts: string;
  /** What the colour is for, in words. */
  verdict: string;
  attention: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The rule: red when a box has an error, a critical alert is open, or the
 * ceiling is reached. Amber when any box needs attention, a warning is open,
 * the ceiling is at 80% or more, or a box is at 80% or more of a limit. Green
 * otherwise. The words always say what the colour is for.
 */
export function healthSummary(overview: Overview, rows: AttentionRow[]): HealthSummary {
  const current = overview.boxes.filter((b) => b.state !== "retired").length;
  const awake = overview.boxes.filter((b) => b.state === "running").length;
  const open = overview.alerts.filter((a) => a.open);
  const critical = open.some((a) => a.severity === "critical");
  const ceiling = ceilingLevel(overview.boxCeiling);
  const filling = nearlyFull(overview);
  const health: Health =
    rows.some((r) => r.severity === "red") || critical || ceiling === "full"
      ? "red"
      : rows.length > 0 || open.length > 0 || ceiling === "near" || filling > 0
        ? "amber"
        : "green";
  const boxes = overview.boxCeiling
    ? `${current} of ${overview.boxCeiling.ceiling} boxes`
    : plural(current, "box", "boxes");
  const counts = `${boxes} · ${awake} awake · ${plural(overview.machines.length, "node", "nodes")}`;
  let verdict = "All healthy";
  if (rows.length > 0) verdict = `${rows.length} need${rows.length === 1 ? "s" : ""} attention`;
  else if (open.length > 0) verdict = `${plural(open.length, "alert", "alerts")} open`;
  else if (ceiling === "near" || ceiling === "full") verdict = ceilingWords(overview.boxCeiling!);
  else if (filling > 0) verdict = `${plural(filling, "box", "boxes")} nearly full`;
  return { health, counts, verdict, attention: rows.length };
}

export type CeilingLevel = "ok" | "near" | "full";

/** The ceiling bar's step: amber from 80%, full at the ceiling. */
export function ceilingLevel(ceiling: BoxCeiling | null): CeilingLevel | null {
  if (ceiling === null) return null;
  if (ceiling.made >= ceiling.ceiling) return "full";
  return ceiling.made / ceiling.ceiling >= NEARLY_FULL ? "near" : "ok";
}

/** The ceiling bar's line, in the PM's words. */
export function ceilingWords(ceiling: BoxCeiling): string {
  const level = ceilingLevel(ceiling);
  const of = `${ceiling.made} of ${ceiling.ceiling} boxes`;
  if (level === "full") return `${of}, so new testers are refused until a box is put away`;
  if (level === "near") return `${of}, so new testers may be refused soon`;
  return of;
}

/** "Updated just now", "Updated 10 s ago", "Updated 3 min ago". */
export function updatedWords(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds} s ago`;
  return `Updated ${Math.floor(seconds / 60)} min ago`;
}
