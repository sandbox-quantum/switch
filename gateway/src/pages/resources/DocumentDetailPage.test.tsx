import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import DocumentDetailPage from "./DocumentDetailPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const doc: DocumentDetail = {
  id: "d1",
  owner_id: "u2",
  owner_name: "Bob",
  read_visibility: "public",
  write_visibility: "public",
  name: "Runbook",
  description: "How we deploy",
  instructions: "",
  attached_rooms_count: 0,
  hidden_rooms_count: 0,
  packages: [],
  scope: "global",
  room_id: null,
  created_by_agent_id: null,
  created_by_agent_name: null,
  created_at: "2026-10-01T00:00:00Z",
  content: "Step one",
  can_edit: false,
  can_manage: false,
  can_transfer: false,
};

type Flags = Pick<DocumentDetail, "can_edit" | "can_manage" | "can_transfer">;

/** The page for a document the server describes with `flags`; every other
 * read answers empty, and each write is recorded. */
function showWith(flags: Flags) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1" },
    session: null,
  } as unknown as ReturnType<typeof useAuth>);
  const writes: { method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0];
      const method = init?.method ?? "GET";
      if (path === "/gateway/documents/d1" && method === "GET") {
        return new Response(JSON.stringify({ ...doc, ...flags }), { status: 200 });
      }
      if (path === "/gateway/documents/d1") {
        writes.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ ...doc, ...flags }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
  render(
    <MemoryRouter initialEntries={["/resources/documents/d1"]}>
      <Routes>
        <Route path="/resources/documents/:id" element={<DocumentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return writes;
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  return screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DocumentDetailPage", () => {
  it("is read-only to someone the server lets do nothing", async () => {
    showWith({ can_edit: false, can_manage: false, can_transfer: false });
    await screen.findByDisplayValue("Runbook");
    expect(field("Name").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete document" })).toBeNull();
  });

  it("lets someone who may write it edit it, but not who may see it, hand it over or delete it", async () => {
    showWith({ can_edit: true, can_manage: false, can_transfer: false });
    await screen.findByDisplayValue("Runbook");
    expect(field("Name").disabled).toBe(false);
    expect(screen.getByLabelText("Access").getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText(
        "Anyone can see, attach and change it. Only its owner and admins can change who may.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete document" })).toBeNull();
  });

  it("does not send who may see it when that was not changed", async () => {
    const writes = showWith({ can_edit: true, can_manage: false, can_transfer: false });
    fireEvent.change(await screen.findByDisplayValue("Runbook"), {
      target: { value: "Deploy runbook" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({
      name: "Deploy runbook",
      description: "How we deploy",
      instructions: "",
      content: "Step one",
    });
  });

  it("offers delete, but not a hand-over, for a document the server will not move", async () => {
    showWith({ can_edit: true, can_manage: true, can_transfer: false });
    await screen.findByDisplayValue("Runbook");
    expect(screen.getByRole("button", { name: "Delete document" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
  });

  it("offers everything to someone who may manage it", async () => {
    showWith({ can_edit: true, can_manage: true, can_transfer: true });
    await screen.findByDisplayValue("Runbook");
    expect(screen.getByLabelText("Access").getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete document" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Transfer ownership" })).toBeTruthy();
  });
});
