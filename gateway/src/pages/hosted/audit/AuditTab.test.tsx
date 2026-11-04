import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER, VIEWER, answer, answers, renderTab } from "../w5shared/testing";
import AuditTab, {
  AUDIT_PATH,
  type AuditEntry,
  PAGE_SIZE,
  auditQuery,
  buildRows,
  parseEntries,
  resultWords,
} from "./AuditTab";
import { ADMIN_HAS_REASON, EMPTY, LOAD_ERROR, LOAD_OLDER, shortId } from "./auditWords";

const refresh = vi.fn(async () => undefined);
vi.mock("../../../data/AuthContext", () => ({
  useAuth: () => ({ user: { id: "op-me", name: "Jo Operator" }, refresh }),
}));

const USER = "k1-6d2c91f03ab2aa00";
const WS = "k1-7c10aa00bb11cc22";
const ADMIN = "k1-a83e00112233aabb";

function raw(over: Record<string, unknown>) {
  return {
    id: "e",
    occurred_at: "2026-10-29T10:52:00+00:00",
    actor_user_id: null,
    actor_name: null,
    action: "hosted.user_paused",
    target_type: "user",
    target_id: USER,
    details: {},
    title: null,
    ...over,
  };
}

// Newest first, as Core sends them.
const PAGE = [
  raw({
    id: "res-1",
    occurred_at: "2026-10-29T10:52:30+00:00",
    actor_user_id: "op-me",
    actor_name: "Jo Operator",
    details: { phase: "result", result: "done", linked_to: "req-1" },
  }),
  raw({
    id: "req-1",
    actor_user_id: "op-me",
    actor_name: "Jo Operator",
    details: {
      phase: "requested",
      reason: "Repeated restarts, checking with the workspace",
    },
  }),
  raw({
    id: "adm-1",
    occurred_at: "2026-10-29T10:31:00+00:00",
    actor_user_id: ADMIN,
    action: "hosted.admin_change",
    details: {
      action: "hosted.person_turned_off",
      workspace: WS,
      result: "done",
      actor_kind: "workspace_admin",
      has_reason: true,
    },
  }),
  raw({
    id: "req-2",
    occurred_at: "2026-10-29T09:40:00+00:00",
    actor_user_id: "op-ren",
    actor_name: "Ren Ops",
    action: "hosted.user_resumed",
    details: { phase: "requested", reason: "Cleared with the workspace admin" },
  }),
];

function entries(list: unknown[]): AuditEntry[] {
  return parseEntries(list) ?? [];
}

