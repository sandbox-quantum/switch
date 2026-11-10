import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSummary, PackageDetail, ReferenceDetail, ReferenceTypeDetail, Session } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { answerFetch as answer } from "../../test/answerFetch";
import ResourcesPage from "./ResourcesPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const gets = (calls: { method: string; path: string }[], path: string) =>
  calls.filter((call) => call.method === "GET" && call.path === path).length;

function reference(id: string, extra: Partial<ReferenceDetail> = {}): ReferenceDetail {
  return {
    id,
    owner_id: "u1",
    owner_name: "Ada",
    read_visibility: "public",
    write_visibility: "private",
    type: "github",
    name: id,
    description: `${id} described`,
    instructions: "",
    value: { urls: ["https://example.com"] },
    attached_rooms_count: 0,
    hidden_rooms_count: 0,
    packages: [],
    created_at: "2026-11-01T10:00:00+00:00",
    type_display_name: "GitHub",
    can_read: true,
    can_edit: true,
    can_manage: true,
    ...extra,
  };
}

function document(id: string, extra: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id,
    owner_id: "u1",
    owner_name: "Ada",
    read_visibility: "public",
    write_visibility: "private",
    name: id,
    description: "",
    instructions: "",
    attached_rooms_count: 0,
    hidden_rooms_count: 0,
    packages: [],
    scope: "global",
    room_id: null,
    created_by_agent_id: null,
    created_by_agent_name: null,
    created_at: "2026-11-01T10:00:00+00:00",
    can_read: true,
    can_edit: true,
    can_manage: true,
    can_transfer: true,
    ...extra,
  };
}

function pkg(id: string, extra: Partial<PackageDetail> = {}): PackageDetail {
  return {
    id,
    owner_id: "u1",
    owner_name: "Ada",
    read_visibility: "public",
    write_visibility: "private",
    name: id,
    description: `${id} described`,
    instructions: "",
    references_count: 2,
    documents_count: 1,
    attached_rooms_count: 3,
    hidden_rooms_count: 0,
    created_at: "2026-11-01T10:00:00+00:00",
    can_read: true,
    can_edit: true,
    can_manage: true,
    ...extra,
  };
}

function storedType(type: string, extra: Partial<ReferenceTypeDetail> = {}): ReferenceTypeDetail {
  return {
    type,
    display_name: type,
    instructions: "Read it.",
    value_schema: {},
    value_hint: "Links to it",
    is_builtin: false,
    owner_id: "u1",
    owner_name: "Ada",
    read_visibility: "public",
    write_visibility: "private",
    shadowed_by_builtin: false,
    created_at: "2026-11-01T10:00:00+00:00",
    can_edit: true,
    can_manage: true,
    ...extra,
  };
}

const BUILT_IN = {
  type: "github",
  display_name: "GitHub",
  instructions: "",
  value_schema: {},
  value_hint: "Links to repositories",
  is_builtin: true,
  owner_id: null,
  owner_name: null,
};

const show = (tab: string) =>
  render(
    <MemoryRouter initialEntries={[`/resources?tab=${tab}`]}>
      <ResourcesPage withTemplates={false} />
    </MemoryRouter>,
  );

