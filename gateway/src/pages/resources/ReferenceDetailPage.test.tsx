import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { type Answer, answerFetch } from "../../test/answerFetch";
import ReferenceDetailPage from "./ReferenceDetailPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const REF: ReferenceDetail = {
  id: "r1",
  owner_id: "u1",
  owner_name: "Ada",
  read_visibility: "public",
  write_visibility: "private",
  type: "github",
  name: "Monorepo",
  description: "All of it",
  instructions: "",
  value: { urls: ["https://github.com/example/repo"] },
  attached_rooms_count: 0,
  hidden_rooms_count: 0,
  packages: ["p1", "p-hidden"],
  created_at: "2026-10-01T00:00:00Z",
  type_display_name: "GitHub",
  can_read: true,
  can_edit: true,
  can_manage: true,
};

function signedInAs({ admin }: { admin: boolean }) {
  vi.mocked(useAuth).mockReturnValue({
    session: { tenant: { id: "t1" } },
    capabilities: { administersWorkspace: admin },
  } as unknown as ReturnType<typeof useAuth>);
}

/** The reads a reference's page makes besides the reference itself. */
const PAGE_READS: Record<string, Answer> = {
  "GET /references/reference-types": [200, []],
  "GET /references/r1/rooms": [200, []],
  "GET /packages": [200, [{ id: "p1", name: "Onboarding", description: "" }]],
  "GET /tenants/t1/members": [200, [{ user_id: "u1", name: "Ada", email: "ada@example.com", can_receive_transfer: true }, { user_id: "u2", name: "Grace", email: "grace@example.com", can_receive_transfer: true }]],
};

async function transferToGrace() {
  fireEvent.click(await screen.findByRole("button", { name: "Transfer ownership" }));
  fireEvent.mouseDown(await screen.findByRole("combobox", { name: "New owner" }));
  fireEvent.click(await screen.findByRole("option", { name: /Grace/ }));
  fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function GoToR2() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/resources/references/r2")}>
      Go to r2
    </button>
  );
}

const show = () =>
  render(
    <MemoryRouter initialEntries={["/resources/references/r1"]}>
      <GoToR2 />
      <Routes>
        <Route path="/resources/references/:id" element={<ReferenceDetailPage />} />
        <Route path="/resources" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe("ReferenceDetailPage", () => {
  beforeEach(() => signedInAs({ admin: false }));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says why it could not open, and goes back to the references", async () => {
    answerFetch({ "GET /references/r1": [403, { detail: "You can't read this reference." }] });
    show();

    expect(await screen.findByText("Couldn't open this reference: You can't read this reference.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to references" }));
    expect(screen.getByTestId("where").textContent).toBe("/resources?tab=references");
  });

  it("will not save it without a name or a URL", async () => {
    answerFetch({
      "GET /references/r1": [200, REF],
      "GET /references/reference-types": [200, []],
      "GET /references/r1/rooms": [200, []],
      "GET /packages": [200, []],
    });
    show();

    const name = await screen.findByDisplayValue("Monorepo");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.change(name, { target: { value: " " } });
    expect(save.disabled).toBe(true);
    expect(screen.getByText("Required.")).toBeTruthy();

    fireEvent.change(name, { target: { value: "Monorepo" } });
    fireEvent.change(screen.getByLabelText("URLs (one per line)"), { target: { value: "" } });
    expect(save.disabled).toBe(true);
  });

  it("counts the packages it is in that the viewer can't open, without naming them", async () => {
    answerFetch({
      "GET /references/r1": [200, REF],
      "GET /references/reference-types": [200, []],
      "GET /references/r1/rooms": [200, []],
      "GET /packages": [200, [{ id: "p1", name: "Onboarding", description: "" }]],
    });
    show();

    expect(await screen.findByText("Onboarding")).toBeTruthy();
    expect(screen.getByText("1 private package you can't open")).toBeTruthy();
    expect(screen.queryByText("p-hidden")).toBeNull();
  });

  it("drops one reference's page when moving to another, rather than show it while the next loads", async () => {
    let answerR2: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input).replace(/^\/gateway/, "").split("?")[0];
        if (path === "/references/r1") return new Response(JSON.stringify(REF), { status: 200 });
        if (path === "/references/r2") return new Promise<Response>((resolve) => (answerR2 = resolve));
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    show();
    await screen.findByDisplayValue("Monorepo");

    fireEvent.click(screen.getByRole("button", { name: "Go to r2" }));
    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect(screen.queryByDisplayValue("Monorepo")).toBeNull();

    answerR2(new Response(JSON.stringify({ ...REF, id: "r2", name: "Roadmap" }), { status: 200 }));
    expect(await screen.findByDisplayValue("Roadmap")).toBeTruthy();
  });

  it("offers a workspace admin each private package it is in as a link, as they can open it", async () => {
    signedInAs({ admin: true });
    answerFetch({ "GET /references/r1": [200, REF], ...PAGE_READS });
    show();

    expect(await screen.findByText("Onboarding")).toBeTruthy();
    expect(screen.getByText("Someone's private package")).toBeTruthy();
    expect(screen.queryByText(/you can't open/)).toBeNull();
  });

  it("goes back to the list when a transfer leaves the reference out of the viewer's sight", async () => {
    answerFetch({
      "GET /references/r1": [[200, REF], [403, { detail: "Not authorized to read this resource" }]],
      "POST /ownership/transfer": [200, { kind: "reference", id: "r1", new_owner_id: "u2" }],
      ...PAGE_READS,
    });
    show();

    await transferToGrace();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/resources?tab=references"));
  });

  it("stays, and says so, when a transfer went through but the page could not be refreshed", async () => {
    answerFetch({
      "GET /references/r1": [[200, REF], [503, { detail: "The database is unavailable." }]],
      "POST /ownership/transfer": [200, { kind: "reference", id: "r1", new_owner_id: "u2" }],
      ...PAGE_READS,
    });
    show();

    await transferToGrace();
    expect(
      await screen.findByText(/Transferred, but this page couldn't be refreshed: The database is unavailable/),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Monorepo")).toBeTruthy();
  });
});
