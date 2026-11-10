import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemplateDetail } from "../../data/api";
import TemplateDetailPage from "./TemplateDetailPage";

const OWNED: TemplateDetail = {
  id: "t-1",
  owner_id: "u-2",
  owner_name: "Bob",
  official: false,
  name: "Standup",
  description: "A daily standup room",
  kind: "room",
  read_visibility: "public",
  write_visibility: "private",
  can_edit: false,
  can_manage: false,
  run_blocked_reason: null,
  run_count: 4,
  version: 1,
  size_bytes: 10,
  created_at: "2026-11-01 09:00:00+00:00",
  updated_at: "2026-11-01 09:00:00+00:00",
  content: "room:\n  name: standup\n",
};

const EXPERT: TemplateDetail = {
  ...OWNED,
  id: "official:switch-expert",
  owner_id: null,
  owner_name: "Switch",
  official: true,
  name: "Switch expert",
  kind: "agent",
  created_at: "",
  updated_at: "",
};

/** The template page for `template`, reached at `path`; each delete is recorded. */
function showWith(template: TemplateDetail) {
  const deleted: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = decodeURIComponent(String(input));
      if (path === `/gateway/templates/${template.id}` && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify(template), { status: 200 });
      }
      if (path === `/gateway/templates/${template.id}` && init?.method === "DELETE") {
        deleted.push(template.id);
        return new Response(JSON.stringify({ deleted_id: template.id }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, blocked: false, errors: [], warnings: [] }), {
        status: 200,
      });
    }),
  );
  render(
    <MemoryRouter initialEntries={[`/templates/${encodeURIComponent(template.id)}`]}>
      <Routes>
        <Route path="/templates/:id" element={<TemplateDetailPage />} />
        <Route path="/templates" element={<p>Templates page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return deleted;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TemplateDetailPage", () => {
  it("says an official template is changed by nobody, and offers no access setting or delete", async () => {
    showWith(EXPERT);
    expect(
      await screen.findByText(
        "Maintained by Switch, so nobody can change it. Copy or download it to make your own version.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Access")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete template" })).toBeNull();
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("names the owner of someone else's template, and who else may change it", async () => {
    showWith(OWNED);
    expect(
      await screen.findByText(
        "This template belongs to Bob. You can copy or download it; only they or a workspace admin can change it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete template" })).toBeNull();
  });

  it("says a template whose owner has left is an admin's to change", async () => {
    showWith({ ...OWNED, owner_name: null });
    expect(
      await screen.findByText(
        "This template belongs to a former member. You can copy or download it; only a workspace admin can change it.",
      ),
    ).toBeTruthy();
  });

  it("deletes after confirming, and goes back to the Templates page", async () => {
    const deleted = showWith({ ...OWNED, can_edit: true, can_manage: true });
    fireEvent.click(await screen.findByRole("button", { name: "Delete template" }));
    expect(
      screen.getByText(
        "Delete “Standup”? Agents and rooms already made from it keep working. This can’t be undone.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleted).toEqual(["t-1"]));
    expect(await screen.findByText("Templates page")).toBeTruthy();
  });
});
