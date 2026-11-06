import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REFRESH_MS, STALE } from "../overview/overview";
import { B1, U1, U3, U4, W2, boxRow, fixture, machineId } from "../overview/testing";
import { HostedContext } from "../HostedContext";
import { MARKER, answer, answers, renderTab } from "../w5shared/testing";
import BoxesTab, { BADGES, EMPTY, NO_MATCH } from "./BoxesTab";
import { BODY, PLACEHOLDER } from "./ShowNameDialog";

vi.mock("../../../data/AuthContext", () => ({
  useAuth: () => ({ user: { id: "op-me", name: "Jo Operator" }, refresh: vi.fn() }),
}));

function rows() {
  return screen.getAllByTestId("box-row");
}

/** A row by any text in it, or by an id's full grouped form (the id cell
 *  shows a short id, with the full one in its label). */
function rowOf(text: string) {
  const row = rows().find(
    (r) =>
      r.textContent?.includes(text) ||
      Array.from(r.querySelectorAll("[aria-label]")).some((el) =>
        el.getAttribute("aria-label")?.includes(text),
      ),
  );
  if (!row) throw new Error(`no row with ${text}`);
  return within(row);
}

describe("the Boxes tab (W4, p10)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows one row per box, hiding retired ones, with ids in display form", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderTab(BoxesTab, { overview: fixture() });
    expect(rows()).toHaveLength(4);
    const first = rowOf("k1-4f2a 91aa 0b1c");
    expect(first.getByLabelText("workspace k1-7c10 ab12 cd34")).toBeTruthy();
    expect(first.getByLabelText("person k1-a83e 91f0 c2d4")).toBeTruthy();
    expect(first.getByText("Running")).toBeTruthy();
    expect(first.getByText("shared-1 · eu-west-3a")).toBeTruthy();
    expect(first.getByText("1.9 GB")).toBeTruthy();
    expect(screen.queryByText(/k1-7aa0/)).toBeNull(); // retired
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a dash for no machine, agents or memory, every workspace, and the restarts", () => {
    renderTab(BoxesTab, { overview: fixture() });
    const paused = rowOf("k1-0e77 b5aa 0b1c");
    expect(paused.getAllByText("—")).toHaveLength(3);
    const two = rowOf("k1-c4d8 12aa 0b1c");
    expect(two.getByLabelText("workspace k1-2a44 ab12 cd34")).toBeTruthy();
    expect(two.getByLabelText("workspace k1-7c10 ab12 cd34")).toBeTruthy();
    expect(two.getByText("3")).toBeTruthy();
  });

  it("has a badge with the copy doc's words for every V4 state", () => {
    const raw = fixture();
    raw.boxes = (Object.keys(BADGES) as string[]).map((state, i) =>
      boxRow(`k1-${String(i).padStart(16, "0")}`, U1, [], state, null, null, 0),
    );
    renderTab(BoxesTab, { overview: raw });
    // "All" shows every state, put away included.
    fireEvent.click(screen.getByRole("button", { name: /^All / }));
    for (const { label } of Object.values(BADGES)) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText("Can't start")).toBeTruthy();
    expect(screen.queryByText("Restarting")).toBeNull();
  });

  it("gives each row W6's actions: Resume for a paused user, Restart only when running", () => {
    renderTab(BoxesTab, { overview: fixture() });
    const running = rowOf("k1-4f2a 91aa 0b1c");
    expect(running.getByRole("button", { name: "Pause user" })).toBeTruthy();
    expect(running.getByRole("button", { name: "Restart box" })).toBeTruthy();
    const paused = rowOf("k1-0e77 b5aa 0b1c");
    expect(paused.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(paused.queryByRole("button", { name: "Restart box" })).toBeNull();
    const starting = rowOf("k1-c4d8 12aa 0b1c"); // its user isn't in people: not paused
    expect(starting.getByRole("button", { name: "Pause user" })).toBeTruthy();
    expect(starting.queryByRole("button", { name: "Restart box" })).toBeNull();
  });

  it("refreshes the overview after an action is accepted", async () => {
    const refresh = vi.fn(async () => undefined);
    const fetchMock = answer(200, { action_id: "a1" });
    renderTab(BoxesTab, { overview: fixture(), refresh });
    fireEvent.click(rowOf("k1-4f2a 91aa 0b1c").getByRole("button", { name: "Pause user" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "abuse report 42" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause user" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/shared-cloud/users/${U1}/pause`);
  });

  it("lists a paused user with no box under the table, with Resume", () => {
    renderTab(BoxesTab, { overview: fixture() });
    const waiting = screen.getAllByTestId("paused-without-box");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].textContent).toContain(`k1-30f7 0000 1111`);
    expect(screen.getAllByText(/k1-30f7/)).toHaveLength(1); // not in the table: no box
    expect(U4.startsWith("k1-30f7")).toBe(true);
  });

  it("says when there are no boxes, and shows the stale line", () => {
    renderTab(BoxesTab, { overview: { ...fixture(), boxes: [] }, overviewStale: true });
    expect(screen.getByText(EMPTY)).toBeTruthy();
    expect(screen.getByText(STALE)).toBeTruthy();
  });

  it("asks the shell for a fresh overview every 30 seconds", () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    renderTab(BoxesTab, { overview: fixture(), refresh });
    act(() => vi.advanceTimersByTime(REFRESH_MS * 2));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("never renders a field W4 doesn't show (the marker search)", () => {
    const { container } = renderTab(BoxesTab, { overview: fixture() });
    expect(container.innerHTML).not.toContain(MARKER);
  });
});

describe("Show name (W4, p15)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** The row's user Show name: the last one, after the workspaces'. */
  function open(row = "k1-0e77 b5aa 0b1c") {
    const links = rowOf(row).getAllByRole("button", { name: "Show name" });
    fireEvent.click(links[links.length - 1]);
  }

  it("needs a reason: the button is disabled until there's text", () => {
    renderTab(BoxesTab, { overview: fixture() });
    open();
    expect(screen.getByText("Show the user's name for k1-f019 c27d 0b51?")).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();
    const confirm = screen.getAllByRole("button", { name: "Show name" }).at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: "ticket 9" } });
    expect(confirm.disabled).toBe(false);
  });

  it("sends the reason only in the body, then shows the name in that row only", async () => {
    const fetchMock = answer(200, { name: "Alex Example", email: "alex@example.com" });
    renderTab(BoxesTab, { overview: fixture() });
    open();
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
      target: { value: "ticket 9 reason-text" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Show name" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("revealed-name")).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/shared-cloud\/reveal$/);
    expect(String(url)).not.toContain("reason-text");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "user",
      keyed_id: U3,
      reason: "ticket 9 reason-text",
    });
    expect(rowOf("k1-0e77 b5aa 0b1c").getByText("Alex Example")).toBeTruthy();
    // Name only: the email Core sends never reaches the page (designer).
    expect(document.body.innerHTML).not.toContain("alex@example.com");
    expect(screen.getAllByTestId("revealed-name")).toHaveLength(1);
    expect(rowOf("k1-4f2a 91aa 0b1c").getAllByRole("button", { name: "Show name" })).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain("reason-text");
  });

  it("forgets the name when the tab is left", async () => {
    answer(200, { name: "Alex Example", email: null });
    const { unmount } = renderTab(BoxesTab, { overview: fixture() });
    open();
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: "ticket 9" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Show name" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByText("Alex Example")).toBeTruthy());
    unmount();
    renderTab(BoxesTab, { overview: fixture() });
    expect(screen.queryByText("Alex Example")).toBeNull();
  });

  it.each([
    [403, "Operators only"],
    [404, "No one with that id has a box."],
    [422, "The reason wasn't accepted. Use up to 500 characters, with no names, messages or secrets."],
    [429, "You've reached the hourly limit for showing names. Try again later."],
    [500, "That didn't go through. Reload the page and try again."],
  ])("shows a %s as its fixed line, never the server's text", async (status, line) => {
    answers({ status, body: { detail: `server says ${MARKER}` } });
    renderTab(BoxesTab, { overview: fixture() });
    open();
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: "ticket 9" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Show name" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(line));
    expect(document.body.innerHTML).not.toContain(MARKER);
    expect(screen.queryByTestId("revealed-name")).toBeNull();
  });

  it("shows a workspace's name beside it wherever it appears", async () => {
    const fetchMock = answer(200, { name: "Example Team", email: null });
    renderTab(BoxesTab, { overview: fixture() });
    // The first Show name in B3's row is its workspace's (W2).
    fireEvent.click(rowOf("k1-0e77 b5aa 0b1c").getAllByRole("button", { name: "Show name" })[0]);
    expect(screen.getByText("Show the workspace name for k1-2a44 ab12 cd34?")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: "ticket 9" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Show name" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getAllByText("Example Team")).toHaveLength(2));
    // MUI hides the page from role queries until the dialog has finished closing.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      kind: "workspace",
      keyed_id: W2,
      reason: "ticket 9",
    });
    // Both rows with W2 show it; the user beside it still offers Show name.
    expect(rowOf("k1-c4d8 12aa 0b1c").getByText("Example Team")).toBeTruthy();
    expect(rowOf("k1-0e77 b5aa 0b1c").getAllByRole("button", { name: "Show name" })).toHaveLength(1);
  });

  it("never shows the marker with the dialog open or after a reveal, nor a field Core adds", async () => {
    answer(200, { name: "Alex Example", email: null });
    const raw = fixture();
    raw.boxes = (raw.boxes as Record<string, unknown>[]).map((b) => ({ ...b, added_later: MARKER }));
    renderTab(BoxesTab, { overview: raw });
    open();
    expect(document.body.innerHTML).not.toContain(MARKER);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: "ticket 9" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Show name" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByText("Alex Example")).toBeTruthy());
    expect(document.body.innerHTML).not.toContain(MARKER);
  });

  it("has its own 404 line for a workspace", async () => {
    answers({ status: 404, body: { detail: `server says ${MARKER}` } });
    renderTab(BoxesTab, { overview: fixture() });
    fireEvent.click(rowOf("k1-0e77 b5aa 0b1c").getAllByRole("button", { name: "Show name" })[0]);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: "ticket 9" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Show name" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("No workspace with that id has a box."),
    );
  });

  it("keeps buttons and the machine on one line, with the table scrolling sideways", () => {
    renderTab(BoxesTab, { overview: fixture() });
    const table = screen.getByRole("table", { name: "Boxes" });
    expect(getComputedStyle(table.parentElement as HTMLElement).overflowX).toBe("auto");
    const cell = rowOf("k1-4f2a 91aa 0b1c").getByText("shared-1 · eu-west-3a").closest("td");
    expect(getComputedStyle(cell as HTMLElement).whiteSpace).toBe("nowrap");
  });

  it("clears the reason on Cancel", () => {
    renderTab(BoxesTab, { overview: fixture() });
    open();
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: "ticket 9" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    open();
    expect((screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement).value).toBe("");
  });
});

