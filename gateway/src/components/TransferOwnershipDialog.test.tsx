import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../data/AuthContext";
import { answerFetch } from "../test/answerFetch";
import { TransferOwnershipDialog } from "./TransferOwnershipSection";

vi.mock("../data/AuthContext", () => ({ useAuth: vi.fn() }));

describe("TransferOwnershipDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says when there is no one else to give it to, rather than offer an empty list", async () => {
    vi.mocked(useAuth).mockReturnValue({ session: { tenant: { id: "t1" } } } as unknown as ReturnType<typeof useAuth>);
    answerFetch({ "GET /tenants/t1/members": [200, [{ user_id: "u1", can_receive_transfer: true }]] });
    render(
      <TransferOwnershipDialog
        kind="reference"
        resourceId="r1"
        resourceLabel="Monorepo"
        ownerId="u1"
        onClose={vi.fn()}
        onTransferred={vi.fn()}
      />,
    );

    expect(await screen.findByText("There is no one else in this workspace to give it to.")).toBeTruthy();
    expect(screen.queryByLabelText("New owner")).toBeNull();
  });
});
