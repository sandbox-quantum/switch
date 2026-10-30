import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { GridColDef } from "@mui/x-data-grid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyDetail } from "../../data/api";
import * as hooks from "../../data/hooks";
import RegistrationKeysPage from "./RegistrationKeysPage";

vi.mock("../../data/hooks", () => ({
  useApiKeys: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, deleteApiKey: vi.fn(), revealApiKey: vi.fn() };
});

vi.mock("./CreateKeyDialog", () => ({ default: () => null }));

// The data grid lays rows out from measured sizes, which jsdom does not have,
// so it renders none. This draws each row and its action cell plainly.
vi.mock("../../components/DataTable", () => ({
  default: ({ rows, columns }: { rows: ApiKeyDetail[]; columns: GridColDef<ApiKeyDetail>[] }) => {
    const actions = columns.find((c) => c.field === "actions");
    return (
      <div>
        {rows.map((row) => (
          <div key={row.id} data-testid={`row-${row.id}`}>
            {row.label}
            {actions?.renderCell?.({ row } as never)}
          </div>
        ))}
      </div>
    );
  },
}));

function key(id: string, type: string, label: string): ApiKeyDetail {
  return {
    id,
    type,
    label,
    key_prefix: `${id}-prefix`,
    created_at: "2026-10-01T00:00:00Z",
  } as ApiKeyDetail;
}

describe("RegistrationKeysPage", () => {
  beforeEach(() => {
    vi.mocked(hooks.useApiKeys).mockReturnValue({
      data: [
        key("reg", "registration", "mine"),
        key("old", "retired", "server-connector:oc (retired: its server-side connector is gone)"),
        key("agent", "agent", "notes-taker"),
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof hooks.useApiKeys>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists a retired key on its own, with nothing to copy", () => {
    render(<RegistrationKeysPage />);

    expect(screen.getByText("Retired Keys")).toBeTruthy();
    const retired = screen.getByTestId("row-old");
    expect(within(retired).queryByLabelText("Copy key")).toBeNull();
    expect(within(retired).getAllByRole("button")).toHaveLength(1);

    // Still a way to register agents, so still copyable.
    expect(within(screen.getByTestId("row-reg")).getAllByRole("button")).toHaveLength(2);
  });

  it("says a retired key has nothing depending on it when deleting it", () => {
    render(<RegistrationKeysPage />);

    fireEvent.click(within(screen.getByTestId("row-old")).getByRole("button"));

    expect(screen.getByText(/It no longer authenticates/)).toBeTruthy();
  });

  it("shows no retired section when there is nothing retired", () => {
    vi.mocked(hooks.useApiKeys).mockReturnValue({
      data: [key("reg", "registration", "mine")],
      loading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof hooks.useApiKeys>);

    render(<RegistrationKeysPage />);

    expect(screen.queryByText("Retired Keys")).toBeNull();
  });
});
