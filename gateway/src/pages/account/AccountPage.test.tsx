import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import AccountPage from "./AccountPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const auth = {
  logout: vi.fn(async () => {}),
  logoutEverywhere: vi.fn(async () => {}),
  recheck: vi.fn(),
};

function signedIn() {
  vi.mocked(useAuth).mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
}

const me = (overrides: Partial<Me> = {}): Me => ({
  id: "u1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  role: "user",
  created_at: "2026-11-01",
  has_password: true,
  ...overrides,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Each `METHOD /path` answers its body with 200, or `[status, body]`. */
function answer(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/gateway/, "").split("?")[0];
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${method} ${path}`;
      if (!(key in routes))
        return new Response(JSON.stringify({ detail: `unmocked ${key}` }), { status: 404 });
      const route = routes[key];
      const [status, body] = Array.isArray(route) ? route : [200, route];
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

async function openDelete() {
  fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));
  return screen.findByRole("dialog");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Your account", () => {
  it("shows the name to edit and the email only to read", async () => {
    signedIn();
    answer({ "GET /auth/me": me() });
    render(<AccountPage />);
    expect(((await screen.findByLabelText("Display name")) as HTMLInputElement).value).toBe(
      "Ada Lovelace",
    );
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ada@example.test");
    expect(screen.getByRole("button", { name: "Change display name" })).toBeTruthy();
    expect(screen.getAllByRole("button").some((b) => /email/i.test(b.textContent ?? ""))).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
  });

  it("offers no password change to an account made through single sign-on", async () => {
    signedIn();
    answer({ "GET /auth/me": me({ has_password: false }) });
    render(<AccountPage />);
    await screen.findByLabelText("Display name");
    expect(screen.queryByRole("region", { name: "Password" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
  });

  it("says so when the account can't be read", async () => {
    signedIn();
    answer({ "GET /auth/me": [500, { detail: "Database unavailable" }] });
    render(<AccountPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Database unavailable");
  });

  it("renames you, and reads the session again for everywhere else the name shows", async () => {
    signedIn();
    const calls = answer({
      "GET /auth/me": me(),
      "PATCH /auth/me": me({ name: "Ada King" }),
    });
    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change display name" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "  Ada King " } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText("Display name changed to Ada King.")).toBeTruthy();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Ada King");
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Ada King" });
    expect(auth.recheck).toHaveBeenCalledTimes(1);
  });

  it("keeps the edit open with the reason when a rename is refused", async () => {
    signedIn();
    answer({
      "GET /auth/me": me(),
      "PATCH /auth/me": [422, { detail: "Name is too long" }],
    });
    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change display name" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada King" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText("Name is too long")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
    expect(auth.recheck).not.toHaveBeenCalled();
  });

  it("signs out of this browser, or of every device", async () => {
    signedIn();
    answer({ "GET /auth/me": me() });
    render(<AccountPage />);
    const card = within(await screen.findByRole("region", { name: "Sign out" }));
    fireEvent.click(card.getByRole("button", { name: "Sign out" }));
    expect(auth.logout).toHaveBeenCalledTimes(1);
    fireEvent.click(card.getByRole("button", { name: "Sign out of all devices" }));
    expect(auth.logoutEverywhere).toHaveBeenCalledTimes(1);
  });
});

describe("Deleting your account", () => {
  it("says up front what stands in the way, in place of the form", async () => {
    signedIn();
    const reason =
      "You're the only organization admin of Acme Group, which has other users. Make one of them an organization admin first.";
    const calls = answer({
      "GET /auth/me": me(),
      "GET /auth/me/deletion": { refusal: reason },
    });
    render(<AccountPage />);
    const dialog = within(await openDelete());
    expect(await dialog.findByText(reason)).toBeTruthy();
    expect(dialog.getByText("You can't delete your account yet")).toBeTruthy();
    expect(dialog.queryByRole("textbox")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Delete account" })).toBeNull();
    fireEvent.click(dialog.getAllByRole("button", { name: "Close" })[1]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes once the email is typed, then signs out on closing", async () => {
    signedIn();
    const calls = answer({
      "GET /auth/me": me(),
      "GET /auth/me/deletion": { refusal: null },
      "DELETE /auth/me": { ok: true },
    });
    render(<AccountPage />);
    const dialog = within(await openDelete());
    const field = await dialog.findByLabelText("Type ada@example.test to confirm");
    const confirm = dialog.getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "ada@example" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: " ADA@example.test " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await dialog.findByText("Your account is deleted")).toBeTruthy();
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ email: "ADA@example.test" });
    expect(auth.logout).not.toHaveBeenCalled();
    fireEvent.click(dialog.getAllByRole("button", { name: "Close" })[1]);
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open with the reason when the deletion is refused after all", async () => {
    signedIn();
    const reason = "You're the only admin of Acme, which has other users. Make one of them an admin first.";
    answer({
      "GET /auth/me": me(),
      "GET /auth/me/deletion": { refusal: null },
      "DELETE /auth/me": [409, { detail: reason }],
    });
    render(<AccountPage />);
    const dialog = within(await openDelete());
    fireEvent.change(await dialog.findByLabelText("Type ada@example.test to confirm"), {
      target: { value: "ada@example.test" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Delete account" }));
    expect(await dialog.findByText(reason)).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Delete account" })).toBeTruthy();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it("still lets you go ahead when the check itself fails, saying it didn't run", async () => {
    signedIn();
    answer({
      "GET /auth/me": me(),
      "GET /auth/me/deletion": [500, { detail: "Internal Server Error" }],
      "DELETE /auth/me": { ok: true },
    });
    render(<AccountPage />);
    const dialog = within(await openDelete());
    expect((await dialog.findByText(/Couldn't check beforehand/)).textContent).toContain(
      "Internal Server Error",
    );
    fireEvent.change(dialog.getByLabelText("Type ada@example.test to confirm"), {
      target: { value: "ada@example.test" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Delete account" }));
    expect(await dialog.findByText("Your account is deleted")).toBeTruthy();
  });

  it("asks again each time it opens", async () => {
    signedIn();
    const calls = answer({
      "GET /auth/me": me(),
      "GET /auth/me/deletion": { refusal: null },
    });
    render(<AccountPage />);
    const dialog = within(await openDelete());
    await dialog.findByLabelText("Type ada@example.test to confirm");
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openDelete();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/auth/me/deletion")).toHaveLength(2),
    );
  });
});
