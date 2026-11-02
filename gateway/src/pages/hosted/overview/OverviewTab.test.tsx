import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER, renderTab } from "../w5shared/testing";
import OverviewTab, { NOTHING_OPEN, OPEN_NOW } from "./OverviewTab";
import { LOAD_ERROR, REFRESH_MS, STALE, parseOverview } from "./overview";
import { fixture } from "./testing";

vi.mock("../../../data/AuthContext", () => ({
  useAuth: () => ({ user: { id: "op-me", name: "Jo Operator" }, refresh: vi.fn() }),
}));

function card(label: string) {
  return within(screen.getByLabelText(label));
}

describe("the Overview tab (W4, p16 at V0)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the five cards from the shell's overview, with no request of its own", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderTab(OverviewTab, { overview: fixture() });
    expect(card("People").getByText("4")).toBeTruthy();
    expect(card("People").getByText("8 agents")).toBeTruthy();
    expect(card("Machines").getByText("5")).toBeTruthy();
    expect(card("Machines").getByText("3 zones")).toBeTruthy();
    // Used over total across the machines that report: (62+48+87+0)% of 16 GB each.
    expect(card("Memory in use").getByText("49%")).toBeTruthy();
    expect(card("Memory in use").getByText("of 64 GB")).toBeTruthy();
    expect(card("Kept apart").getByText("✓")).toBeTruthy();
    expect(card("Kept apart").getByText("Passed · 16 of 16 blocked")).toBeTruthy(); // words, not the mark alone
    expect(card("Kept apart").getByText(/^checked /)).toBeTruthy();
    expect(card("Alerts open").getByText("2")).toBeTruthy();
    expect(card("Alerts open").getByText("1 critical")).toBeTruthy();
    expect(screen.queryByText(/Waiting for room/)).toBeNull(); // no V4 field yet
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists only the open alerts under Open now, ids in a fixed-width font", () => {
    renderTab(OverviewTab, { overview: fixture() });
    const open = within(screen.getByRole("region", { name: OPEN_NOW }));
    expect(open.getByText(/is above 85% memory/)).toBeTruthy();
    expect(open.getByText("shared-3").tagName).toBe("CODE");
    expect(open.queryByText(/Cleared one/)).toBeNull();
  });

  it("says when nothing is open, and when isolation failed or isn't checked", () => {
    const raw = fixture();
    raw.alerts = [];
    const iso = raw.isolation as { attempts: { results: { result: string }[] }[] } & Record<string, unknown>;
    Object.assign(iso, { result: "fail", blocked: 15 });
    iso.attempts[0].results[1].result = "fail";
    const { update } = renderTab(OverviewTab, { overview: raw });
    expect(screen.getAllByText(NOTHING_OPEN)).toHaveLength(2); // the card and Open now
    expect(card("Kept apart").getByText("✗")).toBeTruthy();
    expect(card("Kept apart").getByText("Failed · 15 of 16 blocked")).toBeTruthy();
    expect(card("Alerts open").getByText(NOTHING_OPEN)).toBeTruthy();
    expect(card("Kept apart").getByText(/^Check failed at /)).toBeTruthy();
    update({ overview: { ...raw, isolation: { result: "unknown", checked_at: null } } });
    expect(card("Kept apart").getByText("Not checked yet")).toBeTruthy();
  });

  it("says not confirmed, in amber, when some attempts couldn't run and none got through", () => {
    const raw = fixture();
    const iso = raw.isolation as { attempts: { results: { result: string }[] }[] } & Record<string, unknown>;
    Object.assign(iso, { result: "unknown", blocked: 15 });
    iso.attempts[0].results[1].result = "unknown";
    renderTab(OverviewTab, { overview: raw });
    expect(card("Kept apart").getByText("!")).toBeTruthy();
    const words = card("Kept apart").getByText("Not confirmed · 1 couldn't run");
    expect(card("Kept apart").getByText(/^checked /)).toBeTruthy();
    expect(card("Kept apart").queryByText(/Passed|Failed/)).toBeNull();
    expect(getComputedStyle(words).color).toBeTruthy();
  });

  it("averages the percentages when a machine reports no total", () => {
    const raw = fixture();
    const machines = (raw.nodes as { machines: Record<string, unknown>[] }).machines;
    machines[0].memory_total_bytes = null;
    renderTab(OverviewTab, { overview: raw });
    expect(card("Memory in use").getByText("49%")).toBeTruthy();
    expect(card("Memory in use").getByText("Average 49% across 4 machines")).toBeTruthy();
  });

  it("says when no machine has reported memory, and counts one machine as one", () => {
    const raw = fixture();
    const nodes = raw.nodes as { machines: Record<string, unknown>[] };
    nodes.machines = nodes.machines.slice(0, 1).map((m) => ({ ...m, memory_total_bytes: null }));
    const { update } = renderTab(OverviewTab, { overview: raw });
    expect(card("Memory in use").getByText("Average 62% across 1 machine")).toBeTruthy();
    update({ overview: { ...raw, nodes: { ...nodes, machines: [] } } });
    expect(card("Memory in use").getByText("Not reported yet")).toBeTruthy();
  });

  it("counts open alerts with none critical", () => {
    const raw = fixture();
    raw.alerts = (raw.alerts as Record<string, unknown>[]).filter((a) => a.severity === "warning");
    renderTab(OverviewTab, { overview: raw });
    expect(card("Alerts open").getByText("1 open · none critical")).toBeTruthy();
  });

  it("shows the stale line when a refresh failed, and an error for a broken answer", () => {
    const { update } = renderTab(OverviewTab, { overview: fixture(), overviewStale: true });
    expect(screen.getByText(STALE)).toBeTruthy();
    update({ overview: { people: [] } });
    expect(screen.getByRole("alert").textContent).toBe(LOAD_ERROR);
  });

  it("asks the shell for a fresh overview every 30 seconds, and stops when left", () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const { unmount } = renderTab(OverviewTab, { overview: fixture(), refresh });
    act(() => vi.advanceTimersByTime(REFRESH_MS - 1));
    expect(refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    act(() => vi.advanceTimersByTime(REFRESH_MS * 3));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never renders a field W4 doesn't show (the marker search)", () => {
    const { container } = renderTab(OverviewTab, { overview: fixture() });
    expect(container.innerHTML).not.toContain(MARKER);
  });

  it("drops rows out of shape, and refuses an answer missing a list", () => {
    const raw = fixture();
    (raw.boxes as unknown[]).push({ box: 1 }, { box: "x", user: "u", workspaces: [], state: "made-up", node: null });
    expect(parseOverview(raw)?.boxes).toHaveLength(5);
    expect(parseOverview({ ...raw, boxes: undefined })).toBeNull();
    expect(parseOverview({ ...raw, nodes: { machines: "x" } })).toBeNull();
  });
});
