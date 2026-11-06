import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedContext, type HostedState } from "../HostedContext";
import { MARKER, VIEWER, answer } from "../w5shared/testing";
import BoxDetailPage from "./BoxDetailPage";
import MachineDetailPage from "./MachineDetailPage";
import { readDetail } from "./readDetail";

// The chart draws from measured sizes jsdom doesn't have; a plain stand-in
// records what it was given and passes clicks through, as the real one does.
vi.mock("@mui/x-charts/PieChart", () => ({
  PieChart: ({
    series,
    onItemClick,
  }: {
    series: { data: { id: string; value: number; label: string }[] }[];
    onItemClick?: (event: unknown, item: { dataIndex: number }) => void;
  }) => (
    <div data-testid="pie">
      {series[0].data.map((d, i) => (
        <button key={d.id} type="button" onClick={() => onItemClick?.({}, { dataIndex: i })}>
          {`slice ${d.label} ${d.value}`}
        </button>
      ))}
    </div>
  ),
}));

const GB = 1024 ** 3;
const BOX_1 = "k1-6d2c0a1b2c3d4e5f";
const BOX_2 = "k1-7e3d0a1b2c3d4e5f";
const MACHINE = "k1-aa110a1b2c3d4e5f";

const overview = {
  people: [
    { user_id: "k1-u1", agents: { working: 1, idle: 2, resting: 0, unavailable: 0 }, paused: false },
    { user_id: "k1-u2", agents: { working: 0, idle: 0, resting: 4, unavailable: 1 }, paused: false },
  ],
  boxes: [
    {
      box: BOX_1,
      user: "k1-u1",
      workspaces: ["k1-ws-1"],
      state: "running",
      node: "node-a",
      memory_used_bytes: 1 * GB,
      memory_total_bytes: 4 * GB,
      restarts_today: 2,
      awake: { running: 10, max: 12 },
      active_at: "2026-11-06T09:00:00+00:00",
      heartbeat_at: "2026-11-06T09:01:00+00:00",
      running_observed_at: "2026-11-06T08:00:00+00:00",
      disk: { total_bytes: 15 * GB, available_bytes: 10 * GB, scope: "workspace" },
    },
    {
      box: BOX_2,
      user: "k1-u2",
      workspaces: [],
      state: "resting",
      node: "node-a",
      memory_used_bytes: null,
      memory_total_bytes: null,
      restarts_today: null,
      awake: null,
      active_at: null,
      heartbeat_at: null,
      running_observed_at: "2026-11-06T08:00:00+00:00",
    },
  ],
  nodes: {
    machines: [
      {
        name: "node-a",
        machine: MACHINE,
        zone: "zone-a",
        memory_used_pct: 90,
        memory_booked_pct: 60,
      },
    ],
    report_at: "2026-11-06T09:00:00+00:00",
    report_stale: false,
  },
};

