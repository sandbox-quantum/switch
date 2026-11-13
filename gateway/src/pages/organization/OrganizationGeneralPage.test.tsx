import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurrentOrganization } from "../../data/api";
import { useOrganizationRenamed } from "../../data/organizationEvents";
import { answerFetch } from "../../test/answerFetch";
import { OrganizationGeneralPage } from "./OrganizationPage";

vi.mock("../../data/AuthContext", () => ({ useAuth: vi.fn() }));

const ORGANIZATION: CurrentOrganization = {
  id: "org-1",
  slug: "acme",
  name: "Acme",
  role: "org_admin",
  members_from_directory: false,
  directory_takes_changes: false,
  administers: true,
  can_manage_members: false,
};

function Listener({ heard }: { heard: () => void }) {
  useOrganizationRenamed(heard);
  return null;
}

describe("OrganizationGeneralPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renames the organization and tells the top bar", async () => {
    const calls = answerFetch({
      "GET /organizations/current": [
        [200, ORGANIZATION],
        [200, { ...ORGANIZATION, name: "Acme Labs" }],
      ],
      "PATCH /organizations/current": [200, { id: "org-1", name: "Acme Labs" }],
    });
    const heard = vi.fn();
    render(
      <>
        <Listener heard={heard} />
        <OrganizationGeneralPage />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Rename organization" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Organization name" }), {
      target: { value: "  Acme Labs  " },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Update" })));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Acme Labs" }),
    );
    expect(heard).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Organization renamed to Acme Labs.")).toBeTruthy();
  });

  it("is read-only for someone who is not its admin", async () => {
    answerFetch({
      "GET /organizations/current": [
        200,
        { ...ORGANIZATION, role: null, administers: false, can_manage_members: false },
      ],
    });
    render(<OrganizationGeneralPage />);

    expect(await screen.findByText("Only an org admin can change this.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename organization" })).toBeNull();
  });
});