describe("ResourcesPage", () => {
  beforeEach(() => {
    const tenant = { id: "t1", slug: "acme", name: "Acme", role: "member" };
    vi.mocked(useAuth).mockReturnValue({
      session: { user: { id: "u1", name: "Ada" }, tenant, tenants: [tenant], state: "ready" } as unknown as Session,
    } as unknown as ReturnType<typeof useAuth>);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("References", () => {
    it("loads the list once, and nothing a closed dialog would offer", async () => {
      const calls = answer({ "GET /references": [200, [reference("repo")]] });
      show("references");

      expect(await screen.findByText("1 reference")).toBeTruthy();
      expect(gets(calls, "/references")).toBe(1);
      expect(gets(calls, "/references/reference-types")).toBe(0);
    });

    it("offers Owner and Type dropdowns, an unknown type among them as it reads", async () => {
      answer({
        "GET /references": [
          200,
          [
            reference("repo"),
            reference("ticket", { type: "jira", type_display_name: null, owner_id: "u2", owner_name: "Grace" }),
          ],
        ],
      });
      show("references");

      fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Type" }));
      const types = await screen.findByRole("listbox");
      expect(within(types).getByRole("option", { name: "jira (unknown type)" })).toBeTruthy();
      fireEvent.click(within(types).getByRole("option", { name: "jira (unknown type)" }));

      expect(await screen.findByText("1 of 2 references")).toBeTruthy();
      expect(screen.getByRole("combobox", { name: "Owner" })).toBeTruthy();
    });

    it("searches the description and owner as well as the name", async () => {
      answer({
        "GET /references": [
          200,
          [reference("repo", { description: "The monorepo" }), reference("brief", { owner_name: "Grace", owner_id: "u2" })],
        ],
      });
      show("references");

      const search = await screen.findByLabelText("Search references");
      fireEvent.change(search, { target: { value: "monorepo" } });
      expect(await screen.findByText("1 of 2 references")).toBeTruthy();
      fireEvent.change(search, { target: { value: "grace" } });
      expect(await screen.findByText("1 of 2 references")).toBeTruthy();
    });

    it("says why the list could not load, rather than show an empty one", async () => {
      answer({ "GET /references": [503, { detail: "The database is unavailable." }] });
      show("references");

      expect(await screen.findByText(/Couldn't load the references: The database is unavailable/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByText("No references yet")).toBeNull();
    });

    it("loads the types only once New reference is pressed", async () => {
      const calls = answer({
        "GET /references": [200, [reference("repo")]],
        "GET /references/reference-types": [200, [BUILT_IN]],
      });
      show("references");

      fireEvent.click(await screen.findByRole("button", { name: "New reference" }));
      await waitFor(() => expect(gets(calls, "/references/reference-types")).toBe(1));
    });
  });

  describe("Documents", () => {
    it("offers a document with no owner as No owner", async () => {
      answer({ "GET /documents": [200, [document("notes"), document("orphan", { owner_id: null, owner_name: null })]] });
      show("documents");

      fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Owner" }));
      fireEvent.click(await screen.findByRole("option", { name: "No owner" }));
      expect(await screen.findByText("1 of 2 documents")).toBeTruthy();
    });
  });

  describe("Documents and Packages", () => {
    it("searches a document's description", async () => {
      answer({
        "GET /documents": [200, [document("notes", { description: "Release checklist" }), document("glossary")]],
      });
      show("documents");

      fireEvent.change(await screen.findByLabelText("Search documents"), { target: { value: "checklist" } });
      expect(await screen.findByText("1 of 2 documents")).toBeTruthy();
    });

    it("lists packages once, with what each holds, and filters them by owner", async () => {
      const calls = answer({
        "GET /packages": [200, [pkg("onboarding"), pkg("research", { owner_id: "u2", owner_name: "Grace" })]],
      });
      show("packages");

      expect(await screen.findByText("2 packages")).toBeTruthy();
      expect(gets(calls, "/packages")).toBe(1);
      expect(screen.getByRole("columnheader", { name: /References/ })).toBeTruthy();
      expect(screen.getByRole("columnheader", { name: /Documents/ })).toBeTruthy();
      fireEvent.mouseDown(screen.getByRole("combobox", { name: "Owner" }));
      fireEvent.click(await screen.findByRole("option", { name: "Grace" }));
      expect(await screen.findByText("1 of 2 packages")).toBeTruthy();
    });

    it("says why the packages could not load, rather than show none", async () => {
      answer({ "GET /packages": [500, { detail: "The database is unavailable." }] });
      show("packages");

      expect(await screen.findByText(/Couldn't load the packages: The database is unavailable/)).toBeTruthy();
      expect(screen.queryByText("No packages yet")).toBeNull();
    });
  });

  describe("Reference types", () => {
    const types = (stored: ReferenceTypeDetail[]) =>
      answer({
        "GET /references/reference-types": [200, [BUILT_IN]],
        "GET /references/reference-types/owned": [200, stored],
      });

    it("lists a colleague's public type with nothing to do to it, beside the built-ins", async () => {
      types([storedType("notion", { owner_id: "u2", owner_name: "Grace", can_edit: false, can_manage: false })]);
      show("types");

      expect(await screen.findByText("2 reference types")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Actions for notion" })).toBeNull();
    });

    it("offers only Edit on a type someone else owns but lets anyone change", async () => {
      types([
        storedType("notion", {
          owner_id: "u2",
          owner_name: "Grace",
          write_visibility: "public",
          can_edit: true,
          can_manage: false,
        }),
      ]);
      show("types");

      fireEvent.click(await screen.findByRole("button", { name: "Actions for notion" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: /Edit/ })).toBeTruthy();
      expect(within(menu).queryByRole("menuitem", { name: /Transfer/ })).toBeNull();
      expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).toBeNull();
    });

    it("saves an edit only once something has changed", async () => {
      types([storedType("notion")]);
      show("types");

      fireEvent.click(await screen.findByRole("button", { name: "Actions for notion" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Edit/ }));
      const dialog = await screen.findByRole("dialog", { name: "Edit reference type" });
      const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Notion pages" } });
      expect(save.disabled).toBe(false);
    });

    it("keeps the delete dialog open with the reason a type in use cannot go", async () => {
      answer({
        "GET /references/reference-types": [200, [BUILT_IN]],
        "GET /references/reference-types/owned": [200, [storedType("notion")]],
        "DELETE /references/reference-types/notion": [409, { detail: "References still use this type." }],
      });
      show("types");

      fireEvent.click(await screen.findByRole("button", { name: "Actions for notion" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
      const dialog = await screen.findByRole("dialog", { name: "Delete reference type" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      expect(await within(dialog).findByText("References still use this type.")).toBeTruthy();
      expect(screen.getByRole("dialog", { name: "Delete reference type" })).toBeTruthy();
    });
  });
});
