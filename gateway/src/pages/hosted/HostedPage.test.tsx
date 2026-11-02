import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHosted } from "./HostedContext";
import HostedPage, { HEADING, LINE, LOAD_ERROR } from "./HostedPage";
import HostedRefusal from "./HostedRefusal";
import { ACCESS_PATH } from "./hostedAccess";
import { type HostedTab, TAB_ORDER, orderedTabs } from "./hostedTabs";

const refreshSession = vi.fn(async () => undefined);

vi.mock("../../data/AuthContext", () => ({
  useAuth: vi.fn(() => ({ user: { id: "op-1", name: "Jo Operator" }, refresh: refreshSession })),
}));

const MARKER = "zz-marker-5c1e";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function Alerts() {
  const { operator, overview, overviewStale, refreshKey, refresh } = useHosted();
  const boxes = (overview as { boxes?: unknown[] } | null)?.boxes?.length ?? "none";
  return (
    <div>
      <p>alerts for {operator.name}</p>
      <p>refreshed {refreshKey}</p>
      <p>boxes {String(boxes)}</p>
      <p>stale {String(overviewStale)}</p>
      <button onClick={() => void refresh()}>refresh</button>
    </div>
  );
}

function AuditEvent() {
  return <p>event {useParams().eventId}</p>;
}

function Audit() {
  return (
    <Routes>
      <Route index element={<p>audit list</p>} />
      <Route path=":eventId" element={<AuditEvent />} />
    </Routes>
  );
}

function Boxes() {
  return <p>boxes body</p>;
}

// Listed out of p10's order on purpose.
const TABS: HostedTab[] = [
  { key: "audit", label: "Audit log", component: Audit },
  { key: "alerts", label: "Alerts", component: Alerts },
  { key: "boxes", label: "Boxes", component: Boxes },
];

