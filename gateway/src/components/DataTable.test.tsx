import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DataTable, { type TableColumn } from "./DataTable";

type Row = { id: number; name: string; status: string };

const rows: Row[] = [
  { id: 1, name: "release-bot", status: "Active" },
  { id: 2, name: "triage-helper", status: "Idle" },
  { id: 3, name: "nightly-report", status: "Active" },
];

const columns: TableColumn<Row>[] = [
  { field: "name", headerName: "Name", flex: 1 },
  { field: "status", headerName: "Status", width: 120, filter: { value: (row) => row.status } },
  { field: "actions", headerName: "", width: 64 },
];

const table = (extra: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) => (
  <DataTable
    rows={rows}
    columns={columns}
    noun={{ one: "agent", other: "agents" }}
    search={{ label: "Search agents", text: (row) => row.name }}
    quickFilters={[{ field: "status", value: "Active", label: "Active" }]}
    {...extra}
  />
);

describe("DataTable toolbar", () => {
  afterEach(() => cleanup());

  it("counts the rows with the table's noun", () => {
    render(table());
    expect(screen.getByText("3 agents")).toBeTruthy();
  });

  it("counts what is left while a search narrows the table", () => {
    render(table());
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "bot" } });
    expect(screen.getByText("1 of 3 agents")).toBeTruthy();
  });

  it("shows a pressed quick filter as a removable chip, and clears it", () => {
    render(table());
    const quick = screen.getByRole("button", { name: "Active" });
    fireEvent.click(quick);

    expect(quick.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("2 of 3 agents")).toBeTruthy();
    expect(screen.getByText("Status: Active")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(quick.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("3 agents")).toBeTruthy();
  });

  it("shows no toolbar for a table that asks for none", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.queryByText("3 agents")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps a fixed-height table out of a flex column, where the grid would ignore its height", () => {
    const { container } = render(table({ height: 320 }));
    const grid = container.querySelector(".MuiDataGrid-root") as HTMLElement;

    expect(getComputedStyle(grid).height).toBe("320px");
    expect(getComputedStyle(grid.parentElement!).display).not.toBe("flex");
  });

  it("filters a column from its header menu", async () => {
    render(table());
    fireEvent.click(screen.getByRole("button", { name: /Status column menu/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Filter" }));
    const picker = await screen.findByRole("dialog", { name: "Filter by Status" });
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Idle" }));

    expect(screen.getByText("1 of 3 agents")).toBeTruthy();
    expect(screen.getByText("Status: Idle")).toBeTruthy();
  });

  it("goes back to the first page when the rows are narrowed", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: i < 11 ? `bot-${i + 1}` : `helper-${i + 1}`,
      status: "Active",
    }));
    render(table({ rows: many, pageSize: 10 }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /next page/i })));
    expect(screen.getByText("11–20 of 30")).toBeTruthy();

    await act(async () => fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "bot" } }));
    expect(screen.getByText("1–10 of 11")).toBeTruthy();
  });

  it("refuses a quick filter on a column without a filter", () => {
    expect(() =>
      render(table({ quickFilters: [{ field: "name", value: "release-bot", label: "Release bot" }] })),
    ).toThrow(/has no filter/);
  });

  it("refuses to pin a column without a fixed width", () => {
    expect(() => render(table({ pinnedRight: ["name"] }))).toThrow(/needs a fixed width/);
  });
});
