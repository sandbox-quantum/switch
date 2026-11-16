import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import TemplateDetailPage, { NOT_AVAILABLE } from "./TemplateDetailPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const OWNED: TemplateDetail = {
  id: "t-1",
  owner_id: "u-2",
  owner_name: "Bob",
  official: false,
  name: "Standup",
  description: "A daily standup room",
  kind: "room",
  use_case: "engineering",
  agent_count: 0,
  room_count: 1,
  read_visibility: "public",
  write_visibility: "private",
  can_edit: false,
  can_manage: false,
  run_blocked_reason: null,
  run_count: 4,
  last_run_at: null,
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
  use_case: "support",
  agent_count: 1,
  created_at: "",
  updated_at: "",
};

type Answer = { status: number; body: unknown };

/** The template page for `template`, over a server answering it and
 * `routes` (each `METHOD /path`); every request is recorded. */
function showWith(template: TemplateDetail | { id: string; answer: Answer }, routes: Record<string, Answer> = {}) {
  const calls: { key: string; body: unknown }[] = [];
  const found: Answer = "answer" in template ? template.answer : { status: 200, body: template };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = decodeURIComponent(String(input)).replace(/^\/gateway/, "").split("?")[0];
      const key = `${init?.method ?? "GET"} ${path}`;
      calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const answer =
        routes[key] ??
        (key === `GET /templates/${template.id}`
          ? found
          : key === `DELETE /templates/${template.id}`
            ? { status: 200, body: { deleted_id: template.id } }
            : { status: 200, body: { ok: true, blocked: false, errors: [], warnings: [] } });
      const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      return new Response(body, { status: answer.status });
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
  return calls;
}

const originalLocation = window.location;
const assign = vi.fn();

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u-1" },
    session: { tenant: { id: "ten-1", name: "Acme" } },
  } as unknown as ReturnType<typeof useAuth>);
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, assign },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  assign.mockClear();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: originalLocation });
});

