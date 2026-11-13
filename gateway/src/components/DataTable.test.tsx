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
    expect(screen.getByRole("button", { name: "Remove Status: Active filter" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(quick.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("3 agents")).toBeTruthy();
  });

  it("removes a picked filter from its chip with Enter, as a button", () => {
    render(table());
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    const chip = screen.getByRole("button", { name: "Remove Status: Active filter" });
    fireEvent.click(chip);

    expect(screen.queryByRole("button", { name: "Remove Status: Active filter" })).toBeNull();
    expect(screen.getByText("3 agents")).toBeTruthy();
  });

  it("shows no toolbar for a table that asks for none", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.queryByText("3 agents")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps a fixed-height table out of a flex column, where the grid would ignore its height", () => {
    const { container } = render(table({ height: 320, pageSize: 2 }));
    const grid = container.querySelector(".MuiDataGrid-root") as HTMLElement;

    expect(getComputedStyle(grid).height).toBe("320px");
    expect(getComputedStyle(grid.parentElement!).display).not.toBe("flex");
    // The height is the content's, as pages size a table to its rows; the
    // border goes outside it.
    expect(getComputedStyle(grid).boxSizing).toBe("content-box");
  });

  it("gives the header an opaque fill, so rows scrolling under it are hidden", () => {
    const { container } = render(table());
    const header = getComputedStyle(container.querySelector(".MuiDataGrid-columnHeaders") as HTMLElement);

    expect(header.backgroundColor).toBe("var(--sw-card)");
    expect(header.backgroundImage).toContain("var(--table-band)");
  });

  it("is no taller than its rows while they fit on one page", () => {
    const heightOf = (props: Partial<Parameters<typeof DataTable<Row>>[0]>) => {
      const { container, unmount } = render(<DataTable rows={rows} columns={columns} {...props} />);
      const height = getComputedStyle(container.querySelector(".MuiDataGrid-root") as HTMLElement).height;
      unmount();
      return height;
    };

    expect(heightOf({ height: 600 })).toBe(`${56 + 3 * 52}px`);
    expect(heightOf({ height: 600, pageSize: 2 })).toBe("600px");
  });

  it("keeps its height and footer when its rows fit the page but not the height", () => {
    const { container } = render(<DataTable rows={rows} columns={columns} height={150} />);
    const grid = container.querySelector(".MuiDataGrid-root") as HTMLElement;

    expect(getComputedStyle(grid).height).toBe("150px");
    expect(container.querySelector(".MuiDataGrid-footerContainer")).not.toBeNull();
  });

  it("has no footer while its rows fit on one page, since there is nothing to page through", () => {
    const footer = (props: Partial<Parameters<typeof DataTable<Row>>[0]>) => {
      const { container, unmount } = render(<DataTable rows={rows} columns={columns} {...props} />);
      const found = container.querySelector(".MuiDataGrid-footerContainer") !== null;
      unmount();
      return found;
    };

    expect(footer({ rows: [] })).toBe(false);
    expect(footer({})).toBe(false);
    expect(footer({ pageSize: 2 })).toBe(true);
  });

  it("gives a table sized to its rows room to say it has none", () => {
    const heightOf = (props: Partial<Parameters<typeof DataTable<Row>>[0]>) => {
      const { container, unmount } = render(<DataTable rows={rows} columns={columns} {...props} />);
      const height = getComputedStyle(container.querySelector(".MuiDataGrid-root") as HTMLElement).height;
      unmount();
      return height;
    };

    expect(heightOf({ rows: [], height: 108 })).toBe("160px");
    expect(heightOf({ rows: [], height: 320 })).toBe("320px");
  });

  it("filters a column from its header menu", async () => {
    render(table());
    fireEvent.click(screen.getByRole("button", { name: /Status column menu/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Filter" }));
    const picker = await screen.findByRole("dialog", { name: "Filter by Status" });
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Idle" }));

    expect(screen.getByText("1 of 3 agents")).toBeTruthy();
    // The open picker hides the page behind it from the accessibility tree.
    expect(screen.getByRole("button", { name: "Remove Status: Idle filter", hidden: true })).toBeTruthy();
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

  it("filters from a dropdown above the toolbar, with the same chip the header menu gives", async () => {
    render(table({ quickFilters: [], selectFilters: [{ field: "status", label: "State", allLabel: "All states" }] }));
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "State" }));
    fireEvent.click(await screen.findByRole("option", { name: "Idle" }));

    expect(screen.getByText("1 of 3 agents")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "State" }).textContent).toBe("Idle");
    fireEvent.click(screen.getByRole("button", { name: "Remove Status: Idle filter" }));
    expect(screen.getByRole("combobox", { name: "State" }).textContent).toBe("All states");
    expect(screen.getByText("3 agents")).toBeTruthy();
  });

  it("says how many are picked when the header menu picked several", async () => {
    render(table({ quickFilters: [], selectFilters: [{ field: "status", label: "State", allLabel: "All states" }] }));
    fireEvent.click(screen.getByRole("button", { name: /Status column menu/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Filter" }));
    const picker = await screen.findByRole("dialog", { name: "Filter by Status" });
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Idle" }));
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Active" }));

    expect(screen.getByRole("combobox", { name: "State", hidden: true }).textContent).toBe("2 selected");
  });

  it("drops a pick no row holds any more, rather than leave it over an empty table", async () => {
    const { rerender } = render(table({ quickFilters: [], selectFilters: [{ field: "status", label: "State", allLabel: "All states" }] }));
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "State" }));
    fireEvent.click(await screen.findByRole("option", { name: "Idle" }));
    expect(screen.getByText("1 of 3 agents")).toBeTruthy();

    rerender(
      table({
        rows: rows.filter((row) => row.status !== "Idle"),
        quickFilters: [],
        selectFilters: [{ field: "status", label: "State", allLabel: "All states" }],
      }),
    );

    expect(screen.getByText("2 agents")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Status: Idle filter" })).toBeNull();
  });

  it("filters on an empty value from a dropdown, which reading as nothing picked would lose", async () => {
    const unnamed = [...rows, { id: 4, name: "orphan", status: "" }];
    const statusColumn: TableColumn<Row> = {
      field: "status",
      headerName: "Status",
      width: 120,
      filter: {
        value: (row) => row.status,
        options: [
          { value: "Active", label: "Active" },
          { value: "", label: "No status" },
        ],
      },
    };
    render(
      table({
        rows: unnamed,
        columns: [columns[0], statusColumn, columns[2]],
        quickFilters: [],
        selectFilters: [{ field: "status", label: "State", allLabel: "All states" }],
      }),
    );
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "State" }));
    fireEvent.click(await screen.findByRole("option", { name: "No status" }));

    expect(screen.getByText("1 of 4 agents")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "State" }).textContent).toBe("No status");
  });

  it("opens sorted as asked", () => {
    const { container } = render(table({ initialSort: { field: "name", sort: "desc" } }));
    const header = container.querySelector('.MuiDataGrid-columnHeader[data-field="name"]') as HTMLElement;
    expect(header.getAttribute("aria-sort")).toBe("descending");
  });

  it("refuses a select filter on a column without a filter", () => {
    expect(() => render(table({ selectFilters: [{ field: "name", label: "Name", allLabel: "All names" }] }))).toThrow(
      /has no filter/,
    );
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
