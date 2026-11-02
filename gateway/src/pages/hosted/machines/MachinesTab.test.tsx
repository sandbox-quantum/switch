import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOAD_ERROR, STALE } from "../overview/overview";
import { fixture } from "../overview/testing";
import { MARKER, renderTab } from "../w5shared/testing";
import MachinesTab, { EMPTY, FOOTNOTE, HIGH } from "./MachinesTab";

vi.mock("../../../data/AuthContext", () => ({
  useAuth: () => ({ user: { id: "op-me", name: "Jo Operator" }, refresh: vi.fn() }),
}));

function rowOf(name: string) {
  const row = screen.getAllByTestId("machine-row").find((r) => r.textContent?.startsWith(name));
  if (!row) throw new Error(`no row ${name}`);
  return within(row);
}

describe("the Machines tab (W4, p12)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each machine with its zone, memory bars, boxes and safety check", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderTab(MachinesTab, { overview: fixture() });
    expect(screen.getAllByTestId("machine-row")).toHaveLength(5);
    const one = rowOf("shared-1");
    const zone = one.getByText("eu-west-3a");
    expect(getComputedStyle(zone).textTransform).not.toBe("uppercase"); // lower case, as on Boxes
    expect(one.getByText("Used 62%")).toBeTruthy();
    expect(one.getByText("Booked 84%")).toBeTruthy();
    expect(one.getByText("12 of 12")).toBeTruthy();
    expect(one.getByText("Open")).toBeTruthy();
    expect(rowOf("shared-2").getByText("9 of 12")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks used memory above 85% in red, with p12's words", () => {
    renderTab(MachinesTab, { overview: fixture() });
    const hot = rowOf("shared-3");
    expect(hot.getByText(`Used 87% · ${HIGH}`)).toBeTruthy();
    const bar = hot.getByRole("progressbar", { name: `Used 87% · ${HIGH}` });
    expect(bar.className).toContain("Error");
    expect(rowOf("shared-1").getByRole("progressbar", { name: "Used 62%" }).className).not.toContain(
      "Error",
    );
  });

  it("never lets the figure contradict the warning just over 85%", () => {
    const raw = fixture();
    const machines = (raw.nodes as { machines: Record<string, unknown>[] }).machines;
    machines[0].memory_used_pct = 85.4;
    machines[1].memory_used_pct = 85;
    machines[2].memory_used_pct = 85.04;
    renderTab(MachinesTab, { overview: raw });
    expect(rowOf("shared-1").getByText(`Used 85.4% · ${HIGH}`)).toBeTruthy();
    expect(rowOf("shared-2").getByText("Used 85%")).toBeTruthy();
    expect(rowOf("shared-3").getByText(`Used 85.1% · ${HIGH}`)).toBeTruthy(); // rounded up, never 85.0
  });

  it("shows a held machine's minutes, a failed check, and dashes for missing figures", () => {
    renderTab(MachinesTab, { overview: fixture() });
    expect(rowOf("shared-4").getByText("Safety check · 3 min")).toBeTruthy();
    const failed = rowOf("shared-5");
    expect(failed.getByText("Safety check failed")).toBeTruthy();
    expect(failed.getByText("Used —")).toBeTruthy();
    expect(failed.getByText("Booked —")).toBeTruthy();
    expect(failed.getByText("0")).toBeTruthy(); // no room figure: the count alone
  });

  it("keeps p12's footnote, with the shared services from the answer", () => {
    renderTab(MachinesTab, { overview: fixture() });
    const note = screen.getByTestId("machines-footnote");
    expect(note.textContent).toBe(`${FOOTNOTE} Shared services: egress proxy 2 of 2 ready.`);
    expect(within(note).getByText("Used").tagName).toBe("B");
    expect(within(note).getByText("Booked").tagName).toBe("B");
  });

  it("shows the stale line for a failed refresh or a stale cluster report", () => {
    const raw = fixture();
    (raw.nodes as Record<string, unknown>).report_stale = true;
    renderTab(MachinesTab, { overview: raw });
    expect(screen.getByText(STALE)).toBeTruthy();
  });

  it("says when there are no machines, and errors on a broken answer", () => {
    const raw = fixture();
    (raw.nodes as Record<string, unknown>).machines = [];
    const { update } = renderTab(MachinesTab, { overview: raw });
    expect(screen.getByText(EMPTY)).toBeTruthy();
    update({ overview: { nodes: {} } });
    expect(screen.getByRole("alert").textContent).toBe(LOAD_ERROR);
  });

  it("never renders a field W4 doesn't show (the marker search)", () => {
    const { container } = renderTab(MachinesTab, { overview: fixture() });
    expect(container.innerHTML).not.toContain(MARKER);
  });
});
