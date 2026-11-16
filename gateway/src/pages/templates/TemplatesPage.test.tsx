import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateSummary } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { ALL_OFF, type FeatureFlags } from "../../data/featureFlags";
import TemplatesPage from "./TemplatesPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const template = (over: Partial<TemplateSummary>): TemplateSummary => ({
  id: "t-1",
  owner_id: "u-1",
  owner_name: "Ada",
  official: false,
  name: "Standup",
  description: "A daily standup room",
  kind: "room",
  use_case: null,
  agent_count: 2,
  room_count: 1,
  read_visibility: "public",
  write_visibility: "private",
  can_edit: true,
  can_manage: true,
  run_blocked_reason: null,
  run_count: 3,
  last_run_at: null,
  version: 1,
  size_bytes: 10,
  created_at: "2026-11-01 09:00:00+00:00",
  updated_at: "2026-11-01 09:00:00+00:00",
  ...over,
});

const official = (id: string, over: Partial<TemplateSummary> = {}): TemplateSummary =>
  template({
    id: `official:${id}`,
    owner_id: null,
    owner_name: "Switch",
    official: true,
    name: id,
    description: `The ${id} template`,
    can_edit: false,
    can_manage: false,
    run_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  });

const EXPERT = official("Switch expert", { kind: "agent", use_case: "support", agent_count: 1, room_count: 1 });
const MINE = template({ id: "mine", name: "Standup", use_case: "engineering", run_count: 3 });
const THEIRS = template({
  id: "theirs",
  name: "Retro",
  owner_id: "u-2",
  owner_name: "Bob",
  can_edit: false,
  can_manage: false,
  kind: "group",
  agent_count: 1,
  room_count: 2,
  run_count: 7,
});

const originalLocation = window.location;
const assign = vi.fn();

beforeEach(() => {
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

function signIn(features: FeatureFlags = ALL_OFF) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u-1" },
    session: { tenant: { id: "ten-1", name: "Acme" } },
    capabilities: { features },
  } as unknown as ReturnType<typeof useAuth>);
}

type Answer = { status: number; body: unknown };

/** The page over a server that answers each `METHOD /path` from `routes`
 * (the listing by default), with the template page behind it. */
