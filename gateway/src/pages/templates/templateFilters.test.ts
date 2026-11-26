import { describe, expect, it } from "vitest";
import type { TemplateSummary } from "../../data/api";
import {
  NO_FILTER,
  OFFICIAL_PREVIEW,
  type TemplateFilter,
  librarySections,
  matchesQuery,
  narrowed,
  scopeCounts,
  typeCounts,
} from "./templateFilters";

const template = (over: Partial<TemplateSummary>): TemplateSummary => ({
  id: "t-1",
  owner_id: "u-2",
  owner_name: "Bob",
  official: false,
  name: "Standup",
  description: "A daily standup room",
  kind: "room",
  use_case: null,
  agent_count: 1,
  room_count: 1,
  read_visibility: "public",
  write_visibility: "private",
  can_edit: false,
  can_manage: false,
  run_blocked_reason: null,
  run_count: 0,
  last_run_at: null,
  version: 1,
  size_bytes: 10,
  created_at: "2026-11-01 09:00:00+00:00",
  updated_at: "2026-11-01 09:00:00+00:00",
  ...over,
});

const official = (id: string, over: Partial<TemplateSummary> = {}) =>
  template({ id, name: id, official: true, owner_id: null, owner_name: "Switch", ...over });

const LIBRARY = [
  official("expert", { kind: "agent", use_case: "support", run_count: 2 }),
  official("incident", { use_case: "engineering", run_count: 9 }),
  official("deal", { use_case: "sales" }),
  template({ id: "mine", name: "My standup", owner_id: "u-1", owner_name: "Ada", run_count: 1 }),
  template({ id: "theirs", name: "Sprint group", kind: "group", run_count: 5 }),
  template({ id: "odd", name: "Pipeline", kind: "pipeline" }),
];

const filter = (over: Partial<TemplateFilter> = {}): TemplateFilter => ({
  ...NO_FILTER,
  viewerId: "u-1",
  ...over,
});

const ids = (f: TemplateFilter) =>
  librarySections(LIBRARY, f).map((s) => [s.id, s.items.map((t) => t.id)]);

describe("the library's sections", () => {
  it("puts the workspace's own first, then the official ones, each most used first", () => {
    expect(ids(filter())).toEqual([
      ["workspace", ["theirs", "mine", "odd"]],
      ["official", ["incident", "expert", "deal"]],
    ]);
  });

  it("leaves out a section with nothing in it", () => {
    expect(ids(filter({ scope: "official" }))).toEqual([["official", ["incident", "expert", "deal"]]]);
    expect(ids(filter({ query: "sales" }))).toEqual([["official", ["deal"]]]);
  });

  it("drops every official template for Only mine", () => {
    expect(ids(filter({ onlyMine: true }))).toEqual([["workspace", ["mine"]]]);
    expect(ids(filter({ onlyMine: true, viewerId: null }))).toEqual([]);
  });

  it("files an unnamed kind under Room", () => {
    expect(ids(filter({ type: "room" }))).toEqual([
      ["workspace", ["mine", "odd"]],
      ["official", ["incident", "deal"]],
    ]);
  });

  it("previews the official ones in the All tab, and shows them all in their own", () => {
    const many = Array.from({ length: OFFICIAL_PREVIEW + 3 }, (_, i) => official(`o${i}`));
    const [all] = librarySections(many, filter());
    expect([all.total, all.items.length, all.preview]).toEqual([OFFICIAL_PREVIEW + 3, OFFICIAL_PREVIEW, true]);
    const [own] = librarySections(many, filter({ scope: "official" }));
    expect([own.total, own.items.length, own.preview]).toEqual([OFFICIAL_PREVIEW + 3, OFFICIAL_PREVIEW + 3, false]);
    const [few] = librarySections(many.slice(0, OFFICIAL_PREVIEW), filter());
    expect(few.preview).toBe(false);
  });
});

describe("the counts", () => {
  it("count each tab whatever tab is picked, following search and Only mine", () => {
    expect(scopeCounts(LIBRARY, filter({ scope: "official", type: "agent" }))).toEqual({
      all: 6,
      official: 3,
      workspace: 3,
    });
    expect(scopeCounts(LIBRARY, filter({ query: "my standup" }))).toEqual({ all: 1, official: 0, workspace: 1 });
    expect(scopeCounts(LIBRARY, filter({ onlyMine: true }))).toEqual({ all: 1, official: 0, workspace: 1 });
  });

  it("count each type within the tab, search and Only mine, whatever type is picked", () => {
    expect(typeCounts(LIBRARY, filter({ type: "group" }))).toEqual({ all: 6, agent: 1, room: 4, group: 1 });
    expect(typeCounts(LIBRARY, filter({ scope: "official" }))).toEqual({ all: 3, agent: 1, room: 2, group: 0 });
    expect(typeCounts(LIBRARY, filter({ onlyMine: true }))).toEqual({ all: 1, agent: 0, room: 1, group: 0 });
  });
});

describe("search", () => {
  it("matches the name, description, use case and owner, in any case", () => {
    const t = template({ name: "Triage", description: "Bugs in, fixes out", use_case: "ops", owner_name: "Ada" });
    expect(["triage", "FIXES", "operations", "ada", "  "].map((q) => matchesQuery(t, q))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(matchesQuery(t, "sales")).toBe(false);
  });

  it("says whether anything beyond the tab narrows the library", () => {
    expect(narrowed(filter({ scope: "workspace" }))).toBe(false);
    expect(narrowed(filter({ query: " x " }))).toBe(true);
    expect(narrowed(filter({ type: "agent" }))).toBe(true);
    expect(narrowed(filter({ onlyMine: true }))).toBe(true);
  });
});
