import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answer, signedInAs } from "../../test/signedIn";
import ApiKeysPage from "./ApiKeysPage";
import { apiKey } from "./testFixtures";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

/** The items of a row's "…" menu, by label. */
async function menuOf(rowId: string, name: string): Promise<string[]> {
  fireEvent.click(within(await screen.findByTestId(`row-${rowId}`)).getByRole("button", { name: `Actions for ${name}` }));
  const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
  return items.map((item) => item.textContent ?? "");
}

const MINE = apiKey("mine", { owner_id: "u1", owner_name: "Ada" });
const THEIRS = apiKey("theirs", { owner_id: "u2", owner_name: "Grace", can_reveal: false });
const THEIR_AGENT = apiKey("their-agent", {
  type: "agent",
  label: "helper",
  owner_id: "u2",
  owner_name: "Grace",
  agent_id: "a2",
  agent_name: "helper-renamed",
  can_reveal: false,
  can_delete: false,
});

describe("ApiKeysPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an admin every key in the workspace, and copying only their own", async () => {
    signedInAs("admin");
    const calls = answer({ "GET /api-keys/workspace": [200, [MINE, THEIRS, THEIR_AGENT]] });
    render(<ApiKeysPage />);

    expect(await screen.findByText("The keys in Acme. Only a key's owner can copy it.")).toBeTruthy();
    expect(calls.map((call) => call.path)).toEqual(["/api-keys/workspace"]);
    expect(within(screen.getByTestId("row-theirs")).getByText("Grace")).toBeTruthy();
    expect(await menuOf("theirs", "theirs")).toEqual(["Delete"]);
    // Someone else's agent key: nothing to do with it, so no "…" at all.
    const agentRow = within(screen.getByTestId("row-their-agent"));
    expect(agentRow.getByText("helper-renamed")).toBeTruthy();
    expect(agentRow.queryByRole("button")).toBeNull();
  });

  it("shows a member only their own keys", async () => {
    signedInAs("member");
    const calls = answer({ "GET /api-keys": [200, [MINE]] });
    render(<ApiKeysPage />);

    expect(await screen.findByText("Your keys in Acme.")).toBeTruthy();
    expect(calls.map((call) => call.path)).toEqual(["/api-keys"]);
    expect(await menuOf("mine", "mine")).toEqual(["Copy key", "Delete"]);
    expect(screen.getByText("None of your agents has a key here")).toBeTruthy();
  });

  it("names an agent key whose agent is gone", async () => {
    signedInAs("member");
    answer({
      "GET /api-keys": [200, [apiKey("left", { type: "agent", label: "old-helper", owner_id: "u1" })]],
    });
    render(<ApiKeysPage />);

    expect(await screen.findByText("old-helper (agent deleted)")).toBeTruthy();
  });

  it("deletes someone else's key, saying whose it is", async () => {
    signedInAs("admin");
    const calls = answer({
      "GET /api-keys/workspace": [[200, [MINE, THEIRS]], [200, [MINE]]],
      "DELETE /api-keys/theirs": [200, { ok: true }],
    });
    render(<ApiKeysPage />);

    expect(await menuOf("theirs", "theirs")).toEqual(["Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Delete Grace's key "theirs"\? It stops working at once/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText('Deleted "theirs".')).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE" && call.path === "/api-keys/theirs")).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("row-theirs")).toBeNull());
  });

  it("copies the key, and says so when the browser refuses", async () => {
    signedInAs("member");
    answer({
      "GET /api-keys": [200, [MINE]],
      "GET /api-keys/mine/reveal": [200, { key: "the-secret" }],
    });
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ApiKeysPage />);

    await menuOf("mine", "mine");
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy key/ }));
    expect(await screen.findByText('Copied "mine".')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("the-secret");

    await menuOf("mine", "mine");
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy key/ }));
    expect(await screen.findByText("Your browser blocked the clipboard, so nothing was copied.")).toBeTruthy();
  });
});