describe("the Audit log tab", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    refresh.mockClear();
  });

  it("asks Core for the last 7 days by default, with the session cookie", async () => {
    const fetchMock = answer(200, PAGE);
    renderTab(AuditTab);
    await screen.findByRole("table", { name: "Audit log" });
    const [path, init] = fetchMock.mock.calls[0];
    const url = new URL(path, "https://x");
    expect(url.pathname).toBe(AUDIT_PATH);
    expect(url.searchParams.get("limit")).toBe(String(PAGE_SIZE));
    const since = new Date(url.searchParams.get("since") ?? "");
    expect(Math.round((Date.now() - since.getTime()) / 86_400_000)).toBe(7);
    expect(url.searchParams.get("action")).toBeNull();
    expect(init?.credentials).toBe("include");
  });

  it("shows \"Any action\" in the Action filter by default, not a blank field", async () => {
    answer(200, PAGE);
    renderTab(AuditTab);
    await screen.findByRole("table", { name: "Audit log" });
    expect(screen.getByLabelText("Action").textContent).toBe("Any action");
  });

  it("shows one row per action, with names, reasons and results", async () => {
    answer(200, PAGE);
    renderTab(AuditTab);
    const table = await screen.findByRole("table", { name: "Audit log" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const [mine, admin, theirs] = rows.map((r) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    );
    // The app's usual date and time, never the browser's own locale.
    expect(mine[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} (AM|PM)$/);
    expect(mine.slice(1)).toEqual([
      "Jo Operator (you)",
      "Paused user",
      "k1-6d2c",
      "Repeated restarts, checking with the workspace",
      "Done",
    ]);
    expect(admin.slice(1)).toEqual([
      "Workspace admin k1-a83e (k1-7c10)",
      "Turned off hosted agents",
      "k1-6d2c",
      ADMIN_HAS_REASON,
      "Done",
    ]);
    expect(theirs.slice(1)).toEqual([
      "Ren Ops",
      "Resumed user",
      "k1-6d2c",
      "Cleared with the workspace admin",
      "In progress",
    ]);
  });

  it("filters by action, id and time", async () => {
    const fetchMock = answer(200, []);
    renderTab(AuditTab);
    await screen.findByText(EMPTY);
    fireEvent.mouseDown(screen.getByLabelText("Action"));
    fireEvent.click(await screen.findByRole("option", { name: "Showed name" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const id = screen.getByLabelText("Id");
    fireEvent.change(id, { target: { value: `  ${USER} ` } });
    fireEvent.keyDown(id, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    fireEvent.mouseDown(screen.getByLabelText("Time"));
    fireEvent.click(await screen.findByRole("option", { name: "Last 24 hours" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const url = new URL(fetchMock.mock.calls[3][0], "https://x");
    expect(url.searchParams.get("action")).toBe("operator.name_revealed");
    expect(url.searchParams.get("target_id")).toBe(USER);
    const since = new Date(url.searchParams.get("since") ?? "");
    expect(Math.round((Date.now() - since.getTime()) / 3_600_000)).toBe(24);
  });

  it("loads older entries with the oldest time as `before`, and joins results across pages", async () => {
    const first = Array.from({ length: PAGE_SIZE }, (_, i) =>
      raw({
        id: `res-${i}`,
        occurred_at: new Date(Date.UTC(2026, 9, 29, 12, 0, 59 - (i % 60))).toISOString(),
        actor_user_id: "op-me",
        details: {
          phase: "result",
          result: "failed",
          step: "rate_limited",
          linked_to: `req-${i}`,
        },
      }),
    );
    const oldest = first[first.length - 1];
    const second = [
      raw({
        id: "req-0",
        occurred_at: "2026-10-29T11:00:00+00:00",
        actor_user_id: "op-me",
        actor_name: "Jo Operator",
        details: { phase: "requested", reason: "r" },
      }),
    ];
    const fetchMock = answers({ status: 200, body: first }, { status: 200, body: second });
    renderTab(AuditTab);
    await screen.findByText(EMPTY);
    fireEvent.click(screen.getByRole("button", { name: LOAD_OLDER }));
    expect(await screen.findByText("Refused: too many actions in a short time")).toBeTruthy();
    const url = new URL(fetchMock.mock.calls[1][0], "https://x");
    expect(url.searchParams.get("before")).toBe(oldest.occurred_at);
    expect(url.searchParams.get("before_id")).toBe(oldest.id);
    // A short page means there's nothing older.
    expect(screen.queryByRole("button", { name: LOAD_OLDER })).toBeNull();
  });

  it("drops a 'Load older' answer that arrives after the filters changed", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) =>
      raw({ id: `q-${i}`, actor_user_id: "op-me", details: { phase: "requested", reason: "new" } }),
    );
    let releaseOlder: (r: Response) => void = () => undefined;
    const fetchMock = vi.fn(async (path: string) => {
      const url = new URL(path, "https://x");
      if (url.searchParams.get("before")) {
        return new Promise<Response>((resolve) => (releaseOlder = resolve));
      }
      const body = url.searchParams.get("action") ? [] : full;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderTab(AuditTab);
    await screen.findAllByText("new");
    fireEvent.click(screen.getByRole("button", { name: LOAD_OLDER }));
    fireEvent.mouseDown(screen.getByLabelText("Action"));
    fireEvent.click(await screen.findByRole("option", { name: "Showed name" }));
    await screen.findByText(EMPTY);
    releaseOlder(
      new Response(
        JSON.stringify([
          raw({
            id: "old",
            actor_user_id: "op-me",
            details: { phase: "requested", reason: `stale-${MARKER}` },
          }),
        ]),
        { status: 200 },
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(`stale-${MARKER}`)).toBeNull();
    expect(screen.getByText(EMPTY)).toBeTruthy();
  });

  it("shows an operator's reason as text, never as markup", async () => {
    answer(200, [
      raw({
        id: "r",
        actor_user_id: "op-me",
        details: {
          phase: "requested",
          reason: `<img src=x onerror=alert(1)>${MARKER}`,
        },
      }),
    ]);
    const { container } = renderTab(AuditTab);
    await screen.findByText(new RegExp(MARKER));
    expect(container.querySelector("img")).toBeNull();
  });

  it("words an alert with Core's title, and an unknown code as the code", async () => {
    answer(200, [
      raw({
        id: "a",
        action: "alert.raised",
        target_type: "box",
        title: "Box `k1-c4d812aa0b1c` restarted 3 times in the last hour",
        details: { condition: "box_restarts", severity: "warning", figure: 3 },
      }),
      raw({ id: "n", action: "hosted.something_new", actor_user_id: "op-me" }),
    ]);
    renderTab(AuditTab);
    const table = await screen.findByRole("table", { name: "Audit log" });
    const [alert, other] = within(table).getAllByRole("row").slice(1);
    const alertCells = within(alert).getAllByRole("cell");
    expect(alertCells[1].textContent).toBe("Switch");
    expect(alertCells[2].textContent).toBe(
      "Alert raised: Box k1-c4d812aa0b1c restarted 3 times in the last hour",
    );
    const code = within(within(other).getAllByRole("cell")[2]).getByText("hosted.something_new");
    expect(code.tagName).toBe("CODE");
  });

  it("shows 'Operators only' on a 403, never the server's text", async () => {
    answer(403, { detail: MARKER });
    const { container } = renderTab(AuditTab);
    expect(await screen.findByText("Operators only")).toBeTruthy();
    expect(container.innerHTML).not.toContain(MARKER);
  });

  it("asks the app to check the session again on a 401", async () => {
    answer(401, {});
    renderTab(AuditTab);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Operators only")).toBeNull();
  });

  it.each([422, 500])("shows the fixed load error on a %i", async (status) => {
    answer(status, { detail: MARKER });
    const { container } = renderTab(AuditTab);
    expect(await screen.findByText(LOAD_ERROR)).toBeTruthy();
    expect(container.innerHTML).not.toContain(MARKER);
  });
});

describe("the Audit log's parts", () => {
  it("words results and steps from the copy doc, with a fallback for the rest", () => {
    expect(resultWords("done", undefined).text).toBe("Done");
    expect(resultWords("done", undefined, { partial: true }).text).toBe(
      "Done: the box was stopped to cut off AI access",
    );
    expect(resultWords("failed", undefined).text).toBe("Failed");
    expect(resultWords("failed", "rate_limited").text).toBe(
      "Refused: too many actions in a short time",
    );
    expect(resultWords("failed", "not_found").text).toBe("Failed: no match found");
    expect(resultWords("failed", "revoke").text).toBe("Failed at: cutting off AI access");
    expect(resultWords("failed", "cordoned").text).toBe(
      "Failed at: closing the machine to new boxes",
    );
    // `busy` isn't written by Core, so it has no words of its own.
    expect(resultWords("failed", "busy")).toEqual({
      text: "Failed at step",
      code: "busy",
    });
    expect(resultWords("failed", "policy_refused", { provision: true }).text).toBe(
      "Failed: the cluster's policy refused the box",
    );
    expect(resultWords("failed", "policy_refused")).toEqual({
      text: "Failed at step",
      code: "policy_refused",
    });
    expect(resultWords("expired", undefined).text).toBe("Expired: not picked up in time");
    // `partial` is a progress step, never a result.
    expect(resultWords("partial", undefined)).toEqual({
      text: "",
      code: "partial",
    });
    expect(resultWords(undefined, undefined).text).toBe("—");
  });

  it("reads a done pause as partly done when its progress reached `partial`", () => {
    const [row] = buildRows(
      entries([
        raw({
          id: "r",
          actor_user_id: "op-me",
          details: { phase: "result", result: "done", linked_to: "q" },
        }),
        raw({
          id: "p",
          actor_user_id: "op-me",
          details: { phase: "progress", step: "partial", linked_to: "q" },
        }),
        raw({
          id: "q",
          actor_user_id: "op-me",
          details: { phase: "requested", reason: "x" },
        }),
      ]),
      VIEWER.id,
    );
    expect(row.result.text).toBe("Done: the box was stopped to cut off AI access");
  });

  it("words a workspace admin's budget change, and falls back for an unknown one", () => {
    const rows = buildRows(
      entries([
        raw({
          id: "b",
          actor_user_id: ADMIN,
          action: "hosted.admin_change",
          details: { action: "budget.updated", workspace: WS, result: "done" },
        }),
        raw({
          id: "u",
          actor_user_id: ADMIN,
          action: "hosted.admin_change",
          details: {
            action: "budget.something_new",
            workspace: WS,
            result: "done",
          },
        }),
      ]),
      VIEWER.id,
    );
    expect(rows.map((r) => r.action.text)).toEqual(["Changed a limit", "Workspace admin change"]);
  });

  it("words a box creation's failed step with its own line", () => {
    const [row] = buildRows(
      entries([
        raw({
          id: "r",
          action: "hosted.box_provision",
          details: {
            phase: "result",
            result: "failed",
            step: "ceiling_reached",
            linked_to: "q",
          },
        }),
        raw({
          id: "q",
          action: "hosted.box_provision",
          details: { phase: "requested" },
        }),
      ]),
      VIEWER.id,
    );
    expect([row.who, row.action.text, row.result.text]).toEqual([
      "Switch",
      "Created box",
      "Failed: the box limit was reached",
    ]);
  });

  it("hides progress entries and never names a workspace admin", () => {
    const rows = buildRows(
      entries([
        raw({
          id: "p",
          actor_user_id: "op-me",
          details: { phase: "progress", step: "scaled", linked_to: "q" },
        }),
        raw({
          id: "q",
          actor_user_id: "op-me",
          actor_name: "Jo Operator",
          action: "hosted.box_restarted",
          details: { phase: "requested", reason: "Stuck" },
        }),
        raw({
          id: "g",
          action: "operator.granted",
          target_type: "operator",
          target_id: "op-ren",
          details: { source: "config_file" },
        }),
      ]),
      VIEWER.id,
    );
    expect(rows.map((r) => [r.who, r.action.text, r.result.text])).toEqual([
      ["Jo Operator (you)", "Restarted box", "In progress"],
      ["Server settings", "Added operator", "—"],
    ]);
  });

  it("falls back to 'Switch operator' when Core gave no name", () => {
    const [row] = buildRows(
      entries([
        raw({
          id: "x",
          actor_user_id: "op-gone",
          details: { phase: "requested" },
        }),
      ]),
      VIEWER.id,
    );
    expect(row.who).toBe("Switch operator");
  });

  it("builds the query with every filter, and caps the id", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const url = new URL(
      auditQuery({
        action: "hosted.user_paused",
        id: "x".repeat(300),
        time: "30d",
        now,
      }),
      "https://x",
    );
    expect(url.searchParams.get("target_id")).toHaveLength(128);
    expect(url.searchParams.get("since")).toBe("2026-09-29T12:00:00.000Z");
  });

  it("shortens keyed ids for display only", () => {
    expect(shortId("k1-6d2c91f03ab2")).toBe("k1-6d2c");
    expect(shortId("op-ren")).toBe("op-ren");
  });
});
