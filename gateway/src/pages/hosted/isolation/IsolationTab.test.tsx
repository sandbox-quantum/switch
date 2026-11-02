import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOAD_ERROR, STALE } from "../overview/overview";
import { fixture } from "../overview/testing";
import { MARKER, renderTab } from "../w5shared/testing";
import IsolationTab, { HOW, NOT_CONFIRMED_LINE, NOT_RUN, parseIsolation } from "./IsolationTab";

vi.mock("../../../data/AuthContext", () => ({
  useAuth: () => ({ user: { id: "op-me", name: "Jo Operator" }, refresh: vi.fn() }),
}));

function withIsolation(isolation: Record<string, unknown>) {
  return { ...fixture(), isolation };
}

const ATTEMPTS = [
  {
    label: "Open the other's files",
    results: [
      { direction: "A to B", result: "pass" },
      { direction: "B to A", result: "pass" },
    ],
  },
  {
    label: "Reach the other's agents",
    results: [
      { direction: "A to B", result: "pass" },
      { direction: "B to A", result: "fail" },
    ],
  },
];

describe("the Isolation tab (W4)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says no check has run while V4 has none, with no request of its own", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderTab(IsolationTab, {
      overview: withIsolation({ result: "unknown", blocked: 0, total: 0, checked_at: null, attempts: [] }),
    });
    expect(screen.getByText(NOT_RUN)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows every attempt in each direction, as Console's built tab does", () => {
    renderTab(IsolationTab, {
      overview: withIsolation({
        result: "fail",
        blocked: 3,
        total: 4,
        checked_at: "2026-10-30T06:24:00+00:00",
        attempts: ATTEMPTS,
      }),
    });
    expect(screen.getByText(/1 of 4 attempts got through/)).toBeTruthy();
    expect(screen.getByText(new RegExp(HOW.replace(/[.']/g, ".")))).toBeTruthy();
    const rows = screen.getAllByTestId("attempt-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText("✗ Got through")).toBeTruthy();
    expect(within(rows[0]).getAllByText("✓ Blocked")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "B to A" })).toBeTruthy();
  });

  it("says all were blocked on a pass", () => {
    renderTab(IsolationTab, {
      overview: withIsolation({
        result: "pass",
        blocked: 2,
        total: 2,
        checked_at: "2026-10-30T06:24:00+00:00",
        attempts: ATTEMPTS.slice(0, 1),
      }),
    });
    expect(screen.getByText(/All 2 attempts were blocked/)).toBeTruthy();
  });

  it("drops attempts out of shape, and errors without an isolation block", () => {
    const parsed = parseIsolation(
      withIsolation({
        result: "pass",
        blocked: 1,
        total: 1,
        checked_at: null,
        attempts: [...ATTEMPTS, { label: 1 }, { label: "x", results: [{ direction: 2 }] }],
      }),
    );
    expect(parsed?.attempts).toHaveLength(2);
    const { update } = renderTab(IsolationTab, { overview: { people: [] } });
    expect(screen.getByRole("alert").textContent).toBe(LOAD_ERROR);
    update({
      overview: withIsolation({ result: "unknown", blocked: 0, total: 0, checked_at: null, attempts: [] }),
      overviewStale: true,
    });
    expect(screen.getByText(STALE)).toBeTruthy();
  });

  it("never renders a field it doesn't show (the marker search)", () => {
    const { container, update } = renderTab(IsolationTab, { overview: fixture() });
    expect(container.innerHTML).not.toContain(MARKER);
    // On a valid attempt too, so a field Core adds to one is proven not to show.
    update({
      overview: withIsolation({
        result: "pass",
        blocked: 2,
        total: 2,
        checked_at: "2026-10-30T06:24:00+00:00",
        attempts: [{ ...ATTEMPTS[0], added_later: MARKER, results: ATTEMPTS[0].results.map((r) => ({ ...r, note: MARKER })) }],
      }),
    });
    expect(screen.getAllByTestId("attempt-row")).toHaveLength(1);
    expect(container.innerHTML).not.toContain(MARKER);
  });

  it("looks each cell up by direction, keeps rows with the same label, and takes the heading from the cells", () => {
    renderTab(IsolationTab, {
      overview: withIsolation({
        result: "pass", // says pass, but a cell got through
        blocked: 3,
        total: 4,
        checked_at: "2026-10-30T06:24:00+00:00",
        attempts: [
          ATTEMPTS[0],
          {
            label: ATTEMPTS[0].label, // the same label twice
            results: [
              { direction: "B to A", result: "fail" }, // the other order
              { direction: "A to B", result: "pass" },
            ],
          },
        ],
      }),
    });
    expect(screen.getByText(/1 of 4 attempts got through/)).toBeTruthy();
    const rows = screen.getAllByTestId("attempt-row");
    expect(rows).toHaveLength(2);
    const cells = within(rows[1]).getAllByRole("cell");
    expect(cells[1].textContent).toBe("✓ Blocked"); // A to B
    expect(cells[2].textContent).toBe("✗ Got through"); // B to A
  });

  it("never reads an attempt that couldn't run as one that got through", () => {
    renderTab(IsolationTab, {
      overview: withIsolation({
        result: "unknown",
        blocked: 3, // Core counts only passes
        total: 4,
        checked_at: "2026-10-30T06:24:00+00:00",
        attempts: [
          ATTEMPTS[0],
          {
            label: "Reach the other's agents",
            results: [
              { direction: "A to B", result: "pass" },
              { direction: "B to A", result: "unknown" },
            ],
          },
        ],
      }),
    });
    const head = screen.getByRole("heading");
    expect(head.textContent).toBe("! Not confirmed: 1 of 4 attempts couldn't run");
    expect(screen.getByText(new RegExp(NOT_CONFIRMED_LINE.replace(/[.']/g, ".")))).toBeTruthy();
    expect(screen.queryByText(/attempts got through/)).toBeNull();
    expect(screen.queryByText("✗ Got through")).toBeNull();
    expect(head.textContent).not.toContain("✗");
    const grey = screen.getByText("Couldn't run");
    expect(getComputedStyle(grey).color).not.toBe(getComputedStyle(screen.getAllByText("✓ Blocked")[0]).color);
    expect(getComputedStyle(head).color).not.toBe(getComputedStyle(grey).color); // amber, not grey
  });

  it("still shows red got through when a fail sits beside cells that couldn't run", () => {
    renderTab(IsolationTab, {
      overview: withIsolation({
        result: "fail",
        blocked: 2,
        total: 4,
        checked_at: "2026-10-30T06:24:00+00:00",
        attempts: [
          ATTEMPTS[0],
          {
            label: "Reach the other's agents",
            results: [
              { direction: "A to B", result: "unknown" },
              { direction: "B to A", result: "fail" },
            ],
          },
        ],
      }),
    });
    expect(screen.getByRole("heading").textContent).toBe("✗ 1 of 4 attempts got through");
    expect(screen.queryByText(/Not confirmed/)).toBeNull();
  });

  it("counts cells missing from a dropped attempt as couldn't run, never as blocked", () => {
    renderTab(IsolationTab, {
      overview: withIsolation({
        result: "pass",
        blocked: 4,
        total: 4, // Core says 4 cells, but one attempt is out of shape and dropped
        checked_at: "2026-10-30T06:24:00+00:00",
        attempts: [ATTEMPTS[0], { label: "bad", results: [{ direction: 5 }] }],
      }),
    });
    expect(screen.getByRole("heading").textContent).toBe("! Not confirmed: 2 of 4 attempts couldn't run");
  });

  it("colours Blocked green and Got through red, with the words kept, at fixed widths", () => {
    renderTab(IsolationTab, {
      overview: withIsolation({
        result: "fail",
        blocked: 3,
        total: 4,
        checked_at: "2026-10-30T06:24:00+00:00",
        attempts: ATTEMPTS,
      }),
    });
    const [blocked] = screen.getAllByText("✓ Blocked");
    const through = screen.getByText("✗ Got through");
    expect(getComputedStyle(blocked).color).not.toBe(getComputedStyle(through).color);
    expect(getComputedStyle(screen.getByRole("columnheader", { name: "A to B" })).width).toBe("160px");
  });
});