function renderAt(path: string, state: Partial<HostedState> = {}) {
  const value: HostedState = {
    operator: VIEWER,
    overview,
    overviewStale: false,
    refreshKey: 0,
    refresh: async () => undefined,
    ...state,
  };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HostedContext.Provider value={value}>
        <Routes>
          <Route path="/hosted/machines/:machineId" element={<MachineDetailPage />} />
          <Route path="/hosted/boxes/:boxId" element={<BoxDetailPage />} />
        </Routes>
      </HostedContext.Provider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the machine page", () => {
  it("shows its boxes and agents by state, memory, and asks the audit log for this machine", async () => {
    const fetch = answer(200, []);
    renderAt(`/hosted/machines/${MACHINE}`);
    expect(screen.getByRole("heading", { name: "node-a" })).toBeTruthy();
    const boxes = screen.getByRole("list", { name: "Boxes by state" });
    expect(within(boxes).getByText("Awake: 1")).toBeTruthy();
    expect(within(boxes).getByText("Resting: 1")).toBeTruthy();
    const agents = screen.getByRole("list", { name: "Agents by state" });
    expect(within(agents).getByText("Resting: 4")).toBeTruthy();
    expect(within(agents).getByText("Working: 1")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Memory used: 90%" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Memory booked: 60%" })).toBeTruthy();
    expect(screen.queryByText(/CPU|Disk/)).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const url = new URL(fetch.mock.calls[0][0], "http://x");
    expect(url.pathname).toBe("/gateway/shared-cloud/audit-events");
    expect(url.searchParams.get("target_id")).toBe(MACHINE);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(await screen.findByText("Nothing recorded yet.")).toBeTruthy();
  });

  it("filters its box list by a clicked slice, and clears it with a second click", () => {
    answer(200, []);
    renderAt(`/hosted/machines/${MACHINE}`);
    const table = () => screen.getByRole("table", { name: "Boxes on this machine" });
    expect(within(table()).getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "slice Resting 1" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(2);
    expect(within(table()).getByText("Resting")).toBeTruthy();
    // The same filter from the list beside the chart, by keyboard-reachable button.
    fireEvent.click(screen.getByRole("button", { name: "Resting: 1", pressed: true }));
    expect(within(table()).getAllByRole("row")).toHaveLength(3);
  });

  it("says when the machine isn't in the report, rather than showing an empty page", () => {
    answer(200, []);
    renderAt("/hosted/machines/k1-nope");
    expect(screen.getByText(/isn't in the latest report/)).toBeTruthy();
  });

  it("shows each box by its short id with a copy button, and links it to its own page", () => {
    answer(200, []);
    renderAt(`/hosted/machines/${MACHINE}`);
    const link = screen.getByRole("link", { name: `Open box ${BOX_1}` });
    expect(link.getAttribute("href")).toBe(`/hosted/boxes/${BOX_1}`);
    const table = screen.getByRole("table", { name: "Boxes on this machine" });
    expect(within(table).getByText("k1-6d2c…4e5f")).toBeTruthy();
    expect(within(table).getAllByRole("button", { name: "Copy box id" })).toHaveLength(2);
  });
});

describe("the box page", () => {
  it("shows its state, times, capacity and agents, with disk only as the workspace disk", async () => {
    answer(200, []);
    renderAt(`/hosted/boxes/${BOX_1}`);
    expect(screen.getByText("Awake")).toBeTruthy();
    expect(screen.getByRole("link", { name: "node-a" }).getAttribute("href")).toBe(
      `/hosted/machines/${MACHINE}`,
    );
    expect(screen.getByText("Last active")).toBeTruthy();
    expect(screen.getByText("Running since")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Agents awake: 10 of 12" })).toBeTruthy();
    expect(screen.getByText("Nearly full. Stop agents you're not using to free places.")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Memory: 1.0 GB of 4.0 GB" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Disk: 5.0 GB of 15.0 GB" })).toBeTruthy();
    const agents = screen.getByRole("list", { name: "Agents by state" });
    expect(within(agents).getByText("Idle: 2")).toBeTruthy();
    await screen.findByText("Nothing recorded yet.");
  });

  it("says Not available for what the box hasn't reported, and no Running since while resting", async () => {
    answer(200, []);
    renderAt(`/hosted/boxes/${BOX_2}`);
    expect(screen.getAllByText("Not available").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Running since")).toBeNull();
    expect(screen.getByText("Disk: not available")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await screen.findByText("Nothing recorded yet.");
  });

  it("words the audit timeline as the Audit log does, and shows nothing it can't read", async () => {
    answer(200, [
      {
        id: "e1",
        occurred_at: "2026-11-06T09:00:00+00:00",
        actor_user_id: "op-me",
        actor_name: "Jo Operator",
        action: "hosted.box_restarted",
        target_id: BOX_1,
        details: { reason: MARKER },
      },
      { nonsense: true },
    ]);
    renderAt(`/hosted/boxes/${BOX_1}`);
    const list = await screen.findByRole("list", { name: "Recent activity" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps the last activity it read when a refresh fails", async () => {
    const fetch = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const view = renderAt(`/hosted/boxes/${BOX_1}`);
    await screen.findByText("Nothing recorded yet.");
    fetch.mockImplementation(async () => new Response("{}", { status: 500 }));
    view.rerender(
      <MemoryRouter initialEntries={[`/hosted/boxes/${BOX_1}`]}>
        <HostedContext.Provider
          value={{ operator: VIEWER, overview, overviewStale: false, refreshKey: 1, refresh: async () => undefined }}
        >
          <Routes>
            <Route path="/hosted/boxes/:boxId" element={<BoxDetailPage />} />
          </Routes>
        </HostedContext.Provider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Nothing recorded yet.")).toBeTruthy();
  });

  it("says when the box isn't in the overview", () => {
    answer(200, []);
    renderAt("/hosted/boxes/k1-gone");
    expect(screen.getByText(/isn't in the overview any more/)).toBeTruthy();
  });
});

describe("reading the overview for the detail pages", () => {
  it("drops rows out of shape, and reads a figure out of shape as missing", () => {
    const read = readDetail({
      ...overview,
      boxes: [
        { ...overview.boxes[0], awake: { running: 1, max: 0 }, active_at: "not a time", disk: { scope: "system", total_bytes: 1, available_bytes: 1 } },
        { box: 7 },
      ],
      nodes: { ...overview.nodes, machines: [{ name: "node-a", zone: "z" }] },
    })!;
    expect(read.boxes).toHaveLength(1);
    expect(read.boxes[0]).toMatchObject({ awake: null, activeAt: null });
    expect(read.boxes[0].disk).toEqual({ total_bytes: 1, available_bytes: 1 });
    // A machine without its keyed id can't have a page.
    expect(read.machines).toEqual([]);
  });

  it("isn't an overview without its boxes and nodes", () => {
    expect(readDetail(null)).toBeNull();
    expect(readDetail({ boxes: [] })).toBeNull();
  });
});