describe("TemplateDetailPage", () => {
  it("says an official template is changed by nobody, and offers no access setting, save or delete", async () => {
    showWith(EXPERT);
    expect(
      await screen.findByText(
        "Maintained by Switch, so nobody can change it. Copy or download it to make your own version.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Access")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete template" })).toBeNull();
    expect(screen.getByText("4")).toBeTruthy();
    // It changes only with a release, so it has no dates of its own.
    expect(screen.queryByText("Created:")).toBeNull();
    expect(screen.queryByText("Updated:")).toBeNull();
  });

  it("names the owner of someone else's template, and who else may change it", async () => {
    showWith(OWNED);
    expect(
      await screen.findByText(
        "This template belongs to Bob. You can copy or download it; only they or a workspace admin can change it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Created:")).toBeTruthy();
  });

  it("says a template whose owner has left is an admin's to change", async () => {
    showWith({ ...OWNED, owner_name: null });
    expect(
      await screen.findByText(
        "This template belongs to a former member. You can copy or download it; only a workspace admin can change it.",
      ),
    ).toBeTruthy();
  });

  it("says what the template is for, what it creates, and when it was last used", async () => {
    showWith({ ...OWNED, agent_count: 2, last_run_at: "2026-11-14T12:00:00Z" });
    const info = (label: string) => screen.getByText(`${label}:`).parentElement?.textContent;
    await screen.findByText("Use case:");
    expect(info("Use case")).toBe("Use case: Engineering");
    expect(info("Creates")).toBe("Creates: 2 agents · 1 room");
    expect(info("Last used")).toMatch(/^Last used: 2026-11-1[45] /);
    expect(screen.getByRole("heading", { name: "Standup" })).toBeTruthy();
    expect(screen.getByText("Room")).toBeTruthy();
  });

  it("deletes after confirming, and goes back to the Templates page", async () => {
    const calls = showWith({ ...OWNED, can_edit: true, can_manage: true });
    fireEvent.click(await screen.findByRole("button", { name: "Delete template" }));
    expect(
      screen.getByText("Delete “Standup”? Agents and rooms already made from it keep working. This can’t be undone."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(calls.map((c) => c.key)).toContain("DELETE /templates/t-1"));
    expect(await screen.findByText("Templates page")).toBeTruthy();
  });

  it("removes an official template from the workspace, saying other workspaces keep it", async () => {
    const calls = showWith({ ...EXPERT, can_manage: true });
    fireEvent.click(await screen.findByRole("button", { name: "Remove from this workspace" }));
    expect(
      screen.getByText(
        "Remove “Switch expert” from this workspace? It comes with Switch, so other workspaces keep it. Agents and rooms already made from it keep working. This can’t be undone.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(calls.map((c) => c.key)).toContain("DELETE /templates/official:switch-expert"));
  });

  it("goes back to the templates from a labelled link", async () => {
    showWith(OWNED);
    fireEvent.click(await screen.findByRole("button", { name: "Back to templates" }));
    expect(await screen.findByText("Templates page")).toBeTruthy();
  });

  it("says a template it may not open is not available, rather than naming its id", async () => {
    showWith({ id: "t-9", answer: { status: 404, body: { detail: "Template not found: t-9" } } });
    expect(await screen.findByText(NOT_AVAILABLE)).toBeTruthy();
    expect(screen.queryByText(/t-9/)).toBeNull();
    expect(screen.getByRole("button", { name: "Back to templates" })).toBeTruthy();
  });

  it("keeps the server's reason for any other failure", async () => {
    showWith({ id: "t-9", answer: { status: 500, body: { detail: "database unavailable" } } });
    expect(await screen.findByText("database unavailable")).toBeTruthy();
  });

  it("hands Use over to Switch Console", async () => {
    showWith(EXPERT);
    fireEvent.click(await screen.findByRole("button", { name: "Use template" }));
    const dialog = screen.getByRole("dialog", { name: "Use Switch expert" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open in Switch Console" }));
    expect(assign).toHaveBeenCalledWith(
      "switchdash://open/template/official%3Aswitch-expert" +
        `?server=${encodeURIComponent(window.location.origin)}&workspace=ten-1&use=1`,
    );
  });

  it("greys Use where a person should not run the template", async () => {
    showWith({ ...EXPERT, run_blocked_reason: "Switch Console sets up your switch-buddy for you." });
    const use = await screen.findByRole("button", { name: "Use template" });
    expect(use.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(use);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("duplicates the template as the viewer's own, and opens the copy", async () => {
    showWith(EXPERT, {
      "GET /templates/official:switch-expert/content": { status: 200, body: "version: 2\n" },
      "GET /templates": { status: 200, body: [{ ...OWNED, owner_id: "u-1", name: "Switch expert (copy)" }] },
      "POST /templates": { status: 201, body: { ...OWNED, id: "t-2" } },
      "GET /templates/t-2": { status: 200, body: { ...OWNED, id: "t-2", name: "Switch expert (copy 2)" } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate as my own" }));

    const dialog = await screen.findByRole("dialog", { name: "Duplicate template" });
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Switch expert (copy 2)");
    expect(within(dialog).getByLabelText("Use case").textContent).toBe("Support");
    const save = within(dialog).getByRole("button", { name: "Save copy" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(save);

    // Saved, then navigated to and fetched: a few round trips.
    expect(
      await screen.findByRole("heading", { name: "Switch expert (copy 2)" }, { timeout: 3000 }),
    ).toBeTruthy();
  });

  it("saves a changed use case, and clears one", async () => {
    const mine = { ...OWNED, owner_id: "u-1", can_edit: true, can_manage: true };
    const calls = showWith(mine, {
      "PATCH /templates/t-1": { status: 200, body: { ...mine, use_case: null } },
    });
    fireEvent.mouseDown(await screen.findByLabelText("Use case"));
    fireEvent.click(await screen.findByRole("option", { name: "None" }));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(save);

    await waitFor(() =>
      expect(calls.filter((c) => c.key === "PATCH /templates/t-1").map((c) => c.body)).toEqual([{ use_case: null }]),
    );
  });
});
