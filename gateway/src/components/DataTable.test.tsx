import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataTable from "./DataTable";

const seen: Record<string, unknown>[] = [];

vi.mock("@mui/x-data-grid", () => ({
  DataGrid: (props: Record<string, unknown>) => {
    seen.push(props);
    return null;
  },
}));

describe("the shared data table under Switch web's CSP", () => {
  afterEach(() => {
    cleanup();
    seen.length = 0;
  });

  it("never lets the grid compile filters with eval", () => {
    render(<DataTable rows={[{ id: 1 }]} columns={[{ field: "id" }]} />);
    expect(seen.at(-1)?.disableEval).toBe(true);
  });
});
