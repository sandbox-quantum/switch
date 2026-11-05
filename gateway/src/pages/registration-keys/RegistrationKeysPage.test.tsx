import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyDetail } from "../../data/api";
import RegistrationKeysPage from "./RegistrationKeysPage";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

function key(id: string, overrides: Partial<ApiKeyDetail>): ApiKeyDetail {
  return {
    id,
    label: id,
    type: "registration",
    key_prefix: `sk_${id}`,
    created_at: "2026-10-01T00:00:00Z",
    can_reveal: true,
    can_delete: true,
    ...overrides,
  };
}

function serve(keys: ApiKeyDetail[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(keys), { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RegistrationKeysPage", () => {
  it("offers copy and delete only where the server says each may be done", async () => {
    serve([
      key("mine", {}),
      key("bootstrap", { type: "bootstrap", can_reveal: true, can_delete: false }),
      key("agent", { type: "agent", label: "helper", can_reveal: true, can_delete: false }),
      key("hidden", { type: "agent", label: "theirs", can_reveal: false, can_delete: false }),
    ]);
    render(<RegistrationKeysPage />);

    const mine = within(await screen.findByTestId("row-mine"));
    expect(mine.getByRole("button", { name: "Delete mine" })).toBeTruthy();
    expect(mine.getAllByRole("button")).toHaveLength(2);

    const bootstrap = within(screen.getByTestId("row-bootstrap"));
    expect(bootstrap.queryByRole("button", { name: "Delete bootstrap" })).toBeNull();
    expect(bootstrap.getAllByRole("button")).toHaveLength(1);

    expect(within(screen.getByTestId("row-agent")).getAllByRole("button")).toHaveLength(1);
    expect(within(screen.getByTestId("row-hidden")).queryAllByRole("button")).toHaveLength(0);
  });
});
