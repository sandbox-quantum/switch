import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER, renderTab } from "../w5shared/testing";
import AlertsTab, {
  CLEARED_EMPTY,
  CLEARED_HEADING,
  LOAD_ERROR,
  NOW_EMPTY,
  NOW_HEADING,
  STALE,
  parseAlerts,
} from "./AlertsTab";

vi.mock("../../../data/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "op-me", name: "Jo Operator" },
    refresh: vi.fn(),
  }),
}));

const OPEN = {
  id: "ev-1",
  severity: "critical",
  title: "Box `k1-c4d812aa0b1c` restarted 3 times in the last hour",
  detail: "Three or more restarts in an hour.",
  raised_at: "2026-10-29T10:51:00+00:00",
  cleared_at: null,
};
const CLEARED = {
  id: "ev-2",
  severity: "warning",
  title: "Box `k1-4f2a91aa0b1c` was pushed off its machine",
  detail: "",
  raised_at: "2026-10-29T09:12:00+00:00",
  cleared_at: "2026-10-29T09:14:00+00:00",
};

describe("the Alerts tab", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reads the shell's overview and makes no request of its own", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderTab(AlertsTab, { overview: { alerts: [] } });
    expect(screen.getByText(NOW_EMPTY)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists open alerts under Now and cleared ones under the 24-hour heading", () => {
    renderTab(AlertsTab, { overview: { alerts: [OPEN, CLEARED] } });
    const now = screen.getByRole("list", { name: NOW_HEADING });
    expect(within(now).getByText("Critical")).toBeTruthy();
    expect(within(now).getByText(/restarted 3 times in the last hour/)).toBeTruthy();
    expect(within(now).getByText(/Three or more restarts/)).toBeTruthy();
    // The id shows in a fixed-width font, without the backticks.
    expect(within(now).getByText("k1-c4d812aa0b1c").tagName).toBe("CODE");
    expect(now.textContent).not.toContain("`");
    const cleared = screen.getByRole("list", { name: CLEARED_HEADING });
    expect(within(cleared).getByText(/pushed off its machine/)).toBeTruthy();
    expect(within(cleared).queryByText("Critical")).toBeNull();
    expect(screen.queryByText(/ops room/)).toBeNull();
  });

  it("says so when nothing is open and nothing was cleared", () => {
    renderTab(AlertsTab, { overview: { alerts: [] } });
    expect(screen.getByText(NOW_EMPTY)).toBeTruthy();
    expect(screen.getByText(CLEARED_EMPTY)).toBeTruthy();
  });

  it("follows the shell's refresh", () => {
    const { update } = renderTab(AlertsTab, { overview: { alerts: [] } });
    expect(screen.getByText(NOW_EMPTY)).toBeTruthy();
    update({ overview: { alerts: [OPEN] }, refreshKey: 1 });
    expect(screen.getByText(/restarted 3 times/)).toBeTruthy();
  });

  it("shows the stale line when the last refresh failed, keeping the last alerts", () => {
    renderTab(AlertsTab, { overview: { alerts: [OPEN] }, overviewStale: true });
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.getByText(/restarted 3 times/)).toBeTruthy();
  });

  it("shows a title as text, never as markup", () => {
    const { container } = renderTab(AlertsTab, {
      overview: {
        alerts: [{ ...OPEN, title: `<img src=x onerror=alert(1)> ${MARKER}` }],
      },
    });
    expect(screen.getByText(new RegExp(MARKER))).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it.each([null, "text", { people: [] }, { alerts: "no" }])(
    "treats an overview with no alerts list (%j) as an error, not as no alerts",
    (overview) => {
      renderTab(AlertsTab, { overview });
      expect(screen.getByText(LOAD_ERROR)).toBeTruthy();
      expect(screen.queryByText(NOW_EMPTY)).toBeNull();
    },
  );
});

describe("parseAlerts", () => {
  it("drops rows not in Core's shape", () => {
    expect(
      parseAlerts({
        alerts: [OPEN, { ...OPEN, id: 7 }, { ...OPEN, severity: "info" }, "x", null],
      })?.map((a) => a.id),
    ).toEqual(["ev-1"]);
  });
});
