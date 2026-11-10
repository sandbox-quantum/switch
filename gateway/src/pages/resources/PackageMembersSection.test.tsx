import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import { LOCKED_ROW_HINT } from "../../components/RowAccess";
import PackageMembersSection from "./PackageMembersSection";

const navigate = vi.fn();

vi.mock("react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../../data/hooks", () => ({
  useDocuments: vi.fn(),
  usePackageDocuments: vi.fn(),
  usePackageReferences: vi.fn(),
  useReferences: vi.fn(),
}));

vi.mock("../../data/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/api")>();
  return { ...actual, removeReferenceFromPackage: vi.fn() };
});

function returns<T>(data: T) {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

describe("PackageMembersSection", () => {
  beforeEach(() => {
    vi.mocked(hooks.usePackageReferences).mockReturnValue(
      returns([
        { id: "ref1", name: "Runbook", type: "github", type_display_name: "GitHub", can_read: true },
      ]) as never,
    );
    vi.mocked(hooks.usePackageDocuments).mockReturnValue(returns([]) as never);
    vi.mocked(hooks.useReferences).mockReturnValue(returns([]) as never);
    vi.mocked(hooks.useDocuments).mockReturnValue(returns([]) as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens what the viewer may read, and names the rest without a link", () => {
    vi.mocked(hooks.usePackageReferences).mockReturnValue(
      returns([
        { id: "ref1", name: "Runbook", type: "github", type_display_name: "GitHub", can_read: true },
        { id: "ref2", name: "Secret", type: "github", type_display_name: "GitHub", can_read: false },
      ]) as never,
    );
    vi.mocked(hooks.usePackageDocuments).mockReturnValue(
      returns([{ id: "doc1", name: "Private notes", can_read: false }]) as never,
    );
    render(<PackageMembersSection packageId="p1" canMutate={false} />);

    fireEvent.click(screen.getByTestId("package-reference-ref1"));
    expect(navigate).toHaveBeenCalledWith("/resources/references/ref1");
    navigate.mockClear();
    fireEvent.click(screen.getByTestId("package-reference-ref2"));
    fireEvent.click(screen.getByTestId("package-document-doc1"));
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

  it("counts rooms that lost sight of a member, naming only readable ones", async () => {
    vi.mocked(api.removeReferenceFromPackage).mockResolvedValue({
      package_id: "p1",
      member_id: "ref1",
      affected_room_ids: ["r1"],
      affected_room_names: ["planning"],
      hidden_affected_rooms_count: 1,
    });
    render(<PackageMembersSection packageId="p1" canMutate />);

    fireEvent.click(screen.getByRole("button", { name: "Remove Runbook from package" }));

    await screen.findByText(
      "Removed. 2 room(s) lost visibility: planning, 1 private room you can't open",
    );
  });
});
