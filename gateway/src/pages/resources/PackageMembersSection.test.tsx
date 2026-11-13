import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCKED_ROW_HINT } from "../../components/RowAccess";
import { answerFetch } from "../../test/answerFetch";
import PackageMembersSection from "./PackageMembersSection";

const navigate = vi.fn();

vi.mock("react-router", () => ({
  useNavigate: () => navigate,
}));

const RUNBOOK = { id: "ref1", name: "Runbook", type: "github", type_display_name: "GitHub", can_read: true };

describe("PackageMembersSection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens what the viewer may read, and names the rest without a link", async () => {
    answerFetch({
      "GET /packages/p1/references": [
        200,
        [RUNBOOK, { id: "ref2", name: "Secret", type: "github", type_display_name: "GitHub", can_read: false }],
      ],
      "GET /packages/p1/documents": [200, [{ id: "doc1", name: "Private notes", can_read: false }]],
    });
    render(<PackageMembersSection packageId="p1" canMutate={false} />);

    fireEvent.click(await screen.findByTestId("package-reference-ref1"));
    expect(navigate).toHaveBeenCalledWith("/resources/references/ref1");
    navigate.mockClear();
    fireEvent.click(screen.getByTestId("package-reference-ref2"));
    fireEvent.click(await screen.findByTestId("package-document-doc1"));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Secret")).toBeTruthy();
    // Each private row says so with a lock; the one that opens doesn't.
    // As a screen reader finds it: an image, not hidden, that says why.
    expect(screen.getAllByRole("img", { name: LOCKED_ROW_HINT })).toHaveLength(2);
    expect(
      within(screen.getByTestId("package-reference-ref1")).queryByRole("img", {
        name: LOCKED_ROW_HINT,
      }),
    ).toBeNull();
  });

  it("asks before taking a member out, then counts the rooms that lost sight of it", async () => {
    const calls = answerFetch({
      "GET /packages/p1/references": [200, [RUNBOOK]],
      "GET /packages/p1/documents": [200, []],
      "DELETE /packages/p1/references/ref1": [
        200,
        {
          package_id: "p1",
          member_id: "ref1",
          affected_room_ids: ["r1"],
          affected_room_names: ["planning"],
          hidden_affected_rooms_count: 1,
        },
      ],
    });
    render(<PackageMembersSection packageId="p1" canMutate />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove Runbook from package" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove from package" });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await screen.findByText(
      "Removed. 2 room(s) lost visibility: planning, 1 private room you can't open",
    );
  });

  it("says why the members could not be loaded, rather than that there are none", async () => {
    answerFetch({
      "GET /packages/p1/references": [503, { detail: "The database is unavailable." }],
      "GET /packages/p1/documents": [200, []],
    });
    render(<PackageMembersSection packageId="p1" canMutate />);

    await screen.findByText("Couldn't load the package's references: The database is unavailable.");
    expect(screen.queryByText("No references in this package.")).toBeNull();
  });

  it("loads what may be added only when adding, and not at all for a reader", async () => {
    const calls = answerFetch({
      "GET /packages/p1/references": [200, [RUNBOOK]],
      "GET /packages/p1/documents": [200, []],
      "GET /references": [200, [RUNBOOK, { ...RUNBOOK, id: "ref3", name: "Roadmap" }]],
    });
    render(<PackageMembersSection packageId="p1" canMutate />);
    await screen.findByText("Runbook");
    expect(calls.some((call) => call.path === "/references")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Add references" }));
    const picker = await screen.findByRole("dialog", { name: "Add references" });
    expect(await within(picker).findByText("Roadmap")).toBeTruthy();
    // Already a member, so not offered again.
    expect(within(picker).queryByText("Runbook")).toBeNull();
  });
});
