import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceDetail } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { answerFetch } from "../../test/answerFetch";
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

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

const show = () =>
  render(
    <MemoryRouter initialEntries={["/resources/references/r1"]}>
      <Routes>
        <Route path="/resources/references/:id" element={<ReferenceDetailPage />} />
        <Route path="/resources" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

describe("ReferenceDetailPage", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({ session: null } as unknown as ReturnType<typeof useAuth>);
  });

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
});