function showWith(listing: TemplateSummary[] | Answer, routes: Record<string, Answer> = {}, features = ALL_OFF) {
  signIn(features);
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const [path, query] = String(input).replace(/^\/gateway/, "").split("?");
      const key = `${init?.method ?? "GET"} ${path}`;
      calls.push(query ? `${key}?${query}` : key);
      const answer =
        routes[key] ??
        (key === "GET /templates"
          ? Array.isArray(listing)
            ? { status: 200, body: listing }
            : listing
          : { status: 404, body: { detail: `unmocked ${key}` } });
      const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      return new Response(body, { status: answer.status });
    }),
  );
  render(
    <MemoryRouter initialEntries={["/templates"]}>
      <Routes>
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/:id" element={<p>Template page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return calls;
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const section = (name: string) => screen.getByRole("region", { name });
const cardNames = (region: HTMLElement) =>
  within(region)
    .getAllByRole("article")
    .map((card) => card.getAttribute("aria-label"));

describe("TemplatesPage", () => {
  it("shows the workspace's own templates, then the official ones, most used first", async () => {
    showWith([EXPERT, MINE, THEIRS]);

    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Templates" })).toBeTruthy();
    expect(
      screen.getByText(
        "Templates create agents and rooms on this workspace. Pick one, fill in what it asks, and everything it describes is created in one go, or nothing is.",
      ),
    ).toBeTruthy();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Workspace", "Official"]);
    expect(cardNames(section("Workspace"))).toEqual(["Retro", "Standup"]);
    expect(cardNames(section("Official"))).toEqual(["Switch expert"]);
    expect(tab(/^All/).textContent).toBe("All 3");
    expect(tab(/^Official/).textContent).toBe("Official 1");
    expect(tab(/^Workspace/).textContent).toBe("Workspace 2");
  });

  it("says on each card what the template is for, what it creates, and whose it is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    try {
      showWith([
        EXPERT,
        template({ id: "mine", use_case: "ops", read_visibility: "private", last_run_at: "2026-11-14T12:00:00Z" }),
        template({ id: "never", name: "Unread", owner_name: null, agent_count: null, room_count: null }),
      ]);

      const card = within(await screen.findByRole("article", { name: "Standup" }));
      expect(card.getByText("Room")).toBeTruthy();
      expect(card.getByText("Operations")).toBeTruthy();
      expect(card.getByText("Private")).toBeTruthy();
      expect(card.getByText("2 agents · 1 room")).toBeTruthy();
      expect(card.getByText("used 2 days ago").closest("p")?.textContent).toBe("Ada · used 2 days ago");

      const unread = within(screen.getByRole("article", { name: "Unread" }));
      expect(unread.getByText("Former member")).toBeTruthy();
      expect(unread.queryByText(/agent/)).toBeNull();

      const expert = within(screen.getByRole("article", { name: "Switch expert" }));
      expect(expert.getByText("Agent")).toBeTruthy();
      expect(expert.getByText("Support")).toBeTruthy();
      expect(expert.getByText("1 agent · 1 room")).toBeTruthy();
      expect(expert.queryByText(/Switch ·|^Switch$/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("previews six official templates in the All tab, and See all opens the Official tab", async () => {
    const shipped = Array.from({ length: 8 }, (_, i) => official(`Room ${i}`, { run_count: i }));
    showWith([...shipped, MINE]);

    const officialSection = await screen.findByRole("region", { name: "Official" });
    expect(cardNames(officialSection)).toEqual(["Room 7", "Room 6", "Room 5", "Room 4", "Room 3", "Room 2"]);
    fireEvent.click(within(officialSection).getByRole("button", { name: "See all 8" }));

    expect(tab(/^Official/).getAttribute("aria-selected")).toBe("true");
    expect(cardNames(section("Official"))).toHaveLength(8);
    expect(screen.queryByRole("region", { name: "Workspace" })).toBeNull();
  });

  it("narrows every list and count with the search, the type chips and Only mine", async () => {
    showWith([EXPERT, MINE, THEIRS]);
    await screen.findByRole("region", { name: "Workspace" });

    fireEvent.change(screen.getByLabelText("Search templates"), { target: { value: "bob" } });
    expect(cardNames(section("Workspace"))).toEqual(["Retro"]);
    expect(screen.queryByRole("region", { name: "Official" })).toBeNull();
    expect(tab(/^All/).textContent).toBe("All 1");
    fireEvent.change(screen.getByLabelText("Search templates"), { target: { value: "" } });

    const types = within(screen.getByRole("group", { name: "Filter by template type" }));
    expect(types.getAllByRole("button").map((b) => b.textContent)).toEqual(["All 3", "Agent 1", "Room 1", "Group 1"]);
    fireEvent.click(types.getByRole("button", { name: "Group 1" }));
    expect(cardNames(section("Workspace"))).toEqual(["Retro"]);
    // The tabs count across every type.
    expect(tab(/^All/).textContent).toBe("All 3");
    fireEvent.click(types.getByRole("button", { name: "All 3" }));

    fireEvent.click(screen.getByRole("button", { name: "Only mine" }));
    expect(screen.getByRole("button", { name: "Only mine" }).getAttribute("aria-pressed")).toBe("true");
    expect(cardNames(section("Workspace"))).toEqual(["Standup"]);
    expect(screen.queryByRole("region", { name: "Official" })).toBeNull();
    expect(tab(/^Official/).textContent).toBe("Official 0");
  });

  it("says when nothing matches, and Clear filters brings everything back", async () => {
    showWith([EXPERT, MINE]);
    await screen.findByRole("region", { name: "Workspace" });
    fireEvent.click(tab(/^Official/));
    fireEvent.change(screen.getByLabelText("Search templates"), { target: { value: "nothing like it" } });

    expect(screen.getByText("No templates match these filters.")).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(tab(/^All/).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("Search templates") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("shows just the official templates for a workspace with none of its own", async () => {
    showWith([EXPERT]);
    expect(await screen.findByRole("region", { name: "Official" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Workspace" })).toBeNull();

    fireEvent.click(tab(/^Workspace/));
    expect(
      screen.getByText("No workspace templates yet. Create one, or duplicate an official one to make it your own."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("offers on each card what the server says the viewer may do", async () => {
    showWith([EXPERT, MINE, THEIRS]);
    await screen.findByRole("region", { name: "Workspace" });
    const itemsOf = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: `More actions for ${name}` }));
      const menu = await screen.findByRole("menu");
      const items = within(menu)
        .getAllByRole("menuitem")
        .map((item) => [item.textContent, item.getAttribute("aria-disabled") === "true"]);
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      return items;
    };

    expect(await itemsOf("Standup")).toEqual([
      ["Edit template", false],
      ["Duplicate as my own", false],
      ["Delete template", false],
    ]);
    expect(await itemsOf("Retro")).toEqual([
      ["Edit template“Retro” belongs to Bob. Only they or a workspace admin can change it.", true],
      ["Duplicate as my own", false],
      ["Delete template“Retro” belongs to Bob. Only they or a workspace admin can delete it.", true],
    ]);
    expect(await itemsOf("Switch expert")).toEqual([
      ["Edit templateMaintained by Switch. Duplicate it to make your own version.", true],
      ["Duplicate as my own", false],
    ]);
  });

  it("opens a template from its card, and hands Use over to Switch Console", async () => {
    showWith([EXPERT, MINE]);
    fireEvent.click(await screen.findByRole("button", { name: "Use Standup" }));

    const dialog = screen.getByRole("dialog", { name: "Use Standup" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open in Switch Console" }));
    expect(assign).toHaveBeenCalledWith(
      `switchdash://open/template/mine?server=${encodeURIComponent(window.location.origin)}&workspace=ten-1&use=1`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch expert" }));
    expect(await screen.findByText("Template page")).toBeTruthy();
  });

  it("greys Use where a person should not run the template, saying why", async () => {
    const reason = "Switch Console sets up your switch-buddy for you.";
    showWith([official("switch-buddy", { kind: "agent", run_blocked_reason: reason })]);

    const use = await screen.findByRole("button", { name: "Use switch-buddy" });
    expect(use.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(use);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.mouseOver(use);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe(reason);
    // It describes the button, which keeps its own name.
    expect(use.getAttribute("aria-describedby")).toBe(tooltip.id);
  });

  it("deletes a template after asking", async () => {
    const calls = showWith([MINE], { "DELETE /templates/mine": { status: 200, body: { deleted_id: "mine" } } });
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Standup" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete template" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(calls).toContain("DELETE /templates/mine"));
  });

  it("duplicates a template under a copy name the viewer does not use, as a private one", async () => {
    showWith([MINE, THEIRS], {
      "GET /templates/theirs/content": { status: 200, body: "room:\n  name: retro\n" },
      "POST /templates/validate": { status: 200, body: { ok: true, blocked: false, errors: [], warnings: [] } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Retro" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate as my own" }));

    const dialog = await screen.findByRole("dialog", { name: "Duplicate template" });
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Retro (copy)");
    expect((within(dialog).getByLabelText("Document") as HTMLInputElement).value).toBe("room:\n  name: retro\n");
    expect(within(dialog).getByLabelText("Access").textContent).toMatch(/private/i);
  });

  it("creates with the personal agent, in Console, or from YAML written here", async () => {
    showWith([MINE], {}, { ...ALL_OFF, agent_management: true, switch_buddy: true });
    const menuItems = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Create template" }));
      return within(await screen.findByRole("menu", { name: "Create template" }));
    };

    let menu = await menuItems();
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Create with your personal agentOpens a chat with your agent",
      "Create in ConsoleFill in the template form",
      "Write the YAML herePaste it in or load a file",
    ]);
    fireEvent.click(menu.getByRole("menuitem", { name: /Create with your personal agent/ }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Create with your personal agent" })).getByRole("button", {
        name: "Open in Switch Console",
      }),
    );
    expect(assign).toHaveBeenLastCalledWith(
      `switchdash://open/buddy?server=${encodeURIComponent(window.location.origin)}&workspace=ten-1`,
    );

    menu = await menuItems();
    fireEvent.click(menu.getByRole("menuitem", { name: /Create in Console/ }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Create in Console" })).getByRole("button", {
        name: "Open in Switch Console",
      }),
    );
    expect(assign).toHaveBeenLastCalledWith(
      `switchdash://open/templates?server=${encodeURIComponent(window.location.origin)}&workspace=ten-1`,
    );

    menu = await menuItems();
    fireEvent.click(menu.getByRole("menuitem", { name: /Write the YAML here/ }));
    expect(screen.getByRole("dialog", { name: "New template" })).toBeTruthy();
  });

  it("offers no personal agent where switch-buddy is not served", async () => {
    showWith([MINE], {}, { ...ALL_OFF, agent_management: true });
    fireEvent.click(await screen.findByRole("button", { name: "Create template" }));
    const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Create in ConsoleFill in the template form",
      "Write the YAML herePaste it in or load a file",
    ]);
  });

  it("shows the server's reason the catalogue did not load, instead of the library", async () => {
    showWith({ status: 500, body: { detail: "database unavailable" } });
    expect(await screen.findByText("Could not load templates: database unavailable")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Workspace" })).toBeNull();
    expect(screen.queryByText("No templates match these filters.")).toBeNull();
  });

  it("keeps the library, and says why, when a refresh after an action fails", async () => {
    signIn();
    let listed = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).split("?")[0];
        const method = init?.method ?? "GET";
        if (path === "/gateway/templates" && method === "GET") {
          listed += 1;
          return listed === 1
            ? new Response(JSON.stringify([MINE]), { status: 200 })
            : new Response(JSON.stringify({ detail: "database unavailable" }), { status: 500 });
        }
        if (path === "/gateway/templates/mine" && method === "DELETE") {
          return new Response(JSON.stringify({ deleted_id: "mine" }), { status: 200 });
        }
        throw new Error(`unexpected ${method} ${path}`);
      }),
    );
    render(
      <MemoryRouter>
        <TemplatesPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Standup" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete template" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Could not refresh templates: database unavailable")).toBeTruthy();
    expect(screen.getByRole("article", { name: "Standup" })).toBeTruthy();
  });
});