function answer(status: number, body: unknown = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string, tabs: HostedTab[] = TABS) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="hosted/*" element={<HostedPage tabs={tabs} />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

describe("the Hosted shell", () => {
  beforeEach(() => {
    answer(200);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    refreshSession.mockClear();
  });

  it("shows p10's heading and line, and nothing else, while it checks access", async () => {
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    renderAt("/hosted/boxes");
    expect(screen.getByRole("heading", { name: HEADING })).toBeTruthy();
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("boxes body")).toBeNull();
    await act(async () => release(new Response("{}", { status: 200 })));
    expect(await screen.findByText("boxes body")).toBeTruthy();
  });

  it("checks access once, with the operator overview and the session cookie", async () => {
    const fetchMock = answer(200);
    renderAt("/hosted/boxes");
    await screen.findByText("boxes body");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(ACCESS_PATH);
    expect(init.credentials).toBe("include");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("shows tabs in p10's order, whatever order the table lists them in", async () => {
    renderAt("/hosted/boxes");
    await screen.findByText("boxes body");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Boxes",
      "Alerts",
      "Audit log",
    ]);
  });

  it("sends /hosted and an unknown tab to the first tab", async () => {
    renderAt("/hosted");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/hosted/boxes"));
    cleanup();
    renderAt("/hosted/nonsense");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/hosted/boxes"));
    expect(screen.getByText("boxes body")).toBeTruthy();
  });

  it("moves between tabs by URL", async () => {
    renderAt("/hosted/boxes");
    await screen.findByText("boxes body");
    fireEvent.click(screen.getByRole("tab", { name: "Alerts" }));
    expect(await screen.findByText("alerts for Jo Operator")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/hosted/alerts");
    expect(screen.queryByText("boxes body")).toBeNull();
  });

  it("lets a tab route its own sub-pages", async () => {
    renderAt("/hosted/audit/ev-42");
    expect(await screen.findByText("event ev-42")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Audit log" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("gives tabs the operator and a shared refresh", async () => {
    renderAt("/hosted/alerts");
    expect(await screen.findByText("refreshed 0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(await screen.findByText("refreshed 1")).toBeTruthy();
  });

  it("checks access once when landing on /hosted", async () => {
    const fetchMock = answer(200);
    renderAt("/hosted");
    await screen.findByText("boxes body");
    expect(screen.getByTestId("where").textContent).toBe("/hosted/boxes");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands tabs the access check's overview, and refresh fetches it again", async () => {
    const fetchMock = answer(200, { boxes: [1, 2] });
    renderAt("/hosted/alerts");
    expect(await screen.findByText("boxes 2")).toBeTruthy();
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ boxes: [1, 2, 3] }), { status: 200 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(await screen.findByText("boxes 3")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last overview, marked stale, when a refresh fails", async () => {
    const fetchMock = answer(200, { boxes: [1, 2] });
    renderAt("/hosted/alerts");
    expect(await screen.findByText("boxes 2")).toBeTruthy();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(await screen.findByText("stale true")).toBeTruthy();
    expect(screen.getByText("boxes 2")).toBeTruthy();
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
  });

  it("shows 'Operators only' when a refresh comes back 403", async () => {
    const fetchMock = answer(200, { boxes: [] });
    renderAt("/hosted/alerts");
    await screen.findByText("boxes 0");
    fetchMock.mockImplementation(async () => new Response("{}", { status: 403 }));
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(await screen.findByText("Operators only")).toBeTruthy();
    expect(screen.queryByText("boxes 0")).toBeNull();
  });

  it("sends a 401 to sign-in through the app's own session check, with no line", async () => {
    answer(401, { detail: MARKER });
    const { container } = renderAt("/hosted/boxes");
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Operators only")).toBeNull();
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(container.innerHTML).not.toContain(MARKER);
  });

  it("lets the tab bar scroll, so seven tabs fit a narrow window", async () => {
    const { container } = renderAt("/hosted/boxes");
    await screen.findByText("boxes body");
    expect(container.querySelector(".MuiTabs-scrollableX")).not.toBeNull();
  });

  it("shows only 'Operators only' on a 403, never the server's text", async () => {
    answer(403, { detail: MARKER });
    const { container } = renderAt("/hosted/boxes");
    expect(await screen.findByText("Operators only")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("boxes body")).toBeNull();
    expect(container.innerHTML).not.toContain(MARKER);
  });

  it.each([404, 500, 503])("shows the fixed load error on a %i", async (status) => {
    answer(status, { detail: MARKER });
    const { container } = renderAt("/hosted/boxes");
    expect(await screen.findByText(LOAD_ERROR)).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(container.innerHTML).not.toContain(MARKER);
  });

  it("shows the fixed load error when the server can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(MARKER);
      }),
    );
    const { container } = renderAt("/hosted/boxes");
    expect(await screen.findByText(LOAD_ERROR)).toBeTruthy();
    expect(container.innerHTML).not.toContain(MARKER);
  });

  it("shows just the heading when no tab is built yet", async () => {
    renderAt("/hosted", []);
    await waitFor(() => expect(screen.queryByLabelText("Loading")).toBeNull());
    expect(screen.getByRole("heading", { name: HEADING })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/hosted");
  });
});

describe("the Hosted shell's parts", () => {
  afterEach(cleanup);

  it("orders tabs by p10 and drops duplicates", () => {
    const one: HostedTab = { key: "boxes", label: "Boxes", component: Boxes };
    const two: HostedTab = { key: "boxes", label: "Boxes again", component: Boxes };
    const overview: HostedTab = { key: "overview", label: "Overview", component: Boxes };
    expect(orderedTabs([one, overview, two]).map((t) => t.label)).toEqual(["Overview", "Boxes"]);
    expect(TAB_ORDER).toEqual([
      "overview",
      "boxes",
      "machines",
      "isolation",
      "alerts",
      "audit",
      "operators",
    ]);
  });

  it("refuses useHosted outside the page", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Alerts />)).toThrow("useHosted must be used inside the Hosted page");
    vi.restoreAllMocks();
  });

  it("has one fixed refusal line", () => {
    render(<HostedRefusal />);
    expect(screen.getByRole("status").textContent).toBe("Operators only");
  });
});
