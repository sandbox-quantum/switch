import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    expires_at: null,
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

  it("lists retired keys on their own, deletable only where the server allows", async () => {
    serve([
      key("mine", {}),
      key("gone", {
        type: "retired",
        label: "server-connector:gone (retired)",
        can_reveal: false,
      }),
      key("held", {
        type: "retired",
        label: "stranded (retired)",
        can_reveal: false,
        can_delete: false,
      }),
    ]);
    render(<RegistrationKeysPage />);

    expect(await screen.findByText("Retired keys")).toBeTruthy();
    const gone = within(screen.getByTestId("row-gone"));
    expect(gone.getAllByRole("button")).toHaveLength(1);
    expect(gone.getByRole("button", { name: "Delete server-connector:gone (retired)" })).toBeTruthy();
    const held = within(screen.getByTestId("row-held"));
    expect(held.queryAllByRole("button")).toHaveLength(0);
    expect(held.getByText("Delete its agent first")).toBeTruthy();

    fireEvent.click(gone.getByRole("button"));
    expect(screen.getByText(/It no longer authenticates/)).toBeTruthy();
  });

  it("shows no retired section when nothing is retired", async () => {
    serve([key("mine", {})]);
    render(<RegistrationKeysPage />);

    await screen.findByTestId("row-mine");
    expect(screen.queryByText("Retired keys")).toBeNull();
  });
});
