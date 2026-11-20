import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORGANIZATION_AUDIT_PAGE, type OrganizationAuditEvent } from "../../data/api";
import { answerFetch } from "../../test/answerFetch";
import OrganizationAuditSection from "./OrganizationAuditSection";

vi.mock("../../components/DataTable", () => import("../../test/FakeDataTable"));

const EVENTS = "GET /organizations/current/audit-events";

function event(id: string, extra: Partial<OrganizationAuditEvent> = {}): OrganizationAuditEvent {
  return {
    id,
    occurred_at: "2026-11-12T10:00:00Z",
    actor_user_id: "u1",
    actor_name: "Ada",
    action: "organization.workspace_renamed",
    target_type: "tenant",
    target_id: "t1",
    target_name: "Core",
    details: null,
    ...extra,
  };
}

describe("OrganizationAuditSection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says what changed, who changed it and what it changed, marking the operator", async () => {
    answerFetch({
      [EVENTS]: [
        200,
        [
          event("e1"),
          event("e2", {
            action: "organization.role_changed",
            actor_name: "Root",
            target_name: null,
            details: { platform_access: true, name: "Grace" },
          }),
          event("e3", { action: "organization.something_new", actor_user_id: null, actor_name: null, target_name: null }),
        ],
      ],
    });
    render(<OrganizationAuditSection organizationName="Acme" membersFromDirectory={false} />);

    const renamed = within(await screen.findByTestId("row-e1"));
    expect(renamed.getByText("Workspace renamed")).toBeTruthy();
    expect(renamed.getByText("Ada")).toBeTruthy();
    expect(renamed.getByText("Core")).toBeTruthy();
    const promoted = within(screen.getByTestId("row-e2"));
    expect(promoted.getByText("Organization role changed")).toBeTruthy();
    expect(promoted.getByText("Root (platform operator)")).toBeTruthy();
    expect(promoted.getByText("Grace")).toBeTruthy();
    // An action this page has no words for shows as it is; nobody did it but Switch.
    const unknown = within(screen.getByTestId("row-e3"));
    expect(unknown.getByText("organization.something_new")).toBeTruthy();
    expect(unknown.getByText("Switch")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull();
  });

  it("names member changes in a workspace and joins, with the workspace and role", async () => {
    answerFetch({
      [EVENTS]: [
        200,
        [
          event("changed", {
            action: "organization.member_workspace_role_changed",
            target_type: "user",
            target_name: "Bob",
            details: { workspace: "w2", workspace_name: "Lab", from: "member", to: "admin" },
          }),
          event("removed", {
            action: "organization.member_removed_from_workspace",
            target_type: "user",
            target_name: "Bob",
            details: { workspace: "w2", workspace_name: "Lab", role: "member" },
          }),
          event("invited", {
            action: "organization.member_joined_by_invitation",
            actor_name: "Cy",
            target_type: "user",
            target_name: "Cy",
            details: { workspace: "w1", workspace_name: "Core", role: "member", invited_by: "u1" },
          }),
          event("domain", {
            action: "organization.member_joined_by_domain",
            actor_name: "Di",
            target_type: "user",
            target_name: "Di",
            details: { workspace: "w1", workspace_name: "Core", role: "member", domain: "acme.test" },
          }),
        ],
      ],
    });
    render(<OrganizationAuditSection organizationName="Acme" membersFromDirectory={false} />);

    const changed = within(await screen.findByTestId("row-changed"));
    expect(changed.getByText("Role in a workspace changed")).toBeTruthy();
    expect(changed.getByText("Lab · Member → Workspace admin")).toBeTruthy();
    const removed = within(screen.getByTestId("row-removed"));
    expect(removed.getByText("Removed from a workspace")).toBeTruthy();
    expect(removed.getByText("Lab · Member")).toBeTruthy();
    expect(within(screen.getByTestId("row-invited")).getByText("Joined by invitation")).toBeTruthy();
    const domain = within(screen.getByTestId("row-domain"));
    expect(domain.getByText("Joined by e-mail domain")).toBeTruthy();
    expect(domain.getByText("Core · Member · via acme.test")).toBeTruthy();
  });

  it("loads older events after a full page, from the oldest shown", async () => {
    const full = Array.from({ length: ORGANIZATION_AUDIT_PAGE }, (_, i) =>
      event(`e${i}`, { occurred_at: `2026-11-12T10:${String(59 - i).padStart(2, "0")}:00Z` }),
    );
    const calls = answerFetch({ [EVENTS]: [[200, full], [200, [event("older")]]] });
    render(<OrganizationAuditSection organizationName="Acme" membersFromDirectory={false} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older events" }));

    expect(await screen.findByTestId("row-older")).toBeTruthy();
    expect(screen.getByTestId("row-e0")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull());
    expect(calls).toHaveLength(2);
  });

  it("says nothing is recorded yet, and shows a failure as one", async () => {
    answerFetch({ [EVENTS]: [200, []] });
    render(<OrganizationAuditSection organizationName="Acme" membersFromDirectory={false} />);
    expect(await screen.findByText("Nothing recorded yet")).toBeTruthy();
    cleanup();

    answerFetch({ [EVENTS]: [500, { detail: "The database is unavailable" }] });
    render(<OrganizationAuditSection organizationName="Acme" membersFromDirectory={false} />);
    expect(await screen.findByText(/The database is unavailable/)).toBeTruthy();
  });

  it("names organization roles as Switch Trust does where the members come from WorkOS", async () => {
    answerFetch({
      [EVENTS]: [
        200,
        [
          event("e1", {
            action: "organization.member_demoted_from_directory",
            target_name: "Grace",
            details: { from: "org_admin", to: "member" },
          }),
          event("e2", {
            action: "organization.member_workspace_role_changed",
            target_name: "Grace",
            details: { workspace_name: "Core", from: "admin", to: "member" },
          }),
        ],
      ],
    });
    render(<OrganizationAuditSection organizationName="Acme" membersFromDirectory={true} />);

    const demoted = within(await screen.findByTestId("row-e1"));
    expect(demoted.getByText("Demoted to Viewer from WorkOS")).toBeTruthy();
    expect(demoted.getByText("Org Admin → Viewer")).toBeTruthy();
    // A workspace's roles are Switch Rooms' own, whoever keeps the members.
    const inWorkspace = within(screen.getByTestId("row-e2"));
    expect(inWorkspace.getByText("Core · Workspace admin → Member")).toBeTruthy();
  });
});
