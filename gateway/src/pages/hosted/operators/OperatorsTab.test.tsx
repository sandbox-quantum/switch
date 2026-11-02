import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER, answer, renderTab } from "../w5shared/testing";
import OperatorsTab, {
  FOOTNOTE,
  LOAD_ERROR,
  OPERATORS_PATH,
  parseOperators,
  sinceDate,
} from "./OperatorsTab";

const refresh = vi.fn(async () => undefined);
vi.mock("../../../data/AuthContext", () => ({
  useAuth: () => ({ user: { id: "op-me", name: "Jo Operator" }, refresh }),
}));

const LIST = [
  {
    name: "Jo Operator",
    since: "2026-10-01T09:00:00+00:00",
    how: "server_settings",
    you: true,
  },
  {
    name: "Ren Ops",
    since: "2026-10-20T09:00:00+00:00",
    how: "server_settings",
    you: false,
  },
];

describe("the Operators tab", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    refresh.mockClear();
  });

  it("lists operators by name, with (you), since and how, read-only", async () => {
    const fetchMock = answer(200, LIST);
    renderTab(OperatorsTab);
    expect(await screen.findByText("Jo Operator (you)")).toBeTruthy();
    expect(screen.getByText("Ren Ops")).toBeTruthy();
    expect(screen.getAllByText("Server settings")).toHaveLength(2);
    expect(screen.getByText(FOOTNOTE)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe(OPERATORS_PATH);
    expect(init?.credentials).toBe("include");
  });

  it("shows only what the list says, as text", async () => {
    answer(200, [{ ...LIST[1], name: `<b>${MARKER}</b>`, how: "something_new" }]);
    const { container } = renderTab(OperatorsTab);
    await screen.findByText(`<b>${MARKER}</b>`);
    expect(container.querySelector("b")).toBeNull();
    // A "how" Core hasn't told the page about shows a dash, not the code.
    expect(screen.queryByText("something_new")).toBeNull();
  });

  it("shows 'Operators only' on a 403", async () => {
    answer(403, { detail: MARKER });
    const { container } = renderTab(OperatorsTab);
    expect(await screen.findByText("Operators only")).toBeTruthy();
    expect(container.innerHTML).not.toContain(MARKER);
  });

  it("asks the app to check the session again on a 401", async () => {
    answer(401, {});
    renderTab(OperatorsTab);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("shows the fixed load error on a 500", async () => {
    answer(500, { detail: MARKER });
    const { container } = renderTab(OperatorsTab);
    expect(await screen.findByText(LOAD_ERROR)).toBeTruthy();
    expect(container.innerHTML).not.toContain(MARKER);
  });
});

describe("the Operators tab's parts", () => {
  it("drops rows not in Core's shape", () => {
    expect(parseOperators([LIST[0], { name: 3, how: "x" }, null])?.map((o) => o.name)).toEqual([
      "Jo Operator",
    ]);
    expect(parseOperators({ operators: [] })).toBeNull();
  });

  it("writes the since date in the app's usual format, not the browser's locale", () => {
    expect(sinceDate("2026-10-01T12:00:00")).toBe("2026-10-01");
    expect(sinceDate(null)).toBe("—");
    expect(sinceDate("not a date")).toBe("—");
  });
});