describe("the Boxes filter bar and rows (UX, operators 3 and 5)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function withRows(): Record<string, unknown> {
    const raw = fixture();
    const boxes = raw.boxes as Record<string, unknown>[];
    boxes[0] = {
      ...boxes[0],
      awake: { running: 3, max: 12 },
      memory_total_bytes: 4 * 1024 ** 3,
    };
    boxes[4] = { ...boxes[4], retain_until: "2026-11-20T00:00:00+00:00" };
    return raw;
  }

  function chip(name: RegExp) {
    return screen.getByRole("button", { name });
  }

  it("defaults to Current, with a count on every chip", () => {
    renderTab(BoxesTab, { overview: withRows() });
    expect(rows()).toHaveLength(4);
    expect(chip(/^Current 4$/).getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^Put away 1$/)).toBeTruthy();
    expect(chip(/^All 5$/)).toBeTruthy();
  });

  it("shows put-away boxes only under Put away and All, greyed, with when they go", () => {
    renderTab(BoxesTab, { overview: withRows() });
    fireEvent.click(chip(/^Put away/));
    expect(rows()).toHaveLength(1);
    const put = rowOf("k1-7aa0 31aa 0b1c");
    expect(put.getByText("Put away")).toBeTruthy();
    expect(put.getByText("Kept until 20 Nov")).toBeTruthy();
    // No actions on a put-away box.
    expect(put.queryByRole("button", { name: "Pause user" })).toBeNull();
    expect(getComputedStyle(rows()[0]).opacity).toBe("0.6");
    fireEvent.click(chip(/^All/));
    expect(rows()).toHaveLength(5);
  });

  it("searches ids and machines, and says when nothing matches", () => {
    renderTab(BoxesTab, { overview: withRows() });
    fireEvent.change(screen.getByRole("textbox", { name: "Search boxes" }), {
      target: { value: "k1-0e77 b5aa" },
    });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Search boxes" }), {
      target: { value: "nothing like this" },
    });
    expect(screen.queryAllByTestId("box-row")).toHaveLength(0);
    expect(screen.getByText(NO_MATCH)).toBeTruthy();
  });

  it("reads its filters from the address, so a view can be shared", () => {
    render(
      <MemoryRouter initialEntries={["/hosted/boxes?state=resting&q=k1-91c0"]}>
        <HostedContext.Provider
          value={{
            operator: { id: "op-me", name: "Jo" } as never,
            overview: withRows(),
            overviewStale: false,
            refreshKey: 0,
            refresh: async () => undefined,
          }}
        >
          <BoxesTab />
        </HostedContext.Provider>
      </MemoryRouter>,
    );
    expect(rows()).toHaveLength(1);
    expect(chip(/^Resting/).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("textbox", { name: "Search boxes" }) as HTMLInputElement).value).toBe(
      "k1-91c0",
    );
  });

  it("shows awake agents and memory as the panel words them, and links to the detail pages", () => {
    renderTab(BoxesTab, { overview: withRows() });
    const first = rowOf("k1-4f2a 91aa 0b1c");
    expect(first.getByText("3 of 12 awake")).toBeTruthy();
    expect(first.getByText("1.9 GB of 4.0 GB")).toBeTruthy();
    expect(first.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      `/hosted/boxes/${encodeURIComponent(B1)}`,
    );
    expect(first.getByRole("link", { name: "shared-1 · eu-west-3a" }).getAttribute("href")).toBe(
      `/hosted/machines/${machineId("shared-1")}`,
    );
  });
});
