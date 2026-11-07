import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import * as api from "../../data/api";
import * as hooks from "../../data/hooks";
import PackageMembersSection from "./PackageMembersSection";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
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
      returns([{ id: "ref1", name: "Runbook", type: "github", type_display_name: "GitHub" }]) as never,
    );
    vi.mocked(hooks.usePackageDocuments).mockReturnValue(returns([]) as never);
    vi.mocked(hooks.useReferences).mockReturnValue(returns([]) as never);
    vi.mocked(hooks.useDocuments).mockReturnValue(returns([]) as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
