import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyDetail } from "../../data/api";
import { apiKey } from "../api-keys/testFixtures";
import RegistrationKeysPage from "./RegistrationKeysPage";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const key = apiKey;

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
      key("bootstrap", { type: "bootstrap" }),
      key("active", { type: "agent", label: "helper", can_delete: false }),
      key("leftover", { type: "agent", label: "deleted-helper" }),
      key("hidden", { type: "agent", label: "theirs", can_reveal: false, can_delete: false }),
    ]);
    render(<RegistrationKeysPage />);

    const mine = within(await screen.findByTestId("row-mine"));
    expect(mine.getByRole("button", { name: "Delete mine" })).toBeTruthy();
    expect(mine.getAllByRole("button")).toHaveLength(2);
    expect(within(screen.getByTestId("row-bootstrap")).getAllByRole("button")).toHaveLength(2);

    const active = within(screen.getByTestId("row-active"));
    expect(active.queryByRole("button", { name: "Delete helper" })).toBeNull();
    expect(active.getAllByRole("button")).toHaveLength(1);

    const leftover = within(screen.getByTestId("row-leftover"));
    expect(leftover.getByRole("button", { name: "Delete deleted-helper" })).toBeTruthy();

    expect(within(screen.getByTestId("row-hidden")).queryAllByRole("button")).toHaveLength(0);
  });

  it("says why a delete was refused, and keeps the dialog open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE"
          ? new Response(JSON.stringify({ detail: "Not authorized to delete this key" }), { status: 403 })
          : new Response(JSON.stringify([key("mine", {})]), { status: 200 }),
      ),
    );
    render(<RegistrationKeysPage />);

    fireEvent.click(within(await screen.findByTestId("row-mine")).getByRole("button", { name: "Delete mine" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByText("Not authorized to delete this key")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
