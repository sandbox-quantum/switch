import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER, answer, renderTab } from "../w5shared/testing";
import { groupedId } from "../hostedActions";
import { shortId } from "../w5shared/IdCell";
import { boxPageFor } from "./AttentionAction";
import OverviewTab, {
  BOX_CEILING,
  HEALTH,
  NEEDS_ATTENTION,
  NOTHING_NEEDS_ATTENTION,
  NOTHING_OPEN,
  OPEN_NOW,
} from "./OverviewTab";
import { LOAD_ERROR, REFRESH_MS, STALE, parseOverview } from "./overview";
import { B1, B3, B4, U1, U3, W1, boxRow, fixture } from "./testing";

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

  it("asks the shell for a fresh overview every 15 seconds, and stops when left", () => {
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

  it("asks nothing while the browser tab is hidden, and once more when it's shown again", () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    renderTab(OverviewTab, { overview: fixture(), refresh });
    act(() => vi.advanceTimersByTime(REFRESH_MS * 3));
    expect(refresh).not.toHaveBeenCalled();
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(REFRESH_MS));
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});

describe("Overview's health, Needs attention and ceiling (UX operators 1, 2, 6, 7)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sums up health in words beside a coloured dot, linking to the boxes that need attention", () => {
    renderTab(OverviewTab, { overview: fixture() });
    const health = within(screen.getByRole("region", { name: HEALTH }));
    // The fixture has a paused box, a box restarted 3 times today, and an open critical alert.
    expect(health.getByText("Something's wrong")).toBeTruthy();
    expect(screen.getByTestId("health-dot").dataset.health).toBe("red");
    expect(health.getByText(/4 boxes · 1 awake · 5 nodes/)).toBeTruthy();
    const link = health.getByRole("link", { name: "2 need attention" });
    expect(link.getAttribute("href")).toBe("#needs-attention");
  });

  it("lists a paused box with Resume, whose confirm says why they were paused, then refreshes", async () => {
    const paused = {
      action: "hosted.user_paused",
      target_id: U3,
      occurred_at: "2026-11-06T09:00:00+00:00",
      details: { reason: "<b>Over the AI cap</b>" },
    };
    const fetchMock = vi.fn(async (path: string, _init?: RequestInit) =>
      path.includes("/audit-events?")
        ? new Response(JSON.stringify([paused]), { status: 200 })
        : new Response(JSON.stringify({ action_id: "a-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn(async () => undefined);
    renderTab(OverviewTab, { overview: fixture(), refresh });
    const row = within(screen.getByTestId(`attention-${B3}`));
    expect(row.getByText("Paused by Switch")).toBeTruthy();
    // Ids only, through the shared IdCell (short, full id on hover, copy): never a name.
    expect(row.getByLabelText(`box ${groupedId(B3)}`).textContent).toBe(shortId(B3));
    expect(row.getByLabelText(`user ${groupedId(U3)}`).textContent).toBe(shortId(U3));
    fireEvent.click(row.getByRole("button", { name: "Resume" }));
    const dialog = within(screen.getByRole("dialog"));
    // The operator's reason, read from the audit log for this person, shown as text.
    expect(await dialog.findByText(/^<b>Over the AI cap<\/b> \(paused /)).toBeTruthy();
    expect(document.querySelector("[role=dialog] b")).toBeNull();
    const [readPath] = fetchMock.mock.calls[0]!;
    expect(readPath).toContain("/shared-cloud/audit-events?");
    expect(readPath).toContain(`target_id=${U3}`);
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "Ticket 9" } });
    fireEvent.click(dialog.getByRole("button", { name: "Resume user" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[1]!;
    expect(path).toContain(`/shared-cloud/users/${U3}/resume`);
    expect(JSON.parse(String(init?.body))).toEqual({ reason: "Ticket 9" });
  });

  it("copies the exact box id from a Needs attention row", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderTab(OverviewTab, { overview: fixture() });
    const row = within(screen.getByTestId(`attention-${B3}`));
    fireEvent.click(row.getByRole("button", { name: "Copy box" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(B3));
  });

  it("doesn't read the audit log for Restart, only for Resume", () => {
    const fetchMock = answer(200, []);
    const raw = fixture();
    raw.boxes = [{ ...boxRow(B1, U1, [W1], "running", "shared-1", 1, 0), heartbeat_at: "2026-01-01T00:00:00Z" }];
    renderTab(OverviewTab, { overview: raw });
    fireEvent.click(within(screen.getByTestId(`attention-${B1}`)).getByRole("button", { name: "Restart" }));
    expect(screen.queryByText("Why they were paused")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers Restart for an awake box with no recent report, and Open, to the box's page, for an error", () => {
    const raw = fixture();
    raw.alerts = [];
    raw.boxes = [
      { ...boxRow(B1, U1, [W1], "running", "shared-1", 1, 0), heartbeat_at: "2026-01-01T00:00:00Z" },
      boxRow(B3, U3, [W1], "error", null, null, 0),
    ];
    renderTab(OverviewTab, { overview: raw });
    const list = within(screen.getByRole("region", { name: NEEDS_ATTENTION }));
    expect(within(list.getByTestId(`attention-${B1}`)).getByText(/^No report for \d+ min$/)).toBeTruthy();
    expect(within(list.getByTestId(`attention-${B1}`)).getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(within(list.getByTestId(`attention-${B3}`)).getByText("Error · open it to see why")).toBeTruthy();
    const open = within(list.getByTestId(`attention-${B3}`)).getByRole("link", { name: "Open" });
    expect(open.getAttribute("href")).toBe(boxPageFor(B3));
    expect(boxPageFor(B3)).toBe(`/hosted/boxes/${B3}`);
    // The error box comes first.
    expect(list.getAllByTestId(/^attention-/).map((el) => el.dataset.testid)).toEqual([
      `attention-${B3}`,
      `attention-${B1}`,
    ]);
  });

  it("lists the fixture's box restarted 3 times today with Open", () => {
    renderTab(OverviewTab, { overview: fixture() });
    const row = within(screen.getByTestId(`attention-${B4}`));
    expect(row.getByText("Restarted 3 times today")).toBeTruthy();
    expect(row.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(boxPageFor(B4));
  });

  it("says nothing needs attention, and All healthy in green, when that's so", () => {
    const raw = fixture();
    raw.alerts = [];
    raw.boxes = [boxRow(B1, U1, [W1], "running", "shared-1", 1, 0)];
    renderTab(OverviewTab, { overview: raw });
    expect(screen.getByText(NOTHING_NEEDS_ATTENTION)).toBeTruthy();
    expect(screen.getByTestId("health-dot").dataset.health).toBe("green");
    expect(within(screen.getByRole("region", { name: HEALTH })).getByText(/All healthy/)).toBeTruthy();
  });

  it("shows the ceiling bar only when Core sends the ceiling, in amber with words from 80%", () => {
    const raw = fixture();
    const { update } = renderTab(OverviewTab, { overview: raw });
    expect(screen.queryByRole("region", { name: BOX_CEILING })).toBeNull();
    update({ overview: { ...raw, box_ceiling: { made: 16, ceiling: 20 } } });
    const bar = within(screen.getByRole("region", { name: BOX_CEILING }));
    expect(bar.getByText("16 of 20 boxes, so new testers may be refused soon")).toBeTruthy();
    expect(bar.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("16 of 20 boxes");
  });

  it("says how fresh the figures are, counting up each second, and the stale line when a refresh failed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-06T12:00:00Z"));
    const at = Date.now();
    const { update } = renderTab(OverviewTab, { overview: fixture(), overviewAt: at });
    expect(screen.getByTestId("updated").textContent).toBe("Updated just now");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByTestId("updated").textContent).toBe("Updated 10 s ago");
    update({ overview: fixture(), overviewAt: at, overviewStale: true });
    expect(screen.getByTestId("updated").textContent).toBe(STALE);
  });
});
