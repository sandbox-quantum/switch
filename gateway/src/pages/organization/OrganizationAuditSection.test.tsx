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
    render(<OrganizationAuditSection />);

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

  it("loads older events after a full page, from the oldest shown", async () => {
    const full = Array.from({ length: ORGANIZATION_AUDIT_PAGE }, (_, i) =>
      event(`e${i}`, { occurred_at: `2026-11-12T10:${String(59 - i).padStart(2, "0")}:00Z` }),
    );
    const calls = answerFetch({ [EVENTS]: [[200, full], [200, [event("older")]]] });
    render(<OrganizationAuditSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older events" }));

    expect(await screen.findByTestId("row-older")).toBeTruthy();
    expect(screen.getByTestId("row-e0")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull());
    expect(calls).toHaveLength(2);
  });

  it("says nothing is recorded yet, and shows a failure as one", async () => {
    answerFetch({ [EVENTS]: [200, []] });
    render(<OrganizationAuditSection />);
    expect(await screen.findByText("Nothing recorded yet")).toBeTruthy();
    cleanup();

    answerFetch({ [EVENTS]: [500, { detail: "The database is unavailable" }] });
    render(<OrganizationAuditSection />);
    expect(await screen.findByText(/The database is unavailable/)).toBeTruthy();
  });
});
